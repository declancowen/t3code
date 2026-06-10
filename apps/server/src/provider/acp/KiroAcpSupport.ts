import { type KiroSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type KiroAcpRuntimeSettings = Pick<KiroSettings, "agentName" | "binaryPath">;

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "setModelStrategy" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly environment?: NodeJS.ProcessEnv;
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const agentName = kiroSettings?.agentName.trim();
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: ["acp", ...(agentName ? (["--agent", agentName] as const) : [])],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd, input.environment),
        setModelStrategy: "session-set-model",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
