# XT30PW-M model alignment

The supplied STEP and footprint use different origins. Measured STEP pin axes:
main contacts (±2.5, 8.5)mm; mechanical posts (±5.5, -1.5)mm. Footprint pad
centres are (±2.5, -5)mm and (±5.5, 5)mm respectively in KiCad's y-down frame.
A model translation of (0, -3.5, 0)mm aligns all four axes after the model-to-PCB
y inversion. The previous imported offset (0, -1.01, 0) misplaced the model by
2.49mm. Rotation and scale remain zero and unity. This is a model-origin fix;
no pad geometry or circuit connections were changed.
