"""Layout-guard scenarios: Settings ▸ AI and the Splanc AI credits flow.

Every billing call goes to an in-process fake of the relay's /billing API
(docs/design/ai-billing.md + the e-mail / recovery routes of PR #557) and
Stripe Checkout is a local fake page, so nothing reaches the real network.
The buy scenarios drive the real UI step by step (click / fill), so they
double as an end-to-end walk through the flow.
"""

from __future__ import annotations

import json
import urllib.parse

from layout_guard import Scenario

RELAY_HOST = "splanc.pages.dev"
FLAG = {"splanc.flags.aiCredits": "1"}
SESSION = {"splanc.aiCredits.session": json.dumps({"account_id": "acct_demo", "token": "tok_demo"})}
PACKS = [
    {"sku": "web.credits.10", "channel": "web", "credits": 833, "reference_price_usd": 10},
    {"sku": "web.credits.25", "channel": "web", "credits": 2083, "reference_price_usd": 25},
]
APPLE_PACKS = [
    {"sku": "dev.splanc.app.credits.small", "channel": "apple", "credits": 356},
    {"sku": "dev.splanc.app.credits.medium", "channel": "apple", "credits": 713},
    {"sku": "dev.splanc.app.credits.large", "channel": "apple", "credits": 1427},
]
ACCOUNT_REF = "6f1c2a9e-1b2c-5d3e-8f40-0123456789ab"
STATEMENT = [
    {
        "at": "2026-11-18T19:42:00Z",
        "kind": "usage",
        "credits": -7.4,
        "balance_credits": 412.5,
        "model": "claude-sonnet-5-5",
    },
    {
        "at": "2026-11-18T19:40:00Z",
        "kind": "usage",
        "credits": -4.1,
        "balance_credits": 419.9,
        "model": "claude-sonnet-5-5",
    },
    {
        "at": "2026-11-17T21:05:00Z",
        "kind": "usage",
        "credits": -11.2,
        "balance_credits": 424.0,
        "model": "claude-sonnet-5-5",
    },
    {
        "at": "2026-11-12T18:30:00Z",
        "kind": "purchase",
        "credits": 833,
        "balance_credits": 435.2,
        "sku": "web.credits.10",
    },
]
CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
}


