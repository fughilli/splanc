# Proposed launch pricing — 1,000 units per product

**Recommendation: Mini $52.99, Splanc $109, Splanc with GNSS $139, MAX $299.** These proposed direct-to-consumer, tax-exclusive launch prices approximate the revised 20% / 30% / 30% / 40% gross-margin targets. They include enclosure tooling amortized over the first 1,000 units and packaging. MAX excludes the Raspberry Pi. No prices have been published to a store.

| Product | Central first-batch cost | Proposed launch | Gross margin | Gross profit / unit | Cost scenario range |
|---|---:|---:|---:|---:|---:|
| Mini | $41.98 | **$52.99** | **20.8%** | $11.01 | $32.66–$53.34 |
| Splanc, P4 + C6 + sensors + UWB | $75.71 | **$109** | **30.5%** | $33.29 | $62.79–$100.80 |
| Splanc + u-blox GNSS and selected Taoglas antenna | $97.17 | **$139** | **30.1%** | $41.83 | $80.78–$130.08 |
| MAX, without Pi | $177.86 | **$299** | **40.5%** | $121.14 | $132.54–$262.57 |

At central unrounded costs, exact target prices are $52.47, $108.16, $138.82 and $296.44. Mini uses a .99 promotional price because whole-dollar prices ending in 9 miss its target materially: $49 gives 14.3%, while $59 gives 28.9%. The former $129 GNSS suggestion no longer reaches 30% once the selected antenna is included; it would yield 24.7%. These are planning budgets, not supplier quotes, and the targets are not guaranteed in high-cost scenarios.

Gross margin is `(selling price − unit cost) / selling price`. Required price is `unit cost / (1 − target margin)`. A 50% margin doubles cost; adding 50% to cost yields only a 33.3% margin. Revenue excludes sales taxes and any shipping charged separately. Tool amortization here is a management-planning allocation, not an assertion about accounting policy.

## Included cost build-up

| Cost / unit | Mini | Splanc | MAX |
|---|---:|---:|---:|
| Component budget | $24.01 | $48.27 | $112.78 |
| 3% component overage reserve | $0.72 | $1.45 | $3.38 |
| PCB, assembly, programming and test | $4.75 | $8.00 | $27.70 |
| Enclosure shells, screws and assembly | $3.00 | $4.00 | $9.00 |
| Enclosure tooling / first 1,000 units | $8.00 | $12.00 | $22.00 |
| Packaging allowance | $1.50 | $2.00 | $3.00 |
| **First-batch total** | **$41.98** | **$75.71** | **$177.86** |

Splanc's component model deliberately **retains the full Mini $24.00533 BOM**, including the C6 wireless companion, sensors and two-channel USB-PD power stage; it adds ESP32-P4NRW32X at $4.0479, DWM3000TR13 at $16.2125, and $4 for external 16 MB flash, core supply, crystal and support. The projected board is 100 × 80 mm, four layers, 1 oz. This is a conservative architectural budget rather than a repriced final generated Splanc BOM. Differences such as duplicated/reset circuitry and finalized passives still need reconciliation.

GNSS adds approximately **$21.46 cost**: MAX-M10S module $9.32826, selected **Taoglas AP.25F.07.0078A** active antenna $8.84762, U.FL/bias/protection $1.20, 3% component reserve and $1.50 assembly/RF test. The antenna replaces an earlier $3 generic allowance, increasing the product cost by $6.02 including overage. A **+$30 factory option** moves $109 to $139, yielding about 28.5% incremental margin and 30.1% on the whole product. Both variants share the shell and board outline; tooling is allocated across 1,000 total Splanc units. If fewer GNSS variants are ordered, component price tiers must be requoted.

Mini pricing carries forward the September 9 sourcing ledger. MAX now uses the September 21 **DEGSON/shared-ADC/quad-CSA** revision in `hardware/splanc_max/costing/summary.json`; historical generic and Phoenix budgets are superseded. The generated circuit has 52 LV, 317 power and 3 bridge components. The costing remains a grouped procurement budget with explicit completion reserves, rather than claiming every unqualified part has a supplier quote. The power board remains 200 × 120 mm. Full historical costing inputs are preserved under `hardware/splanc_max/costing/historical-pre-costdown-2026-09-21/`; the old MAX costing report is marked historical.

MAX now budgets **$112.78 components** plus **$27.70 PCB/assembly/test**. Assembly includes an extra **$3/unit** for 127 additional power-board placements and **$2/unit** for telemetry calibration/test. These allowances are incremental to the prior baseline, not factory quotes. The board-area increase retains $1/unit. New precision divider/filter/control passives have a separate $2 component allowance; shunts budget $0.10 each above the exposed $0.0868 reference.

