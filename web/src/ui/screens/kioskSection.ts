/**
 * Device settings: the owner's "Kiosk mode" section (firmware feature "kiosk";
 * .claude/halloween/CONTRACT.md). Enable/disable, the idle timeout (default
 * 120 s), "use the current effect, uniforms and brightness as the attract
 * show", and the owner secret — generated + kept on this phone, sent with each
 * config, and used to unlock the locked operations for this connection.
 *
 * Works over whatever transport the client uses (BLE at the install).
 */

import { Button, Field, Switch, confirmDialog, toast } from "../kit";
import {
  KIOSK_DEFAULT_IDLE_S,
  formatCountdown,
  kioskConfigFields,
  normalizeKioskStatus,
  type KioskStatus,
} from "../../net/kiosk";
import type { KioskStatusMessage, SetKioskConfigMessage } from "../../net/proto";
import { attractDisplayName } from "../../halloween/presets";
import { ensureKioskSecret, kioskSecretFor, setKioskSecret } from "../../halloween/kioskSecrets";
import { kioskStore } from "../../halloween/kioskStore";
import { installPlayStyles } from "./playMode.css";

export interface KioskSectionClient {
  readonly welcome: { mac?: string } | null;
  getKioskStatus(): Promise<KioskStatusMessage>;
  setKioskConfig(cfg: Omit<SetKioskConfigMessage, "type">): Promise<KioskStatusMessage>;
  kioskUnlock(secret: string): Promise<KioskStatusMessage>;
}

function errText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "kiosk_locked") return "the device is locked — unlock it first";
  if (code === "kiosk_bad_secret") return "wrong owner secret (wait a couple of seconds before retrying)";
  if (code === "kiosk_secret_required") return "the device needs an owner secret";
  if (code === "kiosk_no_effect") return "nothing is playing to capture — start an effect first";
  if (code === "kiosk_bad_config") return "the device rejected these settings";
  return e instanceof Error ? e.message : String(e);
}

/** One-line kiosk status for the owner. */
export function kioskStatusLine(s: KioskStatus | null): string {
  if (!s) return "Kiosk: reading…";
  if (!s.enabled) return "Kiosk: off";
  const parts = [`Kiosk: on · idle ${formatCountdown(s.idleTimeoutS)}`];
  parts.push(s.hasAttract || s.attractName ? `show: ${attractDisplayName(s.attractName)}` : "no attract show captured");
  parts.push(s.ownerUnlocked ? "unlocked (owner)" : "locked");
  return parts.join(" · ");
}

