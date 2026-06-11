/**
 * Managed message-queue feature flag.
 *
 * The managed queue is enabled by default. It can be explicitly disabled at
 * runtime by setting `T3CODE_MANAGED_QUEUE` to an "off" value (e.g. `0`,
 * `false`, `off`, `no`) and restarting the server — no rebuild required.
 *
 * Centralized here so the engine and the runtime ingestion reactor share one
 * source of truth instead of duplicating the env-var parsing.
 */

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * Returns whether the managed message queue is enabled.
 *
 * Defaults to `true`; only an explicit "off" value disables it.
 */
export const isManagedQueueEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const raw = env.T3CODE_MANAGED_QUEUE;
  if (raw === undefined) {
    return true;
  }
  return !OFF_VALUES.has(raw.trim().toLowerCase());
};
