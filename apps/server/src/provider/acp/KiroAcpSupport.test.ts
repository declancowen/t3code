import { describe, expect, it } from "vite-plus/test";

import { buildKiroAcpSpawnInput } from "./KiroAcpSupport.ts";

describe("buildKiroAcpSpawnInput", () => {
  it("starts Kiro ACP with the default CLI binary", () => {
    expect(buildKiroAcpSpawnInput(undefined, "/repo")).toEqual({
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/repo",
    });
  });

  it("passes a configured agent name and environment through to the ACP process", () => {
    const env = { KIRO_HOME: "/tmp/kiro" };

    expect(
      buildKiroAcpSpawnInput(
        {
          binaryPath: "/opt/kiro/bin/kiro-cli",
          agentName: "builder",
        },
        "/repo",
        env,
      ),
    ).toEqual({
      command: "/opt/kiro/bin/kiro-cli",
      args: ["acp", "--agent", "builder"],
      cwd: "/repo",
      env,
    });
  });
});
