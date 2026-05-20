import { type KiroSettings, ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import { makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";
import { makeStandardAcpAdapter } from "../acp/StandardAcpAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kiro");
const KIRO_ACTIVE_PROMPT_MESSAGE_METHOD = "_message/send";

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
    sendMessageWhilePromptActive: ({ runtime, sessionId, content }) =>
      runtime.request(KIRO_ACTIVE_PROMPT_MESSAGE_METHOD, { sessionId, content }),
    makeRuntime: (input) =>
      makeKiroAcpRuntime({
        kiroSettings,
        ...(options?.environment ? { environment: options.environment } : {}),
        ...input,
      }),
  });
}
