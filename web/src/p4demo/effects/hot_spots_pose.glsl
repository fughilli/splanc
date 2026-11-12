// Hot spots: up to four coloured points in the WORLD frame (metres). The fixture glows in
// each spot's colour, brighter the closer it gets (within `range`); the LEDs on the side
// facing a spot glow a little more, so the gradient also says which way it is. When the
// fixture's centre is inside a spot (`radius`), the whole fixture blinks in that colour.
// The fixture's pose comes from the uniform pool (`pose` = world <- fixture map, the P4
// tracker module; the map is centred on the fixture). A spot with colour 0 is off.
uniform mat4 pose;                                  // pool-driven: world <- fixture map frame
uniform float tracker_ok : 0.0 .. 1.0 = 0.0;        // pool-driven: 1 while tracking
uniform vec3 spot0 : -5.0 .. 5.0 = vec3(-0.15, -0.15, 0.06);      // spot centres (m, world)
uniform vec3 spot1 : -5.0 .. 5.0 = vec3(0.15, -0.40, 0.06);
uniform vec3 spot2 : -5.0 .. 5.0 = vec3(0.45, -0.15, 0.06);
uniform vec3 spot3 : -5.0 .. 5.0 = vec3(0.15, 0.10, 0.06);
uniform vec3 color0 = vec3(1.0, 0.0, 0.0);          // their colours
uniform vec3 color1 = vec3(0.0, 1.0, 0.0);
uniform vec3 color2 = vec3(0.0, 0.2, 1.0);
uniform vec3 color3 = vec3(1.0, 0.7, 0.0);
uniform float range : 0.05 .. 2.0 = 0.4;            // m: a spot starts to show this far away
uniform float radius : 0.01 .. 0.3 = 0.05;          // m: inside this, it's a hit
uniform float rate : 0.5 .. 10.0 = 4.0;             // blinks per second on a hit
uniform float dim : 0.0 .. 0.2 = 0.02;              // not tracking: a faint outline

state float blink;
state vec3 hitc;  // the colour of the spot the fixture is in (0: none)

void update() {
  blink = fract(blink + dt * rate);
  vec3 c = pose[3].xyz;
  hitc = vec3(0.0, 0.0, 0.0);
  if (length(c - spot3) < radius) { hitc = color3; }
  if (length(c - spot2) < radius) { hitc = color2; }
  if (length(c - spot1) < radius) { hitc = color1; }
  if (length(c - spot0) < radius) { hitc = color0; }
}

// How much of a spot's colour an LED at world position p shows: 0 beyond `range`, 1 at
// the spot's edge, squared so the last few centimetres stand out.
float near(vec3 p, vec3 s) {
  float k = clamp(1.0 - (length(p - s) - radius) / range, 0.0, 1.0);
  return k * k;
}

vec3 shade() {
  if (tracker_ok < 0.5) {
    return vec3(dim, dim, dim);
  }
  if (dot(hitc, hitc) > 0.0) {
    return hitc * step(0.5, blink);
  }
  vec3 p = (pose * vec4(led.pos, 1.0)).xyz;
  vec3 col = color0 * near(p, spot0) + color1 * near(p, spot1) + color2 * near(p, spot2) + color3 * near(p, spot3);
  return min(col, vec3(1.0, 1.0, 1.0));
}
