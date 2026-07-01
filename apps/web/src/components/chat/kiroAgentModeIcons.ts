import { CompassIcon, HammerIcon, ClipboardListIcon, type LucideIcon } from "lucide-react";

/**
 * Lucide icons for Kiro's Build / Plan / Guide agent modes, keyed by the ACP
 * agent id used as the option value (see server `kiroAgentMode`).
 *
 *   - Build (`kiro_default`) → Hammer       (write/modify code)
 *   - Plan  (`kiro_planner`) → ClipboardList (break work into a plan)
 *   - Guide (`kiro_guide`)   → Compass       (docs/help navigation)
 */
const KIRO_AGENT_MODE_ICONS: Readonly<Record<string, LucideIcon>> = {
  kiro_default: HammerIcon,
  kiro_planner: ClipboardListIcon,
  kiro_guide: CompassIcon,
};

/** Resolve the Lucide icon for a Kiro agent-mode option id, if any. */
export function getKiroAgentModeIcon(optionId: string): LucideIcon | undefined {
  return KIRO_AGENT_MODE_ICONS[optionId];
}
