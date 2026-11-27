// The mesh's frame grid (mesh M4): with the show time base set, frame k of the mesh starts
// at epoch + k * kGridUs on every member. One period for the whole mesh, whatever each
// member's autoscaler rung: a rung follows the effect's cost, resets to its default while
// nothing renders (power off, a new effect) and runs past 80 fps on the P4's tracker build,
// so a grid taken from it differs between members (D-519 bench: the P4, off, at 30 fps,
// against a C6 at 80). A member on a rung whose period is a multiple or a divisor of the grid
// (80, 40, 20, 160 fps) is steered onto grid points; any other rung stays off the grid and
// applies scheduled changes on plain time, as an off-grid frame always did.
#pragma once

#include <stdint.h>

namespace lm_grid {

// 80 fps: the C6's top rung.
constexpr int64_t kGridUs = 12500;

// The grid frame a frame starting `rel_us` after the epoch is on, or -1 when it starts a
// quarter grid period or more away from every grid point (or before the epoch).
inline int64_t frame_k(int64_t rel_us) {
  if (rel_us <= 0) return -1;
  const int64_t k = (rel_us + kGridUs / 2) / kGridUs;
  const int64_t e = rel_us - k * kGridUs;
  if (e >= kGridUs / 4 || e <= -kGridUs / 4) return -1;
  return k;
}

// The spacing of the grid points a rung of `period_us` can land on: the grid's when the rung
// is a whole number of grid periods, the rung's own when the grid is a whole number of rung
// periods, 0 (no steering) otherwise.
inline int64_t steer_mod(uint32_t period_us) {
  if (period_us == 0) return 0;
  if (period_us % kGridUs == 0) return kGridUs;
  if (kGridUs % period_us == 0) return period_us;
  return 0;
}

// How much earlier (> 0) or later (< 0) the next frame should start, `rel_us` after the
// epoch as now planned, to land on a grid point: at most a quarter of the steering spacing
// per frame, so the cadence never jumps.
inline int64_t pace_adjust(int64_t rel_us, uint32_t period_us) {
  const int64_t m = steer_mod(period_us);
  if (m == 0) return 0;
  int64_t e = rel_us % m;
  if (e < 0) e += m;
  if (e > m / 2) e -= m;  // e > 0: the next start would be late by e
  if (e > m / 4) e = m / 4;
  if (e < -m / 4) e = -m / 4;
  return e;
}

}  // namespace lm_grid
