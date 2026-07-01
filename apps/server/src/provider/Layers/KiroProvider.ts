import type {
  KiroSettings,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderState,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";
import { discoverCodexSkills } from "../CodexSkillBridge.ts";
import { buildKiroEffortDescriptor } from "../kiroEffort.ts";
import { buildKiroAgentModeDescriptor } from "../kiroAgentMode.ts";

const PROVIDER = ProviderDriverKind.make("kiro");
const KIRO_PRESENTATION = {
  displayName: "Kiro",
  // Kiro replaces the generic Build/Plan interaction toggle with its own
  // Build/Plan/Guide agent-mode selector (see KIRO_MODEL_CAPABILITIES), so the
  // shared toggle is disabled to avoid two competing mode controls.
  showInteractionModeToggle: false,
} as const;
// Every Kiro model carries the agent-mode (Build/Plan/Guide) selector and the
// reasoning effort selector. Mode is listed first as the primary control.
export const KIRO_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [buildKiroAgentModeDescriptor(), buildKiroEffortDescriptor()],
});
const KIRO_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: KIRO_MODEL_CAPABILITIES,
  },
];
const VERSION_TIMEOUT_MS = 4_000;
const WHOAMI_TIMEOUT_MS = 8_000;
const LIST_MODELS_TIMEOUT_MS = 8_000;
const KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

interface KiroWhoamiJsonPayload {
  readonly email?: unknown;
  readonly username?: unknown;
  readonly profile?: unknown;
  readonly authType?: unknown;
  readonly authenticationMethod?: unknown;
  readonly status?: unknown;
}

interface KiroSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

interface KiroListModelsJsonPayload {
  readonly models?: unknown;
  readonly default_model?: unknown;
  readonly defaultModel?: unknown;
}

function getKiroFallbackModels(
  kiroSettings: Pick<KiroSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    KIRO_FALLBACK_MODELS,
    PROVIDER,
    kiroSettings.customModels,
    KIRO_MODEL_CAPABILITIES,
  );
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

function parseKiroWhoamiJsonPayload(raw: string): KiroWhoamiJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as KiroWhoamiJsonPayload;
  } catch {
    return undefined;
  }
}

function readFirstString(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseKiroWhoamiOutput(result: CommandResult): {
  readonly auth: ServerProviderAuth;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly message?: string;
} {
  const jsonPayload = parseKiroWhoamiJsonPayload(result.stdout);
  if (jsonPayload) {
    const record = jsonPayload as Record<string, unknown>;
    const email = readFirstString(record, ["email", "userEmail"]);
    const username = readFirstString(record, ["username", "userName", "userId"]);
    const type = readFirstString(record, ["authType", "authenticationMethod", "loginType"]);
    const profile = readFirstString(record, ["profile", "profileName"]);
    const normalizedStatus = readFirstString(record, ["status", "sessionStatus"])?.toLowerCase();
    if (
      result.code !== 0 ||
      normalizedStatus === "not logged in" ||
      normalizedStatus === "unauthenticated"
    ) {
      return {
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Kiro CLI is not authenticated. Run `kiro-cli login` and try again.",
      };
    }
    return {
      status: "ready",
      auth: {
        status: "authenticated",
        ...(email ? { email } : {}),
        ...(type ? { type } : {}),
        ...(profile ? { label: profile } : username ? { label: username } : {}),
      },
    };
  }

  const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const lowerOutput = combined.toLowerCase();
  if (
    result.code !== 0 ||
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Kiro CLI is not authenticated. Run `kiro-cli login` and try again.",
    };
  }

  const emailMatch = /\bEmail:\s*([^\s]+@[^\s]+)/i.exec(combined);
  return {
    status: "ready",
    auth: {
      status: "authenticated",
      ...(emailMatch?.[1] ? { email: emailMatch[1].trim() } : {}),
    },
  };
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<KiroSessionSelectOption> {
  if (!configOption || configOption.type !== "select") return [];
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          },
        ]
      : entry.options.map((option) => ({
          value: option.value.trim(),
          name: option.name.trim(),
        })),
  );
}

function findModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function buildKiroModelsFromModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) return [];
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    const name = model.name.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: name || slug,
        isCustom: false,
        capabilities: KIRO_MODEL_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function buildKiroModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) return [];
  const modelChoices = flattenSessionConfigSelectOptions(findModelConfigOption(configOptions));
  const seen = new Set<string>();
  return modelChoices.flatMap((modelChoice) => {
    const slug = modelChoice.value.trim();
    const name = modelChoice.name.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: name || slug,
        isCustom: false,
        capabilities: KIRO_MODEL_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function readKiroListModelsArray(raw: string): ReadonlyArray<unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== "object") return [];
    const payload = parsed as KiroListModelsJsonPayload;
    return Array.isArray(payload.models) ? payload.models : [];
  } catch {
    return [];
  }
}

function readKiroListModelString(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseKiroListModelsOutput(
  result: CommandResult,
): ReadonlyArray<ServerProviderModel> {
  if (result.code !== 0) return [];
  const seen = new Set<string>();
  return readKiroListModelsArray(result.stdout).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const slug = readKiroListModelString(record, ["model_id", "id", "slug", "value"]);
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const name = readKiroListModelString(record, [
      "model_name",
      "name",
      "display_name",
      "displayName",
    ]);
    return [
      {
        slug,
        name: name || slug,
        isCustom: false,
        capabilities: KIRO_MODEL_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function hasKiroModelCapabilities(model: Pick<ServerProviderModel, "capabilities">): boolean {
  return (model.capabilities?.optionDescriptors?.length ?? 0) > 0;
}

function mergeKiroDiscoveredModels(
  primary: ReadonlyArray<ServerProviderModel>,
  secondary: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  if (primary.length === 0) return secondary;
  if (secondary.length === 0) return primary;

  const secondaryBySlug = new Map(secondary.map((model) => [model.slug, model] as const));
  const seen = new Set<string>();
  const merged = primary.map((model) => {
    seen.add(model.slug);
    const secondaryModel = secondaryBySlug.get(model.slug);
    return secondaryModel && hasKiroModelCapabilities(secondaryModel)
      ? { ...model, capabilities: secondaryModel.capabilities }
      : model;
  });

  for (const model of secondary) {
    if (!seen.has(model.slug)) {
      merged.push(model);
    }
  }

  return merged;
}

function buildDiscoveredKiroModels(
  response:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const modelStateModels = buildKiroModelsFromModelState(response.models);
  if (modelStateModels.length > 0) return modelStateModels;
  return buildKiroModelsFromConfigOptions(response.configOptions);
}

const discoverKiroModelsViaAcp = (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeKiroAcpRuntime({
      kiroSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return buildDiscoveredKiroModels(started.sessionSetupResult);
  }).pipe(Effect.scoped);

function buildKiroProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly kiroSettings: KiroSettings;
  readonly version: string | null;
  readonly auth: ServerProviderAuth;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
  readonly message?: string;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const messages = [input.message, input.discoveryWarning]
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return buildServerProvider({
    driver: PROVIDER,
    presentation: KIRO_PRESENTATION,
    enabled: input.kiroSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels && input.discoveredModels.length > 0
        ? input.discoveredModels
        : KIRO_FALLBACK_MODELS,
      PROVIDER,
      input.kiroSettings.customModels,
      KIRO_MODEL_CAPABILITIES,
    ),
    skills: input.skills ?? [],
    probe: {
      installed: true,
      version: input.version,
      status:
        input.discoveryWarning && input.status === "ready" ? ("warning" as const) : input.status,
      auth: input.auth,
      ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
    },
  });
}

const runKiroCommand = (
  kiroSettings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcessPlatform;
    const command = ChildProcess.make(kiroSettings.binaryPath, [...args], {
      env: environment,
      shell: platform === "win32",
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const makePendingKiroProvider = (
  kiroSettings: KiroSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const fallbackModels = getKiroFallbackModels(kiroSettings);
    if (!kiroSettings.enabled) {
      return buildServerProvider({
        driver: PROVIDER,
        presentation: KIRO_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kiro is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      driver: PROVIDER,
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kiro CLI availability...",
      },
    });
  });

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getKiroFallbackModels(kiroSettings);
  if (!kiroSettings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: KIRO_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kiro is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runKiroCommand(kiroSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      driver: PROVIDER,
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
          : `Failed to execute Kiro CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }
  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI is installed but timed out while running `kiro-cli --version`.",
      },
    });
  }

  const version = parseGenericCliVersion(
    `${versionProbe.success.value.stdout}\n${versionProbe.success.value.stderr}`,
  );
  const skills = yield* discoverCodexSkills({ cwd: process.cwd(), environment });
  const whoamiProbe = yield* runKiroCommand(
    kiroSettings,
    ["whoami", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(WHOAMI_TIMEOUT_MS), Effect.result);
  const parsedAuth =
    Result.isSuccess(whoamiProbe) && Option.isSome(whoamiProbe.success)
      ? parseKiroWhoamiOutput(whoamiProbe.success.value)
      : {
          status: "warning" as const,
          auth: { status: "unknown" as const },
          message:
            Result.isFailure(whoamiProbe) && isCommandMissingCause(whoamiProbe.failure)
              ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
              : "Could not verify Kiro CLI authentication status.",
        };

  let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
  let discoveryWarning: string | undefined;
  if (parsedAuth.auth.status !== "unauthenticated") {
    const listModelsExit = yield* Effect.exit(
      runKiroCommand(kiroSettings, ["chat", "--list-models", "--format", "json"], environment).pipe(
        Effect.timeoutOption(LIST_MODELS_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(listModelsExit)) {
      yield* Effect.logWarning("Kiro CLI model list failed", {
        cause: Cause.pretty(listModelsExit.cause),
      });
    } else if (Option.isNone(listModelsExit.value)) {
      yield* Effect.logWarning("Kiro CLI model list timed out", {
        timeoutMs: LIST_MODELS_TIMEOUT_MS,
      });
    } else {
      discoveredModels = parseKiroListModelsOutput(listModelsExit.value.value);
    }

    // `chat --list-models` is a cheap one-shot CLI call. Only fall back to the
    // expensive full ACP session spawn (initialize + session/new, 15s budget)
    // when the cheap path yields nothing — otherwise every status refresh would
    // spin up and tear down a throwaway kiro-cli acp process, competing with the
    // user's real session for CLI/auth resources.
    if (discoveredModels.length === 0) {
      const discoveryExit = yield* Effect.exit(
        discoverKiroModelsViaAcp(kiroSettings, environment).pipe(
          Effect.timeoutOption(KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
        ),
      );
      if (Exit.isFailure(discoveryExit)) {
        yield* Effect.logWarning("Kiro ACP model discovery failed", {
          cause: Cause.pretty(discoveryExit.cause),
        });
        discoveryWarning = "Kiro model discovery failed. Check server logs for details.";
      } else if (Option.isNone(discoveryExit.value)) {
        discoveryWarning = `Kiro model discovery timed out after ${KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
      } else if (discoveryExit.value.value.length === 0) {
        discoveryWarning = "Kiro model discovery returned no built-in models.";
      } else {
        discoveredModels = mergeKiroDiscoveredModels(discoveredModels, discoveryExit.value.value);
      }
    }
  }

  return buildKiroProviderSnapshot({
    checkedAt,
    kiroSettings,
    version,
    auth: parsedAuth.auth,
    status: parsedAuth.status,
    skills,
    ...(parsedAuth.message ? { message: parsedAuth.message } : {}),
    discoveredModels,
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});
