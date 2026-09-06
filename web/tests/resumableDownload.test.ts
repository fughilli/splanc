/**
 * Resumable download — the pure planning helpers (the OPFS/network runtime is
 * browser-only and validated on-device). These decide correctness: the resume
 * key, the Range header, Content-Range parsing, and the status→action mapping
 * that drives resume vs. restart vs. complete.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  keyFor,
  rangeHeader,
  parseContentRangeTotal,
  actionForStatus,
  backoffMs,
} from "../src/effects/ai/resumableDownload";

test("keyFor is stable, unique, and filesystem-safe", () => {
  const a = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
  const b = "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf";
  assert.equal(keyFor(a), keyFor(a)); // stable
  assert.notEqual(keyFor(a), keyFor(b)); // distinct URLs → distinct keys
  assert.match(keyFor(a), /^[a-z0-9._-]+$/i); // safe filename chars only
  assert.ok(keyFor(a).includes("q4_k_m.gguf")); // readable tail
});

test("rangeHeader resumes from the given offset", () => {
  assert.equal(rangeHeader(0), "bytes=0-");
  assert.equal(rangeHeader(1048576), "bytes=1048576-");
});

test("parseContentRangeTotal extracts the total size", () => {
  assert.equal(parseContentRangeTotal("bytes 200-1000/1001"), 1001);
  assert.equal(parseContentRangeTotal("bytes 0-0/5"), 5);
  assert.equal(parseContentRangeTotal("bytes */1234"), 1234);
  assert.equal(parseContentRangeTotal(null), null);
  assert.equal(parseContentRangeTotal("bytes 0-9/*"), null); // unknown total
});

test("actionForStatus maps HTTP status → resume/restart/complete/error", () => {
  // Resuming from a checkpoint (from > 0):
  assert.equal(actionForStatus(206, 500), "resume"); // partial content → append
  assert.equal(actionForStatus(200, 500), "restart"); // server ignored Range / file changed
  assert.equal(actionForStatus(416, 500), "complete"); // range past EOF → already done
  assert.equal(actionForStatus(500, 500), "error");
  // 416 with no checkpoint is nonsensical → error (nothing to complete):
  assert.equal(actionForStatus(416, 0), "error");
});

test("backoffMs grows exponentially and caps", () => {
  assert.equal(backoffMs(1), 500);
  assert.equal(backoffMs(2), 1000);
  assert.equal(backoffMs(3), 2000);
  assert.ok(backoffMs(20) <= 15_000); // capped
  assert.equal(backoffMs(20), 15_000);
});
