# Review: PR 2793 Automation Feedback

## Project context

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| **Repository** | `declancowen/t3code`                     |
| **Remote**     | `origin`                                 |
| **Branch**     | `codex/kiro-acp-image-errors`            |
| **Stack**      | TypeScript, Effect, React/Vite, Electron |

## Scope

- `packages/effect-acp/src/protocol.ts` — provider-originated ACP request-id normalization and response restoration.
- `packages/shared/src/shell.ts` — POSIX login-shell environment capture.
- `apps/desktop/src/updates/DesktopUpdates.ts` — desktop updater install failure recovery.
- `.github/workflows/desktop-release.yml` — manual desktop release tag/ref resolution.
- `apps/web/src/components/chat/ComposerPrimaryActions.tsx` — compact idle send button rendering.
- `apps/server/src/httpCors.ts` / `apps/server/src/http.ts` — credentialed browser API CORS trust boundary.

## Hotspots

- ACP JSON-RPC request identity preservation when Effect RPC requires numeric server request IDs.
- Optional login-shell environment variables under `set -e`.
- Desktop update install handoff partial-failure recovery after the backend is stopped.
- Manual release artifact provenance for versioned desktop releases.
- Compact composer layout parity.
- Credentialed browser API CORS origin reflection.

## Review status

| Field                 | Value                |
| --------------------- | -------------------- |
| **Review started**    | 2026-05-23 22:15 BST |
| **Last reviewed**     | 2026-05-23 22:35 BST |
| **Total turns**       | 2                    |
| **Open findings**     | 0                    |
| **Resolved findings** | 6                    |
| **Accepted findings** | 0                    |

## Automation

| Field                | Value                              |
| -------------------- | ---------------------------------- |
| **Mode**             | `pr-review-automation`             |
| **PR**               | `pingdotgg/t3code#2793`            |
| **State authority**  | GitHub review threads              |
| **Review file role** | Human-readable local review ledger |

## Turn 2 — 2026-05-23 22:35 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

### Automation context

| Field                          | Value                                      |
| ------------------------------ | ------------------------------------------ |
| **Trigger**                    | Fresh `@codex review` after push           |
| **PR**                         | `pingdotgg/t3code#2793`                    |
| **Base ref**                   | `main`                                     |
| **Head SHA**                   | `dd6e413d243d0c521128713c5aaf7ba902b02c2d` |
| **Previous reviewed head SHA** | `657f253c1d2daebc5ad7268d1bf8277d281397c8` |
| **Trusted state source**       | `gh api graphql pullRequest.reviewThreads` |
| **Verification policy**        | Focused CORS/server tests, then repo gates |

**Summary:** Imported and fixed Codex's fresh P1 finding that credentialed browser API CORS reflected arbitrary valid HTTP(S) origins.
**Outcome:** Resolved in the current tree; pending commit/push when required gates pass.
**Risk score:** High — this is a credentialed cross-origin API boundary on authenticated local/remote server APIs.
**Change archetypes:** API/transport security, auth-adjacent browser compatibility, hosted/loopback variant hardening.
**Intended change:** Preserve legitimate hosted-app and local-dev browser access while preventing arbitrary websites from receiving credentialed CORS headers.
**Intent vs actual:** The server CORS predicate now accepts only loopback origins and the known hosted app origins (`app.t3.codes`, `latest.app.t3.codes`, `nightly.app.t3.codes`). The global CORS middleware was replaced with a server-owned middleware so `access-control-allow-credentials: true` is emitted only for trusted origins, including preflight responses.
**Confidence:** High for the reviewed boundary and covered variants; hosted custom-domain CORS remains intentionally unsupported without a future explicit configuration surface.
**Coverage note:** Added focused helper coverage for trusted/hostile origins and an integration regression proving untrusted auth failures are not reflected and do not receive credentialed CORS.
**Finding triage:** Live in `dd6e413d`; fixed in the current working tree.
**Static/analyzer evidence:** No analyzer policy changed. Fallow remains unavailable in this repo/PATH.
**Architecture impact:** The credentialed CORS invariant is now owned by `httpCors.ts` and applied at the HTTP transport middleware boundary in `http.ts`; route handlers keep using the same helper instead of duplicating origin policy.
**Bug classes / invariants checked:** auth-adjacent cross-origin trust boundary; loopback vs hosted vs hostile origin variants; credential header emission must be tied to explicit trusted origins.
**Branch totality:** Rechecked the PR automation threads after the first push, resolved stale/outdated prior Codex threads, and imported the only fresh current-SHA Codex finding.
**Sibling closure:** Checked auth success, auth failure, websocket-token preflight, public environment descriptor, and browser OTLP preflight paths that receive browser API CORS headers.
**Remediation impact surface:** Affects all browser API routes through the global route layer. Local loopback dev and known hosted app origins continue to work; arbitrary hosted origins receive no credentialed CORS.
**Residual risk / unknowns:** Custom hosted app origins would need an explicit future server config field rather than falling through to arbitrary origin reflection.

