// Tilt liquid + shake flash: the fixture is a glass of light. LEDs below a
// surface that stays level with the floor glow `liquid`, the rest `air`; tip
// the lamp and the surface sloshes level again. Shake it (or tap it) and it
// flashes white.
//
// The imu_* uniforms are the player's motion-sensor pool (read_sensors): on a
// player with an IMU the firmware writes them every frame, BY NAME. Without
// one they are ordinary knobs — drag imu_gravity to simulate a tilt.
uniform vec3  imu_gravity = 0.0, -1.0, 0.0;     // unit DOWN vector, map frame (+Y up)
uniform float imu_shake : 0.0 .. 1.0 = 0.0;      // 0..1
uniform float imu_tap   : 0.0 .. 1000.0 = 0.0;   // tap counter
uniform float level     : 0.0 .. 1.0 = 0.5;      // how full the glass is
uniform vec3  liquid    : color = 0.0, 0.45, 1.0;
uniform vec3  air       : color = 0.06, 0.0, 0.1;

state float flash;
state float last_tap;

void update() {
  if (imu_tap != last_tap) {
    flash = 1.0;
    last_tap = imu_tap;
  }
  flash = max(flash - dt * 2.5, imu_shake);
}

vec3 shade(Led led) {
  // Depth of this LED along gravity, -1 (top) .. 1 (bottom), over the fixture's
  // room-frame box (the map itself until the fixture is posed in a room).
  vec3 c = (room.min + room.max) * 0.5;
  float r = max(length(room.max - room.min) * 0.5, 0.01);
  float d = dot(led.room - c, imu_gravity) / r;
  float wet = smoothstep(-0.06, 0.06, d - (1.0 - 2.0 * level));
  vec3 col = mix(air, liquid, wet);
  return mix(col, vec3(1.0, 1.0, 1.0), flash);
}
