import {
  type KiroSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";
import { makeStandardAcpAdapter } from "../acp/StandardAcpAdapter.ts";
import { augmentProviderTurnInputWithCodexContext } from "../CodexSkillBridge.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kiro");
const KIRO_ACTIVE_PROMPT_MESSAGE_METHOD = "_message/send";
const SUPPORTED_KIRO_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface KiroAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

export function makeKiroAdapter(kiroSettings: KiroSettings, options?: KiroAdapterLiveOptions) {
  return makeStandardAcpAdapter({
    provider: PROVIDER,
    runtimeLabel: "Kiro",
    ...(options?.environment ? { environment: options.environment } : {}),
    ...(options?.nativeEventLogPath ? { nativeEventLogPath: options.nativeEventLogPath } : {}),
    ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
    ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
    activePromptMessageMethod: KIRO_ACTIVE_PROMPT_MESSAGE_METHOD,
    supportedImageMimeTypes: SUPPORTED_KIRO_IMAGE_MIME_TYPES,
    stopSessionOnInterruptCancelUnsupported: true,
    sendMessageWhilePromptActive: ({ runtime, sessionId, content, contentBlocks }) =>
      runtime.request(KIRO_ACTIVE_PROMPT_MESSAGE_METHOD, {
        sessionId,
        content:
          contentBlocks.length === 1 && contentBlocks[0]?.type === "text" ? content : contentBlocks,
      }),
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
