/**
 * The live (VJ) protocol between the Splanc app and a Splanc bridge
 * (docs/design/live-vj-relay.md). One JSON object per WebSocket text message,
 * the same on both paths:
 *
 *   app ──wss──▶ relay  /live  ──(the bridge's outbound socket)──▶ bridge   (from anywhere)
 *   app ──wss──▶ bridge :8443/live                                          (direct, on the LAN)
 *
 * The bridge owns the one /ws session per player and fans each command out to
 * the selected players. Continuous controls (`c`: uniforms, crossfade,
 * brightness, keypoint morphs) are fire-and-forget and coalesced at both ends;
 * everything else is a query (`q`) with one reply (`r`).
 *
 * Shared by the app (web/src/net/bridgeLive.ts) and the bridge
 * (agent/src/bridge/live.ts): types and constants only, no runtime imports.
 */

export const LIVE_VERSION = 1;
/** The subprotocol a live socket negotiates. */
export const LIVE_SUBPROTOCOL = "splanc-live.v1";
/** The credential rides in the subprotocol list: `["splanc-live.v1", "bearer.<token>"]`. */
export const LIVE_BEARER_PREFIX = "bearer.";

/** App-side coalescing tick: one `c` frame per tick at most, carrying every
 * control that changed. Via the relay each frame is a billed message (20:1). */
export const TICK_RELAY_MS = 33; // ~30 Hz
export const TICK_LAN_MS = 16; // ~60 Hz (free: never leaves the LAN)

/** A player selector: ids (MACs), names, room names, or "all". */
export type Selector = string[];

export type UniformInput = number | boolean | string | number[];

// -- app -> bridge --------------------------------------------------------------------

export interface HelloMsg {
  t: "hello";
  v: number;
  /** Stable per app install (lock ownership survives a reconnect). */
  client_id: string;
  /** Shown to other clients as the lock holder ("Kevin's iPhone"). */
  name: string;
  app?: string;
}

/** Continuous controls: fire-and-forget, last value wins, coalesced per player. */
export interface ControlMsg {
  t: "c";
  to: Selector;
  /** Deck for `u` (0 = A, 1 = B). */
  deck?: number;
  /** Uniform values by name (per player, resolved against its active effect). */
  u?: Record<string, UniformInput>;
  /** Persist `u` (send on release; false/absent while dragging). */
  commit?: boolean;
  /** Crossfade between decks: 0 = all A .. 1 = all B; mode 0 RGB, 1 HSV. */
  xf?: { pos: number; mode?: number };
  /** Output brightness 0..1. */
  bri?: number;
  /** Morph a deck toward a weighted mix of its stored keypoints. */
  kb?: { w: Record<string, number>; seconds?: number; deck?: number };
}

export type QueryOp =
  | "players" // {refresh?: boolean}
  | "effect" // {deck?} -> per player {effect_id, uniforms[], keypoints?}
  | "deploy" // {effect_id, source, deck?, activate?, align?}
  | "set_effect" // {effect_id, deck?}
  | "keypoints" // {deck?}
  | "align" // shared time base
  | "lock" // {on: boolean}: the Show Mode lock
  | "probe" // per player device round trip, through the same queue as controls
  | "identify";

export interface QueryMsg {
  t: "q";
  id: number;
  op: QueryOp;
  to?: Selector;
  [arg: string]: unknown;
}

export interface PingMsg {
  t: "ping";
  id: number;
}

export type AppMsg = HelloMsg | ControlMsg | QueryMsg | PingMsg;

// -- bridge -> app --------------------------------------------------------------------

export interface LiveLock {
  by: string;
  mine: boolean;
}

export interface LivePlayer {
  id: string;
  name: string;
  host: string;
  /** A /ws session to it is up. */
  connected: boolean;
  fw?: string;
  /** Live-relevant firmware features (decks, crossfade, keypoints, time_base, uniform_commit). */
  features: string[];
  room?: string;
  lock: LiveLock | null;
  /** Deck A's active effect id as last seen by the bridge (null = none/unknown). */
  effect: string | null;
  /** The framerate autoscaler (FUG-82) as last reported: the rate the player renders
   * at now (0 = unknown), and whether it parked the effect (couldn't hold the floor
   * or a pinned rate). Absent on firmware without it. */
  fps?: { current: number; target: number; auto: boolean; aborted: boolean };
}

export interface LanInfo {
  /** wss://<ip>:<port>/live */
  url: string;
  /** https://<ip>:<port>/ (open once in a browser to trust the certificate). */
  page: string;
  /** SHA-256 of the bridge's certificate (hex): pin it, or compare it. */
  sha256: string;
}

export interface WelcomeMsg {
  t: "welcome";
  v: number;
  bridge: { id: string };
  via: "relay" | "lan";
  /** The bridge's direct LAN endpoint (null: disabled, or no LAN address). */
  lan: LanInfo | null;
  /** A ticket for the LAN endpoint, minted when connected via the relay. */
  lan_token?: string;
  players: LivePlayer[];
  rooms: Record<string, string[]>;
  /** The coalescing tick the bridge suggests for this path. */
  tick_ms: number;
}

export interface PlayersMsg {
  t: "players";
  players: LivePlayer[];
  rooms: Record<string, string[]>;
}

export interface PerPlayer<T = unknown> {
  player: { id: string; name: string };
  ok: boolean;
  result?: T;
  error?: string;
}

export interface ReplyMsg {
  t: "r";
  id: number;
  ok: boolean;
  error?: string;
  results?: PerPlayer[];
  data?: unknown;
}

export interface PongMsg {
  t: "pong";
  id: number;
}

/** An asynchronous failure (a control couldn't be applied), rate-limited. */
export interface ErrMsg {
  t: "err";
  code: string;
  message: string;
  player?: string;
}

/** A player's framerate autoscaler gave up (fps_state{aborted}, FUG-82): the effect
 * is parked (not rendering). Pushed at once; the steady fps rides `players`. */
export interface FpsMsg {
  t: "fps";
  player: string;
  name: string;
  current_fps: number;
  target_fps: number;
  min_fps: number;
  auto: boolean;
  aborted: boolean;
}

/** From the relay itself (not the bridge). */
export interface RelayNotice {
  t: "relay";
  bridge?: "online" | "offline";
  error?: string;
}

export type BridgeMsg = WelcomeMsg | PlayersMsg | ReplyMsg | PongMsg | ErrMsg | FpsMsg | RelayNotice;

/** Live-relevant firmware features, as listed in LivePlayer.features. */
export const LIVE_FEATURES = ["decks", "crossfade", "keypoints", "time_base", "uniform_commit"];