class FakeBilling:
    """A tiny stateful fake of the relay's billing routes + Stripe Checkout."""

    def __init__(
        self,
        *,
        balance=0.0,
        adult=False,
        email=None,
        anon=False,
        signed_out=False,
        landing=True,
        email_in_use=False,
        statement=None,
        low_mark=50,
        consent=None,
        apple_fail=False,
        signin=False,
        identities=None,
        conflict=False,
        no_account=False,
    ):
        self.balance = balance
        self.adult = adult
        self.email = email
        self.anon = anon
        self.signed_out = signed_out
        self.landing = landing  # does a paid checkout credit the account?
        self.email_in_use = email_in_use
        self.statement = statement if statement is not None else []
        self.low_mark = low_mark
        self.paid = False
        self.return_url = ""
        self.query = ""
        self.consent = consent  # None = never asked; True / False = answered
        self.apple_fail = apple_fail  # the relay can't credit an App Store purchase
        # Sign in with Apple / Google (billing/signin.ts).
        self.signin = signin
        self.identities = list(identities or [])
        self.conflict = conflict
        self.no_account = no_account
        self.auth = None

    def balance_body(self):
        hint = (self.email[0] + "•••" + self.email[self.email.index("@") :]) if self.email else None
        return {
            "balance_credits": self.balance,
            "available_credits": self.balance,
            "held_credits": 0,
            "low": self.balance < self.low_mark,
            "status": "active",
            "adult": self.adult,
            "email_hint": hint,
            "email_verified": bool(self.email),
            "anonymous_ack_at": "2026-11-18T10:00:00Z" if self.anon else None,
            "apple_consumption_consent": self.consent is True,
            "apple_consumption_asked": self.consent is not None,
            "account_ref": ACCOUNT_REF,
            "identities": [
                {"provider": p, "linked_at": "2026-11-20T09:30:00Z"} for p in self.identities
            ],
        }

    def handler(self):
        def h(route, request):
            u = urllib.parse.urlparse(request.url)
            if u.hostname == "checkout.stripe.com":
                ret = self.return_url or "/"
                base, _, frag = ret.partition("#")
                ok = f"{base}?checkout=success&session_id=cs_test_fake#{frag}"
                no = f"{base}?checkout=cancel#{frag}"
                html = (
                    "<html><body style='font-family:sans-serif;padding:32px;background:#f6f9fc'>"
                    "<h2>Stripe Checkout (test fake)</h2><p>Splanc AI credits</p>"
                    f"<a id=pay href='{ok}'>Pay</a> &nbsp; <a id=back href='{no}'>Back</a></body></html>"
                )
                self.paid = True
                return route.fulfill(status=200, content_type="text/html", body=html) or True
            if u.hostname in SCRIPT_STUBS and u.path in SCRIPT_STUBS[u.hostname]:
                body = SCRIPT_STUBS[u.hostname][u.path]
                return route.fulfill(status=200, content_type="text/javascript", body=body) or True
            if u.hostname != RELAY_HOST:
                return False
            self.auth = request.headers.get("authorization")
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=CORS) or True
            body = json.loads(request.post_data) if request.post_data else {}
            self.query = u.query
            status, out = self.api(request.method, u.path, body)
            return (
                route.fulfill(
                    status=status,
                    content_type="application/json",
                    body=json.dumps(out),
                    headers=CORS,
                )
                or True
            )

        return h

    def api(self, method, path, body):
        key = f"{method} {path}"
        if key == "GET /billing/pricing":
            return 200, {
                "version": 1,
                "credits_per_usd": 100,
                "low_balance_credits": self.low_mark,
                "default_model": "claude-sonnet-5-5",
                "models": [],
                "packs": APPLE_PACKS if "channel=apple" in self.query else PACKS,
            }
        if key == "POST /billing/account/recover" or key == "POST /billing/recover/start":
            return 202, {"ok": True, "message": "If an account uses this address, we sent a code."}
        if key == "POST /billing/recover/verify":
            if body.get("code") != "123456":
                return 400, {"error": "invalid_code", "message": "That code didn't work."}
            self.signed_out = False
            self.balance, self.adult, self.email = 412.5, True, body.get("email")
            self.statement = STATEMENT
            return 200, {
                "account_id": "acct_demo",
                "token": "tok_restored",
                "account_ref": "SPL-7Q2K",
                "balance_credits": 412.5,
            }
        if key == "GET /billing/signin/config":
            return 200, SIGNIN_CONFIG if self.signin else {"apple": None, "google": None}
        if key == "POST /billing/signin/nonce":
            return 200, {"nonce": "sn1.fake", "provider_nonce": "fakehash", "expires_at": 0}
        if key == "POST /billing/signin":
            p = body.get("provider", "apple")
            if self.conflict and self.auth:
                return 409, {
                    "error": "identity_in_use",
                    "message": "in use",
                    "current": {"balance_credits": self.balance, "identities": []},
                    "other": {
                        "balance_credits": 412.5,
                        "identities": [{"provider": p, "linked_at": "2026-11-02T09:30:00Z"}],
                    },
                    "switch_ticket": "sw1.fake",
                }
            if self.no_account and body.get("create") is False:
                return 404, {"error": "no_account", "message": "no account"}
            if p not in self.identities:
                self.identities.append(p)
            if self.auth:
                return 200, {"result": "linked", "account_id": "acct_demo", **self.summary()}
            self.signed_out = False
            self.balance, self.adult, self.statement = 412.5, True, STATEMENT
            return 200, {
                "result": "signed_in",
                "account_id": "acct_demo",
                "token": "tok_signed_in",
                **self.summary(),
            }
        if key == "POST /billing/signin/switch":
            self.balance, self.adult, self.statement = 412.5, True, STATEMENT
            self.identities = ["apple"]
            return 200, {
                "result": "switched",
                "account_id": "acct_other",
                "token": "tok_other",
                **self.summary(),
            }
        if key == "POST /billing/signin/unlink":
            self.identities = [x for x in self.identities if x != body.get("provider")]
            return 200, {"ok": True, "identities": self.summary()["identities"]}
        if key == "POST /billing/account":
            return 201, {
                "account_id": "acct_demo",
                "token": "tok_demo",
                "account_ref": "SPL-7Q2K",
                "balance_credits": 0,
            }
        if self.signed_out:
            return 401, {"error": "unauthorized", "message": "Session expired."}
        if key == "GET /billing/balance":
            if self.paid and self.landing:
                self.paid, self.balance = False, self.balance + 833
                self.statement = [
                    {
                        "at": "2026-11-18T20:00:00Z",
                        "kind": "purchase",
                        "credits": 833,
                        "balance_credits": self.balance,
                        "sku": "web.credits.10",
                    }
                ] + self.statement
            return 200, self.balance_body()
        if key == "POST /billing/age":
            self.adult = True
            return 200, {"ok": True, "adult": True}
        if key == "POST /billing/account/email":
            return 202, {"ok": True, "message": "Check your email."}
        if key == "POST /billing/account/email/verify":
            if self.email_in_use:
                return 409, {"error": "email_in_use", "message": "in use"}
            if body.get("code") != "123456":
                return 400, {"error": "invalid_code", "message": "That code didn't work."}
            self.email = body.get("email")
            return 200, {"ok": True, "email_hint": "k•••@example.com", "email_verified": True}
        if key == "POST /billing/account/anonymous":
            self.anon = True
            return 200, {"ok": True, "anonymous_ack_at": "2026-11-18T10:00:00Z"}
        if key == "DELETE /billing/account/email":
            self.email = None
            return 200, {"ok": True}
        if key == "DELETE /billing/account":
            return 200, {"ok": True}
        if key == "GET /billing/statement":
            return 200, {"entries": self.statement}
        if key == "POST /billing/consent":
            self.consent = bool(body.get("apple_consumption"))
            return 200, {"ok": True, "apple_consumption_consent": self.consent}
        if key == "POST /billing/purchase/apple":
            if self.apple_fail:
                return 500, {"error": "billing_error", "message": "Something went wrong."}
            self.balance += 356
            self.statement = [
                {
                    "at": "2026-11-20T20:00:00Z",
                    "kind": "purchase",
                    "credits": 356,
                    "balance_credits": self.balance,
                    "sku": "dev.splanc.app.credits.small",
                }
            ] + self.statement
            return 201, {"credited_credits": 356, "balance_credits": self.balance, "replay": False}
        if key == "POST /billing/checkout":
            self.return_url = body.get("return_url", "")
            return 200, {"url": "https://checkout.stripe.com/c/pay/cs_test_fake"}
        return 404, {"error": "not_found", "message": key}

    def summary(self):
        return {
            "balance_credits": self.balance,
            "identities": self.balance_body()["identities"],
        }


