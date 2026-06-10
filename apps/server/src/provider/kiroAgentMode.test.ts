import { describe, expect, it } from "vite-plus/test";

import {
  KIRO_AGENT_MODE_OPTION_ID,
  KIRO_DEFAULT_AGENT_MODE,
  buildKiroAgentModeDescriptor,
  kiroAgentModeFromSelections,
  resolveKiroAgentMode,
} from "./kiroAgentMode.ts";

describe("resolveKiroAgentMode", () => {
  it("accepts the three built-in Kiro agents", () => {
    for (const agent of ["kiro_default", "kiro_planner", "kiro_guide"]) {
      expect(resolveKiroAgentMode(agent)).toBe(agent);
    }
  });

  it("rejects unknown or empty values so arbitrary agents cannot leak through", () => {
    expect(resolveKiroAgentMode("kiro_evil")).toBeUndefined();
    expect(resolveKiroAgentMode("")).toBeUndefined();
    expect(resolveKiroAgentMode(undefined)).toBeUndefined();
    expect(resolveKiroAgentMode(null)).toBeUndefined();
  });
});

describe("kiroAgentModeFromSelections", () => {
  it("reads the agent-mode option from model-selection option values", () => {
    expect(
      kiroAgentModeFromSelections([{ id: KIRO_AGENT_MODE_OPTION_ID, value: "kiro_planner" }]),
    ).toBe("kiro_planner");
  });

  it("ignores unrelated ids and invalid values", () => {
    expect(kiroAgentModeFromSelections([{ id: "effort", value: "high" }])).toBeUndefined();
    expect(
      kiroAgentModeFromSelections([{ id: KIRO_AGENT_MODE_OPTION_ID, value: "nope" }]),
    ).toBeUndefined();
    expect(kiroAgentModeFromSelections(undefined)).toBeUndefined();
  });
});

describe("buildKiroAgentModeDescriptor", () => {
  it("maps Build/Plan/Guide to the kiro agent ids defaulting to Build", () => {
    const descriptor = buildKiroAgentModeDescriptor();
    expect(descriptor.id).toBe(KIRO_AGENT_MODE_OPTION_ID);
    expect(descriptor.type).toBe("select");
    expect(descriptor.options).toEqual([
      { id: "kiro_default", label: "Build", isDefault: true },
      { id: "kiro_planner", label: "Plan" },
      { id: "kiro_guide", label: "Guide" },
    ]);
    expect(descriptor.currentValue).toBe(KIRO_DEFAULT_AGENT_MODE);
  });
});
