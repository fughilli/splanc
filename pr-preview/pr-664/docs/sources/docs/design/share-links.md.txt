# Design: share links (admin access now, effects and the marketplace later)

Status: first cut built (2026-11-24, `agent/share-admin-access`). Code:
`web/src/net/shareLink.ts` (format), `web/src/store/shareAccess.ts` (what a link carries and
what opening one changes), `web/src/ui/screens/shareSheet.ts` (sender),
`web/src/ui/screens/shareScreen.ts` (receiver, route `#/share`).

## Why

Handing a lamp or a mesh to someone else (a partner, a housemate, a venue's tech) meant
copying the mesh backup text (D-442) and pasting it into the other phone's Mesh section, and
there was no way at all to hand over one fixture. The owner asked for a share button that goes
through the system share sheet, in a format that Splanc opens directly.

## The link

```
https://splanc.io/app/#/share?s=1.<sealed>&k=<key>     opens by itself
https://splanc.io/app/#/share?s=1.<sealed>&c=<salt>    needs a 10-character code
```

- **Everything is after `#`.** A browser never sends the fragment to a server, so splanc.io,
  Cloudflare and any CDN log see only `/app/`. The messaging app that carries the link sees
  all of it. That is why there is a code option.
- **`sealed`** is AES-GCM-128 over a JSON envelope `{v, kind, at, title?, body}`. With `k`,
  the key is random and travels in the link. With `c`, the key is PBKDF2-SHA256 (310 000
  rounds) of a 10-symbol Crockford base32 code (50 bits) shown to the sender, who sends it
  some other way (says it out loud, or uses a different app). The receiver can type the code
  in any case, with or without the dash and with O/0 and I/L mixed up.
- **`kind`** is what `body` is. Today: `mesh` and `fixture`. The version in `s=1.` and `v`
  lets an old app say "update Splanc to open this" instead of "damaged".
- **Base URL:** `https://splanc.io/app/` from the native app. A web build served over https
  (a PR preview or the dev server) points at itself, so links can be tested before release.
- Size: a mesh with 2 fixtures is about 800 characters. That fits in Messages, WhatsApp,
  Signal and mail. It is too long to put in a QR code comfortably (see Follow-ups).

## What each kind carries

| Kind | Body | The receiver can |
| --- | --- | --- |
| `mesh` | The mesh backup body (`meshStore.exportBody`): admin secret, site secret, key epoch, revocations, roster, and **now the provisioner tokens by node** | Do everything the sender can: add, remove, block, control, and share further |
| `fixture` | Name, `wss://` address, MAC, certificate pin and, if the sender put it in a mesh, its mesh id, node and provisioner token (D-324) | Find, connect to and control the fixture; take it out of its mesh ("Take it out of this mesh" in the Mesh section); then add it to a mesh of their own. Nothing mesh-wide |

Opening a link:

- It strips the secret out of the address bar immediately (`history.replaceState` to bare
  `#/share`), so the secret is never left in history or restored with the tab.
- It shows what the link holds (the mesh name and fixtures, or the fixture and its mesh) and
  adds nothing until the person taps **Add**.
- **Mesh:** it replaces this phone's copy of the same mesh and keeps any tokens this phone
  already held. It **refuses a link older than the copy on this phone** (a lower key epoch).
  Otherwise a stale link would roll back the site secret after a "Block it for good".
- **Fixture:** it saves the device. The certificate pin is taken only if this phone has none
  for that MAC; a different pin is never replaced, and the preview says so. Trust on first
  use is passed along, not overridden. The token goes into the mesh's record if this phone
  holds that mesh; otherwise it is kept beside it (`token:<mesh>:<node>`, sealed like the
  rest) and merged in if the mesh is shared later.
- The old backup text (`splanc-mesh-1:`) still imports, and it now carries the tokens too.
  The field is optional, so older apps ignore it.

Entry points: **Share admin access** in the Mesh section (on phones that administer the mesh),
and **Share** in a device's ⋮ grid (not offered for Bluetooth-only devices, whose address
means nothing on another phone).

## Security, plainly

- **A link can't be taken back.** The mesh admin key is one secret. Whoever has it is an
  admin until the mesh is re-created, and a key rotation ("Block it for good") changes the
  site secret, not the admin key. The sheet says "send it only to someone you'd give your
  own phone to".
- **Link-only mode** puts the admin key in the messaging app's history and its cloud backups.
  **Code mode** means the link alone opens nothing; offline brute force of the code costs
  2^50 × 310 000 PBKDF2 rounds, which is out of reach.
- **Nothing passes through Splanc's servers**, and there is no account. That is good for
  privacy, but there is no revocation list and no expiry: an expiry written into an offline
  link can't be enforced against someone who keeps the bytes.

## Decisions for the owner

1. **Default mode. Decided (2026-11-24): code on by default for `mesh` links**, which grant
   everything; the sender can turn it off. `fixture` links open by themselves unless the
   sender turns the code on.