The DEGSON header and matching plug total **$0.4086/pair**, or $8.172 for 20 channels, compared with the prior $59.14 Phoenix reference. Five INA4180A2, five CD74HC4051 and one MCP3208 cost $6.336; twenty shunts budget $2. This replaces two AD7490s budgeted at $26.2836 while adding per-output voltage telemetry. Twenty TPS1H100A parts budget $14.52. Exact sources and tiers are in `hardware/pricing/max-costdown-sourcing.json`. The net central finished-unit cost reduction is **$65.85**, after extra assembly/calibration and unchanged shell/tooling/packaging, taking the proposed launch from $409 to **$299**.

## Price evidence checked 21 September 2026

- **P4:** [LCSC's Espressif listing](https://www.lcsc.com/de/category/941.html?brand=877) exposes ESP32-P4NRW32X C54540373 at **$4.0479 / 1,000+**, with **zero available stock**. That is a price reference, not a secured allocation. [Espressif's official product-change notice](https://documentation.espressif.com/PCN202600801_ESP32-P4_Chip_Revision_v3.2_Upgrade_Chip_Revision_v1.3_Demand_Collection_and_EOL_Plan_Description.pdf) moves the original NRW32 to the X revision and identifies a pin-54 difference. The old part must not be used as a drop-in procurement substitute.
- **UWB:** [DigiKey DWM3000TR13](https://www.digikey.com/en/products/detail/qorvo/DWM3000TR13/24367320) exposes **$16.21250 / 500-piece reel** and 10,388 pieces in the retrieved stock snapshot. Carry that tier to two reels for 1,000 units; no unverified volume discount is assumed. Older aggregator prices around $12.71 were not used. The part is the radio module, not the EVB.
- **GNSS:** [DigiKey MAX-M10S-00B](https://www.digikey.com/en/products/detail/u-blox/MAX-M10S-00B/15712909) exposes **$9.32826 / 500-piece reel** and 5,286 in stock, but also an explicit **500-piece purchase limit** in the retrieved page. The budget does not assert that 1,000 can be ordered immediately. Obtain a supplier allocation/quote before promising volume delivery.
- **Selected antenna:** [DigiKey Taoglas AP.25F.07.0078A](https://www.digikey.com/en/products/detail/taoglas-limited/AP-25F-07-0078A/2754153) lists **$8.84762 at 600 units**, the applicable published tier for 1,000 units plus 3% reserve. The lower $8.59382 tier requires 1,050 units and is not used here. Retrieved stock was only 51 and lead time 16 weeks; this price is not an allocation. This is an active GPS/Galileo L1 patch, not a claim of all-band GNSS reception.
- All shell, tooling, packaging and additional support-component figures are engineering allowances. Existing enclosure cost methodology and primary-source context are recorded in `docs/hardware/splanc-max-costing.md`; there is no injection-mould tooling quotation for these parts.

## What the margin does not pay for automatically

No Pi, Pi cooler/storage, LED strips, external supplies or external signal/power cables are included. The MAX includes its internal ribbon and USB jumper. Freight/import duty, outbound fulfillment, returns/warranty above the small component reserve, payment/crowdfunding fees, distributor discounts, certification, product engineering, software and marketing are not priced into these manufacturing costs. State the retail bundle explicitly before advertising.

For an illustrative **8% of revenue** channel/payment fee, contribution after that fee becomes **12.8% Mini, 22.5% Splanc, 22.1% GNSS and 32.5% MAX**, before other excluded costs. At the high-cost scenarios the gross margins are **−0.7%, 7.5%, 6.4% and 12.2%** respectively. Requote before committing to campaign prices. After tooling recovery, unchanged recurring costs would raise central margins to **35.9%, 41.6%, 38.7% and 47.9%**; those are later-batch economics.

## MAX remaining cost uncertainty

The current implemented engineering draft supports a **$299** planning price at **40.5%** central gross margin. It needs bench validation of mux/ADC settling, reference/shunt/divider calibration, return-offset effects and the independent hardware current limit. The cited distributor stocks do not cover a 1,000-product build; source 20,000 connector pairs and protection switches, 5,000 amplifiers/muxes and 1,000 ADCs by RFQ. Published tiers are cost references, not allocations.

The [DEGSON manufacturer matching-parts list](https://ja.degson.com/content/details_552_1957864.html?lang=ja) confirms the 2EDGKDF-5.08 plug family mates with 2EDGRC-5.08 headers. [Header C669315](https://www.lcsc.com/product-detail/C669315.html) is $0.0759 at 4,800 and [plug C691852](https://www.lcsc.com/product-detail/C691852.html) $0.3327 at 1,000. Prices and exact CAD refer to the selected 3-pin 5.08 mm family; physical mating/temperature-rise tests remain required.

A future factory-programming-only option might remove FT2232HL and support, but that would alter field USB programming/UART functionality. It is not included in the current savings. The high-cost scenario still gives only12.2% at $299; supplier and assembly quotations are required before a public price commitment.

## Recompute

Run `python3 hardware/pricing/calculate.py`. Edit `hardware/pricing/assumptions.json` to change quantities, costs, prices or targets; generated `launch-prices.json` preserves the arithmetic and scenario margins. There are no external publication or purchasing actions in this script.
