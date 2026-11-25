/**
 * Device sheet: the lamp's power toggle (firmware feature "power",
 * docs/design/lamp-power.md). A large on/off switch with the live state
 * (turning on / off, who changed it last), kept in step with the device's
 * power_state pushes (a tap on the lid shows up here at once), plus the way
 * into the dedicated Transitions flow.
 */

import { Button, Switch, toast } from "../kit";
import type { PowerState } from "../../net/proto";
import { powerDetail, powerHeadline, switchOn } from "../../power/power";
import { installPowerStyles } from "./power.css";

export interface PowerSectionClient {
  getPower(): Promise<PowerState>;
  setPower(req: { on?: boolean; toggle?: boolean; instant?: boolean }): Promise<PowerState>;
  onPowerState(fn: (s: PowerState) => void): () => void;
}

export function PowerSection(
  client: PowerSectionClient,
  opts: { onTransitions: () => void; onSensors: () => void },
): HTMLElement {
  installPowerStyles();
  const el = document.createElement("div");
  el.className = "pw-card";
  let cur: PowerState | null = null;
  let busy = false;

  const head = document.createElement("div");
  head.className = "pw-head";
  const text = document.createElement("div");
  text.className = "pw-head-text";
  const cap = document.createElement("span");
  cap.className = "pw-cap";
  cap.textContent = "Lamp";
  const state = document.createElement("span");
  state.className = "pw-state";
  const detail = document.createElement("span");
  detail.className = "pw-detail";
  text.append(cap, state, detail);
  const sw = Switch({
    on: false,
    label: "Lamp power",
    onChange: (on) => void set(on),
  });
  head.append(text, sw.el);

  const actions = document.createElement("div");
  actions.className = "pw-actions";
  actions.append(
    Button({ label: "On / off transitions", icon: "sparkles", variant: "quiet", onClick: opts.onTransitions }),
    Button({ label: "Touch sensor", icon: "chip", variant: "quiet", onClick: opts.onSensors }),
  );
  el.append(head, actions);

  const paint = (): void => {
    state.textContent = powerHeadline(cur);
    detail.textContent = powerDetail(cur);
    sw.set(switchOn(cur));
    sw.el.disabled = busy || cur === null;
    el.dataset["phase"] = String(cur?.phase ?? 0);
  };

  const adopt = (s: PowerState): void => {
    // A push can overtake a reply: keep the newest by seq (it only increases).
    if (cur && s.seq < cur.seq && s.seq !== 0) return;
    cur = s;
    paint();
  };

  async function set(on: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    paint();
    try {
      adopt(await client.setPower({ on }));
    } catch (e) {
      toast(`Couldn't turn the lamp ${on ? "on" : "off"}: ${e instanceof Error ? e.message : String(e)}`, {
        error: true,
      });
    } finally {
      busy = false;
      paint();
    }
  }

  // Live: every power_state (replies and pushes). Unsubscribes itself once the
  // sheet has gone (the element left the document).
  let unsub: (() => void) | null = null;
  unsub = client.onPowerState((s) => {
    if (!el.isConnected && cur !== null) {
      unsub?.();
      return;
    }
    adopt(s);
  });

  paint();
  void client
    .getPower()
    .then(adopt)
    .catch(() => {
      state.textContent = "Couldn't read the power state";
    });
  return el;
}
