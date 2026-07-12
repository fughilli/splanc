# R2 spike — self-signed WSS trust from a hosted origin

**The problem.** The ESP32 player serves WSS with a self-signed certificate
(there is no CA that issues for `esp32.local`). The webapp is hosted
externally (`//web:deploy_cloudflare` → Cloudflare Pages). Browsers never
show a certificate interstitial for a WebSocket connection: from
`https://<project>.pages.dev`, `new WebSocket("wss://esp32.local/ws")`
against an untrusted cert fails with a generic error and NO user-visible way
to approve it. Click-through trust ("Advanced → Proceed" on Chrome, "visit
website" on iOS Safari) exists only for top-level navigations.

**The design (this directory).** The player serves exactly one same-origin
page, `index.html`:

1. The user navigates to `https://<esp32-host>/` directly (the player
   advertises this URL — captive-portal style, QR sticker, or serial log).
2. Loading the page forces the one-tap certificate approval; browsers store
   the exception per (origin, certificate).
3. The page probes `wss://<its own host>/ws` (same-origin, so the stored
   exception applies) and shows the result — the approval demonstrably
   stuck before the user leaves.
4. It redirects to `%%APP_ORIGIN%%/?url=wss://<esp32-host>/ws` — the hosted
   app, told which player to talk to. The app's cross-origin WSS now reuses
   the stored exception. The redirect is UNCONDITIONAL (`location.replace`,
   so Back doesn't loop): loading the page at all means the cert was
   accepted, so a probe failure indicts the player's WS endpoint, which the
   app's own error UI is better placed to explain — the probe only decides
   how fast the redirect fires (~0.4 s verified, ~2.5 s with a warning
   flash otherwise).

The app side has the matching recovery path (`web/src/net/client.ts`
`certApprovalUrl`): when the socket target is cross-origin `wss:` and the
connection won't come up, the error UI tells the user to visit the player's
origin and approve the certificate.

`%%APP_ORIGIN%%` is baked at build time (`:baked` genrule, currently the
deployed <https://ledmapper.pages.dev>; Phase 4c can promote it to a build
setting or substitute at serve time from NVS config). The page ships as a
C array via the vendored module's `c_resource_library` —
`//firmware/landing:landing_page` exposes `landing_html[]` /
`landing_html_len`, the same shape the hardware-verified
`@embedded//apps/wifi_ap` app serves its page with. `:baked_test` pins the
substitution + the load-bearing pieces (same-origin probe, `?url=` bounce).

## What must be validated ON DEVICE (the actual spike bench work)

The container has no phone/browser; these are the documented behaviors this
design relies on, each needing a check on real Chrome-for-Android and iOS
Safari before Phase 4c is committed:

- **Exception scope**: after the interstitial click-through on
  `https://<host>`, a cross-origin `wss://<host>/ws` from the Pages origin
  connects. (Chrome stores proceed-decisions per origin+cert; iOS stores
  them persistently. Verify BOTH, and note Chrome's expiry — historically
  ~one week or until the cert changes.)
- **Private Network Access**: Chrome's PNA work restricts requests from
  public origins to private-network hosts and has been rolling toward
  enforcement. If/when it covers WebSockets, the ESP32 may need to answer a
  PNA preflight (`Access-Control-Allow-Private-Network: true`) or the
  hosted-origin flow breaks regardless of certificate trust. Check the
  Chrome version on the bench and its flags.
- **Plain `ws://` is NOT an escape hatch**: the app origin is `https:`
  (Pages forces it, and getUserMedia needs it), and mixed-content rules
  block `ws://` from secure origins. WSS stays — this half of the R2
  question is settled by platform rules.
- **Cert lifetime/rotation**: the exception is per certificate; a firmware
  that regenerates its cert (factory reset, NVS wipe) sends users back
  through the landing page. Fine — but the landing page must therefore
  always be reachable and never cached stale (serve with
  `Cache-Control: no-store`).

## Bench results so far

- **2026-07-12** — hosted-origin flow **validated end-to-end** against the
  container-hosted stand-in player (`bazelisk run //web:serve`, self-signed
  WSS): the app served from <https://ledmapper.pages.dev> connected to the
  player and drove the virtual-wall capture flow. This confirms the load
  bearing assumption: a stored certificate exception on the player's origin
  unlocks cross-origin WSS from the hosted app.
- Still to record (see below): per-browser behavior (Chrome-for-Android vs
  iOS Safari), exception lifetime across browser restarts / ~24 h, and any
  Private Network Access warnings in the console.

## Bench runbook (no ESP32 needed — the Pi stands in)

The Pi server is already a self-signed WSS player, so the trust flow can be
exercised end-to-end today:

1. Deploy the app: `bazelisk run //web:deploy_cloudflare` (see
   `web/README.md` for the token setup).
2. Start the stand-in player: `bazelisk run //web:serve` (self-signed HTTPS
   on `:8443`).
3. On the phone, open
   `https://<project>.pages.dev/?url=wss://<laptop-LAN-IP>:8443/ws` in a
   FRESH browser profile. Expected: connection fails; the app's error hint
   names `https://<laptop-LAN-IP>:8443/` as the certificate-approval stop.
4. Visit that URL, take the interstitial, confirm the page loads.
5. Return to the Pages tab (reload). Expected: the WSS connects and a
   capture works end-to-end from the hosted origin.
6. Record: browser + version, whether step 5 worked without re-approval,
   and how long the exception survives (retest after browser restart and
   after 24 h).
