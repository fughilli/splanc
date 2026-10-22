// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p08 status=ok calls=3
// request: lava lamp blobs
// Lava lamp: four metaball blobs of hot wax rise and sink in amber oil.
// Blobs dwell at top (cooling, about to sink) and bottom (reheating, about to
// rise) — the asymmetric pause of a real lava lamp — with lazy horizontal
// drift inside the cylinder.  Blobs merge smoothly when they meet.
// All geometry uses led.uv.y for height so the effect is independent of the
// mapping origin.

uniform vec3  blob_color  : color = 1.0, 0.28, 0.02;   // wax: orange-red
uniform vec3  fluid_color : color = 0.45, 0.10, 0.0;   // oil: dark amber
uniform float blob_size   : 0.03 .. 0.12 = 0.065;      // blob radius (m)
uniform float speed       : 0.1 .. 2.0 = 0.4;          // rise/fall speed
uniform float crispness   : 0.5 .. 4.0 = 1.2;          // edge sharpness vs. merge

// Four blob centres (metres in lamp frame, Y relative to base)
state vec4 bx;
state vec4 bhy;
state vec4 bz;

void update() {
  float t = time * speed;
  float r = 0.048;   // horizontal drift radius — keeps blobs inside 0.08 m cylinder

  float p0 = t * 0.43 + 0.00;
  float p1 = t * 0.37 + 2.09;
  float p2 = t * 0.31 + 4.19;
  float p3 = t * 0.52 + 1.05;

  // smoothstep( normalised sine ) gives cubic ease-in/out at 0 and 1:
  // derivative is zero when sin == ±1, so blobs genuinely pause at top
  // (freshly risen, cooling) and bottom (reheated, about to ascend).
  bhy = vec4(
    smoothstep(0.0, 1.0, (sin(p0) + 1.0) * 0.5) * 0.26 + 0.02,
    smoothstep(0.0, 1.0, (sin(p1) + 1.0) * 0.5) * 0.26 + 0.02,
    smoothstep(0.0, 1.0, (sin(p2) + 1.0) * 0.5) * 0.26 + 0.02,
    smoothstep(0.0, 1.0, (sin(p3) + 1.0) * 0.5) * 0.26 + 0.02
  );

  // Slow lateral wobble — incommensurable multipliers so it never repeats
  bx = vec4(
    sin(p0 * 1.31 + 0.00) * r,
    sin(p1 * 1.31 + 1.57) * r,
    sin(p2 * 1.31 + 3.14) * r,
    sin(p3 * 1.31 + 4.71) * r
  );

  bz = vec4(
    cos(p0 * 1.13 + 0.00) * r,
    cos(p1 * 1.13 + 2.09) * r,
    cos(p2 * 1.13 + 4.19) * r,
    cos(p3 * 1.13 + 0.52) * r
  );
}

vec3 shade(Led led) {
  float sz2 = blob_size * blob_size;

  // Use led.uv.y * lamp_height for Y so the maths is in metres but
  // origin-independent (works whatever Y the mapping chose for the base).
  float px = led.pos.x;
  float py = led.uv.y * 0.30;
  float pz = led.pos.z;

  // Metaball potential: field > 1 → inside at least one blob-radius sphere.
  // Epsilon 0.0002 prevents division-by-zero when a LED is exactly on centre.
  float dx0 = px - bx.x;  float dy0 = py - bhy.x;  float dz0 = pz - bz.x;
  float dx1 = px - bx.y;  float dy1 = py - bhy.y;  float dz1 = pz - bz.y;
  float dx2 = px - bx.z;  float dy2 = py - bhy.z;  float dz2 = pz - bz.z;
  float dx3 = px - bx.w;  float dy3 = py - bhy.w;  float dz3 = pz - bz.w;

  float f0 = sz2 / (dx0*dx0 + dy0*dy0 + dz0*dz0 + 0.0002);
  float f1 = sz2 / (dx1*dx1 + dy1*dy1 + dz1*dz1 + 0.0002);
  float f2 = sz2 / (dx2*dx2 + dy2*dy2 + dz2*dz2 + 0.0002);
  float f3 = sz2 / (dx3*dx3 + dy3*dy3 + dz3*dz3 + 0.0002);
  float field = f0 + f1 + f2 + f3;

  // Soft isosurface at field == 1.  crispness widens/narrows the transition:
  // low crispness → blobs bleed into each other; high → hard candy-like edges.
  float hw     = 0.5 / crispness;   // hw in [0.125, 1.0] for range [0.5, 4.0]
  float inside = smoothstep(1.0 - hw, 1.0 + hw, field);

  // Blob temperature follows height: yellow-hot near the top where wax just
  // arrived, deep red near the bottom where it has cooled and sunk.
  float ht         = led.uv.y;
  vec3 blob_top    = vec3(1.0, 0.82, 0.10);
  vec3 blob_bottom = vec3(0.65, 0.03, 0.01);
  vec3 bclr = mix(blob_bottom, mix(blob_color, blob_top, ht), ht);

  // Fluid is almost dark, but warms to amber near active blobs (heat conduction
  // through the glass) and brightens very slightly toward the top (rising heat).
  float heat = clamp(field * 0.20, 0.0, 1.0);
  vec3 fclr  = fluid_color * (0.12 + 0.22 * ht + heat);

  return mix(fclr, bclr, inside);
}
