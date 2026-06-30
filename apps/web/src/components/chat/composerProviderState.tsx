import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { Separator } from "../ui/separator";
import { getKiroAgentModeIcon } from "./kiroAgentModeIcons";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
};

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions, promptInjectionState = "none" } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
  descriptorIds?: ReadonlyArray<string>,
  getOptionIcon?: (descriptorId: string, optionId: string) => LucideIcon | undefined,
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    prompt,
    onPromptChange,
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions,
      prompt,
      ...(descriptorIds ? { descriptorIds } : {}),
    })
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      prompt={prompt}
      onPromptChange={onPromptChange}
      {...(descriptorIds ? { descriptorIds } : {})}
      {...(getOptionIcon ? { getOptionIcon } : {})}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(
    TraitsMenuContent,
    input,
    undefined,
    input.provider === "kiro" ? kiroTraitsOptionIcon : undefined,
  );
}

// Resolver for Kiro's Build/Plan/Guide agent-mode icons; other descriptors
// (e.g. effort) have no icon and fall through to undefined.
function kiroTraitsOptionIcon(_descriptorId: string, optionId: string): LucideIcon | undefined {
  return getKiroAgentModeIcon(optionId);
}

// Kiro surfaces its agent-mode (Build/Plan/Guide) and reasoning effort as two
// independent composer selectors — mirroring Codex's standalone effort picker —
// rather than one combined Traits control. Each picker still persists the full
// option set, so changing one preserves the other.
const KIRO_TRAITS_PICKER_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [["agentMode"], ["effort"]];

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  if (input.provider === "kiro") {
    const pickers = KIRO_TRAITS_PICKER_GROUPS.map((descriptorIds) => ({
      descriptorIds,
      node: renderTraitsControl(TraitsPicker, input, descriptorIds, kiroTraitsOptionIcon),
    })).filter(
      (entry): entry is { descriptorIds: ReadonlyArray<string>; node: ReactNode } =>
        entry.node !== null,
    );
    if (pickers.length === 0) {
      return null;
    }
    return (
      <>
        {pickers.map((entry, index) => (
          <span key={entry.descriptorIds.join(",")} className="flex items-center">
            {index > 0 ? (
              <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
            ) : null}
            {entry.node}
          </span>
        ))}
      </>
    );
  }
  return renderTraitsControl(TraitsPicker, input);
}
