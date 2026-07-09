/** SNTP-style sync math (§7.3) + ServerClock. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bestSample, ServerClock, syncSample } from "../src/net/clocksync";

test("offset/rtt from the §7.3 formulas", () => {
  // Server 1000 ms ahead; 10 ms each way; 2 ms server processing.
  const s = syncSample(100, 1110, 1112, 122);
  assert.equal(s.offsetMs, 1000);
  assert.equal(s.rttMs, 20);
});

test("asymmetric path skews offset by half the asymmetry (known SNTP property)", () => {
  // 5 ms out, 15 ms back, true offset 1000.
  const s = syncSample(100, 1105, 1105, 120);
  assert.equal(s.rttMs, 20);
  assert.equal(s.offsetMs, 995);
});

test("bestSample keeps the min-RTT sample", () => {
  const best = bestSample([
    { offsetMs: 990, rttMs: 44 },
    { offsetMs: 1000, rttMs: 6 },
    { offsetMs: 1015, rttMs: 80 },
  ]);
  assert.equal(best.offsetMs, 1000);
  assert.throws(() => bestSample([]));
});

test("ServerClock converts local to server time", () => {
  let t = 500;
  const clock = new ServerClock({ offsetMs: 250, rttMs: 4 }, () => t);
  assert.equal(clock.toServerTime(600), 850);
  assert.equal(clock.nowServerMs(), 750);
  t = 1000;
  assert.equal(clock.nowServerMs(), 1250);
  clock.update({ offsetMs: 300, rttMs: 2 });
  assert.equal(clock.nowServerMs(), 1300);
});
