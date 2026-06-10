/**
 * Shared Kiro effort-level wiring.
 *
 * Kiro CLI exposes a reasoning "effort" level (low/medium/high/xhigh/max) for
 * models that declare `reasoning.effort`. Unlike the model selector — which
 * `kiro-cli acp` switches in-session via `session/set_model` — effort is only
 * accepted as the `--effort` spawn flag on `kiro-cli acp` (there is no
 * in-session ACP method for it as of kiro-cli 2.6.x). So effort is surfaced as
 * a static model `optionDescriptor` (this module) and applied by spawning the
 * ACP process with `--effort <level>` (see `KiroAcpSupport`/`KiroAcpAdapter`).
 *
 * This module is the single source of truth for the effort option id, the
 * available levels, and the value normalizer so the provider snapshot, the ACP
 * spawn wiring, and the adapter cannot drift apart.
 *
 * @module provider/kiroEffort
 */
import type { ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "./providerSnapshot.ts";

/** Option-selection id used for the Kiro effort selector. */
export const KIRO_EFFORT_OPTION_ID = "effort";

/** Effort level applied when the user has not chosen one explicitly. */
export const KIRO_DEFAULT_EFFORT = "high";

/**
 * Effort levels accepted by `kiro-cli acp --effort`, with display labels.
 * `high` is the default to match Kiro CLI's reasoning default and the
 * convention used by the other reasoning-capable providers.
 */
export const KIRO_EFFORT_LEVELS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly isDefault?: boolean;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

const KIRO_EFFORT_VALUES = new Set<string>(KIRO_EFFORT_LEVELS.map((level) => level.value));

/**
 * Normalize an arbitrary string to a known Kiro effort level, or `undefined`
 * when it is missing/unknown. This guards the value before it is passed to the
 * `kiro-cli acp --effort` flag so we never forward arbitrary CLI arguments.
 */
export function resolveKiroEffortLevel(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return KIRO_EFFORT_VALUES.has(normalized) ? normalized : undefined;
}

/** Extract the selected Kiro effort level from model-selection option values. */
export function kiroEffortFromSelections(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  return resolveKiroEffortLevel(
    getProviderOptionStringSelectionValue(selections, KIRO_EFFORT_OPTION_ID),
  );
}

/** Select descriptor for the effort selector (low/medium/high/xhigh/max). */
export function buildKiroEffortDescriptor() {
  return buildSelectOptionDescriptor({
    id: KIRO_EFFORT_OPTION_ID,
    label: "Effort",
    options: [...KIRO_EFFORT_LEVELS],
  });
}