SIGNIN_CONFIG = {
    "apple": {
        "ios": True,
        "web": {"client_id": "dev.splanc.app.signin", "redirect_uri": "https://splanc.io/app/"},
    },
    "google": {
        "web": {"client_id": "111-web.apps.googleusercontent.com"},
        "ios": {
            "client_id": "222-ios.apps.googleusercontent.com",
            "redirect_uri": "com.googleusercontent.apps.222-ios:/oauth2redirect",
        },
    },
}

# Local stand-ins for Apple's and Google's sign-in scripts (no real network).
# The Google one draws a look-alike of GIS's "Continue with Google" button.
APPLE_JS_STUB = """
window.AppleID = { auth: {
  init(o) { this.o = o; },
  signIn() { return Promise.resolve({ authorization: { code: "c", id_token: "t", state: this.o.state } }); },
} };
"""
GOOGLE_G = (
    '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.7 '
    "1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.2C12.4 13.6 17.7 9."
    '5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5'
    '.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8'
    '-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.2z"/><path fill='
    '"#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4'
    '.1-13.5-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg><span>Continue with Google</span>'
)
GSI_STUB = """
window.google = { accounts: { id: {
  initialize(o) { this.o = o; },
  renderButton(el, opt) {
    const b = document.createElement("div");
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    const dark = opt.theme === "filled_black";
    b.style.cssText = "display:flex;align-items:center;justify-content:center;gap:10px;height:40px;" +
      "border-radius:20px;font:500 14px Roboto,Arial,sans-serif;cursor:pointer;box-sizing:border-box;" +
      "width:" + opt.width + "px;" + (dark ? "background:#131314;color:#e3e3e3;border:1px solid #8e918f;"
                                          : "background:#fff;color:#1f1f1f;border:1px solid #747775;");
    b.innerHTML = '__GOOGLE_G__';
    b.onclick = () => this.o.callback({ credential: "gtok" });
    el.replaceChildren(b);
  },
} } };
"""
GSI_STUB = GSI_STUB.replace("__GOOGLE_G__", GOOGLE_G)
SCRIPT_STUBS = {
    "appleid.cdn-apple.com": {
        "/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js": APPLE_JS_STUB
    },
    "accounts.google.com": {"/gsi/client": GSI_STUB},
}


