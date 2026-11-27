// Host unit tests for the mesh's frame grid (mesh_grid.h).
#include "firmware/player_app/mesh_grid.h"

#include <cassert>

#include "rr_case.h"

using lm_grid::frame_k;
using lm_grid::kGridUs;
using lm_grid::pace_adjust;
using lm_grid::steer_mod;

static void test_frame_k_counts_grid_periods_whatever_the_rung() {
  assert(frame_k(10 * kGridUs) == 10);
  assert(frame_k(10 * kGridUs + kGridUs / 4 - 1) == 10);
  assert(frame_k(10 * kGridUs - kGridUs / 4 + 1) == 10);
  assert(frame_k(10 * kGridUs + kGridUs / 4) == -1);  // off the grid
  assert(frame_k(10 * kGridUs + kGridUs / 2) == -1);
  assert(frame_k(0) == -1);  // at or before the epoch
  assert(frame_k(-kGridUs) == -1);
  // D-519: two members 420 s after the epoch report the same k, one rendering at 80 fps and
  // one idle at the autoscaler's 30 fps default (which used to give 12614 vs 33637).
  const int64_t rel = 420LL * 1000 * 1000 + 300;
  assert(frame_k(rel) == 33600);
}

static void test_steer_mod_only_for_rungs_that_share_grid_points() {
  assert(steer_mod(12500) == kGridUs);  // 80 fps
  assert(steer_mod(25000) == kGridUs);  // 40 fps
  assert(steer_mod(50000) == kGridUs);  // 20 fps
  assert(steer_mod(6250) == 6250);      // 160 fps (the P4's tracker build)
  assert(steer_mod(33333) == 0);        // 30 fps: off the grid
  assert(steer_mod(13333) == 0);        // 75 fps
  assert(steer_mod(16666) == 0);        // 60 fps
  assert(steer_mod(0) == 0);
}

static void test_pace_adjust_pulls_the_next_start_onto_a_grid_point() {
  assert(pace_adjust(100 * kGridUs, 12500) == 0);
  assert(pace_adjust(100 * kGridUs + 1000, 12500) == 1000);    // late by 1 ms: start earlier
  assert(pace_adjust(100 * kGridUs - 1000, 12500) == -1000);   // early: start later
  assert(pace_adjust(100 * kGridUs + 5000, 12500) == kGridUs / 4);  // bounded per frame
  assert(pace_adjust(100 * kGridUs - 5000, 12500) == -kGridUs / 4);
  assert(pace_adjust(100 * kGridUs + 1000, 25000) == 1000);    // 40 fps lands on grid points
  assert(pace_adjust(1000 + 6250, 6250) == 1000);              // 160 fps: every other frame
  assert(pace_adjust(100 * kGridUs + 1000, 33333) == 0);       // 30 fps: no steering
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "mesh_grid",
                      {
                          {"frame_k_counts_grid_periods_whatever_the_rung",
                           test_frame_k_counts_grid_periods_whatever_the_rung},
                          {"steer_mod_only_for_rungs_that_share_grid_points",
                           test_steer_mod_only_for_rungs_that_share_grid_points},
                          {"pace_adjust_pulls_the_next_start_onto_a_grid_point",
                           test_pace_adjust_pulls_the_next_start_onto_a_grid_point},
                      });
}
