# Current MAX procurement budget

Run `python3 hardware/splanc_max/costing/estimate.py` to regenerate BOM CSV/JSON and summary. Current revision: DEGSON3-pin connector pairs, shared MCP3208, five quad INA4180 amplifiers, five4051 muxes and20precision shunts. Generated circuits:52LV/317power/3bridge components.

Central BOM$112.78; PCB/assembly/test$27.70; PCBA set$140.48 before component overage, shell and packaging. All amounts USD,1000sets,21September2026. Extra127power placements add$3 and calibration/test adds$2 in the central assembly budget. This is a grouped engineering budget with explicit reserves, not an exact quoted procurement basket. Source stock does not cover the intended build.

Launch-costing adds3% component reserve,$9shell,$22tooling allocation and$3packaging:$177.86; proposed$299 gives40.5% gross margin excludingPi. See `docs/hardware/launch-pricing.md`.

`historical-pre-costdown-2026-09-21/` preserves the previous generic-connector/AD7490 input and generated outputs. No historical file is an active price recommendation. No procurement, manufacturing or publication has occurred.
