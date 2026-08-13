import Capacitor
import Foundation

// print() lands on the process stdout, which `devicectl process launch --console`
// streams back to the build server (tools/iosctl device-log) — so these show up
// live while investigating a connection.
private func wlog(_ s: String) {
    print("[wss-bridge] \(s)")
}

/// Native WebSocket bridge for the Splanc control plane (docs/design/ios-support.md §4.3).
///
/// The device serves `wss://<lan-ip>/ws` with a **self-signed** certificate. In a
/// browser the user clicks through a one-time trust prompt, but a WKWebView gives
/// JS `new WebSocket()` no way to accept an untrusted cert and shares nothing with
/// Safari — so on iOS the control socket can never open from JS. This plugin owns
/// the socket natively via `URLSessionWebSocketTask`, whose delegate trusts the
/// device's cert, and relays frames to/from JS. `net/nativeSocket.ts` adapts it to
/// the `SocketLike` seam that `LedMapperClient`'s injectable `SocketFactory` expects.
///
/// Trust model: this accepts the server-presented cert for the sockets it opens —
/// the native equivalent of the browser's "accept self-signed cert" step, scoped to
/// this plugin's own URLSessions (the WebView's normal traffic is unaffected). A
/// tighter trust-on-first-use pin (keyed by device MAC, matching the cert-rotation
/// logic in net/client.ts) is a follow-up; for bring-up this restores parity with
/// the web trust flow.
@objc(WssBridge)
public class WssBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WssBridge"
    public let jsName = "WssBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private var conns: [String: WssConnection] = [:]
    private let lock = NSLock()

    @objc func connect(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("connect: missing/invalid 'url'")
            return
        }
        let id = UUID().uuidString
        let conn = WssConnection(id: id, url: url) { [weak self] payload in
            self?.notifyListeners("wssEvent", data: payload)
        }
        lock.lock(); conns[id] = conn; lock.unlock()
        conn.onClosed = { [weak self] in
            guard let self = self else { return }
            self.lock.lock(); self.conns[id] = nil; self.lock.unlock()
        }
        conn.start()
        call.resolve(["id": id])
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("send: missing 'id'"); return }
        lock.lock(); let conn = conns[id]; lock.unlock()
        guard let conn = conn else { call.reject("send: unknown socket \(id)"); return }
        let isBinary = call.getBool("binary") ?? false
        guard let data = call.getString("data") else { call.reject("send: missing 'data'"); return }
        if isBinary {
            guard let bytes = Data(base64Encoded: data) else { call.reject("send: bad base64"); return }
            conn.send(.data(bytes)) { err in
                if let err = err { call.reject("send failed: \(err.localizedDescription)") }
                else { call.resolve() }
            }
        } else {
            conn.send(.string(data)) { err in
                if let err = err { call.reject("send failed: \(err.localizedDescription)") }
                else { call.resolve() }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("close: missing 'id'"); return }
        lock.lock(); let conn = conns[id]; conns[id] = nil; lock.unlock()
        conn?.close()
        call.resolve()
    }
}

/// One native WebSocket connection + its trust-accepting URLSession delegate.
private class WssConnection: NSObject, URLSessionWebSocketDelegate {
    let id: String
    private let url: URL
    private let emit: ([String: Any]) -> Void
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private var closedEmitted = false
    private var closed = false  // set once the client asks to close, to mute the
    // receive loop's expected "Socket is not connected" after cancel.
    var onClosed: (() -> Void)?

    init(id: String, url: URL, emit: @escaping ([String: Any]) -> Void) {
        self.id = id
        self.url = url
        self.emit = emit
        super.init()
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        // The device is always a LAN peer (often on a Wi-Fi with no internet, so
        // its address can be link-local). Pin the socket to local interfaces:
        //  - no cellular: stop iOS routing a "looks internet-less" Wi-Fi request
        //    out over cellular, where the device's IP is unreachable (-1009).
        //  - allow on constrained/expensive Wi-Fi (Low Data Mode / hotspot).
        config.allowsCellularAccess = false
        config.allowsConstrainedNetworkAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.resume()
        receiveLoop()
    }

    func send(_ message: URLSessionWebSocketTask.Message, completion: @escaping (Error?) -> Void) {
        task.send(message) { error in completion(error) }
    }

    func close() {
        closed = true
        task?.cancel(with: .normalClosure, reason: nil)
        emitClose(code: 1000, reason: "client closed")
        session?.invalidateAndCancel()
    }

    // Pump incoming frames to JS, re-arming until the socket ends.
    private func receiveLoop() {
        task.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                // After a client close(), receive() completes with the expected
                // "Socket is not connected" — swallow it, we already emitted close.
                if self.closed { return }
                wlog("receive error \(self.id): \(error.localizedDescription)")
                self.emit(["id": self.id, "type": "error", "message": error.localizedDescription])
                self.emitClose(code: 1006, reason: error.localizedDescription)
            case .success(let message):
                switch message {
                case .data(let data):
                    self.emit(["id": self.id, "type": "message",
                               "data": data.base64EncodedString(), "binary": true])
                case .string(let text):
                    self.emit(["id": self.id, "type": "message", "data": text, "binary": false])
                @unknown default:
                    break
                }
                self.receiveLoop()
            }
        }
    }

    private func emitClose(code: Int, reason: String) {
        if closedEmitted { return }
        closedEmitted = true
        emit(["id": id, "type": "close", "code": code, "message": reason])
        onClosed?()
    }

    // MARK: URLSessionWebSocketDelegate

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol protocol: String?) {
        emit(["id": id, "type": "open"])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                           reason: Data?) {
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        emitClose(code: closeCode.rawValue, reason: text)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           didCompleteWithError error: Error?) {
        if !closed, let error = error {
            emit(["id": id, "type": "error", "message": error.localizedDescription])
        }
        emitClose(code: 1006, reason: error?.localizedDescription ?? "completed")
    }

    // Trust the device's self-signed server certificate for this socket. This is
    // the native counterpart of the browser's one-time cert accept — scoped to the
    // sockets this plugin opens, so nothing else in the app is affected.
    public func urlSession(_ session: URLSession,
                           didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition,
                                                         URLCredential?) -> Void) {
        let method = challenge.protectionSpace.authenticationMethod
        guard method == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
