# Offline PnR round viewer

Build from native diagnostic checkpoints (KiCad 10 CLI and Python bindings):

```sh
python3 hardware/tools/pnr_viewer/build.py \
  output/fresh-pnr-20260919/meridian99/expansion \
  --output output/pnr-viewer/meridian99.html
python3 -m http.server 8765 --bind 127.0.0.1 --directory output/pnr-viewer
```

Open http://127.0.0.1:8765/meridian99.html or open the generated HTML directly in a browser. The HTML is portable, embeds all data and native SVG plots, and needs no network or dependencies at viewing time. Native source boards are hash-checked unchanged after export.

Round changes preserve viewport and selections; Fit uses the union of all board bounds so expansion remains visible. Wheel zoom, drag pan, arrow keys switch rounds, and part search centres a footprint. Layer combinations, opacity, references, pad numbers, net labels, added traces and air wires are independent controls. Pads label selected layers; reference labels include all parts. Repeated net labels are spatially thinned; hover any selected-layer trace for its net and width.

Added traces subtract previous collinear coverage by net, layer and width (10 nm tolerance). This handles reversed and split segments. It is an absolute native-coordinate geometry comparison, not proof of new electrical connectivity: placement movement and rerouting count as additions. Baseline has no additions. Arc tracks fail explicitly pending supported arc comparison. Vias are in native plots but excluded from added-track highlighting.

Air wires use saved native DRC item positions; these may be representative points rather than nearest copper endpoints. All missing-connection links are shown regardless of selected layer. DRC JSON must be the saved report for the supplied checkpoint; builder does not rerun DRC. Native plots include original graphical text, independently of optional generated annotations.

Validation: `python3 -m unittest discover -s hardware/tools/pnr_viewer -p 'test_*.py'`. Three regression tests cover segment splitting/reversal, partial overlap and net/layer/width/position changes. The four-round Meridian99 output was checked in the in-app browser, including visual native/annotation registration, inner copper, added traces, air wires, part search and round switching. These are incomplete signal-stage experimental boards, not the best final electrical checkpoint.
