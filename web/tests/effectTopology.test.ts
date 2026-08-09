/**
 * effectTopology (src/fx/effectTopology.ts) — the classifier that decides whether
 * an effect renders on the flat 64×64 grid or on the virtual tree (FUG-80). Only
 * the topology led fields + graph intrinsics count; pos/uv/idx/count don't.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isTopologyAware } from "../src/fx/effectTopology";

test("spatial effects (pos / uv / time only) are NOT topology-aware", () => {
  assert.equal(isTopologyAware("vec3 shade(Led led){ return hsv2rgb(led.pos.y, 1.0, 1.0); }"), false);
  assert.equal(isTopologyAware("vec3 shade(Led led){ return sample(img, led.uv); }"), false);
  assert.equal(isTopologyAware("vec3 shade(Led led){ return vec3(led.idx / led.count); }"), false);
  assert.equal(isTopologyAware("void update(){} vec3 shade(Led led){ return base * glow; }"), false);
});

test("topology led fields make an effect topology-aware", () => {
  assert.equal(isTopologyAware("vec3 shade(Led led){ return vec3(led.s); }"), true);
  assert.equal(isTopologyAware("vec3 shade(Led led){ return vec3(led.dist); }"), true);
  assert.equal(isTopologyAware("vec3 shade(Led led){ return vec3(led.seg); }"), true);
  assert.equal(isTopologyAware("vec3 shade(Led led){ if (led.branch) return vec3(1.0); }"), true);
});

test("graph intrinsics make an effect topology-aware", () => {
  assert.equal(isTopologyAware("void update(){ flood_from(term(0)); }"), true);
  assert.equal(isTopologyAware("void update(){ int n = term_count(); }"), true);
  assert.equal(isTopologyAware("void update(){ int s = node_seg(0, 0); }"), true);
});

test("comments never trigger detection", () => {
  assert.equal(isTopologyAware("// rides led.dist and flood_from once wired\nvec3 shade(Led led){ return led.pos; }"), false);
  assert.equal(isTopologyAware("/* led.seg / term() TODO */ vec3 shade(Led led){ return sample(t, led.uv); }"), false);
});

test("led.s is distinguished from led.seg and led.pos", () => {
  // led.pos must not match the `s` field; led.seg is topology regardless.
  assert.equal(isTopologyAware("vec3 shade(Led led){ return led.pos * 2.0; }"), false);
  assert.equal(isTopologyAware("vec3 shade(Led led){ return vec3(led.seg); }"), true);
});
