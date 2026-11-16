/** ui/taskPriority: the capture loop's prioritized main-thread tasks. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CoalescedTask, OrderedTaskQueue } from "../src/ui/taskPriority";

const turns = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test("an ordered queue runs every item, in order, one per task", async () => {
  const q = new OrderedTaskQueue();
  const ran: number[] = [];
  for (let i = 0; i < 5; i++) q.push(() => ran.push(i));
  assert.deepEqual(ran, [], "nothing runs synchronously");
  assert.equal(q.backlog, 5);
  await turns(20);
  assert.deepEqual(ran, [0, 1, 2, 3, 4]);
  assert.equal(q.maxBacklog, 5);
});

test("drain runs the backlog now; a throwing item doesn't stop the rest", () => {
  const q = new OrderedTaskQueue();
  const ran: number[] = [];
  const err = console.error;
  console.error = () => undefined;
  try {
    q.push(() => ran.push(1));
    q.push(() => {
      throw new Error("boom");
    });
    q.push(() => ran.push(3));
    q.drain();
  } finally {
    console.error = err;
  }
  assert.deepEqual(ran, [1, 3]);
  assert.equal(q.backlog, 0);
});

test("a coalesced task runs only the latest request", async () => {
  const t = new CoalescedTask(0);
  const ran: string[] = [];
  t.request(() => ran.push("a"));
  t.request(() => ran.push("b"));
  t.request(() => ran.push("c"));
  await turns(5);
  assert.deepEqual(ran, ["c"]);
  t.request(() => ran.push("d"));
  t.cancel();
  await turns(5);
  assert.deepEqual(ran, ["c"], "cancelled");
});

test("runIfStarved draws a starved overlay in the caller's task, once", async () => {
  let now = 0;
  const t = new CoalescedTask(80, "background", () => now);
  const ran: number[] = [];
  t.request(() => ran.push(1));
  // Never ran: starved by definition, so the busy stage draws it now.
  assert.equal(t.runIfStarved(250), true);
  assert.deepEqual(ran, [1]);
  // The scheduled background task finds nothing left to do.
  await turns(5);
  assert.deepEqual(ran, [1]);
  now = 100;
  t.request(() => ran.push(2));
  assert.equal(t.runIfStarved(250), false, "within the staleness bound it waits for its task");
  now = 400;
  t.request(() => ran.push(3)); // replaces 2: only the newest state is drawn
  assert.equal(t.runIfStarved(250), true);
  assert.deepEqual(ran, [1, 3]);
  assert.equal(t.runIfStarved(250), false, "nothing pending");
  await turns(5);
  assert.deepEqual(ran, [1, 3]);
});

test("an ordered queue reports how long its oldest item has waited", () => {
  let now = 0;
  const q = new OrderedTaskQueue("user-visible", () => now);
  assert.equal(q.oldestWaitMs, 0);
  q.push(() => undefined);
  now = 40;
  q.push(() => undefined);
  now = 300;
  assert.equal(q.oldestWaitMs, 300);
  q.drain();
  assert.equal(q.oldestWaitMs, 0);
});
