# Matter certification of the Splanc Bridge

Status: **preparation.** Written 2026-11-20 for owner decisions D-187 and D-188. D-187: build a
certified bridge, submit it for approval and ask for a fee exception; D-188: don't spend
$20-35 k on certification now. This page lists what a certified bridge needs, how far the
uncertified bridge (`agent/src/bridge/matter.ts`, docs/guides/matter.md) is from it, and the
cost and time. The fee-waiver request to the CSA is drafted separately; the owner sends it.
Figures marked **(est.)** are our estimates. Fee figures come from the study
(`docs/design/smart-home-integrations.md` §3.5, read 2026-11-20).

## Why certify at all

One reason only: **Google Home.** Google lets consumer accounts commission certified Matter
devices only. A test vendor ID "cannot be used in a consumer device" (study §3.6). Apple Home,
Home Assistant and (reportedly) Alexa already take the uncertified bridge: Apple warns first,
then offers "Add Anyway". Certification also removes Apple's warning, and lets the store page
use the Matter logo.

## What gets certified

The product is the **Splanc Bridge** box: a Raspberry Pi 3 A+ with the Waveshare 1.3" OLED HAT,
running the Splanc bridge SD image. It is certified as a Matter **Bridge**: an Aggregator
endpoint plus bridged device types (Dimmable Light today, Extended Color Light once colour
exists).

- Bridged lamps are **not** certified one by one. The bridge carries the certification, and
  bridged endpoints are tested as part of it.
- The certified product must match what ships. Do-it-yourself bridges (any Pi, `npx
  splanc-agent bridge`) stay uncertified and keep the test VID. They are "the same software",
  but not a certified product, and they can't carry a production DAC (below).
- matter.js is **not** a CSA "certified software component" or a Matter Compliant Platform, as
  far as we know. The CHIP SDK-based stacks from silicon vendors are. So the whole Matter stack is
  tested at the lab, not only our application layer. matter.js targets the official test
  harness, and Matterbridge and Home Assistant Matter Hub ship on it. We found no certified
  product built on matter.js (**verify with the lab before quoting**).
- Precedent for open source: in March 2025 the CSA certified Home Assistant (a User Interface
  Component) and the Open Home Foundation Matter Server (a software component) through the
  test lab Resillion. The project's own write-up says certification "would be very difficult"
  for other open-source projects without comparable funding [HA-cert].

## Requirements and the gap list

| Requirement | What it is | Where we are | Gap |
| --- | --- | --- | --- |
| **CSA membership** | Adopter ($7,500 / year) is the cheapest tier that can certify. Associate (free) can only rebrand an already certified product (Certification Transfer Program), which doesn't fit our own firmware. | None | Join (or get the fee waived: the waiver request). |
| **Vendor ID (VID)** | Issued with membership. Each device reports it in BasicInformation, and it is encoded in the QR code. Google checks that the developer owns it. | Test VID `0xFFF1`, product ID `0x8001` (`TEST_VENDOR_ID` / `TEST_PRODUCT_ID` in matter.ts) | A production VID; then a PID for the bridge. Both are constants in one file plus the DCL entries. |
| **Device attestation: PAA → PAI → DAC** | Every unit carries a unique Device Attestation Certificate and private key. The DAC is signed by a Product Attestation Intermediate, which chains to a CSA-approved PAA. Controllers check the chain against the DCL. | matter.js's built-in **test** DAC/PAI (chained to the test PAA). Every bridge presents the same test identity. | Buy a PAI from a PAA operator (DigiCert, SSL.com, Kudelski, ...); set-up in the low thousands plus about $0.10-1 per DAC (est.). Add a **factory step** that writes a per-unit DAC + key onto each box (below). Load them in matter.ts instead of the test credentials. |
| **Certification Declaration (CD)** | A CSA-signed statement that the VID/PID is certified, included in attestation. Issued by the CSA on certification. | matter.js's test CD | Comes with certification. Must be built into the image. |
| **DCL entries** | The Distributed Compliance Ledger holds the vendor, the model (VID/PID), each software version, and the compliance record. Controllers query it. | None | Add the vendor + model entries at certification. Add a ModelVersion entry for each software version that ships (see "Software updates"). |
| **Authorised Test Lab (ATL)** | A lab runs the Matter Test Harness cases for the device types and features declared in the PICS (Protocol Implementation Conformance Statement). | Pre-test only: in-container interop with the CHIP SDK's Python controller (`chip-core`) and matter.js's controller | Write the PICS. Run the official test harness ourselves first: it is free and catches the easy failures. Then book a lab. |
| **Commissioning** | On-network commissioning with QR + manual code; a unique random passcode + discriminator per unit; no forbidden passcodes. The code must be printed on the product (a label), not only shown on a screen. | Random per-install passcode + discriminator, persisted; QR + manual code on the OLED/HDMI. | A **printed QR label** on each box and its packaging, generated at the factory from the unit's passcode. The passcode must then be fixed at the factory (today it is made on first boot). |
| **Factory reset** | Clears every fabric and the Matter state. | `splanc-bridge matter-reset` (SSH) and the control socket | A button path on the box: for example a long press on the HAT joystick, with a confirm screen. |
| **Security** | No debug ports open, signed updates, protected keys. | SSH only when the user puts a key on the card; agent updates sha256-checked against splanc.io; system OTA unsigned (`file://` channel) | Sign the system OTA. Put the DAC key in a file readable only by the bridge user (a Pi has no secure element). Document the threat model for the lab. |
| **Software updates** | Each shipped software version is listed on the DCL. Matter's OTA Requestor is optional; an out-of-band updater is allowed, but the reported `softwareVersion` must match the DCL. | Daily self-update of the agent bundle; `softwareVersion` is fixed at 1 | Pin the certified box to a release channel. Map `softwareVersion` to the agent release. Add a DCL ModelVersion step to the release workflow. Ask the lab which changes need recertification. |
| **Interop evidence** | Not formally required, but the lab and Google expect it to work with the big controllers. | CHIP SDK controller (in container), matter.js controller (CI) | Test with Apple Home, Google Home (via a developer project), Alexa, SmartThings and Home Assistant on real hardware. |
| **Wi-Fi / Bluetooth** | The Pi 3 A+ radio module has its own approvals. Matter doesn't require Wi-Fi certification of the end product (programmes may; study §3.5). | | Confirm with the lab; probably nothing to do. |
| **Google Home** | A production VID verified in the Google Home Developer Console, a Matter integration there, and passing Google's own checks. A "Works with Google Home" badge is a separate programme. | None | After CSA certification: register the integration, run Google's test suite, submit. |

