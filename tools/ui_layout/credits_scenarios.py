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
            if u.hostname != RELAY_HOST:
                return False
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=CORS) or True
            body = json.loads(request.post_data) if request.post_data else {}
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
                "packs": PACKS,
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
        if key == "POST /billing/checkout":
            self.return_url = body.get("return_url", "")
            return 200, {"url": "https://checkout.stripe.com/c/pay/cs_test_fake"}
        return 404, {"error": "not_found", "message": key}


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
    Scenario(
        "flow-20-unavailable",
        "#/credits",
        seed={},
        network=fake(),
        expect=title("aren't available here"),
    ),
]