def fake(**kw):
    return lambda: FakeBilling(**kw).handler()


def title(text: str) -> str:
    return f'.cf-title:has-text("{text}")'


def btn(text: str) -> str:
    return f'button:has-text("{text}")'


# The buy flow, step by step (each scenario replays the steps before it).
TO_ACCOUNT = [("click", btn("Get started"))]
TO_EMAIL_CHOICE = TO_ACCOUNT + [
    ("check", ".cf-consent input"),
    ("click", btn("Create account")),
    ("wait_for", btn("Add email (recommended)")),
]
TO_EMAIL_ENTRY = TO_EMAIL_CHOICE + [
    ("click", btn("Add email (recommended)")),
    ("fill", "input[type=email]", "kim@example.com"),
]
TO_EMAIL_CODE = TO_EMAIL_ENTRY + [("click", btn("Send code")), ("wait_for", ".cf-code")]
TO_PACKS = TO_EMAIL_CODE + [
    ("fill", ".cf-code", "123456"),
    ("click", btn("Verify email")),
    ("wait_for", ".cf-pack"),
]
TO_HANDOFF = TO_PACKS + [("click", ".cf-pack >> nth=1"), ("click", btn("Continue to payment"))]
TO_SUCCESS = TO_HANDOFF + [
    ("click", btn("Go to secure checkout")),
    ("click", "#pay"),
    ("wait_for", ".cf-balance", 20000),
    ("wait", 1200),
]

TO_SIGNIN_CHOICE = TO_ACCOUNT + [
    ("check", ".cf-consent input"),
    ("click", btn("Create account")),
    ("wait_for", ".cf-sso-btn--apple"),
    ("wait", 400),
]

FRESH = {**FLAG}
SIGNED_IN = {**FLAG, **SESSION}
RET_PRE = {"splanc.aiCredits.preCheckoutBalance": "0"}

