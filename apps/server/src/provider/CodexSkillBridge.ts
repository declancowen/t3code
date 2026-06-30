// @effect-diagnostics nodeBuiltinImport:off
import {
  type ProviderInteractionMode,
  type ProviderSendTurnInput,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expandHomePath } from "../pathExpansion.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./CodexDeveloperInstructions.ts";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_CODEX_HOME = "~/.codex";
const MAX_SCAN_DEPTH = 8;
const MAX_SKILL_FILES = 300;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  NodePath.join(".codex-plugin", "plugin.json"),
  NodePath.join(".claude-plugin", "plugin.json"),
] as const;

type CodexSkillScope = "project" | "user" | "system" | "admin";

interface CodexSkillRoot {
  readonly path: string;
  readonly scope: CodexSkillScope;
}

export interface CodexSkillDiscoveryOptions {
  readonly cwd?: string | undefined;
  readonly codexHomePath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly homeDir?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export interface CodexPromptAugmentationOptions extends CodexSkillDiscoveryOptions {
  readonly skills?: ReadonlyArray<ServerProviderSkill> | undefined;
}

function normalizeWhitespace(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readTopLevelYamlString(frontmatter: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m");
  const match = pattern.exec(frontmatter);
  return normalizeWhitespace(match?.[1] ? unquoteYamlScalar(match[1]) : undefined);
}

function readMetadataShortDescription(frontmatter: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  let inMetadata = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inMetadata = /^metadata\s*:\s*$/.test(line.trim());
      continue;
    }
    if (!inMetadata) continue;
    const match = /^\s+short-description\s*:\s*(.+)$/.exec(line);
    if (match?.[1]) {
      return normalizeWhitespace(unquoteYamlScalar(match[1]));
    }
  }
  return undefined;
}

function extractFrontmatter(contents: string): string | undefined {
  const lines = contents.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const frontmatter: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") {
      return frontmatter.length > 0 ? frontmatter.join("\n") : undefined;
    }
    frontmatter.push(line);
  }
  return undefined;
}

