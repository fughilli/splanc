// Uniform-keypoint HITL probe (hitl_fx_keypoints.py): every LED = tint * gain, so
// the analyzer reads the deck's uniforms straight off the wire.
uniform vec3 tint : color = 1.0, 0.0, 0.0;
uniform float gain : 0.0 .. 1.0 = 1.0;
void update() {}
vec3 shade(Led led) { return tint * gain; }