SCENARIOS = [
    # Settings ▸ AI (the new home of AI settings)
    Scenario(
        "ai-tab-no-account",
        "#/settings/ai",
        seed=FRESH,
        network=fake(),
        expect=btn("Get Splanc AI credits"),
    ),
    Scenario(
        "ai-tab-account",
        "#/settings/ai",
        seed=SIGNED_IN,
        network=fake(balance=412.5, adult=True, email="kim@example.com", statement=STATEMENT),
        settle_ms=1200,
        expect=btn("Remove email"),
    ),
    Scenario(
        "ai-tab-low-anonymous",
        "#/settings/ai",
        seed=SIGNED_IN,
        network=fake(balance=18.4, adult=True, anon=True, statement=STATEMENT[:2]),
        settle_ms=1200,
        expect=".cacct-low",
    ),
    Scenario(
        "ai-tab-signed-out",
        "#/settings/ai",
        seed=SIGNED_IN,
        network=fake(signed_out=True),
        settle_ms=1200,
        expect=btn("Restore account"),
    ),
    Scenario(
        "ai-tier-sheet",
        "#/settings/ai",
        seed=FRESH,
        network=fake(),
        steps=[("click", btn("Model setup")), ("wait", 600)],
        root=".k-sheet",
        expect=btn("Use Splanc AI credits"),
    ),
    # The dedicated credits flow
    Scenario("flow-01-intro", "#/credits", seed=FRESH, network=fake(), expect=btn("Get started")),
    Scenario(
        "flow-02-account",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_ACCOUNT,
        expect=title("Create your account"),
    ),
    Scenario(
        "flow-03-email-choice",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_EMAIL_CHOICE,
        expect=title("Add a recovery email?"),
    ),
    Scenario(
        "flow-04-anonymous-confirm",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_EMAIL_CHOICE + [("click", btn("Continue without email"))],
        expect=title("Continue without an email?"),
    ),
    Scenario(
        "flow-05-email-entry",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_EMAIL_ENTRY,
        expect=title("Your recovery email"),
    ),
    Scenario(
        "flow-06-email-code",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_EMAIL_CODE,
        expect=title("Check your email"),
    ),
    Scenario(
        "flow-07-email-code-wrong",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_EMAIL_CODE
        + [("fill", ".cf-code", "000000"), ("click", btn("Verify email")), ("wait_for", ".cf-err")],
        expect=".cf-err",
    ),
    Scenario(
        "flow-08-email-in-use",
        "#/credits",
        seed=FRESH,
        network=fake(email_in_use=True),
        steps=TO_EMAIL_CODE
        + [("fill", ".cf-code", "123456"), ("click", btn("Verify email")), ("wait_for", ".cf-err")],
        expect=btn("Restore that account instead"),
    ),
    Scenario(
        "flow-09-packs",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_PACKS,
        expect=title("Choose your credits"),
    ),
    Scenario(
        "flow-10-handoff",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_HANDOFF,
        expect=title("Pay securely with Stripe"),
    ),
    Scenario(
        "flow-11-return-success",
        "#/credits",
        seed=FRESH,
        network=fake(),
        steps=TO_SUCCESS,
        expect=title("You're all set"),
    ),
    Scenario(
        "flow-12-return-pending",
        "#/credits/return",
        search="?checkout=success",
        seed={**SIGNED_IN, **RET_PRE},
        network=fake(balance=0, adult=True, landing=False),
        steps=[("wait_for", btn("Check again"), 25000)],
        expect=title("Payment still processing"),
    ),
    Scenario(
        "flow-13-return-cancelled",
        "#/credits/return",
        search="?checkout=cancel",
        seed=SIGNED_IN,
        network=fake(adult=True),
        expect=title("Checkout cancelled"),
    ),
    Scenario(
        "flow-14-return-failed",
        "#/credits/return",
        search="?checkout=success",
        seed=FRESH,
        network=fake(),
        expect=title("We couldn't confirm your payment"),
    ),
    Scenario(
        "flow-15-restore-email",
        "#/credits/restore",
        seed=FRESH,
        network=fake(),
        steps=[("fill", "input[type=email]", "kim@example.com")],
        expect=title("Restore your account"),
    ),
    Scenario(
        "flow-16-restore-code",
        "#/credits/restore",
        seed=FRESH,
        network=fake(),
        steps=[
            ("fill", "input[type=email]", "kim@example.com"),
            ("click", btn("Send code")),
            ("wait_for", ".cf-code"),
        ],
        expect=title("Check your email"),
    ),
    Scenario(
        "flow-17-restored",
        "#/credits/restore",
        seed=FRESH,
        network=fake(),
        steps=[
            ("fill", "input[type=email]", "kim@example.com"),
            ("click", btn("Send code")),
            ("fill", ".cf-code", "123456"),
            ("click", btn("Restore account")),
            ("wait_for", ".cf-balance"),
            ("wait", 1200),
        ],
        expect=title("Welcome back"),
    ),
    Scenario(
        "flow-18-remove-email",
        "#/credits/removeEmail",
        seed=SIGNED_IN,
        network=fake(balance=412.5, adult=True, email="kim@example.com"),
        expect=title("Remove your recovery email?"),
    ),
    Scenario(
        "flow-19-delete-confirm",
        "#/credits/delete",
        seed=SIGNED_IN,
        network=fake(balance=412.5, adult=True, email="kim@example.com"),
        steps=[("check", ".cf-consent input")],
        expect=title("Delete your Splanc AI account?"),
    ),
    # Sign in with Apple / Google (billing/signin.ts)
    Scenario(
        "signin-01-buy-keep-safe",
        "#/credits",
        seed=FRESH,
        network=fake(signin=True),
        steps=TO_SIGNIN_CHOICE,
        expect=title("Keep your credits safe"),
    ),
    Scenario(
        "signin-02-buy-linked-packs",
        "#/credits",
        seed=FRESH,
        network=fake(signin=True),
        steps=TO_SIGNIN_CHOICE + [("click", ".cf-sso-btn--apple"), ("wait_for", ".cf-pack")],
        expect=title("Choose your credits"),
    ),
    Scenario(
        "signin-03-conflict",
        "#/credits",
        seed=FRESH,
        network=fake(signin=True, balance=40, conflict=True),
        steps=TO_SIGNIN_CHOICE
        + [("click", ".cf-sso-btn--apple"), ("wait_for", btn("Switch to that account"))],
        expect=title("has another account"),
    ),
    Scenario(
        "signin-04-restore",
        "#/credits/restore",
        seed=FRESH,
        network=fake(signin=True),
        steps=[("wait_for", ".cf-sso-btn--apple"), ("wait", 400)],
        expect=title("Restore your account"),
    ),
    Scenario(
        "signin-05-restore-no-account",
        "#/credits/restore",
        seed=FRESH,
        network=fake(signin=True, no_account=True),
        steps=[
            ("wait_for", ".cf-sso-btn--apple"),
            ("click", ".cf-sso-btn--apple"),
            ("wait_for", btn("Try another sign-in")),
        ],
        expect=title("No account for this Apple ID"),
    ),
    Scenario(
        "signin-06-restored",
        "#/credits/restore",
        seed=FRESH,
        network=fake(signin=True),
        steps=[
            ("wait_for", ".cf-sso-btn--apple"),
            ("click", ".cf-sso-btn--apple"),
            ("wait_for", ".cf-balance"),
            ("wait", 1200),
        ],
        expect=title("Welcome back"),
    ),
    Scenario(
        "signin-07-linked-done",
        "#/credits/signin",
        seed=SIGNED_IN,
        network=fake(signin=True, balance=412.5, adult=True),
        steps=[
            ("wait_for", ".cf-sso-btn--apple"),
            ("click", ".cf-sso-btn--apple"),
            ("wait_for", btn("Done")),
        ],
        expect=title("Linked to Apple"),
    ),
    Scenario(
        "signin-08-settings-signed-in",
        "#/settings/ai",
        seed=SIGNED_IN,
        network=fake(
            signin=True, balance=412.5, adult=True, identities=["apple"], statement=STATEMENT
        ),
        settle_ms=1200,
        expect=btn("Sign out…"),
    ),
    Scenario(
        "signin-09-settings-not-signed-in",
        "#/settings/ai",
        seed=SIGNED_IN,
        network=fake(signin=True, balance=412.5, adult=True, statement=STATEMENT),
        settle_ms=1200,
        expect=btn("Sign in with Apple or Google"),
    ),
    Scenario(
        "signin-10-sign-out",
        "#/credits/signout",
        seed=SIGNED_IN,
        network=fake(signin=True, balance=412.5, adult=True, identities=["apple", "google"]),
        expect=title("Sign out of Splanc AI?"),
    ),
    Scenario(
        "signin-11-unlink-last",
        "#/credits/unlinkApple",
        seed=SIGNED_IN,
        network=fake(signin=True, balance=412.5, adult=True, identities=["apple"]),
        expect=title("Remove Apple sign-in?"),
    ),
    Scenario(
        "signin-12-delete-with-signin",
        "#/credits/delete",
        seed=SIGNED_IN,
        network=fake(signin=True, balance=412.5, adult=True, identities=["apple"]),
        settle_ms=1200,
        expect=title("Delete your Splanc AI account?"),
    ),
    Scenario(
        "flow-20-unavailable",
        "#/credits",
        seed={},
        network=fake(),
        expect=title("aren't available here"),
    ),
]


