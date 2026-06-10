import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AcpRequestError } from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  type ChatAttachment,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { AcpParsedSessionEvent } from "./AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import { makeKiroAcpAdapter } from "./KiroAcpAdapter.ts";

const standardAcpAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-standard-acp-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeAcpRuntime(input: {
  readonly cancelCalled: Deferred.Deferred<void>;
  readonly cancel?: Effect.Effect<void, AcpRequestError>;
  readonly prompt?: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, unknown>;
  readonly request?: (method: string, payload: unknown) => Effect.Effect<unknown, unknown>;
  readonly supportsImagePrompts?: boolean;
  readonly events?: Stream.Stream<AcpParsedSessionEvent>;
}): AcpSessionRuntimeShape {
  const ignoreHandler = () => Effect.void;
  return {
    handleRequestPermission: ignoreHandler,
    handleElicitation: ignoreHandler,
    handleReadTextFile: ignoreHandler,
    handleWriteTextFile: ignoreHandler,
    handleCreateTerminal: ignoreHandler,
    handleTerminalOutput: ignoreHandler,
    handleTerminalWaitForExit: ignoreHandler,
    handleTerminalKill: ignoreHandler,
    handleTerminalRelease: ignoreHandler,
    handleSessionUpdate: ignoreHandler,
    handleElicitationComplete: ignoreHandler,
    handleUnknownExtRequest: ignoreHandler,
    handleUnknownExtNotification: ignoreHandler,
    handleExtRequest: ignoreHandler,
    handleExtNotification: ignoreHandler,
    start: () =>
      Effect.succeed({
        sessionId: "fake-session",
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            ...(input.supportsImagePrompts === false
              ? {}
              : { promptCapabilities: { image: true } }),
          },
        } as EffectAcpSchema.InitializeResponse,
        sessionSetupResult: {
          sessionId: "fake-session",
        } as EffectAcpSchema.NewSessionResponse,
        modelConfigId: undefined,
      }),
    getEvents: () => input.events ?? Stream.empty,
    getModeState: Effect.sync(() => undefined),
    getConfigOptions: Effect.succeed([]),
    prompt: input.prompt ?? (() => Effect.succeed({ stopReason: "end_turn" })),
    cancel: input.cancel ?? Deferred.succeed(input.cancelCalled, undefined).pipe(Effect.asVoid),
    setMode: () => Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse),
    setConfigOption: () => Effect.succeed({} as EffectAcpSchema.SetSessionConfigOptionResponse),
    setModel: () => Effect.void,
    request: input.request ?? (() => Effect.succeed({})),
    notify: () => Effect.void,
  } as unknown as AcpSessionRuntimeShape;
}

