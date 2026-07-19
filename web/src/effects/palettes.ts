/**
 * Shared effect colour palettes (0xRRGGBB), used by both the effects-simulator
 * workspace and the phone playback UI so "which colours" means the same thing
 * everywhere. An effect's palette is sent in PlaybackParams.palette; the
 * firmware/WASM Sim cycles through it (pulses pick entries; flood walks it).
 */
export interface Palette {
  name: string;
  rgb: number[];
}

export const PALETTES: Palette[] = [
  { name: "Rainbow", rgb: [0xff0000, 0xff8800, 0xffff00, 0x00ff00, 0x0088ff, 0x8800ff] },
  { name: "Fire", rgb: [0xff2200, 0xff6600, 0xffaa00, 0xffdd44] },
  { name: "Ice", rgb: [0x0044ff, 0x00aaff, 0x66ddff, 0xffffff] },
  { name: "Forest", rgb: [0x004411, 0x00aa33, 0x66ff66, 0xccff99] },
  { name: "Sunset", rgb: [0xff0066, 0xff6600, 0xffcc00] },
  { name: "Cyan", rgb: [0x00ffdd] },
  { name: "Magenta", rgb: [0xff00aa] },
  { name: "White", rgb: [0xffffff] },
];
