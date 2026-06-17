#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import { createInterface } from "node:readline";

type JsonRpcMessage = {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
};

function writePrettyResponse(id: string | number | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result }, null, 2)}\n`);
}

function handleMessage(message: JsonRpcMessage): void {
  switch (message.method) {
    case "initialize":
      writePrettyResponse(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      });
      return;
    case "session/new":
      writePrettyResponse(message.id, {
        sessionId: "pretty-session-1",
        configOptions: [],
      });
      return;
    case "session/prompt":
      writePrettyResponse(message.id, { stopReason: "end_turn" });
      return;
    default:
      writePrettyResponse(message.id, {});
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  handleMessage(JSON.parse(trimmed) as JsonRpcMessage);
});
