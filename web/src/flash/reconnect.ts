/**
 * Reconnect-aware connect retry for the flasher ("first flash sometimes fails").
 *
 * On a board flashed over its native USB-Serial-JTAG (ESP32-C6 etc.), the reset
 * into the ROM bootloader is a chip reset that makes the USB device drop off the
 * bus and re-enumerate — and a blank chip boot-loops on its invalid image header,
 * re-enumerating again and again. If the port vanishes during that window the
 * connect/sync never completes and the user sees "the device reset, but flashing
 * didn't start". So a connect is retried: after a failed (or lost) attempt we
 * release the port, wait for the SAME device (same USB vendor/product id) to
 * re-appear via `navigator.serial.getPorts()` — already-granted ports need no new
 * user gesture — reopen it, and try again with a different reset mode (first
 * `no_reset`, since the previous attempt may already have left the chip in
 * download mode, then a full reset again).
 *
 * Only the connect phase is retried: once images are being written a failure is
 * reported as-is (the caller restarts the whole flash).
 *
 * DOM-free and generic over the port type so it unit-tests with fake ports.
 */

/** esptool-js "before" reset modes we drive a connect attempt with. */
export type ConnectMode = "default_reset" | "usb_reset" | "no_reset";

/** One reset mode per attempt: a normal reset-into-bootloader first; then, after
 * a re-enumeration, assume the chip may already be in download mode; then reset
 * again (esptool-js picks its USB-JTAG reset itself for the native PID). */
export const CONNECT_PLAN: readonly ConnectMode[] = ["default_reset", "no_reset", "default_reset"];

export interface PortInfoLike {
  usbVendorId?: number | undefined;
  usbProductId?: number | undefined;
}

export interface PortLike {
  getInfo(): PortInfoLike;
}

/** The slice of `navigator.serial` we use (the WebUSB polyfill has no events). */
export interface SerialLike<P extends PortLike> {
  getPorts(): Promise<P[]>;
  addEventListener?(type: "disconnect", listener: (ev: Event) => void): void;
  removeEventListener?(type: "disconnect", listener: (ev: Event) => void): void;
}