2. **Delegated admins instead of copying the key** (needs firmware). Decided (2026-11-24):
   built; see "Revocable access" below. The owner's admin key
   signs a sub-admin certificate `{pubkey, rights, not_after}`, and members accept grants from
   it until `not_after` or until a revocation order names it. The link then carries the
   receiver's *own* key (or the receiver sends back its public key) instead of the owner's
   secret, so it can expire and be revoked. That is the only way to get "share for the
   weekend". Recommendation: yes, as mesh M9, after the bench PRs land.
3. **Opening the native app. Decided (2026-11-24): yes.** splanc.io serves
   `/.well-known/apple-app-site-association` naming `D9JWD94AGX.dev.splanc.app` for
   `/app/` with fragment `/share?*` only (Studio-Fug/splanc.io#15), so other `/app` links
   still open the web app. The app gets `applinks:splanc.io` from `web/ios-config/apply.sh`
   behind `SPLANC_IOS_ASSOCIATED_DOMAINS=1`: like Sign in with Apple, the distribution
   profile must include Associated Domains first, or a signed build fails. `@capacitor/app`
   reports the opened link (`web/src/net/appLinks.ts`), and the app applies its fragment
   as the route. Android needs `assetlinks.json` plus an intent filter once there is an
   Android build; the installed PWA on Android already takes links in its scope.

## Revocable access

Built (owner decision 2026-11-24): firmware #655, app on `agent/share-revocable`.

**Sharing.** "Share admin access" now asks what kind of access to give:

- **Access you can take back** (the default). The sender says who it's for and for how
  long: 1 day, 1 week, 30 days (the default) or until revoked. The owner's app makes a
  fresh delegate key, and its admin key signs a certificate (`Delegation`, 138 B:
  `"SMdeleg1" ‖ mesh ‖ delegate key ‖ not_after`, mesh seconds, 0 = until revoked). The
  link carries the delegate's secret, the certificate, the owner's admin public key, the
  site secret and the roster. It carries no provisioner tokens. The person is listed under
  "People with access" only once the link is actually shared or copied.
- **Full admin**: the admin secret itself, as before. It can't be taken back.

**On the delegate's phone** the mesh has role `delegate`. Its app signs grants with the
delegate key; a grant names the delegate (`T_GRANT_D`) and never outlives the certificate,
which `MeshUnlock.delegation` carries. The delegate can add, remove and control fixtures.
It can't block fixtures (rotation orders need the admin key), back the mesh up or share it
on. A delegate link can't replace a phone's full admin copy of the same mesh, and a
certificate that doesn't verify under the stated owner key is refused.

**Firmware.** Members verify the certificate once, on the low-priority crypto task. It
travels on its own, ahead of the grant: the two together don't fit a 192 B packet. A member
missing it asks with the existing `Request`. Refused: a grant that outlives its
certificate, an expired certificate, a delegate on the revocation list, and a delegate
renewing the admin's session. The gateway checks both signatures at unlock.

**Revoking.** "Revoke" under People with access is the owner's key rotation with the
delegate's key hash on the revocation list, the same order "Block it for good" sends. On
every fixture, `Stack::install` drops the delegate's certificate and sessions; its gateway
drops the gateway session and every connection holding it, the detached slot too. The
rotation also changes the site secret, so the revoked person can't provision new fixtures.
Fixtures that are off at the time miss the new keys and need adding again, as with a
block.

**Limits.**

- Revoked delegates share the 8-entry revocation list with blocked fixtures. When a rotation
  starts a fresh list (D-443), the app carries along every revoked delegate that could
  still sign (`keepRevoked`), or it would work again. An order carries at most 4 hashes,
  so a delegate that never expires holds a slot for good. That's why 30 days is the default.
- Expiry is in mesh time, so setting one needs a connected fixture.

## The wider social feature set

The envelope is meant to carry more than admin access, so the same share button and `#/share`
screen grow with it:

- `effect`: an effect's source, uniforms and preview tags, opened into the library
  (search/deploy as today). Free effects can travel entirely in the link (a typical effect is
  2–6 KB compressed, which is too long for some chat apps). Past a size limit, the link
  carries a content hash and the body is fetched from the store.
- `map` / `scene`: a fixture map or a saved scene with its uniforms.
- **Marketplace listing** (the owner's FX-marketplace item: effects sold for credits with
  price scaling). A paid effect can't travel in a link. The link carries a `listing` id,
  opens the listing in the credits flow (#/credits), and the server releases the effect after
  purchase. Sharing a listing is the social loop that sells it; a referral credit could ride
  on the same link.
- Not built: a contacts list, follows, profiles. All of those need accounts, which Splanc
  avoids today except for credits (email sign-in). The listing id can be linked to a credits
  account later without changing the link format.

I couldn't find the marketplace ticket in Linear (searched "marketplace", "FX credits", "sell
effects"), so this section isn't linked to it yet.

## Follow-ups

- QR code for a fixture link (sharing in person): needs a shorter body. Drop the address and
  MAC, and let the receiver find the fixture by its pin through discovery.
- The decisions above.
- HITL: open a mesh link on a second phone and administer the bench mesh from it, then share
  one fixture to a third phone and take it out of the mesh with only that token.
