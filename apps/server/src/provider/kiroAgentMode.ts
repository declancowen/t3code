/**
 * Shared Kiro agent-mode wiring (Build / Plan / Guide).
 *
 * Kiro CLI ships three built-in agents that `kiro-cli acp` exposes as ACP
 * session "modes":
 *   - `kiro_default` — the default coding agent (surfaced as "Build")
 *   - `kiro_planner` — planning agent (surfaced as "Plan")
 *   - `kiro_guide`   — docs/help agent (surfaced as "Guide")
 *
 * These replace the generic, provider-shared Build/Plan interaction toggle for
 * Kiro. They are switched in-session via `session/set_mode` (verified working
 * against kiro-cli 2.6.x), so changing agent keeps the same session/context —
 * no respawn needed (unlike effort, which is spawn-only).
 *
 * Like `kiroEffort`, this is the single source of truth for the option id, the
 * agent ids/labels, and the value normalizer, so the provider snapshot and the
 * adapter cannot drift apart. The descriptor `option.id` values are the literal
 * ACP mode/agent ids so the adapter can pass a selection straight to
 * `session/set_mode`.
 *
 * @module provider/kiroAgentMode
 */
import type { ModelCapabilities, ProviderOptionSelection } from "@t3tools/contracts";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "./providerSnapshot.ts";

/** Option-selection id used for the Kiro agent (Build/Plan/Guide) selector. */
export const KIRO_AGENT_MODE_OPTION_ID = "agentMode";

/** Agent applied when the user has not chosen one explicitly. */
export const KIRO_DEFAULT_AGENT_MODE = "kiro_default";

/**
 * Built-in Kiro agents, in selector order, with display labels. The `value` is
 * the ACP mode/agent id passed to `session/set_mode`.
 */
export const KIRO_AGENT_MODES: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly isDefault?: boolean;
}> = [
  { value: "kiro_default", label: "Build", isDefault: true },
  { value: "kiro_planner", label: "Plan" },
  { value: "kiro_guide", label: "Guide" },
];

const KIRO_AGENT_MODE_VALUES = new Set<string>(KIRO_AGENT_MODES.map((mode) => mode.value));

/**
 * Normalize an arbitrary string to a known Kiro agent id, or `undefined` when
 * it is missing/unknown. Guards the value before it is sent to
 * `session/set_mode` / the `--agent` spawn flag.
 */
export function resolveKiroAgentMode(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return KIRO_AGENT_MODE_VALUES.has(normalized) ? normalized : undefined;
}

/** Extract the selected Kiro agent id from model-selection option values. */
export function kiroAgentModeFromSelections(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  return resolveKiroAgentMode(
    getProviderOptionStringSelectionValue(selections, KIRO_AGENT_MODE_OPTION_ID),
  );
}

/** Select descriptor for the Build/Plan/Guide agent selector. */
export function buildKiroAgentModeDescriptor() {
  return buildSelectOptionDescriptor({
    id: KIRO_AGENT_MODE_OPTION_ID,
    label: "Mode",
    options: [...KIRO_AGENT_MODES],
  });
}

/**
 * Capabilities attached to every discovered Kiro model so the UI renders the
 * agent-mode selector. Combined with the effort selector by the provider.
 */
export const KIRO_AGENT_MODE_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [buildKiroAgentModeDescriptor()],
});
