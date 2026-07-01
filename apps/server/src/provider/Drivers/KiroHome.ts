import * as NodeOS from "node:os";

import type { KiroSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveLocalUserHome } from "../../localUserEnvironment.ts";

function expandKiroHomePath(value: string, baseEnv: NodeJS.ProcessEnv): string {
  if (!value) return value;
  const localHome = resolveLocalUserHome(baseEnv) ?? NodeOS.homedir();
  if (value === "~") return localHome;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return `${localHome}/${value.slice(2)}`;
  }
  return value;
}

export const resolveKiroHomePath = Effect.fn("resolveKiroHomePath")(function* (
  config: Pick<KiroSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return homePath.length > 0
    ? path.resolve(expandKiroHomePath(homePath, baseEnv))
    : path.resolve(resolveLocalUserHome(baseEnv) ?? NodeOS.homedir(), ".kiro");
});

export const makeKiroEnvironment = Effect.fn("makeKiroEnvironment")(function* (
  config: Pick<KiroSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return baseEnv;
  const resolvedHomePath = yield* resolveKiroHomePath(config, baseEnv);
  return {
    ...baseEnv,
    KIRO_HOME: resolvedHomePath,
  };
});

export const makeKiroContinuationGroupKey = Effect.fn("makeKiroContinuationGroupKey")(function* (
  config: Pick<KiroSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const resolvedHomePath = yield* resolveKiroHomePath(config, baseEnv);
  return `kiro:home:${resolvedHomePath}`;
});
