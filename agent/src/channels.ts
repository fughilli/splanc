/**
 * Per-channel LED counts as the player RENDERS them (#397).
 *
 * `hardware_config_state.channels[].ledCount` is the persisted per-channel
 * CONFIG (set_hardware_config / set_led_count), and 0 there means "never set",
 * not "no LEDs": the Hardware Setup page shows it as an empty field. A fixture
 * that was only mapped (never given a count) boots with `leds=0/0` and still
 * renders every LED, because an effect frame drives exactly the stored map's LED
 * count (player_app/main.cpp: `xmit_len = lm_map_len()`) and, with channel 1
 * unconfigured, puts all of them on channel 0. Reporting the raw 0 told tools
 * and agents the strip was empty.
 *
 * So the reported `ledCount` is the configured count when any channel is
 * configured (unchanged), else the map-derived count on channel 0 (capped at the
 * boot's LED capacity, as the firmware caps it). The raw config stays visible as
 * `configuredLedCount`, and `ledCountSource` says which one `ledCount` is.
 */

export interface ChannelConfig {
  channel: number;
  ledCount: number;
}

export type LedCountSource = "configured" | "map" | "unset";

export type RenderedChannel<C extends ChannelConfig> = Omit<C, "ledCount"> & {
  /** LEDs this channel renders. */
  ledCount: number;
  /** The persisted hardware config count (0 = not set). */
  configuredLedCount: number;
  ledCountSource: LedCountSource;
};

/** `channels` with `ledCount` = the rendered count (see the module doc).
 * `mapLeds` is the stored map's LED count (0 / null = no map); `capacity` the
 * boot's LED capacity (`hardware_config_state.led_capacity`, 0 = unknown). */
export function renderedChannels<C extends ChannelConfig>(
  channels: readonly C[],
  mapLeds: number | null | undefined,
  capacity = 0,
): RenderedChannel<C>[] {
  const configured = channels.some((c) => (c.ledCount | 0) > 0);
  let fromMap = Math.max(0, mapLeds ?? 0);
  if (capacity > 0) fromMap = Math.min(fromMap, capacity);
  // The firmware splits at the channel-0 boundary: with nothing configured every
  // rendered LED goes out on the lowest channel.
  const first = channels.length ? Math.min(...channels.map((c) => c.channel)) : 0;
  return channels.map((c) => {
    const cfg = Math.max(0, c.ledCount | 0);
    let ledCount = cfg;
    let ledCountSource: LedCountSource = cfg > 0 ? "configured" : "unset";
    if (!configured && fromMap > 0) {
      ledCount = c.channel === first ? fromMap : 0;
      ledCountSource = c.channel === first ? "map" : "unset";
    }
    return { ...c, ledCount, configuredLedCount: cfg, ledCountSource };
  });
}
