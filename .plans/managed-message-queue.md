# Plan: Visible, Managed Message Queue

## Problem

When a turn is active and the user sends more messages, those messages are
serialized **inside the Kiro adapter** by an in-memory `promptLock` (per-session
semaphore). This queue is invisible to the orchestration layer and the UI, with
two consequences:

1. **Invisible / unmanageable** — the UI thinks the message was "sent" and a turn
   started, but it is actually parked in the adapter lock. The user cannot see
   that it is queued, and cannot remove it before it is dispatched.
2. **Lost on teardown** — the queue is tied to the live session's `ctx`. A
   force-terminate / crash / disconnect drops every queued message
   (`ctx.stopped` path emits `cancelled`, nothing re-dispatches).

## What is already correct (verified — do NOT rebuild)

- **Serialization & ordering**: prompts run FIFO in one warm session; proven by a
  live `kiro-cli acp` repro (essay → 1 → 2 → 3 ran in submitted order).
- **Graceful stop**: fixed separately — `session/cancel` is now sent as a real
  JSON-RPC notification (commit `ed907afd`); cancel resolves in ~1ms.
- **Queued messages survive a normal interrupt**: `generation` discard removed;
  interrupt cancels only the active turn.
- **Context resume on teardown**: handled by `ProviderService` session-directory
  recovery — on the next message it calls `adapter.startSession({ resumeCursor })`
  → `session/load`. Confirmed in logs (force-terminate `08:38:53` → `session/load`
  `08:39:43`). The conversation context carries across teardown. No work needed.

So the **only** remaining gap is the queue itself.

## Design

Move "one turn at a time" ownership from the adapter to the orchestration layer,
and make the pending queue a first-class, visible, durable concept.

### 1. Orchestration owns the queue
- `decider` (`thread.turn.start`): if `targetThread.session.activeTurnId` is set
  (a turn is active), emit a new `thread.message-queued` event **instead of**
  `thread.turn-start-requested`. (`requireThread` already exposes session status /
  `activeTurnId` — no new plumbing.)
- On `turn.completed` / `turn.cancelled` / `turn.failed`: dispatch the next queued
  message FIFO (emit `thread.turn-start-requested` for the head of the queue).
- On session teardown/recovery: keep the queue and dispatch into the recovered
  (resumed) session, so queued messages are no longer dropped.

### 2. Contracts (`packages/contracts`)
- New event `thread.message-queued` (threadId, messageId, text, attachments,
  createdAt).
- New commands:
  - `thread.queued-message.remove` (threadId, messageId)
  - `thread.queued-message.edit` (threadId, messageId, text, attachments)
- Thread projection gains `queuedMessages: { id, text, attachments, createdAt,
  status: "queued" | "dispatching" }[]`.

### 3. Projection
- `message-queued` appends to `queuedMessages`; dispatch removes the head and
  starts its turn; remove command drops a specific entry; edit replaces the
  text/attachments of a still-queued entry (rejected once `dispatching`).

### 4. Web UI (`apps/web`)
- Render `queuedMessages` pinned at the bottom of the thread in a distinct
  "queued" style; flip to a normal turn row when dispatched.
- Per-item **edit** (inline, re-sends `thread.queued-message.edit`) and
  **delete** (✕, `thread.queued-message.remove`) controls. Edit is only allowed
  while status is `queued`.

### 5. Adapter cleanup
- With orchestration guaranteeing one in-flight turn, the adapter `promptLock`
  becomes a thin safety net (keep as defense-in-depth or remove after soak).

## Out of scope
- Context resume (already wired). Cancel encoding (already fixed).
- Reordering queued messages (future; FIFO only for v1).

## Verification
- Unit: decider enqueues when active, dispatches FIFO on completion, honors
  remove; projection reducer for queue add/remove/dispatch.
- Integration: send during active turn → appears queued → dispatched in order;
  remove a queued message → never dispatched; teardown mid-queue → context
  resumes AND queued messages still drain.
