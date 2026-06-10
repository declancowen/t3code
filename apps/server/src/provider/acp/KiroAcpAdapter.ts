import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "./AcpNativeLogging.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "./AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import type { AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { kiroEffortFromSelections } from "../kiroEffort.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const STANDARD_ACP_RESUME_VERSION = 1 as const;
// Grace period after forwarding `session/cancel` before force-terminating the
// session. Graceful cancel of a streaming turn resolves in ~1ms, so this only
// fires when the agent is genuinely stuck (e.g. blocked inside a tool/command
// the CLI will not abort), guaranteeing that stop always works.
const CANCEL_FORCE_TERMINATE_DELAY = "5 seconds";
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export interface KiroAcpAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly runtimeLabel: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly stopSessionOnInterruptCancelUnsupported?: boolean;
  /**
   * When the underlying agent's `prompt` call fails after a turn has started,
   * emit a terminal `turn.completed` event with `state: "failed"` before
   * propagating the error. Without this, a started turn that errors mid-prompt
   * (e.g. an agent that rejects an image) never receives a terminal lifecycle
   * event, leaving consumers stuck in a perpetual "running" state. Opt-in so
   * providers whose CLIs do not surface such failures keep prior behavior.
   */
  readonly emitTurnFailedOnError?: boolean;
  readonly makeRuntime: (
    input: {
      readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
      readonly cwd: string;
      readonly resumeSessionId?: string;
      readonly clientInfo: { readonly name: string; readonly version: string };
      /**
       * Initial reasoning effort level to spawn the runtime with. Applied via
       * the agent CLI's spawn flag (kiro-cli `acp --effort`) since there is no
       * in-session ACP method for effort.
       */
      readonly effort?: string;
    } & Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">,
  ) => Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface StandardAcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly acpSessionId: string;
  readonly supportsImagePrompts: boolean;
  /**
   * Reasoning effort level the underlying ACP process was spawned with. kiro-cli
   * accepts effort only as a spawn flag, so changing effort mid-thread requires
   * respawning the session (see `sendTurn`). Tracked here to detect changes.
   */
  effort: string | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  activePrompt:
    | {
        readonly turnId: TurnId;
      }
    | undefined;
  stopped: boolean;
  // Serializes `session/prompt` calls for this session so mid-turn follow-ups run
  // as ordered real prompts (kiro-cli runs one prompt at a time).
  readonly promptLock: Semaphore.Semaphore;
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStandardAcpResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== STANDARD_ACP_RESUME_VERSION) return undefined;
  if (raw.protocol !== "acp") return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function supportsImagePromptContent(initializeResult: EffectAcpSchema.InitializeResponse): boolean {
  return initializeResult.agentCapabilities?.promptCapabilities?.image === true;
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) return exact;
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) return partial;
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) return undefined;

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly model: string | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_model" | "session/set_mode";
  }) => ProviderAdapterError;
}): Effect.Effect<void, ProviderAdapterError> {
  return Effect.gen(function* () {
    if (input.model !== undefined) {
      yield* input.runtime.setModel(input.model).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            method: "session/set_model",
          }),
        ),
      );
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) return;

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

