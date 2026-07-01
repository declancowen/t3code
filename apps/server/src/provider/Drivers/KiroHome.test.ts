import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeKiroContinuationGroupKey,
  makeKiroEnvironment,
  resolveKiroHomePath,
} from "./KiroHome.ts";

it.layer(NodeServices.layer)("KiroHome", (it) => {
  describe("Kiro home resolution", () => {
    it.effect("uses the process Kiro home when no override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.userInfo().homedir, ".kiro");

        expect(yield* resolveKiroHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeKiroEnvironment({ homePath: "" })).toBe(process.env);
        expect(yield* makeKiroContinuationGroupKey({ homePath: "" })).toBe(`kiro:home:${resolved}`);
      }),
    );

    it.effect(
      "uses the OS account home when the server was launched with the Codex temp home",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const env = { HOME: "/private/tmp/t3code-home" };
          const resolved = path.resolve(NodeOS.userInfo().homedir, ".kiro");

          expect(yield* resolveKiroHomePath({ homePath: "" }, env)).toBe(resolved);
          expect(yield* resolveKiroHomePath({ homePath: "~/.kiro" }, env)).toBe(resolved);
          expect(yield* makeKiroContinuationGroupKey({ homePath: "" }, env)).toBe(
            `kiro:home:${resolved}`,
          );
        }),
    );

    it.effect("sets KIRO_HOME and stamps continuation keys with the configured home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.kiro-work";
        const resolved = path.resolve(NodeOS.userInfo().homedir, ".kiro-work");

        expect(yield* resolveKiroHomePath({ homePath })).toBe(resolved);
        expect((yield* makeKiroEnvironment({ homePath })).KIRO_HOME).toBe(resolved);
        expect(yield* makeKiroContinuationGroupKey({ homePath })).toBe(`kiro:home:${resolved}`);
      }),
    );
  });
});
