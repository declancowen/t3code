import { describe, expect, it } from "vite-plus/test";

import {
  KIRO_DEFAULT_EFFORT,
  KIRO_EFFORT_OPTION_ID,
  buildKiroEffortDescriptor,
  kiroEffortFromSelections,
  resolveKiroEffortLevel,
} from "./kiroEffort.ts";

describe("resolveKiroEffortLevel", () => {
  it("accepts every documented effort level", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(resolveKiroEffortLevel(level)).toBe(level);
    }
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(resolveKiroEffortLevel("  High ")).toBe("high");
    expect(resolveKiroEffortLevel("XHIGH")).toBe("xhigh");
  });

  it("rejects unknown or empty values so arbitrary CLI args cannot leak through", () => {
    expect(resolveKiroEffortLevel("turbo")).toBeUndefined();
    expect(resolveKiroEffortLevel("")).toBeUndefined();
    expect(resolveKiroEffortLevel("--trust-all-tools")).toBeUndefined();
    expect(resolveKiroEffortLevel(undefined)).toBeUndefined();
    expect(resolveKiroEffortLevel(null)).toBeUndefined();
  });
});

describe("kiroEffortFromSelections", () => {
  it("reads the effort option from model-selection option values", () => {
    expect(kiroEffortFromSelections([{ id: KIRO_EFFORT_OPTION_ID, value: "max" }])).toBe("max");
  });

  it("ignores unrelated option ids and invalid values", () => {
    expect(kiroEffortFromSelections([{ id: "fastMode", value: true }])).toBeUndefined();
    expect(
      kiroEffortFromSelections([{ id: KIRO_EFFORT_OPTION_ID, value: "nope" }]),
    ).toBeUndefined();
    expect(kiroEffortFromSelections(undefined)).toBeUndefined();
  });
});

describe("buildKiroEffortDescriptor", () => {
  it("exposes the effort levels defaulting to the documented default", () => {
    const effort = buildKiroEffortDescriptor();
    expect(effort.id).toBe(KIRO_EFFORT_OPTION_ID);
    expect(effort.type).toBe("select");
    expect(effort.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effort.currentValue).toBe(KIRO_DEFAULT_EFFORT);
  });
});
