import {
  type KiroSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";
import { makeKiroAcpAdapter } from "../acp/KiroAcpAdapter.ts";
import { augmentProviderTurnInputWithCodexContext } from "../CodexSkillBridge.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kiro");

export interface KiroAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

export function makeKiroAdapter(kiroSettings: KiroSettings, options?: KiroAdapterLiveOptions) {
  return makeKiroAcpAdapter({
    provider: PROVIDER,
    runtimeLabel: "Kiro",
    ...(options?.environment ? { environment: options.environment } : {}),
    ...(options?.nativeEventLogPath ? { nativeEventLogPath: options.nativeEventLogPath } : {}),
    ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
    ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
    // kiro-cli `acp` honors `session/cancel`: it stops a streaming turn within
    // ~1ms and resolves the in-flight `session/prompt` with `stopReason: "cancelled"`
    // (verified against kiro-cli 2.5.0). So interrupt forwards cancel and lets
    // the CLI terminate the turn while keeping the session warm — we do NOT tear
    // down the process, which previously forced an expensive cold start on the
    // next message. interruptTurn adds a bounded force-terminate fallback for the
    // case where the CLI is stuck inside a tool/command and ignores cancel.
    stopSessionOnInterruptCancelUnsupported: false,
    // Terminal-event guarantee: if `session/prompt` fails at the RPC/transport
    // level (CLI crash, broken pipe, malformed response) there is no `stopReason`
    // to drive a normal turn.completed, so the UI would otherwise hang "running".
    // We emit a terminal turn.completed{failed} in that case. Note this is NOT a
    // double-emit risk: ACP's terminal turn signal IS the prompt response, so a
    // successful/cancelled turn goes through the normal completion path and never
    // reaches here. (Graceful cancel resolves with stopReason "cancelled" — see A.)
    emitTurnFailedOnError: true,
    makeRuntime: (input) =>
      makeKiroAcpRuntime({
        kiroSettings,
        ...(options?.environment ? { environment: options.environment } : {}),
        ...input,
      }),
  }).pipe(
    Effect.map((adapter) => {
      const cwdByThreadId = new Map<ThreadId, string>();
      const startSession = adapter.startSession;
      const sendTurn = adapter.sendTurn;
      const stopSession = adapter.stopSession;
      const stopAll = adapter.stopAll;
      return Object.assign(adapter, {
        startSession: (input: Parameters<typeof adapter.startSession>[0]) =>
          startSession(input).pipe(
            Effect.tap((session) =>
              Effect.sync(() => {
                if (session.cwd) {
                  cwdByThreadId.set(session.threadId, session.cwd);
                }
              }),
            ),
          ),
        sendTurn: (input: Parameters<typeof adapter.sendTurn>[0]) =>
          augmentProviderTurnInputWithCodexContext(input, {
            cwd: cwdByThreadId.get(input.threadId),
            ...(options?.environment ? { environment: options.environment } : {}),
          }).pipe(Effect.flatMap((augmentedInput) => sendTurn(augmentedInput))),
        stopSession: (threadId: Parameters<typeof adapter.stopSession>[0]) =>
          stopSession(threadId).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cwdByThreadId.delete(threadId);
              }),
            ),
          ),
        stopAll: () =>
          stopAll().pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cwdByThreadId.clear();
              }),
            ),
          ),
      });
    }),
  );
}