# -- the iOS app (Apple In-App Purchase) ---------------------------------------------------
#
# A fake Capacitor runtime that says "iOS app" and a fake StoreKitBridge plugin
# (web/native-plugins/storekit-bridge): Apple's localized products, and a
# purchase that completes, waits for Ask to Buy, or never returns (the sheet
# still up). Every other native plugin rejects, as on a build without it.


def ios_js(mode: str = "purchased", storekit: bool = True) -> str:
    return """
(() => {
  const mode = %s;
  const product = (id, n, price) => ({
    id: "dev.splanc.app.credits." + id, displayName: n + " Splanc AI credits", description: "",
    displayPrice: "$" + price, price: Number(price), currencyCode: "USD",
  });
  const products = [
    product("small", "356", "4.99"), product("medium", "713", "9.99"), product("large", "1,427", "19.99"),
  ];
  const tx = {
    transactionId: "2000000000000001", originalTransactionId: "2000000000000001",
    productId: "dev.splanc.app.credits.small", jws: "fake.jws.sig",
  };
  const storeKit = {
    products: async (o) => ({ products: products.filter((p) => o.ids.includes(p.id)) }),
    purchase: () =>
      mode === "hang" ? new Promise(() => {}) :
      Promise.resolve(mode === "pending" ? { status: "pending" } : { status: "purchased", transaction: tx }),
    finish: async () => ({ finished: true }),
    unfinished: async () => ({ transactions: [] }),
    sync: async () => {},
    canMakePayments: async () => ({ allowed: true }),
    addListener: async () => ({ remove: async () => {} }),
  };
  const nope = async () => { throw new Error("not in this build"); };
  const missing = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : nope) });
  const fake = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: (n) => %s && n === "StoreKitBridge",
    registerPlugin: (n) => (n === "StoreKitBridge" && %s ? storeKit : missing),
  };
  // @capacitor/core (bundled for the native paths) rebuilds window.Capacitor
  // for the browser on load; ignore its writes so the page stays "the iOS app".
  const cap = new Proxy(fake, { set: () => true, defineProperty: () => true });
  Object.defineProperty(window, "Capacitor", { get: () => cap, set: () => {}, configurable: false });
})();
""" % (
        json.dumps(mode),
        "true" if storekit else "false",
        "true" if storekit else "false",
    )