## Code changes still needed in the bridge

These are small and can be done before any money is spent. They need no decision beyond D-188:

1. Load attestation from files when they are present (`<state>/matter/attestation/{dac.der,
   dac.key, pai.der, cd.der}`). Fall back to the test credentials otherwise, so DIY bridges keep
   working. The VID/PID then come from the same place.
2. A factory mode: a fixed passcode/discriminator from the factory file instead of a random one,
   so it matches the printed label.
3. `softwareVersion` derived from the agent release (an integer that increases with each
   release), and `softwareVersionString` set to the release name. Today these are 1 and the
   version string.
4. A factory-reset button path on the HAT.
5. A PICS file and a pre-test run of the official Matter Test Harness in CI.

## Cost and time

| Item | Cost | Notes |
| --- | --- | --- |
| CSA Adopter membership | $7,500 / year | Waiver or reduction requested |
| Product certification fee | $3,000 per product (Adopter) | $2,500 for a derivative |
| Authorised test lab | **$8-20 k (est.)** | Quoted per project. More if re-tests are needed. Pre-testing reduces that risk. |
| PAI set-up + DACs | **$1-5 k set-up + $0.10-1 per unit (est.)** | Quoted by volume |
| Engineering | **3-5 weeks (est.)** | Code changes 1-5 above, factory provisioning, test harness pre-runs, lab support |
| **First year** | **about $20-35 k (est.)** | Unchanged from the study. With dues and fees waived, the lab and PAI remain: **about $10-25 k (est.)** |
| Following years | $7,500 / year + recertification fees | Dues and per-release DCL / recertification |

**Time:** 3-6 months from joining to a certified product (study §3.5): about 1 month of
engineering and pre-testing, 1-2 months of lab scheduling and testing, then CSA review and the
DCL. Google's review comes after that.

## Recommended order

1. **Now, free:** make the code changes 1-5. Keep shipping uncertified (Apple "Add Anyway", HA,
   Alexa). Send the fee-waiver request.
2. **When the CSA answers:**
   - If dues are waived or reduced, join, get the VID, buy the PAI, write the PICS and book a
     lab.
   - If not, stay uncertified until Google demand justifies the spend (D-188). Point Google users
     to Home Assistant's Google Assistant link (docs/guides/matter.md).
3. **After CSA certification:** register the Google Home integration, then update the store
   page (D-191 copy: claim Google Home only after this step).

## Sources

- Study: `docs/design/smart-home-integrations.md` §3.5, §3.6, §4.3 (CSA fee schedule, Google's
  test-VID rules, bridge certification), read 2026-11-20.
- [HA-cert] Home Assistant, *Home Assistant is now Matter certified* (2025-03-10):
  https://www.home-assistant.io/blog/2025/03/10/matter-certification/ (read 2026-11-20).
- CSA, *Matter Compliant Platform Certification*:
  https://csa-iot.org/newsroom/matter-compliant-platform-certification-building-on-proven-foundations-for-faster-trusted-smart-home-innovation/
- Matter Alpha, *Home Assistant announces official Matter support* (the CSA's statement that it
  has no certification fee exemption for open-source projects):
  https://www.matteralpha.com/industry-news/home-assistant-announces-official-matter-support
