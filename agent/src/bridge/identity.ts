/**
 * The bridge's identity: an Ed25519 keypair, made once and kept in
 * `<state dir>/bridge.json` (mode 0600), plus the bridge id each relay assigned
 * to it. The private key never leaves this file; the relay only ever sees the
 * public key and signatures (docs/design/cloud-relay.md, "Bridge identity").
 */

import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface StateFile {
  v: 1;
  key: { private_pkcs8: string; public_raw: string };
  /** relay origin -> bridge id. */
  bridges: Record<string, string>;
}

export function defaultStateDir(): string {
  const env = process.env["SPLANC_BRIDGE_STATE_DIR"];
  if (env) return env;
  // systemd's StateDirectory= (the Pi appliance's unit: /var/lib/splanc-bridge).
  const unit = process.env["STATE_DIRECTORY"]?.split(":")[0];
  if (unit) return unit;
  const xdg = process.env["XDG_STATE_HOME"];
  return join(xdg || join(homedir(), ".local", "state"), "splanc");
}

const b64url = (b: Buffer) => b.toString("base64url");

export class BridgeIdentity {
  private readonly file: string;
  private data: StateFile;
  private readonly key: KeyObject;

  constructor(stateDir = defaultStateDir()) {
    this.file = join(stateDir, "bridge.json");
    let data: StateFile | null = null;
    try {
      data = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
    } catch {
      data = null;
    }
    if (!data?.key?.private_pkcs8) {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      data = {
        v: 1,
        key: {
          private_pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
          public_raw: (publicKey.export({ format: "jwk" }) as { x: string }).x,
        },
        bridges: {},
      };
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      this.data = data;
      this.save();
    }
    this.data = data;
    this.key = createPrivateKey({ key: Buffer.from(data.key.private_pkcs8, "base64"), format: "der", type: "pkcs8" });
  }

  get publicKey(): string {
    return this.data.key.public_raw;
  }

  sign(msg: string): string {
    return b64url(sign(null, Buffer.from(msg), this.key));
  }

  bridgeId(relay: string): string | undefined {
    return this.data.bridges[relay];
  }

  setBridgeId(relay: string, id: string): void {
    this.data.bridges[relay] = id;
    this.save();
  }

  forget(relay: string): void {
    delete this.data.bridges[relay];
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}