export function makeKiroAcpAdapter(
  options: KiroAcpAdapterOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | Scope.Scope
  | Crypto.Crypto
> {
  return Effect.gen(function* () {
    const provider = options.provider;
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make(provider);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options.nativeEventLogger ??
      (options.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, StandardAcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider,
            method: "crypto/randomUUIDv4",
            detail: `Failed to generate ${options.runtimeLabel} runtime identifier.`,
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: `Failed to process ${options.runtimeLabel} ACP extension event.`,
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const offerTurnFailedEvent = (
      threadId: ThreadId,
      turnId: TurnId,
      error: ProviderAdapterError,
    ) =>
      Effect.gen(function* () {
        const detail = (error as { readonly detail?: unknown }).detail;
        const candidate =
          typeof detail === "string" && detail.trim().length > 0
            ? detail
            : (error as { readonly message?: unknown }).message;
        const errorMessage = typeof candidate === "string" ? candidate.trim() : "";
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider,
          threadId,
          turnId,
          payload: {
            state: "failed",
            ...(errorMessage.length > 0 ? { errorMessage } : {}),
          },
        });
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: StandardAcpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) return;
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<StandardAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
      }
      return Effect.succeed(ctx);
    };

    const buildPromptContentBlocks = (
      input: Parameters<ProviderAdapterShape<ProviderAdapterError>["sendTurn"]>[0],
      method: string,
      supportsImagePrompts: boolean,
    ) =>
      Effect.gen(function* () {
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        if (input.attachments && input.attachments.length > 0) {
          if (!supportsImagePrompts) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "sendTurn",
              issue: `${options.runtimeLabel} session does not support image attachments.`,
            });
          }
          for (const attachment of input.attachments) {
            // Image support is gated by the agent's advertised
            // `promptCapabilities.image` (checked above via supportsImagePrompts).
            // We intentionally do NOT impose a local MIME allowlist: the CLI is
            // the authority on which image types it accepts, and pre-rejecting
            // here only risks blocking types the CLI would have handled. If a
            // type is genuinely unsupported, the CLI surfaces the error.
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider,
                method,
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        return promptParts;
      });

    const stopSessionInternal = (ctx: StandardAcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== provider) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: `Expected provider '${provider}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const selectedModel =
            input.modelSelection?.instanceId === boundInstanceId
              ? input.modelSelection.model
              : undefined;
          const selectedEffort =
            input.modelSelection?.instanceId === boundInstanceId
              ? kiroEffortFromSelections(input.modelSelection.options)
              : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: StandardAcpSessionContext;

          const resumeSessionId = parseStandardAcpResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider,
            threadId: input.threadId,
          });
          const acp = yield* options
            .makeRuntime({
              childProcessSpawner,
              cwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              ...(selectedEffort ? { effort: selectedEffort } : {}),
              clientInfo: { name: "t3-code", version: "0.0.0" },
              ...acpNativeLoggers,
            })
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  return {
                    outcome:
                      resolved === "cancel"
                        ? ({ outcome: "cancelled" } as const)
                        : {
                            outcome: "selected" as const,
                            optionId: acpPermissionOutcome(resolved, params.options),
                          },
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(provider, input.threadId, "session/start", error),
            ),
          );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            model: selectedModel,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(provider, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: selectedModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: STANDARD_ACP_RESUME_VERSION,
              protocol: "acp",
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const promptLock = yield* Semaphore.make(1);
          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            acpSessionId: started.sessionId,
            supportsImagePrompts: supportsImagePromptContent(started.initializeResult),
            effort: selectedEffort,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            activePrompt: undefined,
            stopped: false,
            promptLock,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider,
                      threadId: ctx.threadId,
                      ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                      payload: {
                        usage: {
                          usedTokens: event.usedTokens,
                          lastUsedTokens: event.usedTokens,
                          ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}),
                        },
                      },
                    });
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(`Stopped ${options.runtimeLabel} ACP event stream.`, {
                cause,
                provider,
                threadId: input.threadId,
              }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider,
            threadId: input.threadId,
            payload: { state: "ready", reason: `${options.runtimeLabel} ACP session ready` },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        // kiro-cli accepts the reasoning effort level only as a spawn flag
        // (`kiro-cli acp --effort`); there is no in-session ACP method for it.
        // So a mid-thread effort change is applied by respawning the ACP session
        // and resuming the same conversation, mirroring how the model selector
        // switches in-session but via a fresh process. Done before acquiring the
        // prompt lock so we never restart underneath an in-flight prompt.
        const requestedEffort =
          input.modelSelection?.instanceId === boundInstanceId
            ? kiroEffortFromSelections(input.modelSelection.options)
            : undefined;
        const current = sessions.get(input.threadId);
        if (
          current &&
          !current.stopped &&
          requestedEffort !== undefined &&
          requestedEffort !== current.effort
        ) {
          yield* startSession({
            threadId: input.threadId,
            provider,
            ...(current.session.cwd ? { cwd: current.session.cwd } : {}),
            runtimeMode: current.session.runtimeMode,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            ...(current.session.resumeCursor ? { resumeCursor: current.session.resumeCursor } : {}),
          });
        }

        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* randomUUIDv4);

        // Serialize every turn on a per-session prompt lock. kiro-cli runs one
        // prompt per session at a time, and its ACP `_message/send` does NOT inject
        // into a running turn (it is accepted and then ignored), so we never use it.
        // Instead each message — including mid-turn follow-ups and image
        // attachments — waits its turn here and is submitted as a real
        // `session/prompt`, in arrival order, with nothing dropped. The prompt await
        // holds the permit; interrupt does not take this lock, so stop is never
        // blocked behind a running turn. Interrupt cancels only the active turn;
        // messages already queued are preserved and run in order — never discarded.
        return yield* ctx.promptLock.withPermit(
          Effect.gen(function* () {
            if (ctx.stopped) {
              // The session was torn down while this turn waited in the queue
              // (e.g. force-terminate after a genuinely stuck turn). Emit a
              // terminal cancelled lifecycle so the UI does not show it
              // perpetually "running", and never contact the CLI.
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider,
                threadId: input.threadId,
                turnId,
                payload: {},
              });
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider,
                threadId: input.threadId,
                turnId,
                payload: { state: "cancelled", stopReason: "cancelled" },
              });
              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }

            const turnModel =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection.model
                : undefined;
            const model = turnModel ?? ctx.session.model;
            yield* applyRequestedSessionConfiguration({
              runtime: ctx.acp,
              runtimeMode: ctx.session.runtimeMode,
              interactionMode: input.interactionMode,
              model,
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(provider, input.threadId, method, cause),
            });

            const promptParts = yield* buildPromptContentBlocks(
              input,
              "session/prompt",
              ctx.supportsImagePrompts,
            );

            const previousActivePrompt = ctx.activePrompt;
            const previousActiveTurnId = ctx.activeTurnId;
            const previousSessionActiveTurnId = ctx.session.activeTurnId;
            ctx.activePrompt = { turnId };
            ctx.activeTurnId = turnId;
            ctx.lastPlanFingerprint = undefined;
            ctx.session = {
              ...ctx.session,
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider,
              threadId: input.threadId,
              turnId,
              payload: model ? { model } : {},
            });

            const result = yield* ctx.acp
              .prompt({
                prompt: promptParts,
              })
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(provider, input.threadId, "session/prompt", error),
                ),
                Effect.tapError((error) =>
                  options.emitTurnFailedOnError
                    ? offerTurnFailedEvent(input.threadId, turnId, error)
                    : Effect.void,
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (ctx.activePrompt?.turnId === turnId) {
                      ctx.activePrompt = previousActivePrompt;
                    }
                    if (ctx.activeTurnId === turnId) {
                      ctx.activeTurnId = previousActiveTurnId;
                    }
                    if (ctx.session.activeTurnId === turnId) {
                      const nextSession = { ...ctx.session };
                      if (previousSessionActiveTurnId !== undefined) {
                        nextSession.activeTurnId = previousSessionActiveTurnId;
                      } else {
                        delete nextSession.activeTurnId;
                      }
                      ctx.session = nextSession;
                    }
                  }),
                ),
              );

            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
            const nextSession = {
              ...ctx.session,
              updatedAt: yield* nowIso,
              ...(model ? { model } : {}),
            };
            delete nextSession.activeTurnId;
            ctx.session = nextSession;

            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });

            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }),
        );
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // Interrupt cancels only the active turn. Messages already queued behind
        // it are intentionally preserved and run in order once the active turn
        // resolves — we never silently discard a message the user submitted.
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const interruptedTurnId = ctx.activePrompt?.turnId;
        // Prefer the CLI's own graceful cancel: it stops a streaming turn almost
        // immediately and resolves session/prompt with stopReason "cancelled".
        yield* Effect.ignore(ctx.acp.cancel);
        if (options.stopSessionOnInterruptCancelUnsupported) {
          yield* stopSessionInternal(ctx);
          return;
        }
        if (interruptedTurnId === undefined) {
          return;
        }
        // Bounded fallback: kiro-cli does not reliably honor session/cancel while
        // it is blocked inside a tool/command execution. If the same turn is still
        // active after the grace period, force-terminate the session so stop always
        // takes effect. Runs in the background so the stop is acknowledged
        // immediately and never blocks a concurrent stopSession.
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Effect.sleep(CANCEL_FORCE_TERMINATE_DELAY);
            if (!ctx.stopped && ctx.activePrompt?.turnId === interruptedTurnId) {
              yield* Effect.logWarning(
                `${options.runtimeLabel} turn did not stop on cancel; force-terminating session.`,
                { provider, threadId },
              );
              yield* stopSessionInternal(ctx);
            }
          }),
        );
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
        Effect.catch((cause) =>
          Effect.logWarning(`Failed to finalize ${options.runtimeLabel} ACP adapter cleanly.`, {
            cause,
            provider,
          }),
        ),
      ),
    );

    return {
      provider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
