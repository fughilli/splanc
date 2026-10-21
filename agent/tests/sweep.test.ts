/**
 * Which hosts the LAN sweep probes (registry.ts localSweepHosts). Regression: on
 * a machine running Tailscale (tailscale0 100.x.y.z/32) the sweep probed the /24
 * "around" that address: 254 SYNs into the tailnet, after which every new
 * outbound TCP connection on the machine hung for ~70 s (seen as a 134 s
 * list_players through the cloud relay, from a client on the bridge's machine).
 * Only on-link LANs are swept now.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { localSweepHosts } from "../src/registry";

const v4 = (address: string, netmask: string, internal = false) => ({ address, netmask, family: "IPv4", internal });
const lo = [v4("127.0.0.1", "255.0.0.0", true)];
const subnets = (hosts: string[]) => [...new Set(hosts.map((h) => h.split(".").slice(0, 3).join(".")))];

describe("localSweepHosts", () => {
  test("a Tailscale /32 is not swept (the container that stalled: docker eth0 + tailscale0)", () => {
    const hosts = localSweepHosts({
      lo,
      eth0: [v4("172.17.0.2", "255.255.0.0")],
      tailscale0: [v4("100.81.107.46", "255.255.255.255")],
    });
    assert.deepEqual(subnets(hosts), ["172.17.0"]);
    assert.equal(hosts.length, 253);
    assert.ok(!hosts.includes("172.17.0.2"), "never itself");
    assert.ok(!hosts.some((h) => h.startsWith("100.")));
  });

  test("CGNAT (100.64.0.0/10), point-to-point and tunnel interfaces are skipped", () => {
    const hosts = localSweepHosts({
      // Tailscale on macOS / a renamed interface: still the CGNAT range.
      en5: [v4("100.101.7.9", "255.192.0.0")],
      wg0: [v4("10.8.0.2", "255.255.255.0")],
      utun3: [v4("10.9.0.2", "255.255.255.0")],
      ppp0: [v4("10.10.0.2", "255.255.255.254")],
      eth1: [v4("192.0.2.7", "255.255.255.255")],
    });
    assert.deepEqual(hosts, []);
  });

  test("a skipped tunnel does not use up the two-LAN cap", () => {
    const hosts = localSweepHosts({
      tailscale0: [v4("100.81.107.46", "255.255.255.255")],
      wg0: [v4("10.8.0.2", "255.255.255.0")],
      wlan0: [v4("192.168.1.20", "255.255.255.0")],
      eth0: [v4("10.0.0.5", "255.255.0.0")],
      eth1: [v4("10.1.0.5", "255.255.255.0")],
    });
    assert.deepEqual(subnets(hosts), ["192.168.1", "10.0.0"]);
  });

  test("a subnet smaller than a /24 is swept as itself, a larger one as the /24 around the address", () => {
    const small = localSweepHosts({ wlan0: [v4("192.168.4.37", "255.255.255.240")] });
    // 192.168.4.32/28: .33-.46, less this machine's .37.
    const want = Array.from({ length: 14 }, (_, i) => `192.168.4.${33 + i}`).filter((h) => h !== "192.168.4.37");
    assert.deepEqual(small, want);
    const big = localSweepHosts({ eth0: [v4("10.20.30.40", "255.255.0.0")] });
    assert.equal(big.length, 253);
    assert.equal(big[0], "10.20.30.1");
    assert.equal(big.at(-1), "10.20.30.254");
  });

  test("two addresses in one /24 sweep it once, skipping both", () => {
    const hosts = localSweepHosts({
      eth0: [v4("192.168.1.20", "255.255.255.0")],
      wlan0: [v4("192.168.1.21", "255.255.255.0")],
    });
    assert.equal(hosts.length, 252);
    assert.ok(!hosts.includes("192.168.1.21"));
    assert.deepEqual(subnets(hosts), ["192.168.1"]);
  });
});
