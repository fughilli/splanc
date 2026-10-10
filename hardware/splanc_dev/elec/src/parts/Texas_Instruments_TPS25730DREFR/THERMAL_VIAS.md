# Ground-pad thermal vias

Pad 39 receives 4 explicit plated 0.20 mm drill / 0.45 mm copper lands.
They share the electrical pad number and have no solder-mask or paste openings
of their own. The top is within the exposed pad's mask opening; the bottom is
tented. The original full-pad paste aperture is replaced by 4 windows
that avoid directly printing paste over the drilled holes.

These are intentional package thermal/ground connections, not general-purpose
signal via-in-pad. Confirm the fabricator's 0.20 mm plated-hole and tenting process,
and inspect solder coverage/voiding during prototype assembly. A filled/capped
process is an alternative if the assembler requires it; it is not assumed here.

References: the matching TI package drawing and layout recommendations in the
TPS25730DREFR data sheet. Dimensions and aperture coordinates are explicit
in the footprint. The unusually narrow TPS552882 PGND land has one via; high
current must also reach its outer PGND pin through the local power layout.
