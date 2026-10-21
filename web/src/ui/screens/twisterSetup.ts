/**
 * "Set up Midi Fighter Twister" sheet: switches the encoders you pick for
 * Deck A / Deck B browsing to relative ("ENC 3FH/41H") mode over SysEx, so the
 * Show Mode effects list scrolls indefinitely, and binds the Show actions to
 * them (turn = browse, push = load).
 *
 * Read-modify-write (see midi/twister.ts for the protocol and firmware
 * references): read the Twister's settings, push only the fields that change
 * on the chosen encoders, push the global settings back unchanged so the
 * firmware reloads, then read back to verify. Nothing is sent until you
 * confirm. If the Twister won't answer the read, an explicit "write without
 * reading" path writes only the chosen encoders' fields.
 */

import { Button, Sheet, Switch, confirmDialog, toast } from "../kit";
import { midiManager, midiSupported, type MidiDeviceInfo } from "../../midi/manager";
import {
  TwisterSession,
  TwisterTimeout,
  describeChanges,
  encoderTag,
  isTwisterPortName,
  planEncoderChanges,
  pushEncoderMessages,
  ENC_MIDI_TYPE,
  MIDI_TYPE_LABEL,
  MOVEMENT_LABEL,
  SWITCH_ACTION,
  type EncoderSettings,
  type SysexLink,
  type TagTable,
  type TwisterIdentity,
} from "../../midi/twister";
import { midiStore, type LoadBehavior } from "../../store/midiStore";

interface DeckPick {
  deck: 0 | 1;
  /** 0..15, or -1 = don't use. */
  encoder: number;
}

const DECK_NAME = ["A", "B"] as const;

/** Web MIDI SysEx link to one output port, listening on every input. */
function webMidiLink(outputId: string): SysexLink {
  return {
    send: (bytes) => midiManager.send(outputId, bytes),
    onSysex: (fn) => midiManager.onSysex((data) => fn(data)),
  };
}

function selectField<T extends string>(
  label: string,
  options: [T, string][],
  value: T,
  onChange: (v: T) => void,
): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "k-field";
  const cap = document.createElement("span");
  cap.className = "k-field-label";
  cap.textContent = label;
  const sel = document.createElement("select");
  for (const [v, text] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    if (v === value) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(sel.value as T));
  wrap.append(cap, sel);
  return wrap;
}

function para(text: string, cls = "sheet-hint"): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

/** Factory Twister mapping: bank b encoder e → CC 16b+e; encoder on channel
 * 1, push switch on channel 2 (firmware factory reset). */
function factorySettings(bank: number, encoder: number): EncoderSettings {
  const cc = (bank * 16 + encoder) & 0x7f;
  return {
    midiType: ENC_MIDI_TYPE.cc,
    channel: 0,
    number: cc,
    movement: 0,
    switchAction: SWITCH_ACTION.ccHold,
    switchChannel: 1,
    switchNumber: cc,
    raw: [],
  };
}

/** Assume every field differs (used when the Twister can't be read). */
function unknownSettings(): EncoderSettings {
  return {
    midiType: -1,
    channel: -1,
    number: -1,
    movement: -1,
    switchAction: -1,
    switchChannel: 0,
    switchNumber: 0,
    raw: [],
  };
}

