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

  it("passes the initial effort level through the --effort spawn flag", () => {
    expect(buildKiroAcpSpawnInput(undefined, "/repo", undefined, "xhigh")).toEqual({
      command: "kiro-cli",
      args: ["acp", "--effort", "xhigh"],
      cwd: "/repo",
    });
  });

  it("orders --agent before --effort and forwards both", () => {
    expect(
      buildKiroAcpSpawnInput(
        { binaryPath: "kiro-cli", agentName: "builder" },
        "/repo",
        undefined,
        "max",
      ),
    ).toEqual({
      command: "kiro-cli",
      args: ["acp", "--agent", "builder", "--effort", "max"],
      cwd: "/repo",
    });
  });

  it("omits --effort when no effort level is provided", () => {
    expect(buildKiroAcpSpawnInput(undefined, "/repo", undefined, "   ").args).toEqual(["acp"]);
  });
});
