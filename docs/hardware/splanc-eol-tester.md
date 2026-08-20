# Splanc EoL Tester — hardware design

**FUG-131.** A bench fixture that plugs into the
[Splanc Dev Module](splanc-dev-module.md)'s `J_EOL` connector and runs a fully
automated End-of-Line (EoL) test: power the DUT, actuate every button through
isolated drivers, sniff its digital buses with the **same FX2 24 MHz logic
analyzer the HITL rigs use**, sample every rail and current-sense output with an
ADC, and apply calibrated resistive loads to prove the per-channel over-current
shutoff both trips on a short and holds at the nominal operating point.

Like the DUT, the tester is authored with [atopile](https://atopile.io) and
built by Bazel (`//hardware/splanc_eol_tester`). This doc is the spec its `.ato`
implements.

---

## 1. Goals

- **One-connector, hands-free test.** The operator seats the DUT on `J_EOL`,
  presses start; the tester sequences power, buttons, bus checks, and load tests
  and returns pass/fail with logged measurements.
- **Reuse the HITL toolchain.** The digital-capture path is an
  **FX2 / fx2lafw** analyzer identical to the HITL rigs (`SBC_ANALYZER=1`,
  sigrok `fx2lafw`), so the same `sigrok-cli` capture/decode code and channel
  conventions apply. The DUT's data/clock lines reach it through `J_EOL`.
- **Prove the protection, not just the telemetry.** Two switchable power
  resistors per channel let the tester force a short (low-R) and a nominal load
  (nominal-R) and confirm the load switch folds back / faults on the short while
  passing the nominal.

---

## 2. Architecture

```text
   Host (HITL Pi / bench PC, USB) ──┬── FX2 (CY7C68013A) 24 MHz LA ──[level shift 5V→3V3]── DUT digital taps
                                    │        (D0..D7: LED_CH0/1_DATA, I2C_SDA/SCL, UART, spare)
                                    │
                                    ├── Tester MCU (ESP32-C6 / RP2040) ── control + reporting over USB-CDC
                                    │        │
                                    │        ├─ isolated button drivers ─► BTN_{RESET,BOOT,PWR,USER}_DRV
                                    │        ├─ VBUS inject enable (high-side switch) ─► VBUS_INJ
                                    │        ├─ load-bank selects (per channel: SHORT / NOMINAL / OFF)
                                    │        └─ ADC mux ─► rail senses + CH0/CH1 CSA taps
                                    │
                                    └── (optional) programmable current sink for fine load sweeps

   J_EOL (2×10, 1.27 mm) ◄───────────────── all of the above
```

The tester carries its **own MCU** (an ESP32-C6, same family as the DUT, or an
RP2040) that owns the button drivers, the VBUS-inject switch, the load-bank
relays/FETs and the analog mux, and reports over USB-CDC. The FX2 is a separate,
host-owned instrument exactly as on the HITL rig — the tester MCU only sequences;
the host runs `sigrok-cli`.

---

## 3. Sub-systems

### 3.1 FX2 24 MHz logic analyzer (shared HITL instrument)

| Item        | Choice                                                                                                        | Notes                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core        | **CY7C68013A** (FX2LP) mini-board footprint                                                                   | Runs `fx2lafw`; 8 channels; 24 MHz sample. Same firmware/flow as `pi/hitl` `internal/analyzer`.                                                  |
| Level shift | 8× **74LVC / TXS0108** 5 V→3 V3 (or 3V3-tolerant clamp)                                                       | The HITL notes warn the "FX2 clone inputs aren't reliably 5 V tolerant" — so the tester adds explicit input protection/level shift on every tap. |
| Channel map | D0=`LED_CH0_DATA`, D1=`LED_CH1_DATA`, D2=`I2C_SDA`, D3=`I2C_SCL`, D4=`UART0_TXD`, D5=`UART0_RXD`, D6/D7 spare | Matches the DUT taps on `J_EOL` pins 11–14, 19–20. `analyzerChannelMap` on the host selects the line under test.                                 |

Because `fx2lafw` has **no hardware trigger** (per the HITL worklog), the host
software-triggers within the sample window — the tester MCU can gate the DUT's
activity (e.g. command a known WS2812 counting pattern) to land it in the window,
the same technique the HITL C6 counting-probe uses.

### 3.2 Isolated button drivers

Each DUT button node (`BTN_*_DRV` on `J_EOL`) is pulled to GND through an
**opto-isolator / analog switch** on the tester, in parallel with the human
button:

| Driver          | Actuates              | Isolation                                                                |
| --------------- | --------------------- | ------------------------------------------------------------------------ |
| `BTN_RESET_DRV` | DUT `EN` (reset)      | opto (e.g. TLP172 / AQY212) — no galvanic path, no fighting the RC.      |
| `BTN_BOOT_DRV`  | DUT GPIO9 (BOOT)      | opto; BOOT+RESET together → enter download mode for a flash/verify step. |
| `BTN_PWR_DRV`   | DUT power button node | opto; supports **short-press on / long-press off** timing from the MCU.  |
| `BTN_USER_DRV`  | DUT USER1/USER2       | opto (two channels) — exercises the user-input path.                     |

Solid-state opto/photorelay parts (not mechanical relays) keep actuation fast,
bounce-free and electrically isolated from the tester's logic.

### 3.3 VBUS inject

A high-side load switch (e.g. **TPS22975**) gates the tester's 5 V onto
`VBUS_INJ` (`J_EOL` pin 1) so the tester can **power the DUT and full power-cycle
it** between sub-tests without a USB cable. Inrush-limited; current-monitored so
a DUT with a hard short on VBUS is caught before anything downstream.

### 3.4 Simulated LED loads (over-current / short test)

Per LED channel (`CH0_5V` / `CH1_5V` on `J_EOL` pins 9–10), a small bank of
FET-switched power resistors to GND:

| Load        | Value                    | Purpose                                                                                                                                                                   |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SHORT**   | 0.5 Ω, ≥5 W (low-R)      | Forces ≫ the ~2.5 A load-switch current limit → the DUT's `TPS25200` must fold back / assert `FAULT`. Tester confirms shutoff via the CSA tap + FX2/GPIO read of `FAULT`. |
| **NOMINAL** | 2.5 Ω, ≥10 W (nominal-R) | ≈2 A at 5 V — the channel's rated operating point. DUT stays on; tester checks the INA226 reading (via I²C sniff / DUT report) matches the applied load within tolerance. |
| **OFF**     | —                        | Both FETs open: leakage / off-state check.                                                                                                                                |

Each load FET is driven from the tester MCU (gate driver + flyback-safe layout);
the resistors are sized for the pulse, and a thermal guard limits dwell. An
optional programmable sink (INA-controlled MOSFET) allows a fine current sweep to
find the exact trip threshold instead of the two discrete points.

### 3.5 Analog sampling (rails + CSA)

The tester samples the DUT's rail senses and current-sense outputs brought out on
`J_EOL`:

| Signal                | `J_EOL` | Measured                             |
| --------------------- | ------- | ------------------------------------ |
| `VSYS_SENSE`          | 3       | System rail under each condition     |
| `VBAT_SENSE`          | 4       | Battery / charge state               |
| `5V0_SENSE`           | 5       | Boost output (divided)               |
| `3V3_SENSE`           | 6       | Logic rail                           |
| `CH0_CSA` / `CH1_CSA` | 7 / 8   | Per-channel current-sense analog tap |

Sampled through an **analog mux (74HC4051)** into the tester MCU's ADC (or a
dedicated I²C ADC like the **ADS1115** for better resolution / absolute
accuracy). Divider ratios chosen so the highest rail (5V0) maps into the ADC
range; references from a clean 3V3A on the tester.

