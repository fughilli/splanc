// Mesh M5 HITL (hitl_mesh_gateway.py): deck A on every fixture, with one slider (`gain`) the
// gateway moves on all of them at once.
uniform float gain : 0.0 .. 1.0 = 1.0;
void update() {}
vec3 shade(Led led) { return vec3(0.1, 0.3, 1.0) * gain; }
