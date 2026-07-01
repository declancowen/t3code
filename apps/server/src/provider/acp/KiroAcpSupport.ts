import { type KiroSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  layer as acpSessionRuntimeLayer,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type KiroAcpRuntimeSettings = Pick<KiroSettings, "agentName" | "binaryPath">;

const KIRO_ACP_REQUEST_TIMEOUTS = {
  initialize: "15 seconds",
  authenticate: "15 seconds",
  "session/load": "15 seconds",
  "session/new": "15 seconds",
  "session/set_model": "8 seconds",
  "session/set_mode": "8 seconds",
  "session/set_config_option": "8 seconds",
} as const satisfies NonNullable<AcpSessionRuntimeOptions["requestTimeouts"]>;

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "setModelStrategy" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly environment?: NodeJS.ProcessEnv;
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
  /**
   * Initial reasoning effort level. Applied via the `kiro-cli acp --effort`
   * spawn flag because kiro-cli has no in-session ACP method for effort. Must
   * already be a validated level (see `resolveKiroEffortLevel`).
   */
  readonly effort?: string;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  effort?: string,
): AcpSpawnInput {
  const agentName = kiroSettings?.agentName.trim();
  const effortLevel = effort?.trim();
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: [
      "acp",
      ...(agentName ? (["--agent", agentName] as const) : []),
      ...(effortLevel ? (["--effort", effortLevel] as const) : []),
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      acpSessionRuntimeLayer({
        ...input,
        spawn: buildKiroAcpSpawnInput(
          input.kiroSettings,
          input.cwd,
          input.environment,
          input.effort,
        ),
        setModelStrategy: "session-set-model",
        setModelFailureMode: "continue-with-current",
        setModeStrategy: "session-set-mode",
        requestTimeouts: {
          ...KIRO_ACP_REQUEST_TIMEOUTS,
          ...input.requestTimeouts,
        },
        wireCompatibility: {
          tolerateMultilineJson: true,
          ignoreNonJsonStdout: true,
          ...input.wireCompatibility,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
