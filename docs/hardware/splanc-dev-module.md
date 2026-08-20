# Splanc Dev Module — hardware design

**FUG-131.** A single-board ESP32-C6 development platform for the splanc LED
player: an 8 MB-flash C6 with its own 2.4 GHz radio front-end, a 1S LiPo power
system, a 5 V/4 A boost feeding two independently-switched and monitored LED
channels, a 9-DoF + baro + microphone sensor cluster, USB-C for code upload and
JTAG, a full set of user/power/boot buttons, exhaustive test points, and a
keyed End-of-Line (EoL) test connector. The companion
[EoL tester board](splanc-eol-tester.md) drives that connector for automated
factory test.

The board is authored as code with [atopile](https://atopile.io) and built by
Bazel (`//hardware/splanc_dev`) via
[rules_atopile](https://github.com/fughilli/rules_atopile). This document is the
specification the `.ato` source implements; the two are meant to be read
together and kept in sync.

---

## 1. Goals and scope

- **Bring-up / dev target, not a shipping product.** Every sensible net is
  broken out to a test point; the board is generously decoupled and laid out to
  be probed, reworked, and abused on the bench.
- **Exercise the whole splanc player stack on real silicon**: two WS2812-class
  LED channels at real power, WiFi/BLE provisioning over the discrete radio, and
  the sensor suite the effects runtime will eventually consume.
- **Design-for-test from day one.** The board terminates in a single keyed EoL
  connector so the [tester](splanc-eol-tester.md) can power it, actuate every
  button, sniff its buses with the same FX2 24 MHz analyzer the HITL rigs use,
  sample every rail and current-sense output, and apply calibrated resistive
  loads to verify the per-channel over-current shutoff.

### 1.1 Deliberate non-goals

- Multi-cell battery support, USB-PD negotiation (fixed 5 V sink only), and
  wireless charging are out of scope.
- The 5 V/4 A boost is specified as an **aggregate** budget across both LED
  channels (≈2 A/channel nominal, 4 A total), not 4 A per channel — see §5.3 for
  why a 1S source makes per-channel 4 A impractical.

---

## 2. System block diagram

```text
             ┌────────── USB-C (sink, 5 V) ──────────┐
             │  CC 5.1k pulldowns · ESD · VBUS        │
             │            D+ / D-  ─────────────► ESP32-C6 native USB (JTAG+CDC)
             ▼
   VBUS ─► [ideal-diode load-share] ─► VSYS ─┬─► [3V3 buck TLV62569] ─► 3V3 (MCU, radio)
             ▲                                │                        └─► [ferrite] ─► 3V3A (sensors/ADC)
             │                                │
   [MCP73831 linear charger] ◄── VBUS         └─► [5V/4A boost TPS61088] ─► 5V0 ─┬─► CH0: shunt→[load sw]→conn
             │  STAT, PROG                                                        │        INA226 (V/I)
             ▼                                                                    └─► CH1: shunt→[load sw]→conn
   1S LiPo ──┴─► [MAX17048 fuel gauge, I2C]                                                INA226 (V/I)
             │
   [power-path pushbutton controller] ── PWR button (on / long-press off), MCU KILL

   ESP32-C6FH8 (8 MB) ── 40 MHz XTAL ── π-match ── PCB IFA antenna (2.4 GHz)
        │  I2C0 (SDA/SCL) ─► MPU6050 · QMC5883L · BMP280 · MAX17048 · 2× INA226
        │  I2S0 ─────────► INMP441 MEMS mic
        │  GPIO ─────────► 2× LED data, 2× load-sw EN + FAULT, boost EN, buttons…
        └──────────────────────────────────► EoL test connector (all of the above)
```

See §4 for the exact pin map and §11 for the EoL connector pinout.

---

## 3. MCU + radio front-end

| Item       | Choice                                                                                      | Notes                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| MCU        | **ESP32-C6FH8** (bare QFN, 8 MB in-package flash)                                           | RISC-V, WiFi 6 + BLE 5 + 802.15.4; native USB Serial/JTAG. `board = esp32c6` in firmware.                      |
| Clock      | 40 MHz crystal, 2× ~12 pF load caps                                                         | RTC uses the internal RC (no 32 kHz XTAL — not needed for this app).                                           |
| Antenna    | PCB **inverted-F antenna (IFA)** in a keep-out on the board edge                            | Zero-BOM radiator; the reference IFA geometry from the ESP32-C6 hardware design guidelines.                    |
| Match      | 3-element **π network** (series L + two shunt C) between the C6 RF pad and the antenna feed | Populated as a π so the board can be tuned on a VNA; nominal is series 0 Ω / DNP shunts, adjusted per antenna. |
| Decoupling | 100 nF + 10 µF per 3V3 pin group, bulk 22 µF at the module                                  | Star ground under the QFN pad.                                                                                 |
| Reset      | **EN** RC (10 kΩ pull-up + 1 µF + button to GND)                                            | Debounced by the RC; also on a test point and the EoL connector.                                               |
| Strapping  | GPIO8 (pull-up), GPIO9 (BOOT button, pull-up), GPIO15 (JTAG-sel, pull-up)                   | Left in the documented safe states; BOOT/RESET double as the download combo.                                   |

> **Module alternative.** For a lower-risk first spin, the same design drops in
> an **ESP32-C6-WROOM-1-N8** (module with integrated antenna, matching, XTAL and
> 8 MB flash) and the discrete radio section (crystal, π-match, IFA) is DNP. The
> `.ato` keeps the radio front-end in its own module so this swap is a one-line
> change. The bare-chip design is the default because the issue explicitly calls
> for a discrete "2.4 GHz antenna with matching network."

---

## 4. Pin map (ESP32-C6)

The firmware board target (`//firmware/player_app:splanc_dev`) and the `.ato`
netlist share this map. Strapping pins (8, 9, 15), the USB pins (12, 13) and the
default UART0 pins (16, 17) are reserved.

| GPIO | Net            | Direction | Function                                                    |
| ---: | -------------- | --------- | ----------------------------------------------------------- |
|    0 | `LED_CH0_DATA` | out       | Channel 0 WS2812 data (level-shifted to 5 V)                |
|    1 | `LED_CH1_DATA` | out       | Channel 1 WS2812 data (level-shifted to 5 V)                |
|    2 | `LOAD_SW0_EN`  | out       | Channel 0 load-switch enable                                |
|    3 | `LOAD_SW0_FLT` | in        | Channel 0 load-switch fault (open-drain, pulled up)         |
|    4 | `LOAD_SW1_EN`  | out       | Channel 1 load-switch enable                                |
|    5 | `LOAD_SW1_FLT` | in        | Channel 1 load-switch fault (open-drain, pulled up)         |
|    6 | `I2C_SDA`      | i/o       | Shared I²C0 data (sensors, fuel gauge, INA226×2)            |
|    7 | `I2C_SCL`      | out       | Shared I²C0 clock                                           |
|    8 | _(strap)_      | —         | Boot strap, pulled up (status LED optional, weak drive)     |
|    9 | `BOOT`         | in        | BOOT button / download strap (pull-up + button to GND)      |
|   10 | `BOOST_EN`     | out       | 5 V boost converter enable                                  |
|   11 | `PWR_KILL`     | out       | Assert to latch system power off (to pushbutton controller) |
|   12 | `USB_D-`       | i/o       | Native USB (JTAG + CDC)                                     |
|   13 | `USB_D+`       | i/o       | Native USB (JTAG + CDC)                                     |
|   14 | `PWR_BTN_SNS`  | in        | Power button state (post-debounce, for graceful shutdown)   |
|   15 | _(strap)_      | —         | JTAG source select, pulled up                               |
|   16 | `UART0_TXD`    | out       | Serial log fallback                                         |
|   17 | `UART0_RXD`    | in        | Serial console fallback                                     |
|   18 | `I2S_BCLK`     | out       | INMP441 bit clock                                           |
|   19 | `I2S_WS`       | out       | INMP441 word select (L/R)                                   |
|   20 | `I2S_DIN`      | in        | INMP441 serial data                                         |
|   21 | `IMU_INT`      | in        | MPU6050 / shared sensor interrupt                           |
|   22 | `USER_BTN1`    | in        | User button 1 (pull-up + button to GND)                     |
|   23 | `USER_BTN2`    | in        | User button 2 (pull-up + button to GND)                     |

INA226, MAX17048 and BMP280 ALERT/INT lines are **polled over I²C** rather than
wired to GPIOs (the C6's usable GPIO budget is tight); their pads are still
broken out as test points for scope work.

### 4.1 I²C0 address map

| Addr | Device    | Role                                      |
| ---- | --------- | ----------------------------------------- |
| 0x0D | QMC5883L  | Magnetometer / compass                    |
| 0x36 | MAX17048  | LiPo fuel gauge                           |
| 0x40 | INA226 #0 | LED channel 0 V/I monitor (A0=A1=GND)     |
| 0x41 | INA226 #1 | LED channel 1 V/I monitor (A0=VS, A1=GND) |
| 0x68 | MPU6050   | Accel + gyro (AD0=0)                      |
| 0x76 | BMP280    | Barometric altimeter (SDO=0)              |

All addresses distinct → one bus, no mux needed. Bus pulled up to **3V3A** with
2.2 kΩ (fast-mode, six devices + connector stub).

---

## 5. Power system

### 5.1 USB-C input

- USB-C 2.0 receptacle (16-pin), **sink-only**: CC1/CC2 each via 5.1 kΩ to GND
  (Rd, advertises a 5 V/default-USB sink). No PD.
- VBUS ESD/TVS array on D+/D-/VBUS; series ferrite + 10 µF bulk on VBUS.
- D+/D- run as a 90 Ω differential pair to the C6 native-USB pins (GPIO12/13).
- VBUS feeds both the charger input and the system load-share.

### 5.2 Battery, charging, fuel-gauge, power path

| Block        | Part                                               | Detail                                                                                                                               |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Charger      | **MCP73831** (linear, single-cell Li-Po)           | `PROG` resistor sets I_chg (default 500 mA; 2 kΩ). `STAT` LED + test point. Charges from VBUS.                                       |
| Fuel gauge   | **MAX17048G** (I²C, ModelGauge, no sense resistor) | Reports SoC + cell voltage on I²C 0x36; `QSTRT`/`ALRT` broken out.                                                                   |
| Load-share   | Ideal-diode P-FET path (VBUS priority)             | System runs from VBUS when present (so charging isn't back-fed by load); falls back to battery when unplugged.                       |
| Power button | **Pushbutton on/off controller** (LTC2954-class)   | Press → latch VSYS on; **long-press → hardware off**; MCU can read state (`PWR_BTN_SNS`) and assert `PWR_KILL` for a clean shutdown. |

VSYS (≈3.0–5.0 V, battery or VBUS) is the common input to both the 3V3 buck and
the 5 V boost.

### 5.3 Rails

| Rail     | Source                          | Budget                      | Part                                       |
| -------- | ------------------------------- | --------------------------- | ------------------------------------------ |
| **3V3**  | Buck from VSYS                  | ~500 mA (MCU + radio peaks) | **TLV62569** (2 A, 1.5 MHz)                |
| **3V3A** | 3V3 via ferrite bead + bulk cap | sensors + ADC reference     | quiet analog domain for the sensor cluster |
| **5V0**  | Boost from VSYS                 | **5 V @ 4 A aggregate**     | **TPS61088** (10 A switch, 2.7–12.6 V in)  |

**On the 4 A boost from 1S.** 5 V × 4 A = 20 W. At a 3.0 V (near-empty) cell and
~88 % efficiency that draws ≈7.6 A from the battery — beyond a typical dev-board
LiPo and its protection FET. The board therefore:

- Specifies the boost for **4 A total across both channels** (≈2 A/channel), and
- Recommends running the LED channels at full power from **USB VBUS** (5 V input,
  boost in near-pass-through) or a bench supply on the VSYS test point; the LiPo
  is for logic + light LED use and for testing the power path itself.

Input/output bulk: ≥2× 22 µF ceramic + 1× 100 µF on 5V0; 2× 22 µF on the boost
input; the datasheet's compensation and soft-start network. A 5V0 sense divider
feeds a test point and the EoL connector.

---

## 6. LED output channels (×2)

Each of the two identical channels, from the 5V0 rail to the LED connector:

```text
5V0 ─► [Rshunt 10 mΩ] ─► [current-limited load switch] ─► CHx_5V ─► 3-pin conn (5V, DATA, GND)
          │  │                  │  EN   FAULT
          │  └── INA226 (Vbus + Vshunt, I²C) ── V/I telemetry
          │                     └─ over-current / short → FAULT (to MCU)
          └── data: GPIO ─► [level shifter 3V3→5V] ─► DATA
```

| Element     | Part                                                       | Role                                                                                                                                        |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Shunt       | 10 mΩ, 1 W, 1 % (2512)                                     | INA226 current sense; ±3.2 A range at 40 mV.                                                                                                |
| Monitor     | **INA226** (I²C)                                           | Bus **voltage** + **current** + power, programmable over/under-current alert. Satisfies "per-channel current/voltage monitoring."           |
| Load switch | **TPS25200** (adjustable current-limit, `ILIM` set ≈2.5 A) | On/off via `LOAD_SWx_EN`; hard **current limit + thermal shutdown** = the over-current / short shutoff; open-drain `FAULT` back to the MCU. |
| Level shift | 74LVC1T45 / single-FET translator                          | 3V3 data → clean 5 V WS2812 logic; series 33 Ω near the connector.                                                                          |
| Connector   | 3-pin 3.96 mm (5V / DATA / GND), reverse-key               | Also mirrored onto the EoL connector for the simulated-load test.                                                                           |

The load switch's current limit is the **short-circuit protection** device the
EoL tester exercises: a low-R resistor across a channel forces the limit to trip
(FAULT asserts, output folds back); a nominal-R resistor verifies the operating
point and the INA226 reading. See [EoL tester](splanc-eol-tester.md) §4.

---

## 7. Sensor cluster

All on the shared I²C0 bus (except the mic, which is I²S), powered from 3V3A.

| Sensor                 | Part         | Bus | Address | Notes                                                        |
| ---------------------- | ------------ | --- | ------- | ------------------------------------------------------------ |
| Accel + gyro (IMU)     | **MPU6050**  | I²C | 0x68    | `INT` → GPIO21; AD0 tied low.                                |
| Compass / magnetometer | **QMC5883L** | I²C | 0x0D    | 3-axis mag; DRDY on a test point.                            |
| Altimeter (baro)       | **BMP280**   | I²C | 0x76    | Pressure→altitude; SDO low.                                  |
| Microphone             | **INMP441**  | I²S | —       | MEMS mic on I²S0 (`BCLK`/`WS`/`DIN`); `L/R` tied low (left). |

> **On "I²C microphone."** The issue names the INMP441, which is an **I²S**
> (not I²C) MEMS microphone; the board wires it on I²S0 accordingly. If a true
> I²C/PDM part is preferred later, the mic lives in its own `.ato` module and can
> be swapped without touching the rest of the board.

Each sensor gets local 100 nF decoupling; the mic gets the datasheet's supply
filter. INT/DRDY/ALERT pins are all broken out to test points.

---

## 8. Buttons

| Button            | Net                   | Circuit                                                                                                                          |
| ----------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **RESET**         | `EN`                  | 10 kΩ pull-up + 1 µF + button to GND (RC debounce).                                                                              |
| **BOOT**          | GPIO9                 | 10 kΩ pull-up + button to GND; hold during reset → download mode.                                                                |
| **POWER (combo)** | pushbutton controller | Press = power on; **long-press = power off** (hardware latch); MCU reads `PWR_BTN_SNS`, asserts `PWR_KILL` to shut down cleanly. |
| **USER1**         | GPIO22                | 10 kΩ pull-up + button to GND; RC + optional external debounce.                                                                  |
| **USER2**         | GPIO23                | 10 kΩ pull-up + button to GND.                                                                                                   |

Every button node is (a) broken out to a test point and (b) routed to the EoL
connector so the tester can drive it through an **opto/analog-switch isolator**
(§11 and the tester doc) — actuating buttons without a robot finger.

---

## 9. Decoupling & power integrity

- Per-IC local ceramics (100 nF) on every supply pin; bulk 10–22 µF at each
  regulator and at the C6 module.
- 5V0: 2× 22 µF + 100 µF low-ESR near the boost, 22 µF at each load switch, 10 µF
  at each LED connector.
- Separate **3V3A** analog island fed through a ferrite bead; sensor references
  and the INA226 supplies hang off it.
- Solid ground pour, stitched; RF section has its own tight ground keep-out under
  the antenna and π-match.

---

## 10. Test points

Every "sensible net" gets a labelled 1 mm test pad (or a loop for scoping):

- **Power:** VBUS, VSYS, VBAT, 3V3, 3V3A, 5V0, and the 5V0 sense-divider node.
- **Charger/gauge:** `STAT`, `PROG`, fuel-gauge `ALRT`.
- **Per LED channel:** `LED_CHx_DATA` (both 3V3 and shifted 5 V sides),
  `LOAD_SWx_EN`, `LOAD_SWx_FLT`, `CHx_5V` (post-switch), the shunt Kelvin taps.
- **Boost:** `BOOST_EN`, `SW` (scope-only loop), feedback node.
- **Buses:** `I2C_SDA`, `I2C_SCL`, `I2S_BCLK`, `I2S_WS`, `I2S_DIN`, `UART0_TXD`,
  `UART0_RXD`.
- **Sensors:** each `INT`/`DRDY`/`ALERT`.
- **Control:** `EN`(reset), `BOOT`, `PWR_BTN_SNS`, `PWR_KILL`, `USER_BTN1/2`.
- **JTAG fallback:** MTMS/MTDI/MTCK/MTDO pads (normally the C6 debugs over USB,
  but the pads allow an external probe).
- **GND:** multiple ground pads distributed for short return loops.

---

## 11. EoL test connector

A single keyed **2×10 1.27 mm** shrouded header (`J_EOL`) carries everything the
[tester](splanc-eol-tester.md) needs. All DUT-driven inputs (buttons, resets)
arrive through the connector so the tester's **isolated drivers** actuate them;
all analog rails/CSA outputs leave through it for the tester's ADC; the two LED
channels leave through it so the tester can hang its **simulated loads** and the
FX2 analyzer can tap the data/clock lines.

| Pin | Net                                   | Pin | Net                                |
| --: | ------------------------------------- | --: | ---------------------------------- |
|   1 | `VBUS_INJ` (tester can power the DUT) |   2 | `GND`                              |
|   3 | `VSYS_SENSE`                          |   4 | `VBAT_SENSE`                       |
|   5 | `5V0_SENSE`                           |   6 | `3V3_SENSE`                        |
|   7 | `CH0_CSA` (INA226 alert / analog tap) |   8 | `CH1_CSA`                          |
|   9 | `CH0_5V` (to simulated load)          |  10 | `CH1_5V` (to simulated load)       |
|  11 | `LED_CH0_DATA` (FX2 tap)              |  12 | `LED_CH1_DATA` (FX2 tap)           |
|  13 | `I2C_SDA` (FX2 / sniff)               |  14 | `I2C_SCL` (FX2 / sniff)            |
|  15 | `BTN_RESET_DRV` (isolated)            |  16 | `BTN_BOOT_DRV` (isolated)          |
|  17 | `BTN_PWR_DRV` (isolated)              |  18 | `BTN_USER_DRV` (USER1/2, isolated) |
|  19 | `UART0_TXD`                           |  20 | `UART0_RXD`                        |

The button-drive pins land on the DUT side of each button (parallel to the human
switch) so the tester pulls them low through an opto/analog-switch without
fighting the pull-ups. `VBUS_INJ` lets the tester fully power-cycle the DUT.

---

## 12. Manufacturing / fabrication

- 4-layer, 1.6 mm, ENIG (RF + fine-pitch QFN), controlled-impedance 90 Ω diff
  for USB and 50 Ω for the RF feed.
- JLCPCB-oriented: parts chosen by LCSC id so the same picker/catalog that
  builds the board also maps to an assembleable BOM (see the `.ato` and
  `//hardware/splanc_dev`).
- Outputs from Bazel: resolved `.kicad_pcb`, layout `.pdf`, Gerber+drill,
  BOM. See §14 for commands.

---

## 13. Interfaces to firmware

The firmware board target `//firmware/player_app:splanc_dev` consumes the §4 pin
map via a board pin-config header (`splanc_dev_pins.h`). It rolls up:

- **LED**: two RMT WS2812 channels on `LED_CH0/1_DATA`.
- **Power control**: drive `BOOST_EN`, `LOAD_SW0/1_EN`; read `LOAD_SW0/1_FLT`,
  `PWR_BTN_SNS`; assert `PWR_KILL` on shutdown.
- **Telemetry**: I²C0 driver reading the two INA226 (per-channel V/I) and the
  MAX17048 (battery SoC).
- **Sensors**: I²C0 for MPU6050 / QMC5883L / BMP280, I²S0 for the INMP441.

Sensor driver implementations that `@embedded` does not yet provide (there is no
I²C/IMU/I²S library there today) are tracked as follow-up; this board target
lands the **pin configuration + power/LED/monitoring bring-up** and reserves the
sensor pins so the drivers drop straight in. See §15.

---

## 14. Build commands

```bash
# Resolved board (part-pick + layout; the one networked step):
bazel build //hardware/splanc_dev:splanc_dev
# Fabrication outputs (hermetic kicad-cli on the resolved board):
bazel build //hardware/splanc_dev:splanc_dev.pdf
bazel build //hardware/splanc_dev:splanc_dev.gerber
# Inspect interactively:
bazel run   //hardware/splanc_dev:splanc_dev.view
```

## 15. Open items / follow-up

- Sensor drivers (MPU6050, QMC5883L, BMP280, INMP441) in firmware — `@embedded`
  has no I²C/I²S stack yet; file a follow-up to add one + the four drivers.
- Antenna π-match values are placeholders pending a VNA sweep of the fabricated
  IFA.
- The 20 W boost from a 1S cell is bench/USB-fed by design (§5.3); if untethered
  full-power LED operation is required, move to a 2S pack or an external 5 V
  input and re-spec the boost.