---

## 4. Test sequence (reference)

1. **Power-on.** Enable `VBUS_INJ`; verify 3V3/VSYS come up (ADC), current in
   bounds.
2. **Boot/flash.** Pulse `BTN_BOOT_DRV`+`BTN_RESET_DRV` → download mode; host
   flashes the EoL firmware image over the DUT USB (or the DUT self-reports over
   UART/`J_EOL`).
3. **Bus check.** FX2 captures `I2C_SDA/SCL` while the DUT scans its sensor bus;
   decode confirms all six I²C addresses ACK. Capture `LED_CH0/1_DATA` while the
   DUT emits a known WS2812 pattern; decode confirms both channels toggle.
4. **Buttons.** Actuate each `BTN_*_DRV`; DUT reports the edge (over UART/USB) →
   confirms every button reaches its GPIO.
5. **Nominal load.** Enable boost (DUT), select **NOMINAL** on each channel;
   read `CHx_CSA` + the DUT's INA226 report; assert ≈2 A, channel stays on.
6. **Short / shutoff.** Select **SHORT** on a channel; assert the load switch
   folds back and `LOAD_SWx_FLT` asserts within the datasheet time; confirm the
   other channel is unaffected. Repeat per channel.
7. **Power-off.** Long-press `BTN_PWR_DRV`; verify VSYS collapses (power-path
   latch off).
8. **Report.** Pass/fail + all logged measurements over USB-CDC; the host folds
   them into the same results path as HITL.

---

## 5. Connector

Mates 1:1 with the DUT `J_EOL` (2×10, 1.27 mm) — see
[dev-module §11](splanc-dev-module.md#11-eol-test-connector) for the pinout. The
tester side is the plug; a short keyed ribbon or a pogo-pin bed-of-nails adapter
seats the DUT.

---

## 6. Build commands

```bash
bazel build //hardware/splanc_eol_tester:splanc_eol_tester         # resolved board
bazel build //hardware/splanc_eol_tester:splanc_eol_tester.pdf     # layout PDF
bazel build //hardware/splanc_eol_tester:splanc_eol_tester.gerber  # fab outputs
```

## 7. Follow-up

- Tester firmware (sequencer + report format) — track separately once the DUT
  EoL firmware image exists.
- Integrate the pass/fail report into the HITL results pipeline (`pi/hitl`) so
  factory EoL and bench HITL share one dashboard.
- Decide bed-of-nails vs. ribbon for volume; this spec assumes the keyed ribbon
  for the first article.
