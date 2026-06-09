import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { AcpRequestError } from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { type ChatAttachment, ProviderDriverKind, ThreadId } from "@t3tools/contracts";

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

it.effect("routes text sent during an active ACP prompt through the active prompt hook", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-active-prompt-steering");
    const promptStarted = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    let promptCallCount = 0;
    const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Effect.sync(() => {
          promptCallCount += 1;
        }).pipe(
          Effect.andThen(Deferred.succeed(promptStarted, undefined)),
          Effect.andThen(Deferred.await(promptResponse)),
        ),
      request: (method, payload) =>
        Effect.sync(() => {
          requests.push({ method, payload });
          return {};
        }),
    });

    const adapter = yield* makeKiroAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      activePromptMessageMethod: "_message/send",
      sendMessageWhilePromptActive: ({ runtime, sessionId, content }) =>
        runtime.request("_message/send", { sessionId, content }),
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
        input: "start a long prompt",
        attachments: [],
      })
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isUndefined(sendTurnFiber.pollUnsafe());
    yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));
    assert.equal(promptCallCount, 1);

    const steeringResult = yield* adapter
      .sendTurn({
        threadId,
        input: "steer the active prompt",
        attachments: [],
      })
      .pipe(Effect.timeout("1 second"));

    assert.equal(promptCallCount, 1);
    assert.deepEqual(requests, [
      {
        method: "_message/send",
        payload: { sessionId: "fake-session", content: "steer the active prompt" },
      },
    ]);

    yield* Deferred.succeed(promptResponse, { stopReason: "end_turn" });
    const firstResult = yield* Fiber.join(sendTurnFiber);

    assert.equal(steeringResult.turnId, firstResult.turnId);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect(
  "routes attachments sent during an active ACP prompt through the active prompt hook",
  () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("cursor");
      const threadId = ThreadId.make("standard-acp-active-prompt-attachment-steering");
      const promptStarted = yield* Deferred.make<void>();
      const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
      const cancelCalled = yield* Deferred.make<void>();
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const imageBytes = Buffer.from("fake image bytes");
      const attachment: ChatAttachment = {
        type: "image",
        id: "active-prompt-image",
        name: "active-prompt-image.png",
        mimeType: "image/png",
        sizeBytes: imageBytes.byteLength,
      };
      yield* fileSystem.writeFile(
        path.join(serverConfig.attachmentsDir, `${attachment.id}.png`),
        imageBytes,
      );

      let promptCallCount = 0;
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const runtime = makeFakeAcpRuntime({
        cancelCalled,
        prompt: () =>
          Effect.sync(() => {
            promptCallCount += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(promptStarted, undefined)),
            Effect.andThen(Deferred.await(promptResponse)),
          ),
        request: (method, payload) =>
          Effect.sync(() => {
            requests.push({ method, payload });
            return {};
          }),
      });

      const adapter = yield* makeKiroAcpAdapter({
        provider,
        runtimeLabel: "Fake ACP",
        activePromptMessageMethod: "_message/send",
        sendMessageWhilePromptActive: ({ runtime, sessionId, content, contentBlocks }) =>
          runtime.request("_message/send", {
            sessionId,
            content:
              contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
                ? content
                : contentBlocks,
          }),
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
          input: "start a long prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isUndefined(sendTurnFiber.pollUnsafe());
      yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));

      const steeringResult = yield* adapter
        .sendTurn({
          threadId,
          input: "inspect this",
          attachments: [attachment],
        })
        .pipe(Effect.timeout("1 second"));

      assert.equal(promptCallCount, 1);
      assert.deepEqual(requests, [
        {
          method: "_message/send",
          payload: {
            sessionId: "fake-session",
            content: [
              { type: "text", text: "inspect this" },
              {
                type: "image",
                data: imageBytes.toString("base64"),
                mimeType: "image/png",
              },
            ],
          },
        },
      ]);

      yield* Deferred.succeed(promptResponse, { stopReason: "end_turn" });
      const firstResult = yield* Fiber.join(sendTurnFiber);

      assert.equal(steeringResult.turnId, firstResult.turnId);
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
      activePromptMessageMethod: "_message/send",
      sendMessageWhilePromptActive: ({ runtime, sessionId, content }) =>
        runtime.request("_message/send", { sessionId, content }),
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

it.effect("restores the previous active ACP turn after an overlapping prompt fails", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-overlap-failure-restores-active-turn");
    const promptStarted = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    let promptCallCount = 0;
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Effect.sync(() => {
          promptCallCount += 1;
          return promptCallCount;
        }).pipe(
          Effect.flatMap((callCount) =>
            callCount === 1
              ? Deferred.succeed(promptStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(promptResponse)),
                )
              : Effect.fail(
                  AcpRequestError.internalError("Internal error", "Prompt already in progress"),
                ),
          ),
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
        input: "start a long prompt",
        attachments: [],
      })
      .pipe(Effect.forkChild);

    yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));
    const sessionsWhileFirstPromptRuns = yield* adapter.listSessions();
    const firstActiveTurnId = sessionsWhileFirstPromptRuns[0]?.activeTurnId;
    assert.isDefined(firstActiveTurnId);

    const secondExit = yield* adapter
      .sendTurn({
        threadId,
        input: "overlapping prompt",
        attachments: [],
      })
      .pipe(Effect.exit, Effect.timeout("1 second"));

    assert.isTrue(Exit.isFailure(secondExit));
    const sessionsAfterOverlapFailure = yield* adapter.listSessions();
    assert.equal(sessionsAfterOverlapFailure[0]?.activeTurnId, firstActiveTurnId);

    yield* Deferred.succeed(promptResponse, { stopReason: "end_turn" });
    yield* Fiber.join(sendTurnFiber);
    yield* adapter.stopSession(threadId);
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
