import AVFoundation
import Capacitor
import Foundation
import Speech

// print() lands on the process stdout, which `devicectl process launch --console`
// streams back (tools/iosctl device-log) — so these show up live while
// investigating the mic on-device. Mirrors @splanc/wss-bridge's wlog.
private func slog(_ s: String) {
    print("[speech-bridge] \(s)")
}

/// Native speech-recognition bridge for Acid Mode voice input
/// (docs/design/ios-support.md §4.4).
///
/// WKWebView exposes `webkitSpeechRecognition`, but it aborts immediately with no
/// transcript — the Web Speech API only works in Safari proper. So on iOS the mic
/// runs natively here through `SFSpeechRecognizer`, streaming partial transcripts
/// back to JS. `ui/acid/voice.ts` binds this plugin via registerPlugin("SpeechBridge")
/// and adapts it to the same `VoiceSession` seam the browser path uses, so Acid
/// Mode's UI is unchanged.
///
/// The recognition/audio-engine core is adapted from the MIT-licensed
/// @capacitor-community/speech-recognition (which ships only a CocoaPods podspec,
/// so it can't join our SPM-based Capacitor project; this is the same logic in a
/// first-party SPM plugin). Emitted events: `partialResults` ({ matches: [String] })
/// and `listeningState` ({ status: "started" | "stopped" }).
@objc(SpeechBridge)
public class SpeechBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechBridge"
    public let jsName = "SpeechBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise)
    ]

    private let defaultMatches = 5

    private var speechRecognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    @objc func available(_ call: CAPPluginCall) {
        guard let recognizer = SFSpeechRecognizer() else {
            call.resolve(["available": false])
            return
        }
        call.resolve(["available": recognizer.isAvailable])
    }

    @objc func start(_ call: CAPPluginCall) {
        if let engine = self.audioEngine, engine.isRunning {
            call.reject("Ongoing speech recognition")
            return
        }

        if SFSpeechRecognizer.authorizationStatus() != .authorized {
            call.reject("Missing permission")
            return
        }

        AVAudioSession.sharedInstance().requestRecordPermission { (granted) in
            if !granted {
                call.reject("User denied access to microphone")
                return
            }

            let language: String = call.getString("language") ?? "en-US"
            let maxResults: Int = call.getInt("maxResults") ?? self.defaultMatches
            let partialResults: Bool = call.getBool("partialResults") ?? false
            slog("start language=\(language) partialResults=\(partialResults)")

            self.recognitionTask?.cancel()
            self.recognitionTask = nil

            self.audioEngine = AVAudioEngine()
            self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: language))

            let audioSession = AVAudioSession.sharedInstance()
            do {
                try audioSession.setCategory(.playAndRecord, options: .defaultToSpeaker)
                try audioSession.setMode(.default)
                try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            } catch {
                call.reject("Microphone is already in use by another application.")
                return
            }

            self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            self.recognitionRequest?.shouldReportPartialResults = partialResults

            let inputNode = self.audioEngine!.inputNode
            let format = inputNode.outputFormat(forBus: 0)

            self.recognitionTask = self.speechRecognizer?.recognitionTask(
                with: self.recognitionRequest!,
                resultHandler: { (result, error) in
                    if let result = result {
                        let matches = NSMutableArray()
                        var counter = 0
                        for transcription in result.transcriptions {
                            if maxResults > 0 && counter < maxResults {
                                matches.add(transcription.formattedString)
                            }
                            counter += 1
                        }

                        let best = matches.firstObject as? String ?? ""
                        slog("result partial=\(!result.isFinal) best=\"\(best)\"")
                        if partialResults {
                            self.notifyListeners("partialResults", data: ["matches": matches])
                        } else {
                            call.resolve(["matches": matches])
                        }

                        if result.isFinal {
                            self.teardown()
                            self.notifyListeners("listeningState", data: ["status": "stopped"])
                        }
                    }

                    if let error = error {
                        slog("recognition error: \(error.localizedDescription)")
                        self.teardown()
                        self.notifyListeners("listeningState", data: ["status": "stopped"])
                        if partialResults {
                            self.notifyListeners("partialResults", data: ["matches": NSMutableArray()])
                        }
                    }
                })

            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { (buffer, _) in
                self.recognitionRequest?.append(buffer)
            }

            self.audioEngine?.prepare()
            do {
                try self.audioEngine?.start()
                self.notifyListeners("listeningState", data: ["status": "started"])
                if partialResults {
                    call.resolve()
                }
            } catch {
                self.teardown()
                call.reject("Unknown error occured")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .default).async {
            if let engine = self.audioEngine, engine.isRunning {
                slog("stop")
                engine.stop()
                self.recognitionRequest?.endAudio()
                self.notifyListeners("listeningState", data: ["status": "stopped"])
            }
            call.resolve()
        }
    }

    /// Tear the audio engine + recognition task down. Safe to call more than once.
    private func teardown() {
        if let engine = self.audioEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        self.recognitionRequest = nil
        self.recognitionTask = nil
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        let permission: String
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            permission = "granted"
        case .denied, .restricted:
            permission = "denied"
        case .notDetermined:
            permission = "prompt"
        @unknown default:
            permission = "prompt"
        }
        call.resolve(["speechRecognition": permission])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { (status) in
            DispatchQueue.main.async {
                switch status {
                case .authorized:
                    AVAudioSession.sharedInstance().requestRecordPermission { (granted) in
                        slog("requestPermissions speech=granted mic=\(granted ? "granted" : "denied")")
                        call.resolve(["speechRecognition": granted ? "granted" : "denied"])
                    }
                default:
                    self.checkPermissions(call)
                }
            }
        }
    }
}
