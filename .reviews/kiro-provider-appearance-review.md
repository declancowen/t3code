# Review: Kiro Provider + Appearance

## Project context

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| **Repository** | `declancowen/t3code`                     |
| **Remote**     | `origin`                                 |
| **Branch**     | `main`                                   |
| **Stack**      | TypeScript, Effect, React/Vite, Electron |

## Scope

- `apps/server/src/provider/acp/StandardAcpAdapter.ts` — ACP prompt lifecycle and active-prompt steering.
- `apps/server/src/provider/Layers/KiroAdapter.ts` — Kiro `_message/send` payload mapping.
- `apps/server/src/provider/acp/StandardAcpAdapter.test.ts` — ACP steering regression coverage.
- `apps/web/src/components/ChatView.tsx` — running-turn image send guard removal.
- `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/NoActiveThreadState.tsx`, `apps/web/src/index.css`, `apps/web/src/routes/*` — sidebar/background appearance changes.

## Hotspots

- ACP active-turn lifecycle ownership and duplicate `session/prompt` prevention.
- Active-prompt steering payload compatibility for text and image attachments.
- Running-turn UI send behavior across provider adapters.
- Sidebar/translucency surface consistency across route wrappers.

## Review status

| Field                 | Value                |
| --------------------- | -------------------- |
| **Review started**    | 2026-05-20           |
| **Last reviewed**     | 2026-05-20 22:17 BST |
| **Total turns**       | 2                    |
| **Open findings**     | 0                    |
| **Resolved findings** | 5                    |
| **Accepted findings** | 0                    |

## Turn 2 — 2026-05-20 22:17 BST

| Field           | Value      |
| --------------- | ---------- |
| **Commit**      | `33128fea` |
| **IDE / Agent** | Codex      |

**Summary:** Re-reviewed the local diff after the Kiro running-turn steering fix was extended from text-only to text plus image attachments.
**Outcome:** All clear with low-risk unknowns.
**Risk score:** Medium — shared ACP adapter lifecycle behavior and provider-specific Kiro payload mapping changed, but the surface is narrow and directly covered by regression tests.
**Change archetypes:** async lifecycle, provider adapter contract, attachment/content contract, shared UI guard.
**Intended change:** While a Kiro ACP prompt is active, sending another message, including image attachments, should steer the active prompt instead of starting a second `session/prompt` or requiring stop/interruption.
**Intent vs actual:** The diff matches the intent. `StandardAcpAdapter` now materializes the same ACP content blocks for initial prompts and active-prompt steering, uses the active-prompt hook when a prompt is in flight, and clears the internal active turn marker when the prompt resolves so later messages start fresh prompts.
**Confidence:** High for local adapter behavior; medium for live Kiro private extension compatibility because `_message/send` is not a public typed contract in this repo.
**Coverage note:** The focused ACP test asserts text steering, attachment steering, no duplicate prompt while active, and fresh prompt after completion.
**Finding triage:** No new blocking findings found.
**Static/analyzer evidence:** `bun lint` passed with 9 existing warnings unrelated to this change.
**Architecture impact:** The shared ACP layer owns content-block materialization and active prompt lifecycle. Kiro-specific private method payload shape stays isolated in `KiroAdapter`, preserving the provider hook architecture.
**Bug classes / invariants checked:** Duplicate active prompt prevention; ACP prompt lifecycle authority; attachment materialization parity; post-completion fresh prompt behavior; UI no longer pre-blocks running image sends.
**Branch totality:** Rechecked the current local diff across ACP adapter, Kiro adapter, ChatView send path, and appearance wrappers.
**Sibling closure:** `rg` confirms `makeStandardAcpAdapter` is used by Kiro only; other providers keep their own adapter paths.
**Remediation impact surface:** No public schema changes. The provider hook signature widened internally to include structured ACP content blocks while preserving the plain text string for text-only hooks.
**Residual risk / unknowns:** A live Kiro browser smoke should still be run after restarting the dev servers because `_message/send` is a Kiro private extension and the repo cannot type-check its runtime payload schema.

### Validation

- `node node_modules/vitest/vitest.mjs run apps/server/src/provider/acp/StandardAcpAdapter.test.ts` — passed, 5 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed with Bun directory added to `PATH` for Turbo package-manager resolution.
- `git diff --check` — passed.

### Branch-totality proof

- **Non-delta files/systems re-read:** `ProviderService.sendTurn`, `ProviderCommandReactor`, `ChatView.onSend`, Kiro adapter hook, ACP content block schema.
- **Prior open findings rechecked:** Previous interrupt/cancel findings remain covered by existing `StandardAcpAdapter` tests.
- **Prior resolved/adjacent areas revalidated:** Active prompt steering now covers both text-only and attachment variants.
- **Hotspots or sibling paths revisited:** Provider hook usage was searched; Kiro remains the only standard ACP adapter consumer.
- **Dependency/adjacent surfaces revalidated:** UI image send guard removal checked against backend attachment materialization and provider routing.
- **Why this is enough:** The high-risk behavior is adapter routing, and the tests directly prove the routing invariant under active and completed prompt states.

### Challenger pass

- Done — the most likely missed issue was attachment sends still being blocked in the UI or rejected by the text-only active-prompt helper. Both paths were removed/reworked and covered with a regression test.

### Resolved / Carried / New findings

No new findings.

### Recommendations

1. **Fix first:** none.
2. **Then address:** restart local backend/web and smoke test Kiro text + image steering against the real CLI.
3. **Patterns noticed:** Kiro private ACP extensions should remain isolated behind provider hook options, not spread into orchestration or UI.

## Turn 1 — 2026-05-20

**Outcome:** No open blocking findings remained after the original Kiro provider and appearance review.

### Findings Resolved

- F-001: Active ACP prompt registration happened after `turn.started`, leaving a short window where a Kiro follow-up could be routed as a second `session/prompt` instead of `_message/send`.
- F-002: Kiro active-prompt follow-ups are intentionally attached to the existing turn, so the UI local-dispatch guard did not clear when the server acknowledged a follow-up on the same running turn.
- F-003: The mobile collapsed composer send button lost the environment-unavailable disable guard while enabling running follow-ups.
- F-004: ACP interrupt completion was locally raced against `session/prompt`, so an interrupted turn could be marked cancelled before the provider acknowledged prompt termination.
- F-005: ACP interrupt skipped `session/cancel` when no local active prompt was registered, leaving resumed/desynced remote prompts unstoppable.
