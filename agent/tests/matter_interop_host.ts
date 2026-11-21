/**
 * Interop host (tools/matter_interop/README.md; not a CI test): the real hub + HubLamps +
 * MatterBridge on UDP 5540 against a fake TLS lamp, held open for an external Matter
 * controller (the CHIP SDK's Python controller). Writes $INTEROP_DIR/code.json (the
 * bridge's status) and lamp.json (what the lamp received); exits on $INTEROP_DIR/stop.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HubLamps } from "../src/bridge/lamps";
import { MatterBridge } from "../src/bridge/matter";
import { Hub } from "../src/hub";
import { FakePlayer } from "./fakePlayer";

const OUT = process.env["INTEROP_DIR"]!;
test("interop host", { timeout: 600_000 }, async () => {
  const S = mkdtempSync(join(tmpdir(), "splanc-interop-"));
  process.env["SPLANC_CONFIG_DIR"] = join(S, "config");
  process.env["SPLANC_CACHE_DIR"] = join(S, "cache");
  const player = new FakePlayer({ name: "Coil", mac: "CC:FD:49:00:00:C1" });
  await player.start();
  player.serveManifest();
  const hub = new Hub({ root: "", hosts: [player.host], mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined, registryDeps: { sweepHosts: () => [] } });
  let matter: MatterBridge | null = null;
  const lamps = new HubLamps(hub, { active: () => matter?.status().commissioned === true, log: console.error, tickMs: 2000 });
  matter = new MatterBridge({ lamps, stateDir: S, port: 5540, log: console.error });
  lamps.start();
  await matter.start();
  await new Promise((r) => setTimeout(r, 3000));
  writeFileSync(join(OUT, "code.json"), JSON.stringify(matter.status()));
  const t0 = Date.now();
  const seen: string[] = [];
  while (Date.now() - t0 < 300_000) {
    await new Promise((r) => setTimeout(r, 500));
    const b = player.received.filter((m) => m.type === "set_brightness").map((m) => String(m["brightness"]));
    if (b.join() !== seen.join()) {
      seen.splice(0, seen.length, ...b);
      writeFileSync(join(OUT, "lamp.json"), JSON.stringify({ brightness: b, status: matter.status() }));
    }
    try {
      const { existsSync } = await import("node:fs");
      if (existsSync(join(OUT, "stop"))) break;
    } catch {}
  }
  lamps.stop();
  await matter.stop();
  hub.close();
  await player.stop();
});
