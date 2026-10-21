/**
 * The CLI's pure half (src/cliArgs.ts): command -> tool mapping (the keypoint
 * commands mirror the MCP tools), the help text and the exit status.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { exitCode, parseArgs, toCall, USAGE } from "../src/cliArgs";

const call = (...argv: string[]) => toCall(parseArgs(argv));

test("keypoint commands map onto the keypoint MCP tools", () => {
  assert.deepEqual(call("list-keypoints"), { tool: "list_keypoints", args: {} });
  assert.deepEqual(call("list-keypoints", "--deck", "1", "--players", "Desk"), {
    tool: "list_keypoints",
    args: { deck: 1, players: "Desk" },
  });
  assert.deepEqual(call("save-keypoint", "dusk"), { tool: "save_keypoint", args: { name: "dusk" } });
  assert.deepEqual(call("save-keypoint", "storm", "rain=1", "tint=1,0,0"), {
    tool: "save_keypoint",
    args: { name: "storm", values: { rain: 1, tint: [1, 0, 0] } },
  });
  assert.deepEqual(call("get-keypoint", "dusk"), { tool: "get_keypoint", args: { name: "dusk" } });
  assert.deepEqual(call("recall-keypoint", "dusk", "--seconds", "10", "--commit"), {
    tool: "recall_keypoint",
    args: { name: "dusk", seconds: 10, commit: true },
  });
  assert.deepEqual(call("blend-keypoints", "calm=0.7", "storm=0.3", "--seconds", "15", "--color-mode", "hsv"), {
    tool: "blend_keypoints",
    args: { weights: { calm: 0.7, storm: 0.3 }, seconds: 15, color_mode: "hsv" },
  });
  assert.deepEqual(call("delete-keypoint", "dusk", "--players", "a,b"), {
    tool: "delete_keypoint",
    args: { name: "dusk", players: ["a", "b"] },
  });
  assert.throws(() => call("save-keypoint"), /missing keypoint name/);
  assert.throws(() => call("blend-keypoints"), /name=weight/);
  assert.throws(() => call("blend-keypoints", "calm=lots"), /must be a number/);
});

test("help lists every command, keypoints included", () => {
  for (const c of [
    "list-players",
    "deploy-effect",
    "list-keypoints",
    "save-keypoint",
    "get-keypoint",
    "recall-keypoint",
    "blend-keypoints",
    "delete-keypoint",
    "call <tool>",
  ]) {
    assert.ok(USAGE.includes(c), c);
  }
  assert.match(USAGE, /Exit status/);
  assert.throws(() => call("frobnicate"), /splanc-agent help/);
});

test("exit status: tool error / all failed = 1, some failed = 2, else 0", () => {
  const per = (...oks: boolean[]) =>
    JSON.stringify({ results: oks.map((ok, i) => ({ player: { id: `${i}`, name: `p${i}` }, ok })), summary: "" });
  assert.equal(exitCode(true, ["boom"]), 1);
  assert.equal(exitCode(false, [per(true, true)]), 0);
  assert.equal(exitCode(false, [per(false, false)]), 1, "every targeted player failed");
  assert.equal(exitCode(false, [per(true, false)]), 2, "partial failure");
  // align_time's shape: players[].ok
  assert.equal(exitCode(false, [JSON.stringify({ players: [{ ok: false }], time_base: "applied" })]), 1);
  // list_players' players carry no ok: not a failure.
  assert.equal(exitCode(false, [JSON.stringify({ players: [], rooms: {} })]), 0);
  assert.equal(exitCode(false, [JSON.stringify({ players: [{ name: "Desk" }] })]), 0);
  assert.equal(exitCode(false, ["not json", JSON.stringify({ level: 0.5 })]), 0);
});

test("export-map maps onto export_map", () => {
  assert.deepEqual(call("export-map"), { tool: "export_map", args: {} });
  assert.deepEqual(call("export-map", "--format", "lxf", "--up", "z", "--players", "Desk"), {
    tool: "export_map",
    args: { format: "lxf", up: "z", players: "Desk" },
  });
  assert.match(USAGE, /export-map/);
});

test("crossfade, deck and plot commands map onto their MCP tools", () => {
  assert.deepEqual(call("crossfade-to", "storm", "--seconds", "8", "--curve", "linear", "--color-mode", "hsv", "rain=0.5"), {
    tool: "crossfade_to",
    args: { effect_id: "storm", seconds: 8, curve: "linear", color_mode: "hsv", uniforms: { rain: 0.5 } },
  });
  assert.throws(() => call("crossfade-to"), /missing effect id/);
  assert.deepEqual(call("list-decks", "--players", "all"), { tool: "list_decks", args: { players: "all" } });
  assert.deepEqual(call("rollback-effect", "--seconds", "3"), { tool: "rollback_effect", args: { seconds: 3 } });
  assert.deepEqual(call("plot-fixture", "--color-by", "confidence", "--size", "512", "--no-labels"), {
    tool: "plot_fixture",
    args: { color_by: "confidence", size: 512, labels: false },
  });
  assert.ok(USAGE.includes("crossfade-to") && USAGE.includes("plot-fixture"));
});
