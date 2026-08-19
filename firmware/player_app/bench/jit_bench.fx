// FUG-125 on-device JIT bench effect. shade() is a long straight-line
// fixed-point arithmetic chain over fixed locals (many MulFix/AddI/SubI, plus
// the TeeLocal reloads the optimizer emits) — exactly the hot integer/fixed
// block the device JIT lowers to one native RV32 segment. The inputs are the
// per-LED fixed context (led.pos/led.s via LoadCtxFix), so there is no soft
// float in the hot chain and the whole body is JIT-able. Read the on-device
// A/B over HITL: `hitl flash --monitor …:esp32c6_fxjitbench_flashbundle`.
void update() {}
vec3 shade(Led led) {
  fixed a = fixed(led.pos.x);
  fixed b = fixed(led.pos.y);
  fixed c = fixed(led.s);
  fixed r = a * b + b * c - c * a + a * a + b * b + c * c;
  fixed t = r * a - r * b + r * c + a * b * c;
  fixed u = t * r + t * a - t * b + t * c - r * r;
  fixed v = u * a + u * b + u * c - t * a + r * c;
  return vec3(float(v), 0.2, 0.5);
}
