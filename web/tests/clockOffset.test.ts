/**
 * ClockOffset — mapping native capture timestamps into the performance.now()
 * clock the IMU and solver use (xr/nativeCaptureSource.ts).
 *
 * Regression cover for a real on-device failure: native frames carried CMTime
 * presentation timestamps (seconds since BOOT) while IMU samples carried
 * performance.now() (ms since the page's time origin). The solver trims IMU to
 * the frame span, so with the epochs unmapped it discarded every sample and died
 * with "too few IMU samples for a VIO solve".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ClockOffset } from "../src/xr/nativeCaptureSource";

test("maps a wildly different epoch onto the arrival clock", () => {
  const c = new ClockOffset();
  // Capture times are seconds-since-boot in ms (~14 hours up); arrivals are
  // page-relative ms. Zero delivery latency, so the mapping is exact.
  const boot = 50_000_000;
  assert.equal(c.map(boot, 1000), 1000);
  assert.equal(c.map(boot + 33, 1033), 1033);
});

test("takes the minimum latency, so one slow frame can't bias the run", () => {
  const c = new ClockOffset();
  // First frame arrives 100 ms late; a later one only 5 ms late. The true offset
  // is the smaller, and every subsequent frame should use it.
  c.map(1000, 1100); // offset 100
  c.map(1033, 1038); // offset 5 — better estimate
  // A frame captured at 1066 truly arrives ~1071; mapped time should track the
  // 5 ms estimate, not the 100 ms one.
  assert.equal(c.map(1066, 1200), 1071);
});

test("freezes after the settle window so later jitter can't shift the clock", () => {
  const c = new ClockOffset(2);
  c.map(0, 10);
  c.map(10, 20); // offset stays 10; window now full
  // An implausibly early arrival after settling must NOT re-anchor the clock.
  assert.equal(c.map(20, 0), 30);
});

test("apply() maps without refining, so IMU can't burn the settle window", () => {
  const c = new ClockOffset(2);
  // IMU samples ride along with a frame but were captured earlier, so their
  // apparent latency is not a latency. They must not vote on the estimate, and
  // must not consume the window either.
  c.apply(0);
  c.apply(0);
  c.apply(0);
  // The window is still open, so a real frame observation still sets the offset.
  assert.equal(c.map(1000, 1010), 1010);
  // ...and an IMU sample from 30 ms before that frame maps with the same offset.
  assert.equal(c.apply(970), 980);
});

test("mapped timestamps stay monotonic while the estimate improves", () => {
  const c = new ClockOffset();
  let prev = -Infinity;
  for (let i = 0; i < 40; i++) {
    const capture = i * 33;
    // Latency shrinks over the settle window — the case that moves the offset
    // downward — while capture advances 33 ms per frame.
    const latency = Math.max(5, 60 - i * 2);
    const t = c.map(capture, capture + latency);
    assert.ok(t > prev, `frame ${i}: ${t} not after ${prev}`);
    prev = t;
  }
});
