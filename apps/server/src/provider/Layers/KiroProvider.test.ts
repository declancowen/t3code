import { describe, expect, it } from "vite-plus/test";
import { createModelCapabilities } from "@t3tools/shared/model";

import { parseKiroListModelsOutput } from "./KiroProvider.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

describe("parseKiroListModelsOutput", () => {
  it("publishes Kiro CLI model choices from chat --list-models json", () => {
    expect(
      parseKiroListModelsOutput({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          models: [
            {
              model_name: "auto",
              model_id: "auto",
              description: "Models chosen by task",
              context_window_tokens: 1_000_000,
            },
            {
              model_name: "claude-opus-4.7",
              model_id: "claude-opus-4.7",
              description: "Experimental preview",
              context_window_tokens: 1_000_000,
            },
          ],
          default_model: "auto",
        }),
      }),
    ).toEqual([
      {
        slug: "auto",
        name: "auto",
        isCustom: false,
        capabilities: emptyCapabilities,
      },
      {
        slug: "claude-opus-4.7",
        name: "claude-opus-4.7",
        isCustom: false,
        capabilities: emptyCapabilities,
      },
    ]);
  });

  it("ignores malformed and duplicate model entries", () => {
    expect(
      parseKiroListModelsOutput({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          models: [
            { model_id: "auto", model_name: "Auto" },
            { model_id: "auto", model_name: "Auto duplicate" },
            { model_name: "missing id" },
            null,
          ],
        }),
      }).map((model) => model.slug),
    ).toEqual(["auto"]);
  });
});
