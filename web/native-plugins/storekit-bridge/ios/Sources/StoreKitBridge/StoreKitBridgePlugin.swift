import Capacitor
import Foundation
import StoreKit
import UIKit

/// Splanc AI credit packs through Apple In-App Purchase (StoreKit 2), for the
/// iOS app only (docs/design/ai-billing.md §Purchases). The web code drives it
/// (web/src/net/storeKit.ts); this side only talks to StoreKit:
///
/// - `products({ids})` → `{products: [{id, displayName, description,
///   displayPrice, price, currencyCode}]}`: Apple's localized prices.
/// - `purchase({productId, appAccountToken})` → `{status: "purchased",
///   transaction}` | `{status: "pending"}` (Ask to Buy, or a payment that needs
///   another step) | `{status: "cancelled"}`. `appAccountToken` is the UUID the
///   relay derives from the credit account (`account_ref`); the signed
///   transaction carries it, so the relay credits only that account.
/// - `finish({transactionId})`: call ONLY after the relay credited (or already
///   had) the purchase. Until then StoreKit keeps the transaction unfinished and
///   hands it back at every launch, so a crash between paying and crediting
///   heals itself.
/// - `unfinished()` → `{transactions}`: what's still waiting (sent at start).
/// - `sync()`: AppStore.sync() (the system "restore" sign-in sheet).
/// - `canMakePayments()` → `{allowed}` (false under Screen Time restrictions).
/// - event `transaction`: Transaction.updates, i.e. purchases that complete
///   outside `purchase()` (Ask to Buy approved, a pending payment cleared,
///   bought on another device / via an offer code). Retained until JS listens.
///
/// A transaction is `{transactionId, originalTransactionId, productId, jws}`
/// where `jws` is StoreKit's signed `jwsRepresentation`, the only thing the
/// relay trusts. Transactions StoreKit itself can't verify are not passed on.
@objc(StoreKitBridge)
public class StoreKitBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StoreKitBridge"
    public let jsName = "StoreKitBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "canMakePayments", returnType: CAPPluginReturnPromise)
    ]

    private var updates: Task<Void, Never>?
    private let store = TransactionStore()

    override public func load() {
        // Listen from launch (Apple's advice), so no approval is missed; events
        // are retained until the web side adds its listener.
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                guard let self = self else { return }
                guard case .verified(let t) = result else { continue }
                await self.store.put(t)
                self.notifyListeners("transaction", data: Self.payload(t, jws: result.jwsRepresentation), retainUntilConsumed: true)
            }
        }
    }

    deinit {
        updates?.cancel()
    }

    static func payload(_ t: Transaction, jws: String) -> [String: Any] {
        return [
            "transactionId": String(t.id),
            "originalTransactionId": String(t.originalID),
            "productId": t.productID,
            "jws": jws,
            "revoked": t.revocationDate != nil
        ]
    }

    @objc func products(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids", String.self) ?? []).filter { !$0.isEmpty }
        if ids.isEmpty {
            call.reject("ids required", "invalid")
            return
        }
        Task {
            do {
                let found = try await Product.products(for: ids)
                call.resolve(["products": found.map { p -> [String: Any] in
                    [
                        "id": p.id,
                        "displayName": p.displayName,
                        "description": p.description,
                        "displayPrice": p.displayPrice,
                        "price": NSDecimalNumber(decimal: p.price).doubleValue,
                        "currencyCode": p.priceFormatStyle.currencyCode
                    ]
                }])
            } catch {
                call.reject(error.localizedDescription, Self.code(error))
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let id = call.getString("productId"), !id.isEmpty else {
            call.reject("productId required", "invalid")
            return
        }
        guard let raw = call.getString("appAccountToken"), let token = UUID(uuidString: raw) else {
            call.reject("appAccountToken must be a UUID", "invalid")
            return
        }
        Task { @MainActor in
            do {
                guard let product = try await Product.products(for: [id]).first else {
                    call.reject("this credit pack isn't on sale", "unavailable")
                    return
                }
                let options: Set<Product.PurchaseOption> = [.appAccountToken(token)]
                let result: Product.PurchaseResult
                if #available(iOS 17.0, *), let scene = self.bridge?.viewController?.view.window?.windowScene {
                    result = try await product.purchase(confirmIn: scene, options: options)
                } else {
                    result = try await product.purchase(options: options)
                }
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let t):
                        await self.store.put(t)
                        call.resolve(["status": "purchased", "transaction": Self.payload(t, jws: verification.jwsRepresentation)])
                    case .unverified:
                        // Left unfinished: the relay could not verify it either.
                        call.reject("the App Store could not verify this purchase", "unverified")
                    }
                case .pending:
                    call.resolve(["status": "pending"])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                @unknown default:
                    call.resolve(["status": "pending"])
                }
            } catch {
                let code = Self.code(error)
                if code == "cancelled" {
                    call.resolve(["status": "cancelled"])
                } else {
                    call.reject(error.localizedDescription, code)
                }
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let raw = call.getString("transactionId"), let id = UInt64(raw) else {
            call.reject("transactionId required", "invalid")
            return
        }
        Task {
            if let t = await self.store.take(id) {
                await t.finish()
                call.resolve(["finished": true])
                return
            }
            // Not seen this launch: look among the unfinished ones.
            for await result in Transaction.unfinished {
                if case .verified(let t) = result, t.id == id {
                    await t.finish()
                    call.resolve(["finished": true])
                    return
                }
            }
            call.resolve(["finished": false])
        }
    }

    @objc func unfinished(_ call: CAPPluginCall) {
        Task {
            var out: [[String: Any]] = []
            for await result in Transaction.unfinished {
                guard case .verified(let t) = result else { continue }
                await self.store.put(t)
                out.append(Self.payload(t, jws: result.jwsRepresentation))
            }
            call.resolve(["transactions": out])
        }
    }

    @objc func sync(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
                call.resolve()
            } catch {
                call.reject(error.localizedDescription, Self.code(error))
            }
        }
    }

    @objc func canMakePayments(_ call: CAPPluginCall) {
        call.resolve(["allowed": AppStore.canMakePayments])
    }

    /// Stable error codes for the web side (never Apple's localized text alone).
    static func code(_ error: Error) -> String {
        if let e = error as? StoreKitError {
            switch e {
            case .userCancelled: return "cancelled"
            case .networkError: return "network"
            case .notAvailableInStorefront: return "unavailable"
            case .notEntitled: return "not_allowed"
            default: return "failed"
            }
        }
        if let e = error as? Product.PurchaseError {
            switch e {
            case .purchaseNotAllowed: return "not_allowed"
            case .productUnavailable: return "unavailable"
            default: return "failed"
            }
        }
        return "failed"
    }
}

/// The verified transactions seen this launch, by id (finish() needs the object).
actor TransactionStore {
    private var byId: [UInt64: Transaction] = [:]

    func put(_ t: Transaction) {
        byId[t.id] = t
    }

    func take(_ id: UInt64) -> Transaction? {
        return byId.removeValue(forKey: id)
    }
}
