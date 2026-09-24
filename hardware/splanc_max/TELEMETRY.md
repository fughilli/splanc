# MAX cost-down telemetry engineering draft

Twenty protected TPS1H100AQPWPRQ1 outputs retain hardware current limiting and
thermal shutdown. A nominal 1k limit resistor targets approximately 2.47A;
2A is the continuous design load, not a precisely guaranteed trip threshold.
Twenty open-drain ST pins share FAULT_N with a 4.7k pull-up to P5V. The ADC reads
this aggregate diagnostic; firmware identifies suspect channels using voltage,
current and commanded enable state. It is not a per-channel fault register.

Five INA4180A2IPWR quad current amplifiers replace the built-in B-variant sensing.
Each output return goes through its own YAGEO PE2512FKE070R02L 20mΩ,1%,1W shunt
to PGND. At2A the return rises40mV, dissipates80mW and produces2V at gain50.
Low-side sensing avoids exposing the amplifier's26V maximum common-mode inputs
to a nominal24V bus and transients. Shared external returns or chassis connections
can bypass current measurement; independent high-side hardware protection still
functions. LED data remains PGND referenced; validate its40mV return-offset margin.
Use Kelvin taps directly at both shunt pads, away from the load-current necks.
Generated source carries `@pnr-kelvin` and2A ampacity annotations; this is a
routing requirement, not a claim that the existing router implements Kelvin rules.

Twenty100k/10k0.1% dividers measure output voltage relative to PGND, with10nF
filters. Actual strip voltage is measured high-side voltage minus current×0.02Ω.
Current amplifier outputs use100Ω/1nF filters. The bus has an additional identical
voltage divider. At24V nominal, divider output is2.182V; at40V it is3.636V.
Input transient/clamp, negative voltage and power-sequencing qualification remain
required; this rough design is not a surge-certified production interface.

Five CD74HC4051PWR muxes each combine four current and four voltage signals into
one MCP3208-CI/SL channel. Mux group g serves channels4g through4g+3. Address0–3
selects current;4–7 selects voltage. ADC channels0–4 are mux outputs,5 reads the
REF3025 calibration reference,6 measures input bus voltage and7 reads FAULT_N.
ADC supply and reference are P5V. The measured2.5V calibration channel estimates
actual ADC reference voltage, removing first-order5V regulator error. Calibrate
reference, shunt/gain and divider errors during test; these are engineering values,
not calibrated accuracy specifications.

The SPI isolator's power side and ADC/mux logic all useP5V; its LV side uses3.3V.
The ISO7761 return translates ADC MISO into the FPGA's3.3V domain. The remaining
former ADC-CS1 signal is spare. Three spare bits of the existing24-bit enable
shift chain drive the shared mux addresses. Firmware must preserve all20 enable
bits whenever changing mux address. No latch pulse is allowed during an ADC
transaction. The shift register OE pins now connect to SHIFT_OE_N: pull-up means
disabled, and the isolated SAFE_ENABLE drives an NPN to enable outputs. Individual
enable/address pull-downs define safe-off/zero-address while the chain is disabled.
Initialize and latch all-zero data before asserting SAFE_ENABLE.

Initial conservative scan policy:250kHz SPI, at least1ms settling after address
changes, discard the first conversion after every ADC channel change, then retain
one sample. The divider's nominal source resistance is9.09kΩ and RC time constant
90.9µs;1ms exceeds10 time constants. At250kHz the ADC acquisition interval is6µs;
validate full12-bit settling with mux resistance, input capacitance, temperature
and actual board parasitics. Target at most50 complete40-signal scans per second
until measured settling tests justify faster sampling. Hardware short protection
does not depend on this scan rate.

Published distributor tier references: five amplifiers$2.6205, ADC$2.751,
five muxes$0.9645, twenty shunts$1.736 = $8.072 for telemetry ICs/shunts,
excluding reference, passives and assembly. This replaces the prior twoAD7490
allowance of$26.28 and adds per-output voltage telemetry. TPS1H100A switches
are separately$14.52 for20 at the referenced1000-unit tier. Stock is insufficient
for a1000-board build; all figures require supplier RFQs. See costing outputs.

Primary design references:
- https://www.ti.com/lit/gpn/INA4180 (RevH, pin functions and low-side sensing)
- https://www.ti.com/lit/ds/symlink/tps1h100-q1.pdf (RevD, A-versionST open drain)
- https://www.ti.com/lit/ds/symlink/cd74hc4051.pdf (RevO,4051pin table)
- https://ww1.microchip.com/downloads/en/devicedoc/21298e.pdf (MCP3208pinout, sampling)
- https://yageogroup.com/component-documentation/download/specsheet/PE2512FKE070R02L
