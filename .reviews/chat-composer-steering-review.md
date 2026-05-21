# Review: Chat Composer Steering

## Project context

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| **Repository** | `declancowen/t3code`                     |
| **Remote**     | `origin`                                 |
| **Branch**     | `main`                                   |
| **Stack**      | TypeScript, React/Vite, Zustand, Lexical |

## Scope

- `apps/web/src/components/chat/ChatComposer.tsx` — composer imperative handle and prompt snapshot synchronization.
- `apps/web/src/components/ChatView.tsx` — send, plan follow-up, and plan implementation caller behavior.

## Hotspots

- Lexical editor state vs persisted composer draft/ref state.
- Running-turn same-thread steering through the existing `thread.turn.start` dispatch path.
- Plan follow-up and implementation flows that read model state after draft text has been cleared.
- Failure rollback that restores prompt, attachments, and terminal contexts after send failure.

## Review status

| Field                 | Value                |
| --------------------- | -------------------- |
| **Review started**    | 2026-05-21 11:10 BST |
| **Last reviewed**     | 2026-05-21 11:10 BST |
| **Total turns**       | 1                    |
| **Open findings**     | 0                    |
| **Resolved findings** | 0                    |
| **Accepted findings** | 0                    |

## Turn 1 — 2026-05-21 11:10 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Reviewed the local diff that fixes Enter submission for running-thread steering by reading a fresh Lexical composer snapshot at the send boundary.
**Outcome:** No findings.
**Risk score:** Medium — the change touches a shared composer handle, keyboard/form submission, async optimistic send, and plan follow-up helper paths.
**Change archetypes:** shared-ui, optimistic-state, fallback-state.
**Intended change:** Make Enter submit use the current visible editor text while preserving the existing send/steering dispatch path and avoiding stale `promptRef` reads.
**Intent vs actual:** The main send path now obtains a fresh `prompt` through `getSendContext()` and uses that value directly. Model-only callers pass `{ syncPrompt: false }`, preventing stale editor content from being reintroduced after plan follow-up clears the draft.
**Confidence:** Medium-high — the main bug class and sibling callers were traced; no browser smoke was run in this shell.
**Coverage note:** TypeScript and diff whitespace checks passed. Existing lint warnings are unrelated. Exact Bun wrapper commands remain blocked because `bun` is not on PATH.
**Finding triage:** No live findings. The earlier overly broad submit-level sync was removed before this review and is no longer in the diff.
**Static/analyzer evidence:** `oxlint` was run earlier on this diff and reported existing warnings only; no architecture/static analyzer policy changes are present.
**Architecture impact:** The authoritative prompt snapshot stays in the composer/editor owner and is exposed through the existing narrow imperative composer boundary. `ChatView` continues to own orchestration/send semantics and does not read Lexical directly.
**Bug classes / invariants checked:** keyboard submit uses visible editor text; plan follow-up does not resurrect cleared prompt text; implement-in-new-thread reads model state without mutating prompt state; failure rollback restores the sent prompt snapshot; image/terminal context snapshots still come from composer refs.
**Branch totality:** Reviewed the full current local diff for the two changed files and checked the existing `.reviews` ledger for prior related context.
**Sibling closure:** Checked `onSend`, `onSubmitPlanFollowUp`, `onImplementPlanInNewThread`, composer pending-input guard, composer draft store `setPrompt`/`clearComposerContent`, and all `getSendContext` callers.
**Remediation impact surface:** The change is contained to web presentation/application state. No contract schema, server orchestration, provider adapter, or persistence migration surface changed.
**Residual risk / unknowns:** The live UI should still be browser-smoked against a running agent turn to confirm Lexical command ordering in the actual app shell.

### Validation

- `./node_modules/.bin/oxfmt` — passed.
- `./node_modules/.bin/oxlint --report-unused-disable-directives` — passed with existing warnings only.
- `./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit` — passed.
- `git diff --check` — passed.
- `bun fmt`, `bun lint`, `bun typecheck` — not run because `bun` is not available in this shell.

### Branch-totality proof

- **Non-delta files/systems re-read:** diff-review gates, architecture-standards review checklist, `ChatView`, `ChatComposer`, `composerDraftStore`, existing review ledger.
- **Prior open findings rechecked:** No prior open findings applied to this new review area.
- **Prior resolved/adjacent areas revalidated:** Prior ledger notes that running composer visibility intentionally remains stop-only while keyboard/form submit routes through `onSend`; this diff preserves that.
- **Hotspots or sibling paths revisited:** main send, plan follow-up, implement-in-new-thread, pending user input early return, draft clear/set actions, send failure rollback.
- **Dependency/adjacent surfaces revalidated:** No server/provider contract change; Codex steering remains on the existing `thread.turn.start` path.
- **Why this is enough:** The risky ownership boundary is the composer snapshot crossing into `ChatView`; all current callers were audited and the non-primary model-only callers explicitly opt out of prompt sync.

### Challenger pass

- Not required for Medium risk. The likely miss was prompt sync leaking into plan follow-up after draft clearing; the current diff prevents that with `{ syncPrompt: false }`.

### Resolved / Carried / New findings

- None.

### Recommendations

1. **Fix first:** none.
2. **Then address:** browser-smoke the running-agent Enter steering path once the app is running with Bun available.
3. **Patterns noticed:** if more model-only callers appear, split the imperative handle into explicit prompt-send and model-selection readers instead of growing the `syncPrompt` option.