/** The port in use disappeared mid-attempt (reset / USB re-enumeration). */
export class PortLostError extends Error {
  constructor() {
    super("The board's USB serial port went away (it reset or re-enumerated).");
    this.name = "PortLostError";
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameUsbId(a: PortInfoLike, b: PortInfoLike): boolean {
  return (
    typeof a.usbVendorId === "number" &&
    a.usbVendorId === b.usbVendorId &&
    a.usbProductId === b.usbProductId
  );
}

export interface WaitTiming {
  /** Pause before looking, so a re-enumerating device has dropped off first. */
  settleMs: number;
  /** Give up if no matching port shows up within this long (after settling). */
  reappearMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_TIMING: WaitTiming = {
  settleMs: 1000,
  reappearMs: 10000,
  pollMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Wait for the board to be (back) on the bus: the original port object if it is
 * still granted, else the single granted port with the same USB id (a
 * re-enumerated device comes back as a new SerialPort). Null on timeout. Throws
 * if several same-id boards are attached, rather than guess and flash the wrong
 * one. With no `serial` to enumerate, just hands back the original port.
 */
export async function waitForPort<P extends PortLike>(
  serial: SerialLike<P> | null,
  original: P,
  timing: WaitTiming = DEFAULT_TIMING,
): Promise<P | null> {
  if (!serial) return original;
  const want = original.getInfo();
  await timing.sleep(timing.settleMs);
  for (let waited = 0; ; waited += timing.pollMs) {
    let ports: P[] = [];
    try {
      ports = await serial.getPorts();
    } catch {
      /* transient enumeration failure: keep polling */
    }
    if (ports.includes(original)) return original;
    const same = ports.filter((p) => sameUsbId(p.getInfo(), want));
    if (same.length === 1) return same[0] ?? null;
    if (same.length > 1) {
      throw new Error(
        "Several boards with the same USB id are connected; unplug the others and try again.",
      );
    }
    if (waited >= timing.reappearMs) return null;
    await timing.sleep(timing.pollMs);
  }
}

/** Run one attempt, rejecting early with PortLostError if `port` disconnects
 * (a `disconnect` event for it on `serial`, or the attempt's own `lost()`). */
function raceLost<P extends PortLike, S>(
  serial: SerialLike<P> | null,
  port: P,
  run: (lost: () => void) => Promise<S>,
): Promise<S> {
  return new Promise<S>((resolve, reject) => {
    let settled = false;
    const onDisconnect = (ev: Event): void => {
      if ((ev.target as unknown) === port) lost();
    };
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      serial?.removeEventListener?.("disconnect", onDisconnect);
      return true;
    };
    const lost = (): void => {
      if (settle()) reject(new PortLostError());
    };
    serial?.addEventListener?.("disconnect", onDisconnect);
    run(lost).then(
      (v) => {
        if (settle()) resolve(v);
      },
      (e: unknown) => {
        if (settle()) reject(e);
      },
    );
  });
}

export interface ReconnectOptions<P extends PortLike, S> {
  port: P;
  /** `navigator.serial` (or a fake); null where ports can't be enumerated. */
  serial: SerialLike<P> | null;
  plan?: readonly ConnectMode[];
  /** One connect attempt on `port`; call `lost()` if the transport sees the
   * device go away. Resolves to whatever the caller needs to carry on. */
  connect(port: P, mode: ConnectMode, lost: () => void): Promise<S>;
  /** Release what a failed attempt left open (close the transport). */
  cleanup(): Promise<void>;
  log(line: string): void;
  /** Short progress text for the UI ("Connecting", "Reconnecting …"). */
  status(text: string): void;
  timing?: WaitTiming;
}

/**
 * Connect with up to `plan.length` attempts, waiting for the board to re-appear
 * between them. Resolves with the port that finally worked (it may be a new
 * SerialPort object after a re-enumeration) and the attempt's result.
 */
export async function connectWithReconnect<P extends PortLike, S>(
  o: ReconnectOptions<P, S>,
): Promise<{ port: P; session: S }> {
  const plan = o.plan ?? CONNECT_PLAN;
  const timing = o.timing ?? DEFAULT_TIMING;
  let port = o.port;
  let lastErr: unknown = new Error("no connect attempts were made");
  for (let i = 0; i < plan.length; i++) {
    const mode = plan[i] ?? "default_reset";
    if (i > 0) {
      o.status(`Reconnecting (attempt ${i + 1} of ${plan.length})`);
      o.log("Waiting for the board to come back on USB…");
      const next = await waitForPort(o.serial, port, timing);
      if (!next) {
        throw new Error(
          `The board didn't come back on USB after it reset (last error: ${errMessage(lastErr)}). ` +
            "Unplug it, plug it back in and try again.",
        );
      }
      if (next !== port) o.log("Board re-enumerated; reopening its new port.");
      port = next;
    } else {
      o.status("Connecting");
    }
    o.log(`Connect attempt ${i + 1} of ${plan.length} (${mode})…`);
    const attemptPort = port;
    try {
      const session = await raceLost(o.serial, attemptPort, (lost) =>
        o.connect(attemptPort, mode, lost),
      );
      return { port: attemptPort, session };
    } catch (err) {
      lastErr = err;
      o.log(`Attempt ${i + 1} failed: ${errMessage(err)}`);
      try {
        await o.cleanup();
      } catch {
        /* the port may already be gone */
      }
    }
  }
  throw new Error(
    `Couldn't connect to the board's bootloader after ${plan.length} attempts (last error: ${errMessage(lastErr)}). ` +
      "Unplug and replug it (or hold BOOT while plugging it in) and try again.",
  );
}

// Post-flash reset, as esptool's own HardReset does it: assert EN via RTS with
// IO0/GPIO9 released (DTR low), then release. esptool-js 0.6's "hard_reset" only
// ever de-asserts RTS — it never pulls EN low — so the chip stays in the flasher
// stub instead of booting the new app. On the native USB-Serial-JTAG the
// peripheral maps the same line states to a chip reset; esptool holds it longer
// there (200 ms) since the USB device drops off the bus as the chip resets.
const USB_JTAG_RESET = "D0|R1|W200|R0|W200";
const UART_BRIDGE_RESET = "D0|R1|W100|R0";
const ESPRESSIF_NATIVE_USB_VID = 0x303a;

/** esptool-js custom_reset sequence that reboots the board into its app. */
export function appResetSequence(info: PortInfoLike): string {
  return info.usbVendorId === ESPRESSIF_NATIVE_USB_VID ? USB_JTAG_RESET : UART_BRIDGE_RESET;
}