export function KioskSection(client: KioskSectionClient): HTMLElement {
  installPlayStyles();
  const el = document.createElement("div");
  el.className = "kiosk-section";
  const mac = client.welcome?.mac ?? "";
  let cur: KioskStatus | null = kioskStore.status;
  let busy = false;
  let enabled = cur?.enabled ?? false;
  let capture = !(cur?.enabled ?? false);
  let timeoutField: HTMLInputElement | null = null;

  const adopt = (m: KioskStatusMessage): void => {
    const s = normalizeKioskStatus(m);
    if (!s) return;
    cur = s;
    enabled = s.enabled;
    kioskStore.apply(s);
    render();
  };

  const run = async (what: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      toast(`${what}: ${errText(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  };

  const unlock = (): Promise<void> =>
    run("Unlock", async () => {
      let secret = kioskSecretFor(mac);
      if (!secret) {
        const typed = prompt("Owner secret for this device (from the phone that set up kiosk mode):")?.trim();
        if (!typed) return;
        secret = typed;
      }
      const s = await client.kioskUnlock(secret);
      if (!s.ownerUnlocked) throw new Error("wrong owner secret");
      if (mac) setKioskSecret(mac, secret);
      adopt(s);
      toast("Unlocked for this connection");
    });

  const apply = (): Promise<void> =>
    run("Kiosk settings", async () => {
      const t = Number(timeoutField?.value ?? KIOSK_DEFAULT_IDLE_S);
      if (!Number.isFinite(t) || t < 10 || t > 86_400) {
        toast("Idle timeout: enter 10–86400 seconds", { error: true });
        return;
      }
      if (!mac) throw new Error("connect once so the device's identity is known");
      const secret = ensureKioskSecret(mac);
      // Kiosk already on and locked: unlock with our secret first.
      if (cur?.enabled && !cur.ownerUnlocked) {
        const u = await client.kioskUnlock(secret);
        if (!u.ownerUnlocked) throw new Error("this phone's owner secret doesn't match the device");
      }
      if (enabled && !capture && !cur?.hasAttract) {
        const ok = await confirmDialog({
          title: "No attract show yet",
          message: "Kiosk mode reverts to the attract show after the timeout. Capture what's playing now?",
          confirmLabel: "Capture current look",
          cancelLabel: "Leave as is",
        });
        if (ok) capture = true;
      }
      adopt(
        await client.setKioskConfig(
          kioskConfigFields({
            enabled,
            idleTimeoutS: t,
            captureAttractFromCurrent: enabled && capture,
            ownerSecret: secret,
          }),
        ),
      );
      capture = false;
      toast(enabled ? "Kiosk mode on" : "Kiosk mode off");
    });

  function render(): void {
    el.replaceChildren();
    const h = document.createElement("div");
    h.className = "device-detail-cap";
    h.textContent = "Kiosk mode (public install)";
    const line = document.createElement("div");
    line.className = "kiosk-status-line";
    line.textContent = kioskStatusLine(cur);
    el.append(h, line);

    const onRow = document.createElement("div");
    onRow.className = "kiosk-row";
    const onLab = document.createElement("label");
    onLab.textContent = "Visitors can play; owner settings locked";
    const sw = Switch({
      on: enabled,
      label: "Kiosk mode",
      onChange: (v) => {
        enabled = v;
        if (v && !cur?.enabled) capture = true;
        render();
      },
    });
    onRow.append(onLab, sw.el);
    el.append(onRow);

    const fld = Field({
      label: "Back to the show after (seconds idle)",
      type: "number",
      value: String(cur?.idleTimeoutS ?? KIOSK_DEFAULT_IDLE_S),
    });
    fld.input.inputMode = "numeric";
    fld.input.min = "10";
    timeoutField = fld.input;
    el.append(fld.el);

    const capRow = document.createElement("label");
    capRow.className = "kiosk-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = capture;
    cb.addEventListener("change", () => (capture = cb.checked));
    const capText = document.createElement("span");
    capText.textContent = "Use the current effect, uniforms and brightness as the attract show";
    capRow.append(cb, capText);
    el.append(capRow);

    const btns = document.createElement("div");
    btns.className = "kiosk-row";
    btns.append(Button({ label: "Apply", variant: "primary", disabled: busy, onClick: () => void apply() }));
    if (cur?.enabled && !cur.ownerUnlocked) {
      btns.append(Button({ label: "Unlock", variant: "quiet", disabled: busy, onClick: () => void unlock() }));
    }
    el.append(btns);

    const secret = kioskSecretFor(mac);
    const sec = document.createElement("div");
    sec.className = "kiosk-secret";
    sec.textContent = secret
      ? `Owner secret (kept on this phone): ${secret}`
      : "An owner secret is generated on this phone the first time you apply.";
    el.append(sec);
    if (secret) {
      el.append(
        Button({
          label: "Copy owner secret",
          variant: "quiet",
          onClick: () =>
            void navigator.clipboard?.writeText(secret).then(
              () => toast("Copied — keep it somewhere safe"),
              () => toast("Couldn't copy", { error: true }),
            ),
        }),
      );
    }
    const rec = document.createElement("div");
    rec.className = "device-detail-cap";
    rec.textContent = "Lost the secret? Run `kiosk off` on the device's USB serial console.";
    el.append(rec);
  }

  render();
  void client
    .getKioskStatus()
    .then(adopt)
    .catch((e: unknown) => {
      const line = el.querySelector(".kiosk-status-line");
      if (line) line.textContent = `Kiosk: couldn't read (${errText(e)})`;
    });
  return el;
}
