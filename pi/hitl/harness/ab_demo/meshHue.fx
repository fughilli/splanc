// Mesh M5 HITL (hitl_mesh_gateway.py): an effect small enough for ONE mesh packet (no
// uniforms: a uniform's manifest alone is ~250 B), deployed to every fixture through the
// gateway (mesh_send{submit_effect}) onto deck B.
void update() {}
vec3 shade(Led led) {
  fixed16 h = fract(fixed16(time) * fixed16(0.25));
  return hsv2rgb(h, fixed16(1.0), fixed16(1.0));
}