IOS_TO_CONSENT = [
    ("click", btn("Get started")),
    ("wait_for", title("Help Apple with refund requests?")),
]
IOS_TO_PACKS = IOS_TO_CONSENT + [
    ("click", btn("Yes, share my usage")),
    ("click", btn("Continue")),
    ("wait_for", btn("Buy for $4.99")),
]
IOS_BUY = IOS_TO_PACKS + [("click", btn("Buy for $4.99"))]
IOS_READY = {"adult": True, "anon": True}

SCENARIOS += [
    Scenario(
        "ios-flow-01-consent",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(**IOS_READY),
        init_js=ios_js(),
        steps=IOS_TO_CONSENT,
        expect=title("Help Apple with refund requests?"),
    ),
    Scenario(
        "ios-flow-02-consent-chosen",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(**IOS_READY),
        init_js=ios_js(),
        steps=IOS_TO_CONSENT + [("click", btn("No, don't share"))],
        expect='.cf-choice.on:has-text("No, don\'t share")',
    ),
    Scenario(
        "ios-flow-03-packs",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(**IOS_READY),
        init_js=ios_js(),
        steps=IOS_TO_PACKS,
        expect=btn("Buy for $4.99"),
    ),
    Scenario(
        "ios-flow-04-purchasing",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(**IOS_READY),
        init_js=ios_js("hang"),
        steps=IOS_BUY + [("wait_for", title("Complete the purchase with Apple"))],
        expect=title("Complete the purchase with Apple"),
        no_controls=True,
    ),
    Scenario(
        "ios-flow-05-success",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(**IOS_READY),
        init_js=ios_js(),
        steps=IOS_BUY + [("wait_for", ".cf-balance"), ("wait", 1200)],
        expect=title("You're all set"),
    ),
    Scenario(
        "ios-flow-06-ask-to-buy",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(**IOS_READY),
        init_js=ios_js("pending"),
        steps=IOS_BUY + [("wait_for", title("Waiting for approval"))],
        expect=title("Waiting for approval"),
    ),
    Scenario(
        "ios-flow-07-paid-not-credited",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(apple_fail=True, **IOS_READY),
        init_js=ios_js(),
        steps=IOS_BUY + [("wait_for", btn("Check again"))],
        expect=title("Payment received, adding credits"),
    ),
    Scenario(
        "ios-flow-08-returning-buyer",
        "#/credits",
        seed=SIGNED_IN,
        network=fake(balance=12.5, consent=False, **IOS_READY),
        init_js=ios_js(),
        steps=[("click", btn("Get started")), ("wait_for", btn("Buy for $4.99"))],
        expect=btn("Buy for $4.99"),
    ),
    Scenario(
        "ios-flow-09-old-build",
        "#/credits",
        seed=FRESH,
        network=fake(),
        init_js=ios_js(storekit=False),
        expect=title("Update Splanc to buy credits"),
    ),
    Scenario(
        "ios-ai-tab-account",
        "#/settings/ai",
        seed=SIGNED_IN,
        network=fake(balance=412.5, consent=True, statement=STATEMENT, **IOS_READY),
        init_js=ios_js(),
        settle_ms=1200,
        expect=btn("Check for purchases"),
    ),
    Scenario(
        "ios-ai-tier-sheet",
        "#/settings/ai",
        seed=FRESH,
        network=fake(),
        init_js=ios_js(),
        steps=[("click", btn("Model setup")), ("wait", 600)],
        root=".k-sheet",
        expect=btn("Use Splanc AI credits"),
    ),
]
