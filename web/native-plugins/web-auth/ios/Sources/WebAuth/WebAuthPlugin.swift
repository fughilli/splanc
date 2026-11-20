import AuthenticationServices
import Capacitor
import Foundation
import UIKit

/// One-tap OAuth sign-in for the iOS app (docs/design/ai-tiers.md, "iOS one-tap
/// connect"): runs an `ASWebAuthenticationSession` — the system sign-in sheet,
/// which shares Safari's cookies, so a user already signed in to OpenRouter in
/// Safari just taps "Continue" / "Authorize".
///
/// The WKWebView can't do this itself: Capacitor opens off-origin pages in
/// Safari, and nothing brings a redirect back into the app. The session instead
/// watches for a redirect to `callbackScheme` (e.g. `splanc://…`) and hands that
/// URL back to JS. OpenRouter redirects to an https bounce page
/// (web/public/oauth-callback.html on splanc.io), which forwards `code`/`state`
/// to `splanc://oauth/openrouter`. The session captures that navigation itself,
/// so no URL type has to be registered in Info.plist, and another app claiming
/// the same scheme can't intercept it. The PKCE verifier never leaves the app,
/// so a leaked code is useless anyway.
///
/// JS: `registerPlugin("WebAuth").start({ url, callbackScheme })` →
/// `{ url: "<callback URL>" }`; rejects with code "canceled" when the user
/// closes the sheet.
///
/// Also native Sign in with Apple for Splanc AI credit accounts
/// (agent/relay/src/billing/signin.ts): `appleSignIn({ nonce })` →
/// `{ identityToken, authorizationCode }` from AuthenticationServices. No
/// scopes are requested (no name, no email): the relay only needs the stable
/// user id in the token. `nonce` is the relay's nonce hash, which Apple puts in
/// the token. Needs the "Sign in with Apple" capability (web/ios-config/apply.sh
/// adds the entitlement). Rejects with "canceled" when the user closes it.
@objc(WebAuth)
public class WebAuth: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "WebAuth"
    public let jsName = "WebAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appleSignIn", returnType: CAPPluginReturnPromise)
    ]

    // The pending Sign in with Apple call (one at a time).
    private var appleCall: CAPPluginCall?

    @objc func appleSignIn(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty, nonce.count <= 128 else {
            call.reject("nonce is required", "invalid")
            return
        }
        DispatchQueue.main.async {
            if self.appleCall != nil {
                call.reject("a sign-in is already in progress", "busy")
                return
            }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = []
            request.nonce = nonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.appleCall = call
            controller.performRequests()
        }
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = appleCall else { return }
        appleCall = nil
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken, let token = String(data: tokenData, encoding: .utf8),
              let codeData = cred.authorizationCode, let code = String(data: codeData, encoding: .utf8) else {
            call.reject("Apple returned no identity token", "failed")
            return
        }
        call.resolve(["identityToken": token, "authorizationCode": code])
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = appleCall else { return }
        appleCall = nil
        if let e = error as? ASAuthorizationError, e.code == .canceled {
            call.reject("sign-in cancelled", "canceled")
            return
        }
        call.reject(error.localizedDescription, "failed")
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return self.bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    // Keep the session alive until it completes (ASWebAuthenticationSession is
    // cancelled when deallocated).
    private var session: ASWebAuthenticationSession?

    @objc func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              url.scheme == "https" else {
            call.reject("url must be an https URL", "invalid")
            return
        }
        guard let scheme = call.getString("callbackScheme"), !scheme.isEmpty,
              scheme.range(of: "^[a-z][a-z0-9+.-]*$", options: .regularExpression) != nil else {
            call.reject("callbackScheme must be a URL scheme", "invalid")
            return
        }
        DispatchQueue.main.async {
            if self.session != nil {
                call.reject("a sign-in is already in progress", "busy")
                return
            }
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                self.session = nil
                if let callback = callback {
                    call.resolve(["url": callback.absoluteString])
                    return
                }
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    call.reject("sign-in cancelled", "canceled")
                    return
                }
                call.reject(error?.localizedDescription ?? "sign-in failed", "failed")
            }
            s.presentationContextProvider = self
            // Share Safari's cookies so an existing OpenRouter login is reused (one tap).
            s.prefersEphemeralWebBrowserSession = false
            self.session = s
            if !s.start() {
                self.session = nil
                call.reject("could not start the sign-in sheet", "failed")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return self.bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
