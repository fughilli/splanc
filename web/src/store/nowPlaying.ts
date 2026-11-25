/**
 * Which library effect is playing on each device, as far as this session knows
 * (the Effects tab's fixture card + "Playing" row badge). In memory only: set
 * when the app plays an effect, and hydrated from the device's own answer
 * (get_effect_uniforms → effect id) when the Effects tab opens.
 */

type Listener = () => void;

class NowPlaying {
  private byDevice = new Map<string, string>();
  private listeners = new Set<Listener>();

  get(deviceId: string | null | undefined): string | null {
    return deviceId ? this.byDevice.get(deviceId) ?? null : null;
  }

  set(deviceId: string | null | undefined, effectId: string | null): void {
    if (!deviceId) return;
    const prev = this.byDevice.get(deviceId) ?? null;
    if (prev === effectId) return;
    if (effectId) this.byDevice.set(deviceId, effectId);
    else this.byDevice.delete(deviceId);
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const nowPlaying = new NowPlaying();