it.effect("keeps interrupted ACP turns active until session/prompt resolves", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-cancel-awaits-prompt");
    const promptStarted = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(Deferred.await(promptResponse)),
        ),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const sendTurnFiber = yield* adapter
      .sendTurn({
        threadId,
        input: "cancel after provider prompt resolves",
        attachments: [],
      })
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isUndefined(sendTurnFiber.pollUnsafe());
    yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));
    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));
    yield* Effect.yieldNow;

    const earlySendTurnExit = sendTurnFiber.pollUnsafe();
    assert.isUndefined(earlySendTurnExit);

    yield* Deferred.succeed(promptResponse, { stopReason: "cancelled" });
    const result = yield* Fiber.join(sendTurnFiber);

    assert.equal(result.threadId, threadId);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("rejects image attachments when the ACP session does not advertise image prompts", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-image-capability-required");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      supportsImagePrompts: false,
    });
    const attachment: ChatAttachment = {
      type: "image",
      id: "image-capability-required",
      name: "image-capability-required.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const error = yield* adapter
      .sendTurn({
        threadId,
        input: "inspect",
        attachments: [attachment],
      })
      .pipe(Effect.flip, Effect.timeout("1 second"));

    assert.instanceOf(error, ProviderAdapterValidationError);
    assert.equal(error.issue, "Fake ACP session does not support image attachments.");
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("forwards image attachments to the agent without a local MIME allowlist", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("kiro-acp-image-forwarded");
    const cancelCalled = yield* Deferred.make<void>();
    const promptReceived = yield* Deferred.make<ReadonlyArray<EffectAcpSchema.ContentBlock>>();
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: (payload) =>
        Deferred.succeed(promptReceived, payload.prompt).pipe(
          Effect.as({ stopReason: "end_turn" } as EffectAcpSchema.PromptResponse),
        ),
    });

    // image/svg+xml was previously rejected by a static MIME allowlist before it
    // ever reached the CLI. The agent advertises promptCapabilities.image, so the
    // attachment must now be forwarded and the CLI left to accept or reject it.
    const attachment: ChatAttachment = {
      type: "image",
      id: "imageforwardedsvg",
      name: "diagram.svg",
      mimeType: "image/svg+xml",
      sizeBytes: 6,
    };

    const serverConfig = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    assert.isNotNull(attachmentPath);
    yield* fs.makeDirectory(serverConfig.attachmentsDir, { recursive: true });
    yield* fs.writeFile(attachmentPath!, new TextEncoder().encode("<svg/>"));

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Kiro",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "inspect",
      attachments: [attachment],
    });

    const promptParts = yield* Deferred.await(promptReceived).pipe(Effect.timeout("1 second"));
    const imageBlock = promptParts.find(
      (block): block is Extract<EffectAcpSchema.ContentBlock, { type: "image" }> =>
        block.type === "image",
    );
    assert.isDefined(imageBlock);
    assert.equal(imageBlock!.mimeType, "image/svg+xml");
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("forwards session/cancel when no local active prompt is registered", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-cancel-without-local-prompt");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({ cancelCalled });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("stops the ACP session on interrupt when cancel is unsupported and opted in", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("standard-acp-cancel-unsupported-stops-session");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      cancel: Deferred.succeed(cancelCalled, undefined).pipe(
        Effect.andThen(Effect.fail(AcpRequestError.methodNotFound("session/cancel"))),
      ),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      stopSessionOnInterruptCancelUnsupported: true,
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));

    assert.isFalse(yield* adapter.hasSession(threadId));
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("stops the ACP session on interrupt after a successful cancel write when opted in", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("standard-acp-cancel-write-stops-session");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({ cancelCalled });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      stopSessionOnInterruptCancelUnsupported: true,
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));

    assert.isFalse(yield* adapter.hasSession(threadId));
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("serializes overlapping sendTurn calls into ordered prompts", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("kiro-acp-serializes-turns");
    const firstStarted = yield* Deferred.make<void>();
    const firstResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    const promptTexts: Array<string> = [];
    const requests: Array<string> = [];
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: (payload) =>
        Effect.gen(function* () {
          const text = payload.prompt
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          promptTexts.push(text);
          if (promptTexts.length === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            return yield* Deferred.await(firstResponse);
          }
          return { stopReason: "end_turn" } as EffectAcpSchema.PromptResponse;
        }),
      request: (method) =>
        Effect.sync(() => {
          requests.push(method);
          return {};
        }),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Kiro",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const firstFiber = yield* adapter.sendTurn({ threadId, input: "first" }).pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"));

    // A second message arrives while the first turn is still active.
    const secondFiber = yield* adapter
      .sendTurn({ threadId, input: "second" })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    // It must not start a concurrent prompt and must never use `_message/send`.
    assert.equal(promptTexts.length, 1);
    assert.deepEqual(requests, []);

    // Completing the first turn lets the queued second turn run as a real prompt.
    yield* Deferred.succeed(firstResponse, { stopReason: "end_turn" });
    yield* Fiber.join(firstFiber);
    yield* Fiber.join(secondFiber).pipe(Effect.timeout("2 seconds"));

    assert.deepEqual(promptTexts, ["first", "second"]);
    assert.deepEqual(requests, []);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("runs turns queued behind an interrupted prompt (never discards them)", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("kiro-acp-discard-queued-on-interrupt");
    const firstStarted = yield* Deferred.make<void>();
    const firstResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    let promptCallCount = 0;
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Effect.gen(function* () {
          promptCallCount += 1;
          if (promptCallCount === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            return yield* Deferred.await(firstResponse);
          }
          return { stopReason: "end_turn" } as EffectAcpSchema.PromptResponse;
        }),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Kiro",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const firstFiber = yield* adapter.sendTurn({ threadId, input: "first" }).pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"));

    const queuedFiber = yield* adapter
      .sendTurn({ threadId, input: "queued behind the active turn" })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    // Stop cancels the active turn, but the queued message is preserved and
    // runs once the cancelled turn resolves — it is never discarded.
    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.succeed(firstResponse, { stopReason: "cancelled" });
    yield* Fiber.join(firstFiber);
    yield* Fiber.join(queuedFiber).pipe(Effect.timeout("2 seconds"));

    // The queued turn must still reach the CLI after an interrupt.
    assert.equal(promptCallCount, 2);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("starts a fresh ACP prompt after the previous prompt completes", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-new-prompt-after-completion");
    const cancelCalled = yield* Deferred.make<void>();
    let promptCallCount = 0;
    const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Effect.sync(() => {
          promptCallCount += 1;
          return { stopReason: "end_turn" as const };
        }),
      request: (method, payload) =>
        Effect.sync(() => {
          requests.push({ method, payload });
          return {};
        }),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "first prompt",
      attachments: [],
    });
    const sessionsAfterFirst = yield* adapter.listSessions();
    assert.isUndefined(sessionsAfterFirst[0]?.activeTurnId);
    yield* adapter.sendTurn({
      threadId,
      input: "second prompt",
      attachments: [],
    });

    assert.equal(promptCallCount, 2);
    assert.deepEqual(requests, []);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("force-terminates the session when a turn ignores cancel", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("kiro-acp-cancel-force-terminate");
    const promptStarted = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      // cancel is a no-op here: the turn keeps running, simulating the CLI being
      // stuck inside a tool/command that does not honor session/cancel.
      cancel: Effect.void,
      prompt: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(Deferred.await(promptResponse)),
        ),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Kiro",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const turnFiber = yield* adapter
      .sendTurn({ threadId, input: "stuck turn" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));
    assert.isTrue(yield* adapter.hasSession(threadId));

    yield* adapter.interruptTurn(threadId);
    yield* Effect.yieldNow;
    // Cancel did nothing; advancing past the grace period fires the fallback.
    yield* TestClock.adjust("6 seconds");
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    assert.isFalse(yield* adapter.hasSession(threadId));
    yield* Fiber.interrupt(turnFiber);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("emits a context-window token-usage event from ACP usage updates", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("standard-acp-usage-update-token-usage");
    const cancelCalled = yield* Deferred.make<void>();
    const usageEvent: AcpParsedSessionEvent = {
      _tag: "UsageUpdated",
      usedTokens: 4242,
      maxTokens: 1_000_000,
      rawPayload: {
        sessionId: "fake-session",
        update: { sessionUpdate: "usage_update", used: 4242, size: 1_000_000 },
      },
    };
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      events: Stream.make(usageEvent),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Kiro",
      makeRuntime: () => Effect.succeed(runtime),
    });

    const collector = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.type === "thread.token-usage.updated"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const collected = yield* Fiber.join(collector).pipe(Effect.timeout("2 seconds"));
    const events = Array.from(collected);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event?.type, "thread.token-usage.updated");
    if (event?.type === "thread.token-usage.updated") {
      assert.equal(event.threadId, threadId);
      assert.deepEqual(event.payload.usage, {
        usedTokens: 4242,
        lastUsedTokens: 4242,
        maxTokens: 1_000_000,
      });
    }
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("spawns with the selected effort and respawns when effort changes mid-thread", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const instanceId = ProviderInstanceId.make(provider);
    const threadId = ThreadId.make("kiro-acp-effort-spawn-and-respawn");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({ cancelCalled });
    const spawnedEfforts: Array<string | undefined> = [];

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Kiro",
      makeRuntime: (input) =>
        Effect.sync(() => {
          spawnedEfforts.push(input.effort);
          return runtime;
        }),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: {
        instanceId,
        model: "auto",
        options: [{ id: "effort", value: "high" }],
      },
    });

    // Same effort on the next turn must NOT respawn the ACP process.
    yield* adapter.sendTurn({
      threadId,
      input: "first",
      modelSelection: {
        instanceId,
        model: "auto",
        options: [{ id: "effort", value: "high" }],
      },
    });

    // Changing effort mid-thread respawns with the new --effort level.
    yield* adapter.sendTurn({
      threadId,
      input: "second",
      modelSelection: {
        instanceId,
        model: "auto",
        options: [{ id: "effort", value: "max" }],
      },
    });

    assert.deepEqual(spawnedEfforts, ["high", "max"]);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("issues session/set_mode for the selected Kiro agent at start and per turn", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const instanceId = ProviderInstanceId.make(provider);
    const threadId = ThreadId.make("kiro-acp-agent-mode-switch");
    const cancelCalled = yield* Deferred.make<void>();
    const base = makeFakeAcpRuntime({ cancelCalled });
    const setModes: Array<string> = [];
    const runtime: AcpSessionRuntimeShape = {
      ...base,
      setMode: (modeId: string) => {
        setModes.push(modeId);
        return Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse);
      },
    };

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Kiro",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: {
        instanceId,
        model: "auto",
        options: [{ id: "agentMode", value: "kiro_planner" }],
      },
    });

    yield* adapter.sendTurn({
      threadId,
      input: "hi",
      modelSelection: {
        instanceId,
        model: "auto",
        options: [{ id: "agentMode", value: "kiro_guide" }],
      },
    });

    assert.deepEqual(setModes, ["kiro_planner", "kiro_guide"]);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);