function defaultSkillName(skillPath: string): string {
  return NodePath.basename(NodePath.dirname(skillPath)).trim() || "skill";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await NodeFSP.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function dedupeRoots(roots: ReadonlyArray<CodexSkillRoot>): ReadonlyArray<CodexSkillRoot> {
  const seen = new Set<string>();
  const deduped: CodexSkillRoot[] = [];
  for (const root of roots) {
    const resolved = NodePath.resolve(root.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    deduped.push({ ...root, path: resolved });
  }
  return deduped;
}

export function buildCodexSkillRoots(
  options: CodexSkillDiscoveryOptions = {},
): ReadonlyArray<CodexSkillRoot> {
  const env = options.environment ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? NodeOS.homedir();
  const platform = options.platform;
  const codexHome = expandHomePath(
    options.codexHomePath?.trim() || env.CODEX_HOME?.trim() || DEFAULT_CODEX_HOME,
  );
  const roots: CodexSkillRoot[] = [];
  const cwd = options.cwd?.trim();

  if (cwd) {
    roots.push(
      { path: NodePath.join(cwd, ".codex", "skills"), scope: "project" },
      { path: NodePath.join(cwd, ".agents", "skills"), scope: "project" },
    );
  }

  roots.push(
    { path: NodePath.join(codexHome, "skills"), scope: "user" },
    { path: NodePath.join(codexHome, "plugins", "cache"), scope: "user" },
    { path: NodePath.join(codexHome, "skills", ".system"), scope: "system" },
  );

  if (homeDir) {
    roots.push({
      path: NodePath.join(expandHomePath(homeDir), ".agents", "skills"),
      scope: "user",
    });
  }

  if (platform !== "win32") {
    roots.push({ path: "/etc/codex/skills", scope: "admin" });
  }

  return dedupeRoots(roots);
}

async function discoverSkillFilesUnderRoot(
  root: CodexSkillRoot,
  maxFiles: number,
): Promise<ReadonlyArray<{ path: string; scope: CodexSkillScope }>> {
  if (maxFiles <= 0) return [];
  if (!(await pathExists(root.path))) return [];
  const found: Array<{ path: string; scope: CodexSkillScope }> = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root.path, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0 && found.length < maxFiles) {
    const { dir, depth } = queue.shift()!;
    let realDir = dir;
    try {
      realDir = await NodeFSP.realpath(dir);
    } catch {
      realDir = NodePath.resolve(dir);
    }
    if (visited.has(realDir)) continue;
    visited.add(realDir);

    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (entry.name.startsWith(".")) continue;
      const entryPath = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) {
          queue.push({ dir: entryPath, depth: depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        found.push({ path: entryPath, scope: root.scope });
      }
    }
  }

  return found;
}

async function readPluginManifestName(pluginRoot: string): Promise<string | undefined> {
  for (const relativeManifestPath of PLUGIN_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = NodePath.join(pluginRoot, relativeManifestPath);
    let stat: import("node:fs").Stats;
    try {
      stat = await NodeFSP.stat(manifestPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    try {
      const parsed = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as unknown;
      const rawName =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { readonly name?: unknown }).name
          : undefined;
      const name = typeof rawName === "string" ? normalizeWhitespace(rawName) : undefined;
      return name ?? normalizeWhitespace(NodePath.basename(pluginRoot));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function pluginNamespaceForSkillPath(skillPath: string): Promise<string | undefined> {
  for (let current = NodePath.dirname(skillPath); ; current = NodePath.dirname(current)) {
    const namespace = await readPluginManifestName(current);
    if (namespace) return namespace;

    const parent = NodePath.dirname(current);
    if (parent === current) return undefined;
  }
}

async function parseSkillFile(
  skillPath: string,
  scope: CodexSkillScope,
): Promise<ServerProviderSkill | null> {
  let stat: import("node:fs").Stats;
  try {
    stat = await NodeFSP.stat(skillPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return null;

  let contents: string;
  try {
    contents = await NodeFSP.readFile(skillPath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = extractFrontmatter(contents);
  if (!frontmatter) return null;

  const baseName = readTopLevelYamlString(frontmatter, "name") ?? defaultSkillName(skillPath);
  const namespace = await pluginNamespaceForSkillPath(skillPath);
  const name = namespace ? `${namespace}:${baseName}` : baseName;
  const description = readTopLevelYamlString(frontmatter, "description");
  const shortDescription = readMetadataShortDescription(frontmatter);

  return {
    name,
    path: NodePath.resolve(skillPath),
    scope,
    enabled: true,
    ...(description ? { description } : {}),
    ...(shortDescription ? { shortDescription } : {}),
  };
}

function scopeRank(scope: string | undefined): number {
  switch (scope) {
    case "project":
      return 0;
    case "user":
      return 1;
    case "system":
      return 2;
    case "admin":
      return 3;
    default:
      return 4;
  }
}

async function discoverCodexSkillsUnsafe(
  options: CodexSkillDiscoveryOptions,
): Promise<ReadonlyArray<ServerProviderSkill>> {
  const roots = buildCodexSkillRoots(options);
  const skillFiles: Array<{ path: string; scope: CodexSkillScope }> = [];

  for (const root of roots) {
    const remainingBudget = MAX_SKILL_FILES - skillFiles.length;
    if (remainingBudget <= 0) break;
    skillFiles.push(...(await discoverSkillFilesUnderRoot(root, remainingBudget)));
  }

  const seenPaths = new Set<string>();
  const skills: ServerProviderSkill[] = [];
  for (const skillFile of skillFiles) {
    const resolvedPath = NodePath.resolve(skillFile.path);
    if (seenPaths.has(resolvedPath)) continue;
    seenPaths.add(resolvedPath);
    const skill = await parseSkillFile(resolvedPath, skillFile.scope);
    if (skill) skills.push(skill);
  }

  return skills.sort((left, right) => {
    const scope = scopeRank(left.scope) - scopeRank(right.scope);
    if (scope !== 0) return scope;
    const name = left.name.localeCompare(right.name);
    return name !== 0 ? name : left.path.localeCompare(right.path);
  });
}

export function discoverCodexSkills(
  options: CodexSkillDiscoveryOptions = {},
): Effect.Effect<ReadonlyArray<ServerProviderSkill>> {
  return Effect.gen(function* () {
    const platform = options.platform ?? (yield* HostProcessPlatform);
    return yield* Effect.promise(async () => {
      try {
        return await discoverCodexSkillsUnsafe({ ...options, platform });
      } catch {
        return [];
      }
    });
  });
}

function collectSkillMentions(text: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2]?.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

function renderSkillFragment(skill: ServerProviderSkill, contents: string): string {
  return `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${contents.trim()}\n</skill>`;
}

async function buildCodexSkillFragmentsUnsafe(
  text: string,
  options: CodexPromptAugmentationOptions,
): Promise<ReadonlyArray<string>> {
  const mentions = collectSkillMentions(text);
  if (mentions.length === 0) return [];

  const skills = options.skills ?? (await discoverCodexSkillsUnsafe(options));
  const enabledSkillsByName = new Map(
    skills.filter((skill) => skill.enabled).map((skill) => [skill.name, skill] as const),
  );
  const fragments: string[] = [];

  for (const mention of mentions) {
    const skill = enabledSkillsByName.get(mention);
    if (!skill) continue;
    try {
      const stat = await NodeFSP.stat(skill.path);
      if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) continue;
      const contents = await NodeFSP.readFile(skill.path, "utf8");
      fragments.push(renderSkillFragment(skill, contents));
    } catch {
      continue;
    }
  }

  return fragments;
}

export function buildCodexSkillFragments(
  text: string,
  options: CodexPromptAugmentationOptions = {},
): Effect.Effect<ReadonlyArray<string>> {
  return Effect.promise(async () => {
    try {
      return await buildCodexSkillFragmentsUnsafe(text, options);
    } catch {
      return [];
    }
  });
}

export function codexModeInstructionsForInteractionMode(
  interactionMode: ProviderInteractionMode | undefined,
): string | undefined {
  if (interactionMode === "plan") return CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS;
  if (interactionMode === "default") return CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS;
  return undefined;
}

export function augmentProviderTurnInputWithCodexContext(
  input: ProviderSendTurnInput,
  options: CodexPromptAugmentationOptions = {},
): Effect.Effect<ProviderSendTurnInput> {
  return Effect.gen(function* () {
    const originalText = input.input?.trim() ?? "";
    const fragments = [
      codexModeInstructionsForInteractionMode(input.interactionMode),
      ...(yield* buildCodexSkillFragments(originalText, options)),
    ].filter((fragment): fragment is string => Boolean(fragment && fragment.trim()));

    if (fragments.length === 0) return input;

    const nextInput = [...fragments, originalText].filter((part) => part.length > 0).join("\n\n");
    return {
      ...input,
      input: nextInput,
    };
  });
}
