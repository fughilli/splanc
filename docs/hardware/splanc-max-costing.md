> Historical pre-costdown budget. Superseded for current MAX by `hardware/splanc_max/costing/summary.json` and `docs/hardware/launch-pricing.md`; retained below for comparison.

# Splanc MAX / Mini concept production budget

Budget date: **21 September 2026**, USD, **1,000 finished units**. MAX is an unrouted concept design. These are planning costs, not a supplier quotation or an assurance that stock can cover this build. Parts prices below were retrieved from distributor pages on that date; several pages expose cached snapshots. Where a 1,000-piece tier was unavailable, the table explicitly carries a smaller-quantity price forward. Most connectors, passives, mechanical parts and fabrication costs remain engineering allowances.

The reproducible ledger is `hardware/splanc_max/costing/bom.csv` / `bom.json`; run `python3 hardware/splanc_max/costing/estimate.py` to recompute its summaries. Component quantities refer to one complete MAX set: LV board, power board, USB jumper and ribbon/hardware. A 20-per-board component requires 20,000 pieces for this build; using a public 1,000-piece tier does not imply allocation of 20,000.

## Cost result

| MAX item | Components / set | Bare PCB / set | Assembly + electrical test / set | Total / set |
|---|---:|---:|---:|---:|
| LV / FPGA / Pi interface | $37.95 | $3.00 | $3.50 | $44.45 |
| 20-channel power / isolation / distribution | $102.43 | $7.00 | $7.50 | $116.93 |
| USB A–C jumper PCB | $1.40 | $0.30 | $0.40 | $2.10 |
| Ribbon and board-mounting hardware | $2.65 | — | — | $2.65 |
| **MAX electronics set** | **$144.43** | **$10.30** | **$11.40** | **$166.13** |

Thus the central 1,000-unit electronics budget is **about $166,130**, excluding Pi, storage, enclosure, power supplies, external LED wiring, freight, duties/tax and development/tooling. Components alone are about **$144,430**, or **$148,763 with a simple 3% overage allowance**. This percentage does not calculate reel rounding or supplier minimums.

| Budget scenario | Components / set | PCB + assembly + test / set | Electronics set | 1,000 sets |
|---|---:|---:|---:|---:|
| Favorable procurement / simple assembly | $107.34 | $14.35 | $121.69 | $121,690 |
| Central planning allowance | $144.43 | $21.70 | $166.13 | $166,130 |
| Higher parts / fabrication / test costs | $200.21 | $31.90 | $232.11 | $232,110 |

These are scenarios, not statistical confidence bounds. They assume the same architecture. They do not claim the low case is currently purchasable.

## Architecture being costed

- LV board: **85 × 56 mm**, four layers, 1 oz, GW1NR-LV9QN88PC6/I5 FPGA, external W25Q32JVSSIQ flash, FT2232HL USB programming/UART bridge, clock sources, 1.2/1.8/3.3 V supplies, Pi 40-pin header, USB C and a 50-pin ribbon connector.
- Power board: **180 × 120 mm**, four layers, nominal 2 oz outer copper, twenty TPS1H100**B** load switches with analog current sense and current limiting, four six-channel ISO7760 isolators for strip data, one ISO7761 for SPI/control, two AD7490 ADCs, REF3025 reference, three 74HC595 latched enable registers, twenty 3-way strip terminals, input protection and local regulators.
- Two busbars, each approximately **160 × 8 × 2 mm**, with two M5 power connections and a protected busbar region. Both supply and return distribution must be sized; a copper plane is not silently assumed to carry the aggregate return.
- Provisional rating used for budgeting: **12/24 V, 2 A per strip, 40 A aggregate**. This is not a validated rating. The 5 V variant needs a different/bypassed local regulator path; it is not qualified by the 12/24 V bill of materials.
- Pi 5 with active cooler is the mechanical reference, separately powered. Strip-side isolation separates the Pi/LV domain from the shared LED power domain; it is not twenty independently isolated outputs.

