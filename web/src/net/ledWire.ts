// WS2812 wire-rate math shared by the Hardware Setup screen (and its test).

/**
 * The fastest effect rate the WS2812 wire allows for a longest channel of `leds`
 * LEDs — the firmware autoscaler's wire ceiling (firmware/fps: 28.8 µs per LED —
 * 24 bits of three 400 ns samples — + a 300 µs latch, on the 5..80 fps 5-fps
 * ladder with 5% headroom).
 */
export function wireFpsCeiling(leds: number): number {
  const wireUs = leds > 0 ? Math.floor((leds * 28_800) / 1000) + 300 : 0;
  for (let fps = 80; fps > 5; fps -= 5) {
    if (Math.floor((Math.floor(1_000_000 / fps) * 95) / 100) >= wireUs) return fps;
  }
  return 5;
}
