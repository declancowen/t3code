import {
  MAX_APPEARANCE_CHAT_FONT_SIZE,
  MAX_APPEARANCE_CONTRAST,
  MIN_APPEARANCE_CHAT_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
} from "@t3tools/contracts/settings";
import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { CHAT_FONT_OPTIONS, LOBSTER_THEME_COLORS, REDUCE_MOTION_OPTIONS } from "../../appearance";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer } from "./settingsLayout";

const THEME_MODE_OPTIONS = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: LaptopIcon },
] as const;

function clampInteger(value: number | null | undefined, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function ThemeModeControl({
  theme,
  onThemeChange,
}: {
  readonly theme: "system" | "light" | "dark";
  readonly onThemeChange: (theme: "system" | "light" | "dark") => void;
}) {
  return (
    <div className="inline-flex min-h-8 w-full items-center rounded-full bg-secondary/45 p-0.5 sm:w-auto">
      {THEME_MODE_OPTIONS.map((option) => {
        const Icon = option.icon;
        const isSelected = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isSelected}
            className={cn(
              "inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 text-sm transition-colors sm:flex-none",
              isSelected
                ? "bg-background text-foreground shadow-sm/5"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onThemeChange(option.value)}
          >
            <Icon className="size-4" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThemePreviewLine({
  number,
  children,
  highlighted = false,
}: {
  readonly number: number;
  readonly children: ReactNode;
  readonly highlighted?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid min-h-7 grid-cols-[3.25rem_1fr] items-center text-[13px] leading-none",
        highlighted && "bg-current/12",
      )}
    >
      <span className="select-none border-r border-white/10 pr-3 text-right text-muted-foreground">
        {number}
      </span>
      <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap px-3 font-mono text-foreground/90">
        {children}
      </code>
    </div>
  );
}

function ThemePreviewPane({ side }: { readonly side: "before" | "after" }) {
  const isAfter = side === "after";

  return (
    <div
      className={cn(
        "relative min-w-0 bg-[#0b1220]",
        isAfter ? "text-emerald-400" : "text-[#ff5c5c]",
      )}
    >
      {isAfter ? (
        <span className="absolute inset-y-0 left-0 w-1 bg-emerald-400" aria-hidden />
      ) : (
        <span
          className="absolute inset-y-7 left-0 w-1 bg-[repeating-linear-gradient(to_bottom,#ff5c5c_0,#ff5c5c_2px,transparent_2px,transparent_4px)]"
          aria-hidden
        />
      )}
      <ThemePreviewLine number={1}>
        <span className="text-[#ff6b6b]">const</span>{" "}
        <span className="text-foreground">themePreview</span>
        <span className="text-[#ff7b86]">: </span>
        <span className="text-blue-400">ThemeConfig</span>
        <span className="text-[#ff7b86]"> = </span>
        <span className="text-muted-foreground">{"{"}</span>
      </ThemePreviewLine>
      <ThemePreviewLine number={2} highlighted>
        <span className="text-foreground/85">surface: </span>
        <span className="text-teal-300">"{isAfter ? "sidebar-elevated" : "sidebar"}"</span>
        <span className="text-muted-foreground">,</span>
      </ThemePreviewLine>
      <ThemePreviewLine number={3} highlighted>
        <span className="text-foreground/85">accent: </span>
        <span className="text-teal-300">"{isAfter ? "#0ea5e9" : "#2563eb"}"</span>
        <span className="text-muted-foreground">,</span>
      </ThemePreviewLine>
      <ThemePreviewLine number={4} highlighted>
        <span className="text-foreground/85">contrast: </span>
        <span className="text-amber-400">{isAfter ? "68" : "42"}</span>
        <span className="text-muted-foreground">,</span>
      </ThemePreviewLine>
      <ThemePreviewLine number={5}>
        <span className="text-muted-foreground">{"};"}</span>
      </ThemePreviewLine>
    </div>
  );
}

function ThemePreview() {
  return (
    <div className="grid overflow-hidden border-y border-border/70 bg-[#0b1220] sm:grid-cols-2">
      <ThemePreviewPane side="before" />
      <ThemePreviewPane side="after" />
    </div>
  );
}

function ColorValuePill({
  value,
  variant,
}: {
  readonly value: string;
  readonly variant: "accent" | "background" | "foreground";
}) {
  const foreground = variant === "foreground" ? "#111827" : "#ffffff";

  return (
    <div
      className={cn(
        "inline-flex h-8 min-w-38 items-center gap-2 rounded-lg border px-3 font-mono text-sm",
        variant === "background" && "border-white/10",
        variant === "foreground" && "border-black/10",
        variant === "accent" && "border-white/10",
      )}
      style={{ backgroundColor: value, color: foreground }}
    >
      <span className="size-3.5 rounded-full border border-current/25 bg-transparent" />
      <span>{value.toUpperCase()}</span>
    </div>
  );
}

function ThemeEditorRow({
  label,
  control,
}: {
  readonly label: ReactNode;
  readonly control: ReactNode;
}) {
  return (
    <div className="grid min-h-13 grid-cols-1 gap-3 border-t border-border/55 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="flex min-w-0 items-center justify-start sm:justify-end">{control}</div>
    </div>
  );
}

function AppearanceOptionRow({
  title,
  description,
  control,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly control: ReactNode;
}) {
  return (
    <div className="grid min-h-16 grid-cols-1 gap-3 border-t border-border/60 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      <div className="flex min-w-0 justify-start sm:justify-end">{control}</div>
    </div>
  );
}

function ContrastControl({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="grid w-full max-w-xs grid-cols-[1fr_2.5rem] items-center gap-4 sm:w-72">
      <input
        type="range"
        min={MIN_APPEARANCE_CONTRAST}
        max={MAX_APPEARANCE_CONTRAST}
        step={1}
        value={value}
        onChange={(event) =>
          onChange(
            clampInteger(
              Number(event.currentTarget.value),
              MIN_APPEARANCE_CONTRAST,
              MAX_APPEARANCE_CONTRAST,
            ),
          )
        }
        aria-label="Appearance contrast"
        className="min-w-0 accent-primary"
      />
      <span className="text-right text-sm tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function ReduceMotionControl({
  value,
  onChange,
}: {
  readonly value: "system" | "on" | "off";
  readonly onChange: (value: "system" | "on" | "off") => void;
}) {
  return (
    <div className="inline-flex w-full rounded-full bg-secondary/45 p-0.5 sm:w-auto">
      {REDUCE_MOTION_OPTIONS.map((option) => {
        const isSelected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isSelected}
            className={cn(
              "h-7 flex-1 rounded-full px-3 text-sm transition-colors sm:flex-none",
              isSelected
                ? "bg-background text-foreground shadow-sm/5"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  const selectedChatFontLabel = useMemo(
    () =>
      CHAT_FONT_OPTIONS.find((option) => option.value === settings.appearanceChatFontFamily)
        ?.label ?? "Satoshi",
    [settings.appearanceChatFontFamily],
  );

  return (
    <SettingsPageContainer className="max-w-4xl gap-6">
      <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Appearance</h1>

      <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-sm/5">
        <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-medium text-foreground">Theme</h2>
            <p className="text-sm text-muted-foreground">Use light, dark, or match your system</p>
          </div>
          <ThemeModeControl theme={theme} onThemeChange={setTheme} />
        </div>

        <ThemePreview />

        <div className="m-3 overflow-hidden rounded-xl border border-border/80 bg-secondary/20">
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
            <div className="text-sm font-semibold text-muted-foreground">Dark theme</div>
            <div className="flex gap-5 text-sm font-medium text-muted-foreground sm:ms-auto">
              <button type="button" disabled className="cursor-default opacity-70">
                Import
              </button>
              <button type="button" disabled className="cursor-default opacity-70">
                Copy theme
              </button>
            </div>
            <Select
              value={settings.appearanceTheme}
              onValueChange={(value) => {
                if (value === "lobster") {
                  updateSettings({ appearanceTheme: value });
                }
              }}
            >
              <SelectTrigger
                className="h-8 w-full min-w-0 rounded-xl border-border/55 bg-background/45 text-sm sm:w-56"
                aria-label="Color theme"
              >
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-background font-semibold text-primary text-xs">
                  Aa
                </span>
                <SelectValue>Lobster</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="lobster">
                  Lobster
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>

          <ThemeEditorRow
            label="Accent"
            control={<ColorValuePill value={LOBSTER_THEME_COLORS.accent} variant="accent" />}
          />
          <ThemeEditorRow
            label="Background"
            control={
              <ColorValuePill value={LOBSTER_THEME_COLORS.background} variant="background" />
            }
          />
          <ThemeEditorRow
            label="Foreground"
            control={
              <ColorValuePill value={LOBSTER_THEME_COLORS.foreground} variant="foreground" />
            }
          />
          <ThemeEditorRow
            label="UI font"
            control={
              <Select
                value={settings.appearanceChatFontFamily}
                onValueChange={(value) => {
                  if (value === "satoshi") {
                    updateSettings({ appearanceChatFontFamily: value });
                  }
                }}
              >
                <SelectTrigger
                  className="h-8 w-full min-w-0 rounded-lg border-border/70 bg-background/25 text-sm sm:w-56"
                  aria-label="Chat font"
                >
                  <SelectValue>{selectedChatFontLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {CHAT_FONT_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <ThemeEditorRow
            label="Translucent sidebar"
            control={
              <Switch
                checked={settings.appearanceTranslucentSidebar}
                onCheckedChange={(checked) =>
                  updateSettings({ appearanceTranslucentSidebar: Boolean(checked) })
                }
                aria-label="Use translucent sidebar"
              />
            }
          />
          <ThemeEditorRow
            label="Contrast"
            control={
              <ContrastControl
                value={settings.appearanceContrast}
                onChange={(value) => updateSettings({ appearanceContrast: value })}
              />
            }
          />
        </div>

        <AppearanceOptionRow
          title="Use pointer cursors"
          description="Change the cursor to a pointer when hovering over interactive elements"
          control={
            <Switch
              checked={settings.appearanceUsePointerCursors}
              onCheckedChange={(checked) =>
                updateSettings({ appearanceUsePointerCursors: Boolean(checked) })
              }
              aria-label="Use pointer cursors"
            />
          }
        />
        <AppearanceOptionRow
          title="Reduce motion"
          description="Reduce animations or match your system"
          control={
            <ReduceMotionControl
              value={settings.appearanceReduceMotion}
              onChange={(value) => updateSettings({ appearanceReduceMotion: value })}
            />
          }
        />
        <AppearanceOptionRow
          title="UI font size"
          description="Adjust the base size used for chat messages and composer text"
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={settings.appearanceChatFontSize}
                min={MIN_APPEARANCE_CHAT_FONT_SIZE}
                max={MAX_APPEARANCE_CHAT_FONT_SIZE}
                step={1}
                size="sm"
                className="w-20"
                onValueChange={(value) =>
                  updateSettings({
                    appearanceChatFontSize: clampInteger(
                      value,
                      MIN_APPEARANCE_CHAT_FONT_SIZE,
                      MAX_APPEARANCE_CHAT_FONT_SIZE,
                    ),
                  })
                }
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Chat font size in pixels" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-sm text-muted-foreground">px</span>
            </div>
          }
        />
        <AppearanceOptionRow
          title="Font Smoothing"
          description="Use native macOS font anti-aliasing"
          control={
            <Switch
              checked={settings.appearanceFontSmoothing}
              onCheckedChange={(checked) =>
                updateSettings({ appearanceFontSmoothing: Boolean(checked) })
              }
              aria-label="Use font smoothing"
            />
          }
        />
      </section>
    </SettingsPageContainer>
  );
}
