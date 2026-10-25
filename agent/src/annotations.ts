/**
 * MCP tool annotations + the server's `instructions`, shared by every way the
 * agent is served (stdio, the LAN bridge behind the cloud relay).
 *
 * Hosts act on the annotations: ChatGPT treats a tool without readOnlyHint as a
 * write action and asks the user to confirm it, so read-only must be honest in
 * both directions. The rules used here:
 *
 * - readOnlyHint: nothing on a player changes (the hub's own discovery cache and
 *   this session's compile memo are not "the environment").
 * - destructiveHint: it deletes, or overwrites without an undo, something the
 *   user keeps — a remembered player, a keypoint, a stored effect, a pose, a
 *   room, a certificate pin, a name — or may replace the running effect without
 *   being asked to (measure_effect's rollback_on_overrun). crossfade_to counts:
 *   it overwrites whatever was cued on the idle deck (the user's Show Mode cue).
 * - idempotentHint: calling it again with the same arguments changes nothing
 *   further.
 * - openWorldHint: false for every tool that talks only to the user's own players
 *   on their own network; true for file_bug, which reaches GitHub.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { FILE_BUG_ANNOTATIONS } from "../../web/src/bugs/bugReport";
import { LIBRARY_TOOLS } from "../relay/src/library";

const read = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const write = (title: string, destructive: boolean, idempotent: boolean): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
});

/** Every tool's annotations, by name. createServer refuses a tool missing here. */
export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  // players + rooms
  list_players: read("List players"),
  refresh_players: read("Find players again"),
  add_player: write("Add a player by host", false, true),
  forget_player: write("Forget a player", true, true),
  trust_player: write("Re-trust a player's new certificate", true, true),
  identify_player: write("Blink players to identify them", false, true),
  export_map: read("Export an LED map"),
  plot_fixture: read("Plot a fixture in 3D"),
  set_room: write("Set a room's players", true, true),
  set_fixture_pose: write("Place a fixture in its room", true, true),
  align_time: write("Align effect clocks", false, true),
  // device control
  set_brightness: write("Set brightness", false, true),
  update_firmware: write("Update firmware over Wi-Fi", true, true),
  list_uniforms: read("List effect controls"),
  set_uniforms: write("Set effect controls", false, true),
  ramp_uniforms: write("Glide effect controls", false, true),
  // keypoints
  list_keypoints: read("List saved looks"),
  save_keypoint: write("Save a look", true, true),
  recall_keypoint: write("Recall a saved look", false, true),
  blend_keypoints: write("Blend saved looks", false, true),
  get_keypoint: read("Read a saved look"),
  delete_keypoint: write("Delete a saved look", true, true),
  read_sensors: read("Read the motion sensor"),
  // Overwrites the stored sensor calibration (no undo but recalibrating).
  calibrate_sensors: write("Calibrate the motion sensor", true, true),
  // sensor drivers (FUG-107)
  scan_i2c: read("Scan the sensor bus"),
  deploy_driver: write("Load a sensor driver", true, true),
  driver_state: read("Read the sensor driver"),
  remove_driver: write("Remove the sensor driver", true, true),
  // Wi-Fi rejoin policy: offline/manual can take the player off the network
  // (recoverable only over BLE / the console), so it counts as destructive.
  get_wifi_policy: read("Read the Wi-Fi rejoin policy"),
  set_wifi_policy: write("Change the Wi-Fi rejoin policy", true, false),
  // effect authoring
  compile_effect: read("Compile an effect"),
  estimate_effect: read("Estimate an effect's frame cost"),
  preview_effect: read("Preview an effect"),
  deploy_effect: write("Deploy an effect", true, false),
  set_effect: write("Switch the running effect", false, true),
  rollback_effect: write("Roll back the last deploy", true, false),
  crossfade_to: write("Crossfade to an effect", true, false),
  list_decks: read("Show the FX decks"),
  measure_effect: write("Measure the running effect", true, false),
  // textures
  list_textures: read("List texture inputs"),
  stream_texture: write("Stream into a texture", false, true),
  stop_texture: write("Stop a texture stream", false, true),
  // identity
  set_device_name: write("Rename a player", true, true),
  // the effects library (relay/src/library.ts defines them, annotations included:
  // search/get read-only; save idempotent by source hash; update/delete destructive)
  ...Object.fromEntries(LIBRARY_TOOLS.map((t) => [t.name, t.annotations])),
  // bug reports (web/src/bugs/bugReport.ts): reaches GitHub; not idempotent
  file_bug: { ...FILE_BUG_ANNOTATIONS },
};

/**
 * Server-wide guidance (MCP `instructions`). ChatGPT asks that the first 512
 * characters stand on their own; the rest adds rules.
 */
export const SERVER_INSTRUCTIONS =
  "Splanc controls addressable-LED light fixtures (players) on the user's home network. " +
  "Start with list_players: names, rooms, firmware. Target tools with players: a name, room or \"all\". " +
  "identify_player blinks fixtures so the user can tell them apart. " +
  "set_brightness sets 0..1; list_uniforms then set_uniforms or ramp_uniforms tune the running effect; " +
  "keypoints are saved looks. New scene or mood: search_effects first (past effects), " +
  "else compile_effect, preview_effect, deploy_effect; rollback_effect undoes it.\n\n" +
  "Rules: ask the user before deleting or overwriting their keypoints, renaming a player " +
  "(set_device_name), re-trusting a certificate (trust_player), updating firmware (update_firmware) or forgetting a player. Ask where fixtures " +
  "are rather than guessing poses. Use commit=true sparingly (flash wear). If a player is unreachable, " +
  "say so; refresh_players looks again. Nothing here rewires or re-maps a fixture: that is done in the " +
  "Splanc app. To change effects live without a hard cut, crossfade_to fades to the new one (in step across " +
  "players; rollback_effect fades back). plot_fixture draws a fixture or a room in 3D (PNG) to check a map or poses. " +
  "When something is reproducibly broken (a crash, a tool failing, the preview and the fixture disagreeing), " +
  "offer to report it with file_bug; it returns a GitHub link by default, and files directly only after the user agrees.";