The busbar material pair is roughly 45.9 g of copper. The $5 pair allowance includes fabrication and plating, rather than equating finished busbars with raw copper commodity cost. Joint resistance, bolt preload, creepage, guards and hot-spot testing remain engineering work. Nominal 100 mΩ switches at 2 A dissipate about **0.4 W each / 8 W total** before hot resistance and other losses; thermal validation and ventilation therefore matter to the enclosure. [TI TPS1H100-Q1](https://www.ti.com/product/TPS1H100-Q1) distinguishes the A fault-status variant from the B analog-current-sense variant.

## Major component price evidence

| Item | Qty / set | Budget unit price | Evidence and qualification |
|---|---:|---:|---|
| GW1NR-LV9QN88PC6/I5 | 1 | $18.2529 | [LCSC C5799578](https://www.lcsc.com/product-image/C5799578.html): exposed **100+** tier; 182-stock snapshot. No verified 1,000-piece quote. |
| W25Q32JVSSIQ | 1 | $1.1546 | [LCSC C179173](https://www.lcsc.com/de/product-detail/C179173.html): **300+** tier; next tier 2,000. Regional/cache listings disagree; use the conservative applicable tier, not an old $0.1885 snapshot. |
| FT2232HL-REEL | 1 | $10.4124 | [LCSC C27882](https://www.lcsc.com/product-detail/usb%20converters_ftdi_ft2232hl-reel_C27882.html): **100+** tier carried forward; retrieved page cached about three months. |
| TPS1H100BQPWPRQ1 | 20 | **$0.82 allowance** | [LCSC C475505](https://www.lcsc.com/fr/product-detail/power-distribution-switches_texas-instruments-tps1h100bqpwprq1_C475505.html) shows $0.4597 at **1,000+**, but only 42 pieces in the exposed snapshot. Budget retains headroom for sourcing 20,000. |
| ISO7760FDWR | 4 | **$3.00 allowance** | [DigiKey device listing](https://www.digikey.com/en/products/detail/texas-instruments/ISO7760FDWR/7604341); no applicable volume price recovered. |
| ISO7761FDWR | 1 | **$3.00 allowance** | [TI device information](https://www.ti.com/product/ISO7761); five forward and one return signal required. Do not substitute a cheaper ISO7741 without redesigning the control interface. |
| AD7490BRUZ-REEL7 | 2 | $13.1418 | [LCSC C36884](https://www.lcsc.com/product-detail/Analog-to-Digital-Converters-ADC_Analog-Devices-AD7490BRUZ-REEL7_C36884.html): **100+** tier, 1,197-stock snapshot against 2,000 needed. |
| Strip terminal, pluggable 3-way pair | 20 | **$1.10 allowance** | Unselected supplier/MPN; allowance now includes both board header and mating plug, 5.08 mm pitch. |
| R-78E5.0-0.5 plus 3.3 V support | 1 package | **$4.00 allowance** | Part-family budget, not a quoted module price. |

The ADCs alone contribute **$26.28 per set**. Slower multichannel current measurement using a cheaper ADC plus mux, or time-multiplexing the switch diagnostics, is a credible cost-down investigation. It has not been substituted into this design or the central estimate. An $8 total ADC subsystem would save approximately $18.28 per set. FPGA and USB bridge sourcing merit RFQs; Tang Nano retail-board pricing is not evidence of standalone FPGA quantity pricing.

## Manufacturing model

Assume FR-4, 1.6 mm boards, standard drilled vias, lead-free assembly, no blind/buried vias, no press-fit assembly, and panel utilization around 70–80%. The cost ranges cover conventional routing; additional copper weight, thermal via filling or high-aspect-ratio constraints will change them. LV is approximately 47.6 cm² and power 216 cm². The small jumper is budgeted at under 10 cm²; its final geometry is still subject to connector fit.

The central $11.40 assembly/test package is an engineering allowance for SMT, through-hole headers/terminals, busbar fastening, programming and basic functional/current-channel testing. It is not merely the solder-joint charge. Roughly 500–800 LV SMT joints and 900–1,500 power SMT joints would alone imply about $1.70–$2.80 combined using $0.0012/joint at this batch volume. Through-hole connections, hidden-joint inspection, fixtures, handling and test then add cost. [JLCPCB's September 2026 price schedule](https://jlcpcb.com/help/article/pcb-assembly-price) lists joint, setup, feeder, manual and X-ray charges separately; an actual Gerber/BOM/CPL quote is required. Bare-board central costs of $3/$7/$0.30 are **area/complexity allowances**, not extracted cart quotes.

Recurring test allowance does not include development of fixtures/firmware or compliance certification. A 40 A test fixture needs separate design; simultaneous full-load testing costs more than sequential channel checks. Electrical test must include every channel, USB/SPI/flash function, isolation continuity checks, current-sense calibration and power protection behavior.

## Mini carry-forward estimate

`hardware/splanc_dev/mini-sourcing.json` is a **9 September 2026** sourcing snapshot for 136 populated components. Its component cost is **$24.00533 per unit at a 1,000-unit build**; procurement for 1,030 assemblies with supplier multiples is **$24,728.68**. This report does not silently reprice it or claim it covers later BOM changes.

For the current Mini board, budget an additional **$1–$2.50 bare PCB** and **$2–$4 assembly/programming/test** per unit, pending final outline, stack-up and generated BOM/CPL reconciliation. That gives approximately **$27–$30.50 electronics per Mini**, excluding its enclosure, cables, freight, duties and development costs. The routing checkpoint is not a manufacturing release.

## Product-level items deliberately separate

Pi memory capacity is not specified. Do not use the obsolete launch price for Pi 5 2 GB: Raspberry Pi announced subsequent memory-driven increases. [Official February 2026 announcement](https://www.raspberrypi.com/news/more-memory-driven-price-rises/) establishes that the earlier $50 launch figure is stale. Leave the selected Pi SKU as a procurement input; a **$65–$105 provisional allowance** is suitable only for early comparisons, not a present volume quote. Add a **$5–$8 cooler allowance**, **$4–$8 storage allowance**, and the separately chosen supply.

Neither injection-mould tooling nor printed-shell pricing has been quoted. STEP concepts need fit prototypes, fastener/tolerance confirmation and thermal tests before tooling procurement. Keep enclosure cost separate from the electronics figures above.

## Separate enclosure production scenarios

These allowances assume two simple shells per product, ABS or PC/ABS, screws rather than complex moving snap features, ordinary finish, no sealing gasket or IP rating, no cosmetic paint, and cutouts arranged at the parting line where possible. They are not a cost calculation from a final mould-ready STEP. Side actions, removable connector panels, metal inserts, flame-rated resin or tool rework can increase them.

| Product / 1,000 enclosures | Variable shell + fastener/assembly cost / set | Total tool NRE | Tool NRE / set at 1,000 | First 1,000 combined / set |
|---|---:|---:|---:|---:|
| Mini clamshell, favorable | $2 | $4,000 | $4 | $6 |
| Mini clamshell, central | $3 | $8,000 | $8 | $11 |
| Mini clamshell, higher | $4 | $12,000 | $12 | $16 |
| MAX box and lid, favorable | $6 | $12,000 | $12 | $18 |
| MAX box and lid, central | $9 | $22,000 | $22 | $31 |
| MAX box and lid, higher | $12 | $35,000 | $35 | $47 |

The MAX allowance is larger because its enclosure surrounds the Pi stack and 180 × 120 mm distribution board, has more port cutouts, and needs airflow and guarded power connections. Exact shell mass and final envelope are not yet inputs to this budget. A two-cavity family mould may reduce setup/tool cost but is not assumed to be feasible without mould-flow and ejection review.

[Xometry's injection moulding cost guide](https://www.xometry.com/resources/injection-molding/injection-molding-cost/) describes tool complexity, resin, cycle time and cavitation as cost drivers and gives order-of-magnitude small-part tooling context. [Protolabs' design-to-cost guide](https://www.protolabs.com/resources/design-tips/11-tips-to-reduce-injection-molding-costs/) explains geometry and quantity effects. Those sources motivate the model; **none quotes these particular enclosures**. At only 1,000 units, tooling amortization dominates, so printed/cast or modified stock boxes deserve a supplier comparison before mould commitment.

Central first-batch totals excluding Pi/storage/supply/shipping/tax: **MAX electronics + enclosure about $197.13 each**; **Mini electronics + enclosure about $38–$41.50 each**. Repeat batches after amortization would exclude tool NRE. Do not add the NRE again if it is already present in a supplier's piece price.


## Final design reconciliation

Reconciled against `hardware/splanc_max/design.json`: **52 LV, 190 power and 3 USB-bridge circuit components**. The budget is a grouped cost model, not a 245-line purchase BOM. A final complete procurement BOM still requires selecting generic component MPNs and reconciling every design ref.

The final design uses **50-pin ribbon connections**, **20 pluggable 5.08 mm output terminal pairs**, and an added **TXU0304PWR** SPI translator. Relative to the original $132.43 central estimate these add $0.55, $11.00 and $0.45 respectively: **+$12.00 per set**, giving the updated **$144.43 component budget** above. Standard board and assembly ranges are unchanged at this stage.

The budget retains explicit **completion reserves** for not-yet-fitted USB descriptor/HAT identification EEPROMs, input fuse/reverse-polarity/TVS protection, and USB/output ESD protection. Their presence in the cost allowance is not evidence that these circuits are in the delivered native board or atopile netlist. Similarly the 5 V local regulator variant remains outside the current 12/24 V prototype. Current totals are a product-completion planning budget, not the exact as-drawn fitted BOM cost.