### External Finding Import

| Source | Finding                                              | Current status | Bug class                                 | Missed invariant/variant                                | Action                                             |
| ------ | ---------------------------------------------------- | -------------- | ----------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Codex  | Credentialed CORS reflects arbitrary HTTP(S) origins | resolved       | Auth-Adjacent Cross-Origin Trust Boundary | credentials must only be allowed for trusted UI origins | fixed with trusted-origin predicate and middleware |

### Validation

- `bun run --cwd apps/server test src/http.test.ts src/server.test.ts` — passed, 70 tests.

### Branch-totality proof

- **Non-delta files/systems re-read:** fresh Codex thread, Effect HTTP CORS middleware implementation, server CORS/auth tests, hosted pairing docs, release hosted app domain docs, auth route CORS helper.
- **Prior open findings rechecked:** First five imported findings remain fixed; their old GitHub threads are resolved or outdated.
- **Prior resolved/adjacent areas revalidated:** Macroscope correctness passed on `dd6e413d`; Cursor Bugbot passed on `dd6e413d`; stale Codex ACP/shell threads were resolved after current-tree proof.
- **Hotspots or sibling paths revisited:** credentialed auth responses, auth failures, preflight handling, public descriptor response headers, OTLP trace preflight, local loopback dev redirect helper.
- **Dependency/adjacent surfaces revalidated:** Hosted pairing expects direct backend reachability from the browser, and hosted release docs define the known app origins that remain trusted.
- **Why this is enough:** The original defect was arbitrary-origin reflection with credentials; the current middleware no longer reflects untrusted origins and the regression test asserts the hostile-origin failure path.

### Challenger pass

Done — assumed the generic Effect CORS middleware could still leak credential headers even after tightening `allowedOrigins`. The first focused test caught that exact companion issue, so the fix now owns both origin reflection and credential-header emission.

### Resolved / Carried / New findings

- `PR2793-CORS-001` — resolved in the current working tree.
  - Fingerprint: `apps/server/src/httpCors.ts:isBrowserApiCorsOriginAllowed:credentialed-cors-trust-boundary`
  - Evidence: trusted origin allowlist and custom middleware conditional credential headers.
  - Verification: `bun run --cwd apps/server test src/http.test.ts src/server.test.ts`.

### Recommendations

1. **Fix first:** commit and push the CORS remediation after repo gates pass.
2. **Then address:** monitor PR checks again; only Vercel authorization should remain external if no new findings appear.

## Turn 1 — 2026-05-23 22:15 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

### Automation context

| Field                          | Value                                                |
| ------------------------------ | ---------------------------------------------------- |
| **Trigger**                    | Manual import of unresolved PR review threads        |
| **PR**                         | `pingdotgg/t3code#2793`                              |
| **Base ref**                   | `main`                                               |
| **Head SHA**                   | `657f253c1d2daebc5ad7268d1bf8277d281397c8`           |
| **Previous reviewed head SHA** | `657f253c1d2daebc5ad7268d1bf8277d281397c8`           |
| **Trusted state source**       | `gh api graphql pullRequest.reviewThreads`           |
| **Verification policy**        | Focused regressions, full repo tests, format/lint/ts |

