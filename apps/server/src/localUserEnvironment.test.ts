import * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";

import { resolveLocalUserHome, withLocalUserHome } from "./localUserEnvironment.ts";

describe("localUserEnvironment", () => {
  it("preserves normal HOME values", () => {
    const env = { HOME: "/Users/someone" };

    expect(resolveLocalUserHome(env)).toBe("/Users/someone");
    expect(withLocalUserHome(env)).toBe(env);
  });

  it("maps the Codex-launched T3 temp HOME back to the OS account home", () => {
    const env = { HOME: "/private/tmp/t3code-home" };

    expect(resolveLocalUserHome(env)).toBe(NodeOS.userInfo().homedir);
    expect(withLocalUserHome(env)).toEqual({
      HOME: NodeOS.userInfo().homedir,
    });
  });
});
