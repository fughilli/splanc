# Smart-home integrations: feasibility study

Status: **study only. Nothing here is built.** Written 2026-11-20 for the
website team, who need a realistic status for the store page. All web sources
were read on 2026-11-20. Figures marked **(est.)** are our estimates, not
published numbers.

## TL;DR

- **Matter on the lamp's ESP32-C6 is not feasible on today's image.** Matter
  needs IPv6, UDP, lwIP-style sockets, its own BLE commissioning and about
  1.5 MB of flash. Our heapless netstack is IPv4 TCP only, the vendor lwIP is
  gone on purpose, and we have about 266 KB of flash headroom. Thread does not
  change this.
- **The cheap, broad route is a Matter bridge in the Splanc Agent** (the Pi
  bridge appliance, or any always-on computer running `splanc-agent`). It
  exposes every lamp as a bridged Matter light. It costs nothing on the lamp
  and covers Apple Home, Home Assistant and probably Alexa and SmartThings
  while uncertified. **Google Home will not accept an uncertified Matter
  device for normal users.**
- **Home Assistant first.** A HACS custom integration that talks our protocol
  straight to the lamps reaches the most technical early buyers for the least
  money. HA's own HomeKit Bridge and Google/Alexa connectors then cover the
  other ecosystems for HA users at no extra cost to us.
- **Prerequisite for everything:** the planned lamp **on/off state**, the
  on/off transition effects and a **pushed state report** (so a touch on the
  lid shows up in the smart home). Without these, every integration is just
  "brightness 0".
- **Never** ship HomeKit (HAP) directly on the lamp or in our bridge
  commercially without MFi. **Never** claim "Works with Google Home / Apple
  Home / Alexa" on the store page until the relevant programme says so.

## 1. What a smart home would control

Smart homes model a lamp as a *light*: on/off, brightness, optionally colour
(hue/saturation or colour temperature), and scenes. The Splanc mapping:

| Smart-home concept | Splanc today | Splanc planned | Gap |
| --- | --- | --- | --- |
| On/off | none (brightness 0 is the closest) | lamp on/off state, toggled by the capacitive touch sensor under the lid | protocol arm `SetPower` + state in replies |
| On/off transition | `crossfade_to` exists | per-lamp ON/OFF transition effects | none once planned work lands |
| Brightness | `SetBrightness` (0..1, `ledmapper.proto` arm 31) | | none |
| Scenes | keypoints (saved looks), effects library | | expose keypoints as an effect list / scene list |
| Colour | effect uniforms (effect-specific) | | needs a convention, e.g. a well-known `color` uniform, or a "solid colour" built-in effect |
| State reporting | request/reply; no push of local changes | | **push a state report when the touch sensor (or another client) changes power or brightness** |

The last row matters for every route. Matter subscriptions, HA's
`async_write_ha_state` and Google's Report State all expect the device to say
when it changed. Recommendation: add a small `PowerState` message
(`on`, `brightness`, `active_keypoint`) that the lamp sends unsolicited to each
connected session on every change. It is one protocol arm and a few hundred
bytes of RAM, and it is useful to the app as well.

## 2. Where an integration could live