**Summary:** Imported and fixed all five unresolved automated review findings from Cursor Bugbot, Macroscope, and Codex.
**Outcome:** All clear for the imported finding scope.
**Risk score:** High — one finding was a shared ACP transport identity bug, two were partial-failure/release-provenance bugs, and the remaining two touched shared shell/UI behavior.
**Change archetypes:** protocol compatibility, async lifecycle recovery, release automation, shared utility compatibility, shared UI parity.
**Intended change:** Close the unresolved PR findings without moving ownership boundaries or weakening the Kiro image attachment fix.
**Intent vs actual:** The diff addresses the current-tree failure modes: ACP aliases no longer collide with native numeric IDs; missing optional env vars are non-fatal; updater async install errors restart the backend through the same helper as sync failures; manual desktop release builds checkout the commit pointed to by the requested tag; compact composer mode reaches the send button.
**Confidence:** High — each imported finding now has a direct code change plus focused regression coverage where the repo can test it, and the full repo test script passed after repairing the local Electron binary install.
**Coverage note:** Focused tests were added or updated for ACP ID collision, shell env capture command shape, desktop async install error recovery, and compact composer send button rendering.
**Finding triage:** All imported findings were live in the pre-fix tree and resolved in the current tree.
**Static/analyzer evidence:** No analyzer policy changed. Fallow is unavailable in this repo/PATH. `bun lint` exits 0 with existing unrelated warnings in `ChatView.tsx`, `catalog.test.ts`, and `clientPersistenceStorage.ts`.
**Architecture impact:** Ownership remains in the correct layers: ACP transport owns request-id normalization, shared shell owns environment capture, desktop updater owns backend restart policy, GitHub Actions owns release provenance, and composer presentation owns compact button layout.
**Bug classes / invariants checked:** Identity/uniqueness for ACP request IDs; variant state for unset env vars and compact UI; lifecycle/partial failure for updater install errors; contract/provenance for release tag-to-artifact commit mapping.
**Branch totality:** Reviewed the local fix delta plus the branch Kiro/ACP image diff against `origin/main`. Pre-existing dirty `.gitignore` and untracked app-logo/public/release artifacts remain outside this fix scope.
**Sibling closure:** Checked native numeric ID cleanup and alias response restoration, multi-variable env capture, sync and async updater install failure paths, release checkout consumers of `needs.preflight.outputs.ref`, and the only `SendButton` call site.
**Remediation impact surface:** The ACP fix affects all provider-originated core requests using `effect-acp`; the shell fix affects desktop environment hydration; desktop release/update fixes affect manual releases and failed install recovery; composer fix affects compact render surfaces only.
**Residual risk / unknowns:** The workflow tag lookup is script-reviewed and type/lint/test-covered only through repository gates, not by executing GitHub Actions. Live PR automation will re-evaluate after push.

### External Finding Import

| Source        | Finding                                                                      | Current status | Bug class                                                          | Missed invariant/variant                                         | Action                           |
| ------------- | ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------- |
| Cursor Bugbot | Manual desktop release builds `github.sha` instead of the version tag commit | resolved       | Contract Encoding                                                  | release version/tag must own build provenance                    | fixed in workflow preflight      |
| Macroscope    | Async updater install error does not restart stopped backend                 | resolved       | Lifecycle And Transient Containers / Atomicity And Partial Failure | event-driven install failure must mirror sync failure recovery   | fixed with shared restart helper |
| Macroscope    | Compact composer does not pass compact state to `SendButton`                 | resolved       | Variant State / Affordance Parity                                  | compact mode must reach final idle send control                  | fixed and covered                |
| Codex         | ACP aliased request ID can collide with native numeric provider request IDs  | resolved       | Identity And Uniqueness                                            | internal server request IDs must not overlap active provider IDs | fixed and covered                |
| Codex         | Login shell `printenv` aborts optional env capture under `set -e`            | resolved       | Variant State / Compatibility                                      | unset optional vars must be non-fatal                            | fixed and covered                |

### Validation

- `bun run --cwd packages/effect-acp test src/protocol.test.ts` — passed, 12 tests.
- `bun run --cwd packages/shared test src/shell.test.ts` — passed, 25 tests.
- `bun run --cwd apps/desktop test src/updates/DesktopUpdates.test.ts` — passed, 8 tests.
- `bun run --cwd apps/web test src/components/chat/ComposerPrimaryActions.test.ts` — passed, 9 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed, 13 packages.
- `bun run test` — passed, 13 packages, after running Electron's package postinstall to restore the missing local Electron binary.

### Branch-totality proof

- **Non-delta files/systems re-read:** PR review threads, diff-review gates, architecture enforcement guidance, ACP protocol tests, shell tests, desktop updater tests, composer action tests, desktop release workflow checkout path.
- **Prior open findings rechecked:** All five unresolved GitHub review threads were mapped to current-tree behavior and fixed.
- **Prior resolved/adjacent areas revalidated:** Kiro image attachment handling and provider error surfacing still use the shared ACP adapter/transport path; desktop sync install failure recovery still restarts the backend; composer submit semantics are otherwise unchanged.
- **Hotspots or sibling paths revisited:** ACP alias cleanup vs native ID cleanup, missing vs present shell env vars, sync vs event-driven updater install failures, release workflow tag-push vs manual dispatch, compact vs non-compact send button.
- **Dependency/adjacent surfaces revalidated:** `needs.preflight.outputs.ref` consumers, `DesktopBackendManager.start` restart behavior, `readEnvironmentFromLoginShell` callers, and `ComposerPrimaryActions` idle state rendering.
- **Why this is enough:** The strongest failure modes now have direct regression tests, and the non-testable workflow branch uses the tag commit as the single release provenance source before build checkout.

### Challenger pass

- Done — assumed one serious issue remained in request-id aliasing. The current code aliases colliding numeric provider requests instead of letting them pass through, so two active requests cannot share the same internal request ID even when one original ID is already numeric.

### Resolved / Carried / New findings

- No open findings remain for this imported PR feedback set.

### Recommendations

1. **Fix first:** none.
2. **Then address:** push and let GitHub mark the old review threads outdated or rerun automation on the new commit.