- Manual: local `vp run dev:desktop` — queued messages visible + deletable.

## Status
- Not started. Sanity-checked: no existing queue concept to duplicate; decider
  has the needed read-model state; resume-on-teardown already works.

## Build notes / corrected scope (from a first implementation pass)

The contracts + decider layers were drafted and verified, then reverted to keep
the tree green pending the projection work. Re-apply as follows:

### Contracts (verified to typecheck)
- `OrchestrationQueuedMessageStatus = Schema.Literals(["queued","dispatching"])`.
- `OrchestrationQueuedMessage = { id: MessageId, text, attachments?: ChatAttachment[],
  status (default "queued"), createdAt, updatedAt }`.
- Add `queuedMessages: Schema.Array(OrchestrationQueuedMessage)` (decoding default
  `[]`) to `OrchestrationThread`.
- Commands `thread.queued-message.remove` {messageId} and `thread.queued-message.edit`
  {messageId, text, attachments: UploadChatAttachment[]} — add to BOTH
  `DispatchableClientOrchestrationCommand` and `ClientOrchestrationCommand`.
- Payloads + events: `thread.message-queued`
  {messageId, text, attachments?, modelSelection?, interactionMode, createdAt},
  `thread.queued-message-removed` {messageId}, `thread.queued-message-edited`
  {messageId, text, attachments?}. Add to the event union AND
  `OrchestrationEventType` literals.

### Decider (verified to typecheck)
- `thread.turn.start`: compute `turnActive = session && status!="stopped" &&
  activeTurnId!=null`. If `sourceProposedPlan===undefined && (turnActive ||
  queuedMessages.length>0)` → return a single `thread.message-queued` event
  (carry text/attachments/modelSelection/interactionMode); do NOT emit
  message-sent/turn-start-requested. Else existing behavior.
- Add `thread.queued-message.remove` / `.edit` cases → emit the corresponding
  events (before the `default: command satisfies never` arm).

### Projection — BIGGER THAN EXPECTED (the reason for the pause)
Projections are **SQL-materialized**, not just in-memory:
- `messages` is persisted in the `projection.thread-messages` table by
  `ProjectionPipeline.ts` (`thread.message-sent` reducer ~line 690/788) and read
  back by `ProjectionSnapshotQuery.ts` (~line 1189 `messagesByThread`).
- So durable `queuedMessages` needs a **new `projection.thread-queued-messages`
  table + migration**, pipeline reducers for the 3 queue events
  (insert / delete / update + clear-on-dispatch), and a snapshot-query join
  (plus the in-memory `projector.ts` reducer for live reads).
- Every place that constructs an `OrchestrationThread` needs `queuedMessages`
  (ProjectionSnapshotQuery ~1189/1387, projector default, and ~6 test fixtures:
  OrchestrationEngine.test, ProjectionSnapshotQuery.test, commandInvariants.test,
  server.test).
- **Durability decision:** v1 could reduce only in `projector.ts` (live, in-session)
  and stub `queuedMessages: []` in the SQL snapshot — but that loses the queue on
  cold reload/restart and risks message loss, so prefer doing the SQL table.
- **Regression guard:** the decider enqueue branch MUST land together with the
  projection reduction; shipping enqueue alone makes queued messages vanish.

### Dispatch reactor
- On `turn.completed` / `turn.cancelled` / `turn.failed` for a thread with a
  non-empty queue and no active turn: dispatch the FIFO head — emit
  `thread.message-sent` + `thread.turn-start-requested` for it AND remove it from
  the queue (must bypass the decider's enqueue check). Re-dispatch into the
  resumed session after a teardown.

### Web UI
- Render `queuedMessages` pinned at the thread bottom in a "queued" style; inline
  edit (`thread.queued-message.edit`, allowed only while `status==="queued"`) +
  delete (`thread.queued-message.remove`); flip to a normal turn on dispatch.
