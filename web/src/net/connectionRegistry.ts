/**
 * Single-flight per device: at most one live wss/TLS socket to a given device at
 * a time. The player serves TLS from only TWO slots, so a stray parallel
 * handshake — the background liveness prober racing the comms socket, or a
 * duplicate URL spelling of the same device — starves real connections and the
 * player logs a fatal-alert storm (mbedtls -0x7780). Keying the live comms client
 * by host lets the prober MULTIPLEX liveness onto it (read its `welcome` instead
 * of opening a second socket), collapsing the nominal case to one socket.
 */

import type { LedMapperClient } from "./client";

/** The host[:port] that identifies a device's TLS endpoint. Two URL spellings
 * that hit the same endpoint (path/query differences) share a key; distinct
 * hostnames for the same device (IP vs .local) do not — those are collapsed
 * later by MAC in the device store. */
export function deviceHostKey(wssUrl: string): string {
  try {
    return new URL(wssUrl).host; // host includes the port
  } catch {
    return wssUrl;
  }
}

class ConnectionRegistry {
  private byHost = new Map<string, LedMapperClient>();

  /** Record the live comms client for its device host. Call right after
   * constructing the active client (last writer wins per host). */
  register(client: LedMapperClient): void {
    this.byHost.set(deviceHostKey(client.url), client);
  }

  /** Drop a client on close/disconnect. No-op if a newer client already replaced
   * it for that host (so a reconnect that re-registered isn't clobbered). */
  unregister(client: LedMapperClient): void {
    const key = deviceHostKey(client.url);
    if (this.byHost.get(key) === client) this.byHost.delete(key);
  }

  /** The comms client that currently owns this device host's single socket, if
   * any — whether connected or still mid-handshake. The prober consults this to
   * avoid opening a parallel socket to a device we're already talking to. */
  clientFor(wssUrl: string): LedMapperClient | undefined {
    return this.byHost.get(deviceHostKey(wssUrl));
  }
}

export const connectionRegistry = new ConnectionRegistry();
