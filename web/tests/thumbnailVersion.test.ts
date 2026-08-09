/**
 * Thumbnail engine versioning (src/store/mapStore.ts). A framing change to the
 * thumbnail renderer (FUG-81: drop grid/triad, zoom to fit) must retire already-
 * cached thumbnails, otherwise maps whose thumbnail was rendered by the old
 * engine keep showing the grid/triad forever. isThumbnailStale is the predicate
 * the map browser uses to decide whether to re-render on view.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isThumbnailStale, THUMBNAIL_ENGINE_VERSION } from "../src/store/mapStore";

test("a thumbnail from the current engine is fresh", () => {
  assert.equal(isThumbnailStale({ thumbnailVersion: THUMBNAIL_ENGINE_VERSION }), false);
});

test("a pre-versioning thumbnail (no version) is stale", () => {
  // The grid/triad era stored no version — an absent version must read as stale
  // so it gets re-rendered with the new framing.
  assert.equal(isThumbnailStale({}), true);
});

test("a thumbnail from an older engine version is stale", () => {
  assert.equal(isThumbnailStale({ thumbnailVersion: THUMBNAIL_ENGINE_VERSION - 1 }), true);
});
