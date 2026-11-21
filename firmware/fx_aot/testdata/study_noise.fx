// Noise field: slowly moving value noise over 3-D position (meters), mapped
// between two colours. A good base for "fire", "water", "aurora" moods.
uniform float scale    : 0.5 .. 10.0 = 3.0;
uniform float speed    : 0.0 .. 2.0 = 0.3;
uniform vec3  low      : color = 0.0, 0.05, 0.2;
uniform vec3  high     : color = 0.1, 0.9, 0.6;
uniform float contrast : 0.5 .. 3.0 = 1.5;

state float z;

void update() {
  z = time * speed;
}

vec3 shade(Led led) {
  vec3 p = led.pos * scale + vec3(0.0, z, z * 0.5);
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), u.x);
  float b = mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), u.x);
  float c = mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), u.x);
  float d = mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), u.x);
  float n = mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
  float t = clamp((n - 0.5) * contrast + 0.5, 0.0, 1.0);
  return mix(low, high, t);
}
