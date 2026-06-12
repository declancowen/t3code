import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (v: string): CommandId => CommandId.make(v);
const asEventId = (v: string): EventId => EventId.make(v);
const asProjectId = (v: string): ProjectId => ProjectId.make(v);
const asThreadId = (v: string): ThreadId => ThreadId.make(v);
const asMessageId = (v: string): MessageId => MessageId.make(v);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT = asProjectId("project-queue");
const THREAD = asThreadId("thread-queue");
const MODEL = { instanceId: ProviderInstanceId.make("kiro"), model: "claude-opus-4.8" };

// Build a read model with a project + thread, optionally with an active turn
// and/or a pre-existing queued message.
const seed = (opts: {
  activeTurnId?: string | null;
  queuedMessageId?: string;
  providerName?: string;
}) =>
  Effect.gen(function* () {
    const providerName = opts.providerName ?? "kiro";
    let seq = 0;
    const next = () => (seq += 1);
    let rm: OrchestrationReadModel = createEmptyReadModel(NOW);
    rm = yield* projectEvent(rm, {
      sequence: next(),
      eventId: asEventId(`evt-${seq}`),
      aggregateKind: "project",
      aggregateId: PROJECT,
      type: "project.created",
      occurredAt: NOW,
      commandId: asCommandId(`cmd-${seq}`),
      causationEventId: null,
      correlationId: asCommandId(`cmd-${seq}`),
      metadata: {},
      payload: {
        projectId: PROJECT,
        title: "Queue Project",
        workspaceRoot: "/tmp/queue",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    rm = yield* projectEvent(rm, {
      sequence: next(),
      eventId: asEventId(`evt-${seq}`),
      aggregateKind: "thread",
      aggregateId: THREAD,
      type: "thread.created",
      occurredAt: NOW,
      commandId: asCommandId(`cmd-${seq}`),
      causationEventId: null,
      correlationId: asCommandId(`cmd-${seq}`),
      metadata: {},
      payload: {
        threadId: THREAD,
        projectId: PROJECT,
        title: "Queue Thread",
        modelSelection: MODEL,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    if (opts.activeTurnId !== undefined) {
      rm = yield* projectEvent(rm, {
        sequence: next(),
        eventId: asEventId(`evt-${seq}`),
        aggregateKind: "thread",
        aggregateId: THREAD,
        type: "thread.session-set",
        occurredAt: NOW,
        commandId: asCommandId(`cmd-${seq}`),
        causationEventId: null,
        correlationId: asCommandId(`cmd-${seq}`),
        metadata: {},
        payload: {
          threadId: THREAD,
          session: {
            threadId: THREAD,
            status: opts.activeTurnId === null ? "ready" : "running",
            providerName,
            providerInstanceId: ProviderInstanceId.make(providerName),
            runtimeMode: "full-access",
            activeTurnId: opts.activeTurnId === null ? null : TurnId.make(opts.activeTurnId),
            lastError: null,
            updatedAt: NOW,
          },
        },
      });
    }
    if (opts.queuedMessageId) {
      rm = yield* projectEvent(rm, {
        sequence: next(),
        eventId: asEventId(`evt-${seq}`),
        aggregateKind: "thread",
        aggregateId: THREAD,
        type: "thread.message-queued",
        occurredAt: NOW,
        commandId: asCommandId(`cmd-${seq}`),
        causationEventId: null,
        correlationId: asCommandId(`cmd-${seq}`),
        metadata: {},
        payload: {
          threadId: THREAD,
          messageId: asMessageId(opts.queuedMessageId),
          text: "queued text",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: NOW,
        },
      });
    }
    return rm;
  });

const turnStartCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: asCommandId("cmd-turn-start"),
  threadId: THREAD,
  message: { messageId: asMessageId("msg-new"), role: "user", text: "hello", attachments: [] },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: NOW,
};

const decide = (
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
  queueEnabled: boolean,
) =>
  decideOrchestrationCommand({ command, readModel, queueEnabled }).pipe(
    Effect.map((r) => (Array.isArray(r) ? r : [r])),
    Effect.provide(NodeServices.layer),
  );

it.effect("enqueues a message sent during an active turn when the flag is on", () =>
  Effect.gen(function* () {
    const rm = yield* seed({ activeTurnId: "turn-1" });
    const events = yield* decide(turnStartCommand, rm, true);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["thread.message-queued"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does NOT enqueue when the flag is off (starts the turn as before)", () =>
  Effect.gen(function* () {
    const rm = yield* seed({ activeTurnId: "turn-1" });
    const events = yield* decide(turnStartCommand, rm, false);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["thread.message-sent", "thread.turn-start-requested"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does NOT enqueue for steer-capable providers (Codex) even when the flag is on", () =>
  Effect.gen(function* () {
    // Codex supports mid-turn steering. The decider must bypass the queue
    // and route the message through the normal `thread.message-sent` +
    // `thread.turn-start-requested` path so the adapter can steer the
    // active turn instead of parking the input.
    const rm = yield* seed({ activeTurnId: "turn-1", providerName: "codex" });
    const events = yield* decide(turnStartCommand, rm, true);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["thread.message-sent", "thread.turn-start-requested"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("dispatch drains the FIFO head into a real turn when idle", () =>
  Effect.gen(function* () {
    const rm = yield* seed({ activeTurnId: null, queuedMessageId: "queued-1" });
    const command: OrchestrationCommand = {
      type: "thread.queued-message.dispatch",
      commandId: asCommandId("cmd-dispatch"),
      threadId: THREAD,
      createdAt: NOW,
    };
    const events = yield* decide(command, rm, true);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "thread.queued-message-removed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("dispatch is a no-op while a turn is still active", () =>
  Effect.gen(function* () {
    const rm = yield* seed({ activeTurnId: "turn-1", queuedMessageId: "queued-1" });
    const command: OrchestrationCommand = {
      type: "thread.queued-message.dispatch",
      commandId: asCommandId("cmd-dispatch"),
      threadId: THREAD,
      createdAt: NOW,
    };
    const events = yield* decide(command, rm, true);
    assert.deepEqual(events, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