export function openTwisterSetup(opts: { onDone?: () => void } = {}): void {
  const sheet = Sheet("Set up Midi Fighter Twister");
  const body = sheet.body;
  body.classList.add("twister-setup");

  if (!midiSupported()) {
    body.append(
      para(
        "This browser has no Web MIDI, so Splanc can't configure the Twister from here. " +
          "iOS/iPadOS Safari doesn't support Web MIDI at all — use Chrome or Edge on a computer or Android.",
        "twister-warn",
      ),
      para(
        "Or set it up by hand in DJ TechTools' Midi Fighter Utility: pick the encoder, set its " +
          "Encoder MIDI Type to “ENC 3FH/41H” (and Sensitivity to Velocity Sensitive for acceleration), " +
          "send to the Twister, then MIDI-learn it in Show Mode.",
      ),
    );
    return;
  }

  // -- state ----------------------------------------------------------------
  let output: MidiDeviceInfo | null = null;
  let inputName = "";
  let identity: TwisterIdentity | null = null;
  let session: TwisterSession | null = null;
  let bank = 0;
  const picks: [DeckPick, DeckPick] = [
    { deck: 0, encoder: 0 },
    { deck: 1, encoder: 3 },
  ];
  let acceleration = true;
  let pushLoads = true;
  let global: TagTable | null = null;
  let current = new Map<number, EncoderSettings>();
  let readFailed = false;
  let busy = false;
  let status = "";

  const content = document.createElement("div");
  content.className = "twister-content";
  body.append(
    para(
      "Turns the encoders you pick into endless relative encoders (ENC 3FH/41H) so the Show Mode " +
        "effects list scrolls without stopping, and maps them: turn to browse, push to load. " +
        "Only those settings change; everything else on the Twister is kept.",
    ),
    content,
  );

  function activePicks(): DeckPick[] {
    return picks.filter((p) => p.encoder >= 0);
  }

  /** Target channel/CC: keep an existing Twister mapping's, else the Twister's own. */
  function targetFor(p: DeckPick, cur: EncoderSettings): { channel: number; number: number } {
    const b = midiStore.showBindingFor(p.deck === 0 ? "deckA.browse" : "deckB.browse");
    if (b && b.kind === "cc" && isTwisterPortName(b.device)) return { channel: b.channel, number: b.number };
    return { channel: cur.channel, number: cur.number };
  }

  function plansFor(): Map<number, { pick: DeckPick; cur: EncoderSettings; plan: TagTable }> {
    const out = new Map<number, { pick: DeckPick; cur: EncoderSettings; plan: TagTable }>();
    for (const p of activePicks()) {
      const tag = encoderTag(bank, p.encoder);
      const cur = current.get(tag) ?? (readFailed ? unknownSettings() : undefined);
      if (!cur) continue;
      const basis = readFailed ? factorySettings(bank, p.encoder) : cur;
      const t = targetFor(p, basis);
      const plan = planEncoderChanges(cur, {
        bank,
        encoder: p.encoder,
        channel: t.channel,
        number: t.number,
        acceleration,
        momentarySwitch: pushLoads,
      });
      out.set(tag, { pick: p, cur, plan });
    }
    return out;
  }

  // -- actions --------------------------------------------------------------
  async function connect(): Promise<void> {
    busy = true;
    status = "Asking for SysEx access…";
    render();
    const ok = await midiManager.enableSysex();
    busy = false;
    if (!ok) {
      status = "SysEx access was denied. Allow MIDI device control for this site and try again.";
      render();
      return;
    }
    const outs = midiManager.outputs();
    output = outs.find((o) => isTwisterPortName(o.name)) ?? null;
    if (!output) {
      status = outs.length
        ? "No Midi Fighter Twister among the MIDI outputs. Plug it in (USB) and try again."
        : "No MIDI outputs found. Plug the Twister in (USB) and try again.";
      render();
      return;
    }
    inputName = midiManager.devices().find((d) => isTwisterPortName(d.name))?.name ?? output.name;
    session = new TwisterSession(webMidiLink(output.id));
    status = "Found it — checking firmware…";
    render();
    identity = await session.identify().catch(() => null);
    status = "";
    await read();
  }

  async function read(): Promise<void> {
    if (!session) return;
    busy = true;
    status = "Reading the Twister's settings…";
    render();
    current = new Map();
    readFailed = false;
    try {
      global = await session.readGlobal();
      for (const p of activePicks()) {
        const tag = encoderTag(bank, p.encoder);
        current.set(tag, await session.readEncoder(tag));
      }
      status = "";
    } catch (err) {
      readFailed = true;
      global = null;
      status =
        err instanceof TwisterTimeout
          ? "The Twister didn't answer the settings read (older firmware?). You can still write without reading."
          : `Read failed: ${String(err)}`;
    }
    busy = false;
    render();
  }

  function bindShowActions(after: Map<number, EncoderSettings>): void {
    for (const p of activePicks()) {
      const tag = encoderTag(bank, p.encoder);
      const s = after.get(tag) ?? factorySettings(bank, p.encoder);
      const d = DECK_NAME[p.deck];
      midiStore.setShowBinding(
        `deck${d}.browse`,
        { device: inputName, kind: "cc", channel: s.channel, number: s.number },
        "binOffset",
      );
      if (pushLoads) {
        midiStore.setShowBinding(`deck${d}.load`, {
          device: inputName,
          kind: "cc",
          channel: s.switchChannel,
          number: s.switchNumber,
        });
      }
    }
  }

  async function write(): Promise<void> {
    if (!session) return;
    const plans = plansFor();
    const lines: string[] = [];
    for (const [, { pick, cur, plan }] of plans) {
      const changes = describeChanges(cur, plan);
      lines.push(
        `Encoder ${pick.encoder + 1} (Deck ${DECK_NAME[pick.deck]}): ${changes.length ? changes.join(", ") : "already set"}`,
      );
    }
    if (readFailed) {
      const ok = await confirmDialog({
        title: "Write without reading?",
        message:
          "The Twister didn't answer the settings read, so Splanc can't check what's on it. This " +
          "OVERWRITES the chosen encoders' MIDI type, channel, CC, sensitivity and push-switch " +
          "action (other settings and encoders are kept). Unplug and replug the Twister afterwards " +
          `to load the change. ${lines.join(". ")}.`,
        confirmLabel: "Overwrite",
        danger: true,
      });
      if (!ok) return;
      busy = true;
      render();
      try {
        // Encoder parts only: with no read there is no global table to push
        // back (a partial global push zeroes the missing settings).
        for (const [tag, { plan }] of plans) {
          for (const m of pushEncoderMessages(tag, plan)) {
            midiManager.send(output!.id, m);
            await new Promise((r) => setTimeout(r, 60));
          }
        }
      } catch (err) {
        busy = false;
        status = `Write failed: ${String(err)}`;
        render();
        return;
      }
      busy = false;
      const after = new Map<number, EncoderSettings>();
      for (const [tag, { pick }] of plans) {
        const f = factorySettings(bank, pick.encoder);
        const t = targetFor(pick, f);
        after.set(tag, { ...f, channel: t.channel, number: t.number });
      }
      bindShowActions(after);
      status = "Written. Unplug and replug the Twister to load it, then try the knobs in Show Mode.";
      render();
      opts.onDone?.();
      return;
    }
    const ok = await confirmDialog({
      title: "Write to the Twister?",
      message: `${lines.join(". ")}. Everything else on the Twister stays as it is.`,
      confirmLabel: "Write",
    });
    if (!ok || !global) return;
    busy = true;
    status = "Writing…";
    render();
    try {
      const planOnly = new Map([...plans].map(([tag, v]) => [tag, v.plan] as [number, TagTable]));
      const res = await session.apply(planOnly, global);
      bindShowActions(res.after);
      current = res.after;
      status = res.mismatched.length
        ? `Written, but encoder(s) ${res.mismatched.map((t) => ((t - 1) % 16) + 1).join(", ")} read back different — check them in the Midi Fighter Utility.`
        : "Done. The encoders are relative now and mapped to Show Mode (turn = browse, push = load).";
      toast("Midi Fighter Twister set up");
      opts.onDone?.();
    } catch (err) {
      status = `Write failed: ${String(err)}`;
    }
    busy = false;
    render();
  }

  // -- render ---------------------------------------------------------------
  function encoderOptions(): [string, string][] {
    const o: [string, string][] = [["-1", "Not used"]];
    for (let i = 0; i < 16; i++) o.push([String(i), `Encoder ${i + 1} (row ${(i >> 2) + 1}, col ${(i % 4) + 1})`]);
    return o;
  }

  function currentLine(p: DeckPick): string {
    const s = current.get(encoderTag(bank, p.encoder));
    if (!s) return readFailed ? "unknown (not read)" : "—";
    return (
      `${MIDI_TYPE_LABEL[s.midiType] ?? s.midiType}, ch ${s.channel + 1} CC ${s.number}, ` +
      `${MOVEMENT_LABEL[s.movement] ?? s.movement}`
    );
  }

  function render(): void {
    content.replaceChildren();
    if (!session) {
      content.append(
        Button({
          label: busy ? "Connecting…" : "Allow SysEx & find the Twister",
          icon: "midi",
          block: true,
          disabled: busy,
          onClick: () => void connect(),
        }),
        para("Chrome asks to let this site control MIDI devices (SysEx) — that's how settings are written."),
      );
      if (status) content.append(para(status, "twister-status"));
      return;
    }
    const found = document.createElement("div");
    found.className = "twister-found";
    found.textContent = `${output?.name ?? "Twister"}${identity ? ` · firmware ${identity.version}` : ""}`;
    content.append(found);

    content.append(
      selectField(
        "Twister bank",
        [0, 1, 2, 3].map((b) => [String(b), `Bank ${b + 1}`] as [string, string]),
        String(bank),
        (v) => {
          bank = Number(v);
          void read();
        },
      ),
    );
    for (const p of picks) {
      content.append(
        selectField(`Deck ${DECK_NAME[p.deck]} browse encoder`, encoderOptions(), String(p.encoder), (v) => {
          p.encoder = Number(v);
          void read();
        }),
      );
      if (p.encoder >= 0) content.append(para(`Now: ${currentLine(p)}`, "twister-now metric"));
    }

    const accel = Switch({ on: acceleration, label: "Acceleration", onChange: (on) => ((acceleration = on), render()) });
    const accelRow = document.createElement("div");
    accelRow.className = "twister-row";
    accelRow.append(accel.el, document.createTextNode(" Acceleration (faster turn = bigger jumps)"));
    const push = Switch({ on: pushLoads, label: "Push loads", onChange: (on) => ((pushLoads = on), render()) });
    const pushRow = document.createElement("div");
    pushRow.className = "twister-row";
    pushRow.append(push.el, document.createTextNode(" Push the encoder to load the highlighted effect"));
    content.append(accelRow, pushRow);
    if (pushLoads) {
      content.append(
        selectField<LoadBehavior>(
          "Push does",
          [
            ["cue", "Cue — load onto the deck"],
            ["take", "Take — load and crossfade to it"],
          ],
          midiStore.showOptions().loadBehavior,
          (v) => midiStore.setShowOptions({ loadBehavior: v }),
        ),
      );
    }

    const plans = plansFor();
    if (plans.size > 0) {
      const ul = document.createElement("ul");
      ul.className = "twister-plan";
      for (const [, { pick, cur, plan }] of plans) {
        const li = document.createElement("li");
        const ch = describeChanges(cur, plan);
        li.textContent = `Encoder ${pick.encoder + 1}: ${ch.length ? ch.join("; ") : "already set — nothing to write"}`;
        ul.append(li);
      }
      content.append(ul);
    }
    if (status) content.append(para(status, "twister-status"));

    const actions = document.createElement("div");
    actions.className = "twister-actions";
    const anyChange = [...plans.values()].some((v) => v.plan.length > 0);
    actions.append(
      Button({ label: "Re-read", variant: "quiet", disabled: busy, onClick: () => void read() }),
      Button({
        label: readFailed ? "Write without reading…" : anyChange ? "Write to Twister" : "Map in Show Mode",
        variant: readFailed ? "danger" : "primary",
        disabled: busy || activePicks().length === 0,
        onClick: () => {
          if (!readFailed && !anyChange) {
            bindShowActions(current);
            toast("Mapped to Show Mode");
            opts.onDone?.();
            render();
            return;
          }
          void write();
        },
      }),
    );
    content.append(actions);
  }

  render();
}
