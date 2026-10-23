// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p02 status=ok calls=1
// request: campfire embers with occasional sparks
// Campfire embers with occasional sparks.
// A glowing ember bed at the bottom of the lamp flickers LED by LED, deep red
// through orange. Now and then a bright spark rises up the cylinder, swirls
// a little, and fades out before it reaches the top.

uniform float heat        : 0.05 .. 1.0 = 0.6;    // how high the ember glow reaches
uniform float flicker     : 0.0 .. 1.0 = 0.6;     // flicker depth
uniform float flick_speed : 0.1 .. 4.0 = 1.2;     // flicker rate
uniform float sparks      : 0.0 .. 3.0 = 0.7;     // new sparks per second (per slot)
uniform float rise        : 0.03 .. 0.6 = 0.15;   // spark rise speed, m/s
uniform float spark_size  : 0.005 .. 0.05 = 0.02; // spark radius, metres
uniform float swirl       : 0.0 .. 3.0 = 0.8;     // spark sideways drift, rad/s
uniform vec3  ember       : color = 1.0, 0.12, 0.01;
uniform vec3  flame       : color = 1.0, 0.5, 0.08;
uniform vec3  spark_col   : color = 1.0, 0.75, 0.35;
uniform float brightness  : 0.0 .. 1.0 = 1.0;

state float miny;
state float inv_h;
state float inv_s2;

state float ang0; state float y0; state float l0; state vec3 sp0;
state float ang1; state float y1; state float l1; state vec3 sp1;
state float ang2; state float y2; state float l2; state vec3 sp2;
state float ang3; state float y3; state float l3; state vec3 sp3;

void update() {
  vec3 c = (room.min + room.max) * 0.5;
  float hgt = max(room.max.y - room.min.y, 0.01);
  float rad = max((room.max.x - room.min.x) * 0.5, 0.01);
  miny = room.min.y;
  inv_h = 1.0 / hgt;
  inv_s2 = 1.0 / (spark_size * spark_size);
  float f = float(frame);
  float p = sparks * dt;

  // spark 0
  if (l0 <= 0.0) {
    if (hash(f * 0.731 + 1.0) < p) {
      ang0 = hash(f * 1.37 + 11.0) * 6.2832; y0 = hgt * 0.05; l0 = 1.0;
    }
  } else {
    y0 = y0 + rise * dt; ang0 = ang0 + swirl * dt;
    l0 = 1.0 - y0 * inv_h * 1.2;
  }
  sp0 = vec3(c.x + rad * cos(ang0), miny + y0, c.z + rad * sin(ang0));

  // spark 1
  if (l1 <= 0.0) {
    if (hash(f * 0.913 + 2.0) < p) {
      ang1 = hash(f * 1.71 + 23.0) * 6.2832; y1 = hgt * 0.05; l1 = 1.0;
    }
  } else {
    y1 = y1 + rise * 1.3 * dt; ang1 = ang1 - swirl * 0.7 * dt;
    l1 = 1.0 - y1 * inv_h * 1.3;
  }
  sp1 = vec3(c.x + rad * cos(ang1), miny + y1, c.z + rad * sin(ang1));

  // spark 2
  if (l2 <= 0.0) {
    if (hash(f * 0.577 + 3.0) < p) {
      ang2 = hash(f * 2.11 + 37.0) * 6.2832; y2 = hgt * 0.08; l2 = 1.0;
    }
  } else {
    y2 = y2 + rise * 0.8 * dt; ang2 = ang2 + swirl * 1.2 * dt;
    l2 = 1.0 - y2 * inv_h * 1.4;
  }
  sp2 = vec3(c.x + rad * cos(ang2), miny + y2, c.z + rad * sin(ang2));

  // spark 3
  if (l3 <= 0.0) {
    if (hash(f * 0.661 + 4.0) < p) {
      ang3 = hash(f * 2.53 + 51.0) * 6.2832; y3 = hgt * 0.03; l3 = 1.0;
    }
  } else {
    y3 = y3 + rise * 1.1 * dt; ang3 = ang3 - swirl * dt;
    l3 = 1.0 - y3 * inv_h * 1.15;
  }
  sp3 = vec3(c.x + rad * cos(ang3), miny + y3, c.z + rad * sin(ang3));
}

float spark(vec3 p, vec3 sp, float life) {
  if (life <= 0.0) { return 0.0; }
  vec3 d = p - sp;
  return max(1.0 - dot(d, d) * inv_s2, 0.0) * life;
}

vec3 shade(Led led) {
  float h = clamp((led.room.y - miny) * inv_h, 0.0, 1.0);

  // ember bed: strong at the bottom, fading upward
  float bed = clamp(1.0 - h / heat, 0.0, 1.0);

  // per-LED flicker from two detuned sines with random phases
  float id = float(led.idx);
  float r1 = hash(id);
  float r2 = hash(id + 17.0);
  float fs = time * flick_speed;
  float fl = 0.5 + 0.25 * sin(fs * (1.0 + 2.0 * r1) + r1 * 6.2832)
                  + 0.25 * sin(fs * (2.3 + 3.0 * r2) + r2 * 6.2832);
  // a slow wave of heat rolling around the bed
  fl = fl * (0.75 + 0.25 * sin(led.room.x * 40.0 + led.room.z * 30.0 - fs * 0.7));

  float t = bed * (1.0 - flicker + flicker * fl);
  vec3 col = mix(ember, flame, t * t) * (t * 0.95 + 0.02 * bed);

  float s = spark(led.room, sp0, l0) + spark(led.room, sp1, l1)
          + spark(led.room, sp2, l2) + spark(led.room, sp3, l3);

  return clamp(col + spark_col * s, 0.0, 1.0) * brightness;
}
