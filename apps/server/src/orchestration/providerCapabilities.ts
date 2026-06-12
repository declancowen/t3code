/**
 * Provider capability helpers consumed by the orchestration decider.
 *
 * The managed message-queue is only the right behavior for providers that
 * cannot accept user input mid-turn. Steer-capable providers (Codex, Claude,
 * Cursor, OpenCode) go back to the pre-queue path so the user can steer the
 * active turn instead of having their message parked in a FIFO.
 *
 * Centralized here so the decider, command reactor, and any future caller
 * read one source of truth for "does this provider support mid-turn steer?".
 */

/**
 * Provider driver kinds that do NOT support mid-turn user-input steering.
 * Messages bound to these threads are eligible for the managed queue when
 * a turn is already running. All other providers should bypass the queue.
 *
 * Keep this list narrow — the default for unknown / new providers is "yes,
 * supports steering" so the queue does not silently swallow mid-turn input.
 */
const NO_STEER_PROVIDERS: ReadonlySet<string> = new Set(["kiro"]);

/**
 * Returns whether the given provider name supports mid-turn steering.
 *
 * Accepts the `providerName` value stored on `OrchestrationSession` (which
 * mirrors the provider driver kind, e.g. `"codex"`, `"claudeAgent"`,
 * `"cursor"`, `"opencode"`, `"kiro"`). Treats `null`/unknown values as
 * steer-capable to avoid trapping mid-turn input in the queue when the
 * thread has not bound to a provider yet.
 */
export const providerSupportsSteering = (providerName: string | null | undefined): boolean => {
  if (providerName === null || providerName === undefined) {
    return true;
  }
  return !NO_STEER_PROVIDERS.has(providerName);
};
