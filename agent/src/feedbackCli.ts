/**
 * `splanc-agent feedback …` — the Splanc team's triage CLI for agent-feedback
 * reports (docs/design/agent-feedback.md; the logic is in feedback.ts):
 *
 *   feedback list [--signature s] [--status s] [--file f ...]   grouped by signature
 *   feedback show <id> | --file f                              one report, readable
 *   feedback replay <id> | --file f [--runs 5] [--host …]      re-run its tool calls against a player
 *   feedback status <id> <received|reproduced|not_reproduced|fixed|wontfix> [--fixed-in X] [--message m]
 *   feedback fixture <id> | --file f --out f.json --expect ok/ok/sent [--note n]
 *
 * Reports come from the relay's private store (SPLANC_FEEDBACK_TOKEN = the
 * relay's FEEDBACK_ADMIN_TOKEN; --relay or SPLANC_RELAY) or from files the app
 * exported. Replay drives the hub's own tools over an in-memory MCP link, so a
 * player is needed: a scratch fixture or a test player (--host); never a user's.
 */

import { writeFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { FeedbackReport } from "../../web/src/feedback/agentTrace";
import { relayUrl } from "./bridge/relayLink";
import { flag, type Parsed } from "./cliArgs";
import {
  getReport,
  groupReports,
  listReports,
  readReportFile,
  regressionFixture,
  renderGroups,
  renderReplay,
  renderReport,
  replayReport,
  setReportStatus,
  summaryOf,
  type ToolAnswer,
  type TriageSource,
} from "./feedback";
import type { Hub } from "./hub";
import { createServer, VERSION } from "./server";

function source(p: Parsed): TriageSource {
  const token = process.env["SPLANC_FEEDBACK_TOKEN"] ?? "";
  if (!token) throw new Error("set SPLANC_FEEDBACK_TOKEN (the relay's FEEDBACK_ADMIN_TOKEN), or pass --file");
  return { relay: relayUrl(flag(p, "relay")), token };
}

async function reports(p: Parsed, id: string | undefined): Promise<FeedbackReport[]> {
  const files = p.flags.get("file") ?? [];
  if (files.length) return files.flatMap((f) => readReportFile(f));
  if (!id) throw new Error("pass a report id, or --file <exported report>");
  return [(await getReport(source(p), id)).report];
}

/** MCP calls against `hub`'s tools. */
export async function hubCaller(hub: Hub): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolAnswer>> {
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "splanc-feedback-replay", version: VERSION });
  await client.connect(b);
  return async (name, args) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as { isError?: boolean; content: { type: string; text?: string }[] };
    return { isError: r.isError === true, text: r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") };
  };
}

export async function runFeedback(p: Parsed, makeHub: () => Hub): Promise<number> {
  const sub = p.positional[1];
  const id = p.positional[2];
  switch (sub) {
    case "list": {
      const files = p.flags.get("file") ?? [];
      const rows = files.length
        ? files.flatMap((f) => readReportFile(f)).map((r) => summaryOf(r))
        : await listReports(source(p), {
            ...(flag(p, "signature") ? { signature: flag(p, "signature")! } : {}),
            ...(flag(p, "status") ? { status: flag(p, "status")! } : {}),
          });
      console.log(flag(p, "json") ? JSON.stringify(groupReports(rows), null, 2) : renderGroups(groupReports(rows)));
      return 0;
    }
    case "show": {
      for (const r of await reports(p, id)) console.log(flag(p, "json") ? JSON.stringify(r, null, 2) : renderReport(r));
      return 0;
    }
    case "replay":
    case "fixture": {
      const [r] = await reports(p, id);
      const hub = makeHub();
      try {
        const call = await hubCaller(hub);
        const res = await replayReport(r!, Number(flag(p, "runs") ?? (sub === "fixture" ? 1 : 5)), { call });
        if (sub === "replay") {
          console.log(flag(p, "json") ? JSON.stringify(res, null, 2) : renderReplay(res));
          return res.reproduced > 0 ? 0 : 3;
        }
        const out = flag(p, "out");
        const expect = flag(p, "expect");
        if (!out || !expect) throw new Error("fixture needs --out <file.json> and --expect <outcome once fixed, e.g. ok/ok/sent>");
        writeFileSync(out, `${JSON.stringify(regressionFixture(r!, res, { failingStepOutcome: expect, note: flag(p, "note") ?? "" }), null, 2)}\n`);
        console.log(`wrote ${out} (failing step ${res.failingStep + 1}, must replay as ${expect})`);
        return 0;
      } finally {
        hub.close();
      }
    }
    case "status": {
      const status = p.positional[3];
      if (!id || !status) throw new Error("feedback status <id> <received|reproduced|not_reproduced|fixed|wontfix>");
      await setReportStatus(source(p), id, status, {
        ...(flag(p, "fixed-in") ? { fixed_in: flag(p, "fixed-in")! } : {}),
        ...(flag(p, "message") ? { message: flag(p, "message")! } : {}),
      });
      console.log(JSON.stringify({ ok: true, id, status }));
      return 0;
    }
    default:
      throw new Error("feedback list | show <id> | replay <id> | status <id> <status> | fixture <id> (see `splanc-agent help`)");
  }
}
