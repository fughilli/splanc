/** Reconnect-aware flasher connect retry ("first flash sometimes fails"). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONNECT_PLAN,
  PortLostError,
  RESET_THEN_REOPEN_PLAN,
  appResetSequence,
  connectPlanFor,
  connectWithReconnect,
  waitForPort,
  type ConnectMode,
  type PortInfoLike,
  type SerialLike,
  type WaitTiming,
} from "../src/flash/reconnect";

const C6: PortInfoLike = { usbVendorId: 0x303a, usbProductId: 0x1001 };
const CP210X: PortInfoLike = { usbVendorId: 0x10c4, usbProductId: 0xea60 };

class FakePort {
  constructor(
    readonly name: string,
    private readonly info: PortInfoLike = C6,
  ) {}
  getInfo(): PortInfoLike {
    return this.info;
  }
}

/** navigator.serial stand-in: a mutable granted-port list + disconnect events. */
class FakeSerial implements SerialLike<FakePort> {
  ports: FakePort[] = [];
  getPortsCalls = 0;
  /** Called on each getPorts(), so a test can make a device (re)appear. */
  onGetPorts: (call: number) => void = () => {};
  private listeners = new Set<(ev: Event) => void>();
  getPorts(): Promise<FakePort[]> {
    this.onGetPorts(++this.getPortsCalls);
    return Promise.resolve([...this.ports]);
  }
  addEventListener(_type: "disconnect", l: (ev: Event) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_type: "disconnect", l: (ev: Event) => void): void {
    this.listeners.delete(l);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  disconnect(port: FakePort): void {
    this.ports = this.ports.filter((p) => p !== port);
    for (const l of [...this.listeners]) l({ target: port } as unknown as Event);
  }
}

/** Instant fake clock: records requested sleeps instead of waiting. */
function fakeTiming(over: Partial<WaitTiming> = {}): WaitTiming & { slept: number[] } {
  const slept: number[] = [];
  return {
    settleMs: 1000,
    reappearMs: 2000,
    pollMs: 250,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    ...over,
    slept,
  };
}

interface Harness {
  calls: { port: FakePort; mode: ConnectMode }[];
  cleanups: number;
  log: string[];
  status: string[];
}

function harness(): Harness {
  return { calls: [], cleanups: 0, log: [], status: [] };
}

function opts(
  h: Harness,
  port: FakePort,
  serial: FakeSerial | null,
  connect: (port: FakePort, mode: ConnectMode, lost: () => void, n: number) => Promise<string>,
  timing: WaitTiming = fakeTiming(),
) {
  return {
    port,
    serial,
    timing,
    connect: (p: FakePort, mode: ConnectMode, lost: () => void) => {
      h.calls.push({ port: p, mode });
      return connect(p, mode, lost, h.calls.length);
    },
    cleanup: () => {
      h.cleanups++;
      return Promise.resolve();
    },
    log: (s: string) => h.log.push(s),
    status: (s: string) => h.status.push(s),
  };
}

test("first attempt succeeds: one default_reset connect, no waiting or cleanup", async () => {
  const h = harness();
  const port = new FakePort("a");
  const serial = new FakeSerial();
  serial.ports = [port];
  const r = await connectWithReconnect(opts(h, port, serial, async () => "loader"));
  assert.equal(r.session, "loader");
  assert.equal(r.port, port);
  assert.deepEqual(
    h.calls.map((c) => c.mode),
    ["default_reset"],
  );
  assert.equal(h.cleanups, 0);
  assert.equal(serial.getPortsCalls, 0);
  assert.deepEqual(h.status, ["Connecting"]);
  assert.equal(serial.listenerCount, 0, "disconnect listener removed after the attempt");
});

test("connect failure → waits for the re-enumerated board, retries no_reset on the new port", async () => {
  const h = harness();
  const original = new FakePort("before-reset");
  const reborn = new FakePort("after-reset");
  const serial = new FakeSerial();
  serial.ports = [original];
  const r = await connectWithReconnect(
    opts(h, original, serial, async (_p, _m, _lost, n) => {
      if (n === 1) {
        // The reset into the bootloader drops the device; it comes back as a
        // new SerialPort object with the same USB id.
        serial.ports = [new FakePort("other-board", CP210X), reborn];
        throw new Error("Failed to connect with the device");
      }
      return "loader";
    }),
  );
  assert.equal(r.port, reborn);
  assert.equal(r.session, "loader");
  assert.deepEqual(
    h.calls.map((c) => [c.port.name, c.mode]),
    [
      ["before-reset", "default_reset"],
      ["after-reset", "no_reset"],
    ],
  );
  assert.equal(h.cleanups, 1, "failed attempt's transport released before reopening");
  assert.ok(h.status.includes("Reconnecting (attempt 2 of 3)"));
  assert.ok(h.log.some((l) => l.includes("Attempt 1 failed: Failed to connect with the device")));
  assert.ok(h.log.some((l) => l.includes("re-enumerated")));
});

test("a disconnect event for the port aborts a hung attempt with PortLostError and retries", async () => {
  const h = harness();
  const original = new FakePort("a");
  const reborn = new FakePort("b");
  const serial = new FakeSerial();
  serial.ports = [original];
  const r = await connectWithReconnect(
    opts(h, original, serial, (p, _m, _lost, n) => {
      if (n === 1) {
        // A sync that would never finish: the port vanishes underneath it.
        setImmediate(() => {
          serial.disconnect(p);
          serial.ports = [reborn];
        });
        return new Promise<string>(() => {});
      }
      return Promise.resolve("loader");
    }),
  );
  assert.equal(r.port, reborn);
  assert.ok(h.log.some((l) => l.includes(new PortLostError().message)));
  assert.equal(serial.listenerCount, 0);
});

test("another port's disconnect doesn't abort the attempt", async () => {
  const h = harness();
  const port = new FakePort("a");
  const other = new FakePort("other", CP210X);
  const serial = new FakeSerial();
  serial.ports = [port, other];
  const r = await connectWithReconnect(
    opts(h, port, serial, async () => {
      serial.disconnect(other);
      await new Promise((resolve) => setImmediate(resolve));
      return "loader";
    }),
  );
  assert.equal(r.session, "loader");
  assert.equal(h.calls.length, 1);
});

test("the transport's own device-lost callback also triggers a retry", async () => {
  const h = harness();
  const port = new FakePort("a");
  const serial = new FakeSerial();
  serial.ports = [port];
  const r = await connectWithReconnect(
    opts(h, port, serial, (_p, _m, lost, n) => {
      if (n === 1) {
        setImmediate(lost);
        return new Promise<string>(() => {});
      }
      return Promise.resolve("loader");
    }),
  );
  // Device never re-enumerated: the same port object is reused.
  assert.equal(r.port, port);
  assert.deepEqual(
    h.calls.map((c) => c.mode),
    ["default_reset", "no_reset"],
  );
});

test("every attempt fails: tries the whole plan, then reports the last error", async () => {
  const h = harness();
  const port = new FakePort("a");
  const serial = new FakeSerial();
  serial.ports = [port];
  await assert.rejects(
    connectWithReconnect(
      opts(h, port, serial, async (_p, _m, _l, n) => {
        throw new Error(`sync timeout #${n}`);
      }),
    ),
    /after 3 attempts \(last error: sync timeout #3\)/,
  );
  assert.deepEqual(
    h.calls.map((c) => c.mode),
    [...CONNECT_PLAN],
  );
  assert.equal(h.cleanups, 3);
});

test("board never comes back: gives up after the reappear timeout", async () => {
  const h = harness();
  const port = new FakePort("a");
  const serial = new FakeSerial();
  serial.ports = [port];
  const timing = fakeTiming();
  await assert.rejects(
    connectWithReconnect(
      opts(
        h,
        port,
        serial,
        async () => {
          serial.ports = [];
          throw new Error("Failed to connect with the device");
        },
        timing,
      ),
    ),
    /didn't come back on USB/,
  );
  assert.equal(h.calls.length, 1);
  // settle, then polls until reappearMs (2000/250 = 8 polls).
  assert.deepEqual(timing.slept, [1000, ...Array<number>(8).fill(250)]);
});

test("waitForPort: board that shows up late is found by USB id", async () => {
  const original = new FakePort("a");
  const reborn = new FakePort("b");
  const serial = new FakeSerial();
  serial.onGetPorts = (n) => {
    if (n === 3) serial.ports = [reborn];
  };
  assert.equal(await waitForPort(serial, original, fakeTiming()), reborn);
  assert.equal(serial.getPortsCalls, 3);
});

test("waitForPort: prefers the original port while it's still granted", async () => {
  const original = new FakePort("a");
  const serial = new FakeSerial();
  serial.ports = [new FakePort("twin"), original];
  assert.equal(await waitForPort(serial, original, fakeTiming()), original);
});

test("waitForPort: refuses to guess between several same-id boards", async () => {
  const serial = new FakeSerial();
  serial.ports = [new FakePort("x"), new FakePort("y")];
  await assert.rejects(waitForPort(serial, new FakePort("a"), fakeTiming()), /Several boards/);
});

test("waitForPort: without navigator.serial, retries the same port", async () => {
  const original = new FakePort("a");
  assert.equal(await waitForPort(null, original, fakeTiming()), original);
});

test("connectPlanFor: reset-then-reopen only for the native USB-JTAG over WebUSB", () => {
  assert.deepEqual(connectPlanFor(C6, true), RESET_THEN_REOPEN_PLAN);
  assert.equal(RESET_THEN_REOPEN_PLAN[0], "reset_only");
  assert.equal(RESET_THEN_REOPEN_PLAN[1], "no_reset");
  // Native Web Serial (desktop) and UART bridges keep the standard plan.
  assert.deepEqual(connectPlanFor(C6, false), CONNECT_PLAN);
  assert.deepEqual(connectPlanFor(CP210X, true), CONNECT_PLAN);
  assert.deepEqual(connectPlanFor({ usbVendorId: 0x303a, usbProductId: 0x0002 }, true), CONNECT_PLAN);
});

test("reset_only: pulses the reset, never syncs on that handle, reopens the new port with no_reset", async () => {
  // The Android path: the USB-JTAG reset kills the WebUSB handle (the board
  // re-enumerates), so the first sync must happen on the NEW port.
  const h = harness();
  const original = new FakePort("before-reset");
  const reborn = new FakePort("in-bootloader");
  const serial = new FakeSerial();
  serial.ports = [original];
  const resets: FakePort[] = [];
  const r = await connectWithReconnect({
    ...opts(h, original, serial, async () => "loader"),
    plan: RESET_THEN_REOPEN_PLAN,
    reset: (p: FakePort) => {
      resets.push(p);
      serial.ports = [reborn]; // dropped off the bus, back in download mode
      return Promise.reject(new Error("The device was disconnected."));
    },
  });
  assert.deepEqual(resets, [original]);
  assert.equal(r.port, reborn);
  assert.deepEqual(
    h.calls.map((c) => [c.port.name, c.mode]),
    [["in-bootloader", "no_reset"]],
    "exactly one connect: no doomed sync on the reset handle",
  );
  assert.equal(h.cleanups, 1, "the reset handle is released before reopening");
  assert.ok(h.log.some((l) => /re-enumerated/.test(l)));
  assert.ok(!h.log.some((l) => /Attempt \d failed/.test(l)), "the reset is not reported as a failure");
});

test("reset_only: a ROM banner in the first sync is absorbed by the second no_reset", async () => {
  const h = harness();
  const original = new FakePort("a");
  const reborn = new FakePort("b");
  const serial = new FakeSerial();
  serial.ports = [original];
  const r = await connectWithReconnect({
    ...opts(h, original, serial, async (_p, _m, _l, n) => {
      if (n === 1) throw new Error("Invalid head of packet (0x65)");
      return "loader";
    }),
    plan: RESET_THEN_REOPEN_PLAN,
    reset: () => {
      serial.ports = [reborn];
      return Promise.resolve();
    },
  });
  assert.equal(r.session, "loader");
  assert.deepEqual(
    h.calls.map((c) => c.mode),
    ["no_reset", "no_reset"],
  );
});

test("reset_only without a reset hook is skipped", async () => {
  const h = harness();
  const port = new FakePort("a");
  const serial = new FakeSerial();
  serial.ports = [port];
  const r = await connectWithReconnect({
    ...opts(h, port, serial, async () => "loader"),
    plan: RESET_THEN_REOPEN_PLAN,
  });
  assert.equal(r.port, port);
  assert.deepEqual(
    h.calls.map((c) => c.mode),
    ["no_reset"],
  );
});

test("appResetSequence pulses EN (RTS) with IO0 released, longer on native USB", () => {
  assert.equal(appResetSequence(C6), "D0|R1|W200|R0|W200");
  assert.equal(appResetSequence(CP210X), "D0|R1|W100|R0");
  assert.equal(appResetSequence({}), "D0|R1|W100|R0");
});
