# Kiro Provider + Appearance Diff Review

Date: 2026-05-20
Scope: Full local diff against `main`, including Kiro ACP steering/stop behavior, appearance settings, chat typography, and desktop artifact tweaks.
Skills: `diff-review`, `architecture-standards`

## Result

No open blocking findings remain.

## Findings Resolved

- F-001: Active ACP prompt registration happened after `turn.started`, leaving a short window where a Kiro follow-up could be routed as a second `session/prompt` instead of `_message/send`.
  - Fixed by validating prompt content first, then registering `ctx.activePrompt`, `ctx.activeTurnId`, and session state before emitting `turn.started`.

- F-002: Kiro active-prompt follow-ups are intentionally attached to the existing turn, so the UI local-dispatch guard did not clear when the server acknowledged a follow-up on the same running turn.
  - Fixed by treating an updated running session on the same active turn as acknowledgement for active-turn steering.

- F-003: The mobile collapsed composer send button lost the environment-unavailable disable guard while enabling running follow-ups.
  - Fixed by restoring `environmentUnavailable !== null` to the collapsed send-button disabled state.

## Architecture Notes

- Kiro-specific behavior remains isolated in `apps/server/src/provider/Layers/KiroAdapter.ts`.
- The shared ACP layer only knows about an optional provider-supplied active-prompt hook and a provider-supplied method name.
- Provider settings continue to use the existing schema annotation and instance-registry architecture rather than adding page-local provider form logic.
- Appearance settings are client settings in `packages/contracts`; runtime application stays in the web app bootstrap and CSS variables.

## Validation

- `bun fmt`
- `bun lint` (passes with 9 existing warnings)
- `bun run typecheck`
- `bun run test src/provider/acp/AcpAdapterSupport.test.ts`
- `bun run test src/provider/acp/KiroAcpSupport.test.ts src/provider/Layers/KiroProvider.test.ts src/provider/Drivers/KiroHome.test.ts src/provider/Layers/ProviderInstanceRegistryLive.test.ts`
- `bun run test src/components/ChatView.logic.test.ts`
- `bun run test -- --configLoader runner src/settings.test.ts`
- `bun run test -- --configLoader runner src/settings/DesktopClientSettings.test.ts`
- `git diff --check`

Browser smoke was attempted, but the browser automation tool was not available in this session and sandboxed `curl` could not connect to localhost despite both local ports being open.
