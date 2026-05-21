import type { CSSProperties } from "react";
import type {
  AppearanceChatFontFamily,
  AppearanceReduceMotion,
  UnifiedSettings,
} from "@t3tools/contracts/settings";

export const LOBSTER_THEME_COLORS = {
  accent: "#ff5c5c",
  background: "#101827",
  foreground: "#e4e4e7",
} as const;

export const CHAT_FONT_OPTIONS: ReadonlyArray<{
  readonly value: AppearanceChatFontFamily;
  readonly label: string;
}> = [{ value: "satoshi", label: "Satoshi" }];

export const REDUCE_MOTION_OPTIONS: ReadonlyArray<{
  readonly value: AppearanceReduceMotion;
  readonly label: string;
}> = [
  { value: "system", label: "System" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

type ChatTypographyStyle = CSSProperties & {
  readonly "--chat-font-family": string;
  readonly "--chat-font-size": string;
};

export function resolveChatFontFamily(fontFamily: AppearanceChatFontFamily): string {
  switch (fontFamily) {
    case "satoshi":
      return '"Satoshi", var(--app-font-sans)';
  }
}

export function buildChatTypographyStyle(
  settings: Pick<UnifiedSettings, "appearanceChatFontFamily" | "appearanceChatFontSize">,
): ChatTypographyStyle {
  return {
    "--chat-font-family": resolveChatFontFamily(settings.appearanceChatFontFamily),
    "--chat-font-size": `${settings.appearanceChatFontSize}px`,
  };
}

export function applyDocumentAppearanceSettings(
  settings: Pick<
    UnifiedSettings,
    | "appearanceChatFontFamily"
    | "appearanceChatFontSize"
    | "appearanceContrast"
    | "appearanceFontSmoothing"
    | "appearanceReduceMotion"
    | "appearanceTheme"
    | "appearanceTranslucentSidebar"
    | "appearanceUsePointerCursors"
  >,
  resolvedTheme: "light" | "dark",
): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  const contrast = Math.max(0, Math.min(100, settings.appearanceContrast)) / 100;
  const borderAlpha = resolvedTheme === "dark" ? 0.04 + contrast * 0.08 : 0.05 + contrast * 0.09;
  const inputAlpha = resolvedTheme === "dark" ? 0.06 + contrast * 0.09 : 0.07 + contrast * 0.1;
  const sidebarAccentAlpha =
    resolvedTheme === "dark" ? 0.04 + contrast * 0.08 : 0.03 + contrast * 0.07;
  const sidebarBorderAlpha =
    resolvedTheme === "dark" ? 0.06 + contrast * 0.12 : 0.06 + contrast * 0.1;
  const contrastChannel = resolvedTheme === "dark" ? "255, 255, 255" : "0, 0, 0";

  root.dataset.appearanceTheme = settings.appearanceTheme;
  root.dataset.fontSmoothing = settings.appearanceFontSmoothing ? "true" : "false";
  root.dataset.reduceMotion = settings.appearanceReduceMotion;
  root.dataset.translucentSidebar = settings.appearanceTranslucentSidebar ? "true" : "false";
  root.dataset.usePointerCursors = settings.appearanceUsePointerCursors ? "true" : "false";
  root.style.setProperty(
    "--chat-font-family",
    resolveChatFontFamily(settings.appearanceChatFontFamily),
  );
  root.style.setProperty("--chat-font-size", `${settings.appearanceChatFontSize}px`);
  root.style.setProperty("--border", `rgba(${contrastChannel}, ${borderAlpha.toFixed(3)})`);
  root.style.setProperty("--input", `rgba(${contrastChannel}, ${inputAlpha.toFixed(3)})`);
  root.style.setProperty(
    "--sidebar-accent",
    `rgba(${contrastChannel}, ${sidebarAccentAlpha.toFixed(3)})`,
  );
  root.style.setProperty(
    "--sidebar-border",
    `rgba(${contrastChannel}, ${sidebarBorderAlpha.toFixed(3)})`,
  );
}