| Host | Always on? | Runs today | RAM/flash budget | Notes |
| --- | --- | --- | --- | --- |
| Lamp ESP32-C6 (`firmware/player_app`) | yes | heapless netstack (IPv4 TCP, TLS/WSS server, mDNS), heapless BLE host (Improv) | free heap ~55-90 KB, about 266 KB flash left in the 2.25 MB `app` slot (after #569) | TLS handshake needs a ~17 KB contiguous block; RAM is the binding constraint (`docs/design/ram-budget.md`) |
| ESP32-P4 + C6 split (`docs/design/p4-c6-split.md`, #386) | yes | design stage; C6 keeps networking, P4 renders | P4 has far more RAM/flash | Networking deliberately stays on the C6; Matter on the P4 would need Espressif's esp-hosted, which #386 rejected as the main path |
| Pi bridge appliance (`pi/bridge`, #300/#304) | yes | `splanc-agent bridge`: the hub (one TLS session per player, pinned certs) + relay link | a full Linux box | NixOS SD image + flasher; not yet booted on a real Pi |
| Splanc Agent on the user's computer (`agent/`) | only while running | MCP server, hub, discovery (`_splanc._tcp`) | plenty | Node/TypeScript, so matter.js fits |
| Cloudflare relay (`agent/relay`, `docs/design/cloud-relay.md`) | yes | Worker + Durable Object per bridge, free tier | free-tier limits | reaches the LAN only through a bridge; no user accounts today |

## 3. Route 1: Matter over Wi-Fi on the lamp's C6

### 3.1 What Matter needs

A Matter Wi-Fi device (connectedhomeip, packaged for Espressif as esp-matter)
needs:

- **IPv6** (link-local plus SLAAC/ULA) with ICMPv6 neighbour discovery and MLD.
  Google states plainly: "IPv6 must be enabled on your home wireless network"
  [G-hub].
- **UDP** transport with Matter's own reliability layer (MRP), optionally TCP.
- **DNS-SD over mDNS** for `_matter._tcp` (operational) and `_matterc._udp`
  (commissionable) discovery, over IPv6.
- **Commissioning**: normally BLE (BTP over a GATT service) to hand over Wi-Fi
  credentials, then PASE (SPAKE2+) for the setup code and CASE (sigma, P-256
  ECDH/ECDSA) for each fabric. Every controller ("multi-admin") adds a fabric.
- **Attestation**: a per-device DAC, signed by a PAI, signed by a CSA-approved
  PAA, plus a Certification Declaration from the CSA.
- **Persistent storage** for fabrics, ACLs, session resumption and counters.

On ESP32 the CHIP platform layer is written against **lwIP** (via `esp_netif`)
and against **NimBLE or Bluedroid**.

### 3.2 Published memory numbers

Espressif's own optimisation guide (esp-idf v5.4.1, esp-matter `6a77422`, the
default `light` example) [EM-opt]:

| Metric | Default light example |
| --- | --- |
| Used D/IRAM (static) | 195,080 B |
| Used flash (app image) | 1,476,960 B |
| Free heap at boot | 35,976 B |
| Free heap after commissioning | 101,580 B (BLE released) |

The page is titled ESP32-C6 but its test setup lists an ESP32-C3. The two
pages carry identical numbers, so treat them as one build. The largest savings
it lists: chip-shell off (-66 KB flash, +10 KB heap), BLE controller in flash
(+23 KB boot heap, but +143 KB flash), FreeRTOS and heap code in flash
(+16 KB heap). Arduino-ESP32 3.x ships an official `esp_matter_light` example
for the C6 as "Arduino as an IDF component" [AR-matter], so the toolchain
exists for our Arduino-core based build. It still pulls in the full
esp-matter/lwIP/NimBLE stack.

### 3.3 Fit against our image

| Need | esp-matter brings | We have | Verdict |
| --- | --- | --- | --- |
| Flash | ~1.0-1.2 MB **(est.)** for CHIP + lwIP + NimBLE on top of the IDF base; 1.48 MB for the whole light example | ~266 KB headroom in a 2.25 MB slot on a 4 MiB part, with a 1.3 MB loader partition | **Does not fit.** Needs an 8 MB flash part or dropping the loader/OTA layout (`docs/design/ota.md`) |
| Heap | needs ~35-65 KB **(est.)** of steady heap for CHIP pools, CASE sessions, subscriptions, lwIP and mDNS | 55-90 KB free, shared with a ~28 KB TLS session per wss client | **Does not fit** alongside wss without big cuts; a Matter-only image could fit |
| IP stack | lwIP with IPv6, UDP, sockets | heapless netstack: IPv4 + our own TCP (`firmware/netstack/src/tcp.rs`); `esp_netif_init()` is deliberately skipped (`netstack_transport.cpp:1831`) | **Conflict.** Either port CHIP's Inet/System layer onto the netstack (implementing IPv6, ND, MLD, UDP and IPv6 mDNS from scratch), or run lwIP next to the netstack on one STA interface (two stacks demuxing one MAC: fragile, and it returns the ~25 KB of vendor heap we removed) |
| BLE | NimBLE/Bluedroid + CHIPoBLE | heapless BLE host for Improv (`firmware/blehost`) | Port CHIPoBLE/BTP to our host, or skip BLE with *on-network commissioning* (the lamp is already on Wi-Fi via Improv and advertises `_matterc._udp`; the spec allows it, controller support needs testing) |
| Wi-Fi credentials | Matter's Network Commissioning cluster owns them | Improv owns them | Two owners of one credential set; needs a policy (`improv-always-fresh-join` user rule) |
| Crypto | mbedTLS P-256, SPAKE2+, AES-CCM, HKDF | from-source mbedTLS (#569), already used for TLS | OK |
| Storage | NVS key/value for fabrics | NVS (credentials, name) + littlefs | OK, small |

**Effort (est.):** porting CHIP onto the netstack is 3-6 engineer-months,
followed by a long tail of interop bugs on real controllers. Running lwIP next
to the netstack is 1-2 months, plus RAM work we may not be able to finish.
Either path has to be certified on top (section 3.5).

**Verdict:** not on the current C6 image. A Matter-native lamp would have to
be a different SKU (8 MB flash and either a Matter-first image or the P4+C6
split with Matter on the P4 over esp-hosted). Revisit only if certified
"Works with Google Home" on the lamp itself becomes a sales requirement.

### 3.4 Matter over Thread on the C6

The C6 has an 802.15.4 radio, but:

- It has **one RF path** shared by Wi-Fi, BLE and 802.15.4, and "802.15.4
  receive operations have the lowest priority" [IDF-coex]. Our product needs
  Wi-Fi for effects upload, the app and the agent, so Thread would run in
  leftover airtime.
- esp-matter builds a C6 device as Wi-Fi **or** Thread, not both.
- Thread adds OpenThread (more RAM and flash) and needs a border router in the
  home (HomePod mini, Apple TV 4K, Nest Hub 2nd gen, Nest Wifi Pro).
- It removes none of the Matter costs above, and adds Thread Group
  certification.

**Verdict:** does not help. A Thread-only lamp would also lose the Splanc app
protocol. Never pursue it for the current product.

### 3.5 Certification

CSA fee schedule (read 2026-11-20 from csa-iot.org/become-member) [CSA-fees]:

| Tier | Annual dues | Certify a product | Certify own derivative | Certification Transfer Program |
| --- | --- | --- | --- | --- |
| Associate | $0 | not allowed (CTP only) | n/a | $2,500 per product + $500 per product per year |
| Adopter | $7,500 | $3,000 | $2,500 | $2,500 |
| Participant | $21,500 | $2,000 | $1,500 | $1,500 |
| Promoter | $112,500 + initiation | $2,000 | $1,500 | $1,500 |

On top of that:

- **Authorised Test Lab (ATL) testing.** Prices are quoted per project and
  not published. A community estimate puts fees plus ATL at about $19.5 k for
  one product [ND-cost]. We estimate **$8-20 k per product (est.)**, more if
  re-testing is needed. Pre-testing with the Matter Test Harness reduces the
  risk of re-tests.
- **Vendor ID**: issued with membership; Google verifies ownership of a
  production VID before you can use it in its console [G-test].
- **DAC/PAI attestation.** Each device needs a unique DAC chained to a PAI
  and a CSA-approved PAA. Providers (SSL.com, DigiCert, Kudelski, and
  Espressif's pre-provisioning service) quote by volume and publish no prices
  [SSL-dac]. Expect **~$0.10-$1.00 per device plus a PAI set-up fee in the low
  thousands (est.)**, and a factory step that injects the DAC and key into
  each lamp (flash or the C6's eFuse/HMAC-protected storage).
- **Wi-Fi Alliance / Bluetooth SIG.** A pre-certified module (ESP32-C6
  modules carry Wi-Fi and BLE listings) avoids most separate radio fees.
  Matter certification itself does not require Wi-Fi certification of the end
  product, but Google and Apple ecosystem programmes may ask for it **(est.,
  verify per programme)**.
- **The Certification Transfer Program** (rebranding an already certified
  product) only applies to an unchanged white-label product. It does not cover
  our own firmware.
- **There is no fee-free certified path.** The "certification-free" path is
  simply shipping uncertified with a test VID, see 3.6.

**Total first year for one certified product (est.):** Adopter $7.5 k +
certification $3 k + ATL $8-20 k + PAI/DAC set-up $1-5 k, so about
**$20-35 k and 3-6 months**. After that, $7.5 k a year in dues plus fees for
each recertification and each new product.

### 3.6 What works without certification

An uncertified device ships a test VID (0xFFF1-0xFFF4) and test DAC/PAI.
Controllers behave differently:

| Controller | Uncertified (test VID) device | Source |
| --- | --- | --- |
| **Apple Home** | Shows an "Uncertified Accessory" warning; **Add Anyway** proceeds. iOS 18+ can add and control Matter without a home hub; a hub (HomePod/Apple TV) is still needed for remote access and automations | [A-matter], [HM-apple], [A-forum] |
| **Google Home** | Blocked for normal users. Commissioning is only allowed for members of the developer's Google Home Developer Console project, or for listed field-trial users. "Consumer users can only use your product once it has been certified by the Alliance." A test VID "cannot be used in a consumer device." Matter also needs a Google hub (speaker, display, Nest Wifi Pro, Google TV Streamer) | [G-test], [G-create], [G-hub] |
| **Home Assistant** (Matter integration) | Works; at most a soft "uncertified" warning for lights | [ND-ha] |
| **Amazon Alexa** | Reported to accept test devices (forum claim, **unverified**) | [GH-133] |
| **SmartThings** | Not verified; test before claiming | — |

Power users can get past Google's block: anyone can make a free Developer
Console project with a Matter integration for VID 0xFFF1 and our PID, and then
commission into their own home. That is a developer workflow, so it is fine
for a support article and not something to advertise.

## 4. Route 2: a Matter bridge in the Splanc Agent

### 4.1 Shape

```text
Apple Home / HA / Alexa / (Google)  ──Matter over IPv6 on the LAN──▶  Splanc Agent bridge
                                                                       (Pi appliance or any always-on host)
                                                                         matter.js Aggregator endpoint
                                                                           ├─ bridged Extended Color Light: "Coil (bedroom)"
                                                                           ├─ bridged Extended Color Light: "Coil (hall)"
                                                                           └─ ...
                                                                         hub.ts: one pinned-TLS /ws session per player
                                                                                    │ existing app protocol
                                                                                    ▼
                                                                                 lamps (no change)
```

- **Implementation:** matter.js (`@matter/node`), the TypeScript Matter
  implementation that Matterbridge and Home Assistant Matter Hub build on
  [MJS], [MB], [HAMH]. It fits the agent's Node/TS codebase and the existing
  `hub.ts` (discovery plus one session per player).
- **Mapping:** each player becomes a bridged *Extended Color Light* (or a
  Dimmable Light if colour is not offered): OnOff → planned `SetPower` with its
  transition effect; LevelControl → `SetBrightness`; ColorControl → a colour
  uniform convention; Scenes Management → keypoints. Name and room from the
  player registry; reachability from hub liveness.
- **Commissioning:** the bridge itself commissions (on-network, via QR or
  manual code shown on the Pi's HDMI/OLED screen and in the app). No BLE is
  needed because the Pi is wired or already on Wi-Fi.
- **Lamp cost:** zero RAM and zero flash, beyond the protocol prerequisites in
  section 1.

### 4.2 Effort and cost

- Uncertified MVP: **2-4 weeks (est.)** for on/off/level/colour/scenes,
  persistence of fabrics in `$SPLANC_BRIDGE_STATE_DIR`, a pairing screen on the
  bridge display, and tests against Apple Home, HA and Alexa.
- Ongoing: matter.js and controller releases. Matter 1.x minor versions arrive
  about twice a year, so budget a few days per release.
- Running cost: none. It is all local.

### 4.3 Certification of the bridge

A bridge is certified as one product (an Aggregator). Bridged devices are not
certified individually. The cost is the same as section 3.5 (about $20-35 k in
the first year, est.). Problems:

- A software bridge running on **user-supplied hardware** (any Pi or any
  computer) is awkward to certify, because the certified product has to match
  what ships. A dedicated "Splanc Bridge" box sold by us is certifiable; a
  curl-installed agent is not.
- Every bridge needs its own DAC. For a box we sell, that is a factory step;
  for a software install it would mean issuing DACs from a cloud service,
  which is unusual and needs PAA policy review.
- Comparable open-source bridges (Matterbridge, HA Matter Hub) ship
  uncertified and rely on Apple/HA/Alexa tolerance.

### 4.4 UX

- **Good:** one pairing step covers every lamp, current and future. New lamps
  appear automatically. It works with Apple Home today (with "Add Anyway").
- **Bad:** the user must own and run an always-on bridge. Google Home users are
  shut out until the bridge is certified. If the bridge is down, every lamp
  drops out of the smart home (the Splanc app still works).
- The bridge already exists for cloud agents, so it now has two jobs. That
  strengthens the case for selling or recommending a bridge.

## 5. Route 3: Home Assistant

HA is where technical early buyers are. It also re-exports devices to Apple
Home (HomeKit Bridge), Google and Alexa (Nabu Casa cloud or manual set-up), so
one integration gives HA users every ecosystem.

### 5.1 Native integration (HACS, then core)

- **Shape:** a Python custom component `splanc`. It discovers lamps by
  zeroconf (`_splanc._tcp`, already advertised), has a config flow with
  trust-on-first-use of the per-device certificate (as `agent/src/trust.ts`
  does), keeps one wss session per lamp, and creates a `light` entity
  (on/off, brightness, `effect` list = keypoints and library effects, RGB if
  the colour convention lands) plus diagnostic sensors.
- **Protocol:** reuse `shared/protocol/python` (the generated protobuf
  package). Publish it to PyPI, because core requires the device library to
  live outside HA.
- **Session budget:** the lamp caps concurrent TLS sessions at 2, at about
  28 KB each (`ram-budget.md`), and the agent keeps "one socket per player"
  (`cloud-relay.md`). HA plus the agent uses both slots, so the phone app is
  locked out. The integration therefore needs a mode that talks to the
  bridge's hub instead of the lamp when a bridge exists. **This is the main
  design risk for direct-to-lamp.** A third session slot is not affordable on
  the C6.
- **Effort (est.):** HACS release 2-3 weeks. Core submission needs the Bronze
  tier of the quality scale (18 mandatory rules: UI config flow, tests, docs,
  a PyPI library) [HA-qs]. The core review queue typically takes weeks to
  months. HACS integrations are not graded or supported by the HA project.
- **Maintenance:** low to medium. Pin to a protocol version, and run its CI
  against HA's monthly releases.

### 5.2 MQTT discovery

- **On the lamp:** an MQTT client means a new outbound TCP client in the
  netstack, a broker address setting, MQTT framing (~10-20 KB flash, a few KB
  RAM, **est.**), plus TLS if the broker needs it (another ~28 KB session:
  not affordable alongside wss). Users must run a broker. **Not recommended.**
- **On the bridge/agent:** `mqtt.js` plus HA discovery payloads is about a
  week **(est.)**. It is generic: Node-RED, openHAB and others also speak
  MQTT. It is a good cheap add-on once the bridge has a state model, but it is
  inferior to the native integration for HA itself.

### 5.3 ESPHome-style exposure

- Flashing ESPHome replaces our firmware and loses every Splanc feature.
  **Never.**
- Emulating ESPHome's native API on the lamp (protobuf over TCP 6053 with a
  Noise PSK, advertised as `_esphomelib._tcp`) would let HA auto-discover the
  lamp with no custom component. RAM is small (a few KB, est.), but it is a
  private protocol that changes with ESPHome releases, needs a second TCP
  listener, and presents the lamp to HA as an ESPHome device. **Defer:**
  interesting, but a support trap.

## 6. Route 4: HomeKit / Apple Home

| Path | Feasible? | Commercial OK? | Notes |
| --- | --- | --- | --- |
| Via Matter (bridge, section 4) | yes | yes while uncertified ("Add Anyway"); fully once certified | **The recommended Apple path.** iOS 18+ works without a hub; a hub is needed for remote control and automations [A-matter] |
| HAP directly on the lamp | technically (HomeSpan / esp32-homekit implement HAP-R2) | **no.** The public HAP spec is licensed for non-commercial use only; devices "distributed or sold" need MFi [HAP-nc] | Also another TLS-like session (SRP + ChaCha) and RAM. **Never** |
| HAP in our bridge (HAP-NodeJS) | yes | **no** for a commercial product, same licence issue [HAP-nc] | Matter gives the same reach legally. **Never ship it**; users may run Homebridge themselves |
| HA HomeKit Bridge | yes, zero work once section 5.1 exists | user-run, so not our product claim | Good to document for HA users |

## 7. Route 5: Google Home / Alexa cloud-to-cloud

- **How:** each platform calls our cloud. Google sends SYNC, QUERY and EXECUTE
  intents and expects Report State; Alexa sends Smart Home directives. Our
  cloud forwards them through the relay to the user's bridge, then to the
  lamps.
- **Needs:**
  - an **OAuth 2.0 authorisation-code server** and user accounts. Google
    requires account linking for all users and support for several Google
    users per account [G-al]. We have no accounts today: the relay pairs
    bridges by token, with no account and no hosting bill.
  - a fulfilment endpoint. A Worker route is fine for Google. Alexa Smart Home
    skills are normally fulfilled by an AWS Lambda (free tier likely
    sufficient, est.).
  - always a bridge, because the cloud cannot reach the lamp without one.
- **Certification:** Google: a Test Suite run, an integration test with a test
  account we supply, and a policy review. A rejected integration cannot be
  resubmitted as-is [G-cert]. No fee is published. Alexa: skill certification
  (~5 days); "Works with Alexa" badging adds lab testing negotiated with an
  authorised lab [WWA].
- **Effort (est.):** OAuth/accounts 2-3 weeks (new security surface), Google
  fulfilment 2-3 weeks, Alexa 2-3 weeks, plus review cycles.
- **Ongoing cost:** within Cloudflare free-tier limits at small scale
  (100 k Worker requests/day), but it adds a cloud dependency, accounts and
  personal data, and with them privacy-policy and account-deletion duties.
- **Why it matters:** it is the **only route into Google Home for normal users
  without paying the CSA**, because Google's C2C certification has no
  published fee while uncertified Matter is blocked.
- **Risks:** cloud latency on a local device, security of a remote-control
  path into homes, and platform churn (Google is steering partners toward
  Matter).

## 8. Route 6: other options

- **SmartThings:** supports Matter (the bridge route probably works; test it)
  and community *Edge drivers* (Lua, local LAN). A community driver is
  possible, but SmartThings is low priority.
- **IFTTT:** publishing a service needs a paid IFTTT business plan, and it
  only reaches the cloud. Skip it.
- **Documented local API:** the cheapest win for tinkerers. Document the app
  protocol (`shared/protocol`, the Python package) and the agent's MCP tools,
  and optionally add a tiny local REST/JSON endpoint on the bridge (`/lamps`,
  `/lamps/:id/power`). Node-RED, openHAB, Hubitat and scripts can then
  integrate themselves. **About 1 week (est.).**
- **The AI assistant path already exists:** the Splanc MCP connector lets
  Claude and other agents control lamps today. It is a real, shippable claim.

## 9. Comparison

| Route | Platforms covered | Needs a hub? | Lamp RAM / flash cost | Effort (est.) | Certification cost / time | UX | Main risks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Matter on the C6 (Wi-Fi)** | Apple, Google*, Alexa, SmartThings, HA (*Google only if certified) | the ecosystem's own hub (Google always; Apple for remote) | **~35-65 KB heap, ~1.0-1.2 MB flash (est.); does not fit** | 3-6 engineer-months (netstack port) | ~$20-35 k first year, 3-6 months; per-device DAC | best: lamp pairs directly, no Splanc box | does not fit today; IPv6/lwIP rework; two Wi-Fi credential owners; certification money |
| A'. Matter over Thread on the C6 | same | Thread border router | worse than A | more than A | A + Thread Group | worse: Wi-Fi features suffer | single RF path; loses the app protocol |
| **B. Matter bridge in the agent** (uncertified) | Apple ("Add Anyway"), HA, Alexa (unverified), SmartThings (untested); **not Google** for consumers | **yes: Splanc bridge** (Pi or always-on PC) + ecosystem hub | **0** (plus section 1 prerequisites) | 2-4 weeks | $0 | one pairing for all lamps | needs a bridge; uncertified warnings; Google gap |
| B+. Matter bridge, certified | + Google | yes: a bridge box we sell | 0 | B + 1-2 months | ~$20-35 k first year, 3-6 months; a DAC per bridge | as B, no warnings | needs a hardware bridge SKU; fixed software stack |
| **C1. HA native integration** | HA, and through HA: Apple (HomeKit Bridge), Google/Alexa (Nabu Casa) | HA server | 0 (prereqs) | 2-3 weeks to HACS; core +1-3 months review | $0 | great for HA users | the lamp's 2-session TLS cap; HA release churn |
| C2. MQTT on the lamp | HA, Node-RED, openHAB | MQTT broker | ~10-20 KB flash, a few KB RAM; TLS not affordable | 3-4 weeks | $0 | fiddly | RAM; plaintext MQTT on the LAN |
| C2'. MQTT on the bridge | same | broker + bridge | 0 | ~1 week | $0 | fiddly | low |
| C3. ESPHome API emulation | HA | HA server | a few KB RAM, ~15-30 KB flash (est.) | 3-5 weeks | $0 | auto-discovered in HA | private protocol churn; support trap |
| D1. HAP on the lamp or bridge | Apple | none | lamp: large | 4-8 weeks | **MFi required to sell** | good | licence: not allowed commercially |
| D2. HA HomeKit Bridge | Apple (via HA) | HA | 0 | 0 (after C1) | $0 | OK | user-run |
| **E. Google/Alexa cloud-to-cloud** | Google, Alexa (consumers) | bridge + our cloud | 0 | 6-9 weeks for both + reviews | no published fees; Google/Alexa review time | voice works; set-up via account linking | accounts and OAuth; cloud security; platform churn |
| F. Local REST/MQTT API docs | Node-RED, openHAB, Hubitat, scripts | bridge | 0 | ~1 week | $0 | for tinkerers | low |

## 10. Recommended phased approach

**Phase 0: prerequisites (in the planned lamp work).** Lamp on/off state, the
touch toggle, ON/OFF transition effects, a `SetPower` arm and an unsolicited
`PowerState` report, and a colour convention (a well-known `color` uniform or
a built-in solid-colour effect). Every route needs these. Owner decision D1.

**Phase 1: most users, least cost (about 1-1.5 months total, est.).**
1. **Home Assistant custom integration (HACS)**, talking to the lamp directly,
   with an option to go through the bridge hub when the agent holds the
   session. Document HA's HomeKit Bridge and Google/Alexa exposure.
2. **Uncertified Matter bridge in the agent/Pi bridge** (matter.js). It
   reaches Apple Home and HA natively, and Alexa/SmartThings after testing.
3. **Local API docs** for the protocol and bridge (Node-RED etc.).

**Phase 2: decide on Google, driven by demand.** Choose between:
(a) Google + Alexa **cloud-to-cloud** through the relay (no CSA fees, but
accounts and a cloud path), or (b) **CSA Adopter membership and a certified
Splanc Bridge box** (~$20-35 k, est.). Measure demand first: store-page
interest and HA/Matter usage. Owner decisions D3/D4.

**Phase 3 (deferred): HA core submission** once the integration is stable and
the protocol is versioned. Also deferred: MQTT on the bridge and ESPHome
emulation.

**Defer indefinitely:** Matter on the C6 (revisit only for a new 8 MB / P4+C6
SKU with a Matter requirement); IFTTT.

**Never:** HAP/HomeKit directly on the lamp or in our bridge for sale without
MFi; Matter over Thread on the current lamp; flashing ESPHome; an MQTT client
with TLS on the C6; a second TLS session slot on the C6 for integrations.

## 11. What the store page can honestly say today

Today, **no third-party smart-home platform is supported.** Suggested copy:

> **Control:** the free Splanc app (Bluetooth and Wi-Fi, on your phone or in
> the browser), and AI assistants such as Claude through the Splanc connector.
>
> **Smart-home platforms:** Home Assistant and Matter (Apple Home and others
> through the Splanc Bridge) are on our roadmap. We'll update this page when
> they ship. Splanc lamps are **not** Matter-certified and do not currently
> work with Google Home, Apple Home or Alexa.

Do not use "Works with …" badges or ecosystem logos. Those need each
programme's approval, and the CSA logo needs certification. Once Phase 1
ships, the page can say "Home Assistant integration (community install via
HACS)" and "Apple Home via the Splanc Bridge (Matter, uncertified: iOS shows
an 'Uncertified Accessory' prompt)". "Google Home" can appear only after
Phase 2.

## 12. Owner decisions

Each decision is separate. **(rec.)** marks the recommendation.

**D1. Lamp power-state protocol (prerequisite).**
- (a) **(rec.)** Add `SetPower` + an unsolicited `PowerState` report as part of
  the planned touch/on-off work, designed with smart-home mapping in mind.
- (b) Model "off" as brightness 0 and add the state later.
- (c) Postpone all smart-home work until the touch feature ships.

**D2. First integration to build.**
- (a) **(rec.)** HA custom integration (HACS) first, then the uncertified
  Matter bridge.
- (b) Uncertified Matter bridge first (it covers Apple Home and HA in one go,
  but needs a bridge).
- (c) Both in parallel.
- (d) Neither for now.

**D3. Google Home strategy.**
- (a) **(rec.)** Defer. Decide after Phase 1 shows demand.
- (b) Cloud-to-cloud (Google + Alexa) through the relay, accepting user
  accounts and OAuth.
- (c) CSA membership + a certified bridge (see D4).
- (d) Never support Google directly; point users at HA's Google exposure.

**D4. CSA membership / Matter certification spend (~$20-35 k first year, est.).**
- (a) **(rec.)** Not now. Revisit when a hardware bridge SKU exists or Google
  demand is proven.
- (b) Join as Adopter ($7,500/yr) now and certify a Splanc Bridge box.
- (c) Join and certify a Matter-native lamp (needs a new SKU, see D5).

**D5. Matter on the lamp itself.**
- (a) **(rec.)** No for the current C6/4 MB lamp. Record it as a requirement
  to evaluate for the P4+C6 / 8 MB hardware generation.
- (b) Start a netstack IPv6/UDP + CHIP port spike now (3-6 engineer-months,
  est.).
- (c) Build a separate Matter-only firmware image (esp-matter, without the
  Splanc protocol) as an option users can flash.

**D6. Selling a Splanc Bridge box.**
- (a) **(rec.)** Keep the bridge as software on the user's Pi for now; position
  it as "recommended for smart-home and AI features".
- (b) Sell a pre-imaged Pi bridge (prerequisite for a certified bridge).
- (c) Fold bridge duties into a future P4-class lamp so it needs no separate
  box.

**D7. Store-page wording.**
- (a) **(rec.)** Publish the section 11 copy now: no claims, roadmap mention
  only.
- (b) Say nothing about smart homes until Phase 1 ships.
- (c) Mention HA/Matter as "coming soon" with a target quarter.

**D8. HomeKit via HAP.**
- (a) **(rec.)** Never ship HAP. Use Matter for Apple Home and document HA's
  HomeKit Bridge and Homebridge for users who want it.
- (b) Apply to MFi for a HAP product.

## Sources (all read 2026-11-20)

- [CSA-fees] Connectivity Standards Alliance, *Become a member* (tiers and
  per-product fees): https://csa-iot.org/become-member/ ; Adopter one-pager
  2025: https://csa-iot.org/wp-content/uploads/2025/02/Adopter-Membership_One-Pager_2025.pdf ;
  Certification Transfer Program: https://csa-iot.org/certification/transfer-program/
- [ND-cost] Nordic DevZone, community certification cost estimate (unofficial):
  https://devzone.nordicsemi.com/f/nordic-q-a/117885/zigbee-vs-matter-thread-certification-cost-with-nrf-modules-and-stack/517842
- [EM-opt] Espressif, esp-matter *Configuration options to optimize RAM and
  Flash* (ESP32-C6 page): https://docs.espressif.com/projects/esp-matter/en/latest/esp32c6/optimizations.html
- [AR-matter] Espressif component registry, arduino-esp32 `esp_matter_light`
  example (v3.3.x):
  https://components.espressif.com/components/espressif/arduino-esp32/versions/3.3.3/examples/esp_matter_light
- [IDF-coex] ESP-IDF, ESP32-C6 *RF Coexistence*:
  https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c6/api-guides/coexist.html
- [SSL-dac] SSL.com Matter DAC/PAI (pricing by quote):
  https://ssl.com/products/device-machine-trust/matter/dac/ ; Espressif Matter
  services: https://docs.espressif.com/projects/esp-matter/en/latest/esp32h2/espressif_services.html ;
  Matter handbook, attestation: https://handbook.buildwithmatter.com/how-it-works/attestation/
- [G-create] Google Home Developers, *Create a Matter integration* (test VIDs
  0xFFF1-0xFFF4): https://developers.home.google.com/matter/integration/create
- [G-test] Google Home Developers, *Test a Matter integration* / *Field
  trial*: https://developers.home.google.com/matter/test ,
  https://developers.home.google.com/matter/field-trial/run
- [G-hub] Google Nest Help, Matter hub requirements and IPv6:
  https://support.google.com/googlenest/answer/12391458
- [G-al] Google Home Developers, cloud-to-cloud *Account linking*:
  https://developers.home.google.com/cloud-to-cloud/primer/account-linking
- [G-cert] Google Home Developers, cloud-to-cloud *Prepare to submit for
  certification*: https://developers.home.google.com/cloud-to-cloud/certification/submit
- [A-matter] Apple Support, *Pair and manage your Matter accessories*:
  https://support.apple.com/en-us/HT213441
- [HM-apple] Homey support (the "Add Anyway" uncertified-accessory flow):
  https://support.homey.app/hc/en-us/articles/26204255659676-How-to-control-your-devices-in-Apple-Home-with-the-Matter-Bridge-app
- [A-forum] Apple Developer Forums, uncertified accessory threads:
  https://developer.apple.com/forums/thread/844646 ,
  https://developer.apple.com/forums/thread/844870
- [GH-133] google-home/sample-apps-for-matter-android issue 133 (test-VID
  behaviour across controllers; forum claims):
  https://github.com/google-home/sample-apps-for-matter-android/issues/133
- [ND-ha] Nordic DevZone, HA Matter commissioning with test credentials:
  https://devzone.nordicsemi.com/f/nordic-q-a/124268/
- [WWA] Amazon, *Works with Alexa* programme and skill requirements:
  https://developer.amazon.com/alexa/smart-home/launch/works-with-alexa ,
  https://developer.amazon.com/en-US/docs/alexa/smarthome/wwa-skill-requirements.html
- [HAP-nc] CNX Software, *Apple opens HAP specification to non-commercial
  projects* (2017): https://cnx-software.com/2017/06/09/apple-opens-homekit-accessory-protocol-specification-to-non-commercial-projects/ ;
  HomeSpan: https://github.com/HomeSpan/HomeSpan ; HAP-NodeJS:
  https://github.com/homebridge/HAP-NodeJS
- [MJS] matter.js: https://github.com/project-chip/matter.js ;
  [MB] Matterbridge: https://matterbridge.io/README.html ;
  [HAMH] Home Assistant Matter Hub: https://t0bst4r.github.io/home-assistant-matter-hub/readme
- [HA-qs] Home Assistant developer docs, *Integration quality scale*:
  https://developers.home-assistant.io/docs/core/integration-quality-scale/

Repo context: `docs/design/ram-budget.md`, `docs/design/cloud-relay.md`,
`docs/design/p4-c6-split.md`, `docs/design/ota.md`, `firmware/netstack/DESIGN.md`,
`firmware/loader/partitions_ota.csv`, `firmware/player_app/netstack_transport.cpp`,
`shared/protocol/proto/ledmapper.proto`, `shared/protocol/python`,
`agent/src/hub.ts`, `agent/src/discovery.ts`, `pi/bridge/`.
