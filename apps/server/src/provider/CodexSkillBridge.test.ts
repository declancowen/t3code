// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- pre-existing test debt (uses Effect.runPromise); tests pass, refactor to it.effect is a follow-up
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ThreadId } from "@t3tools/contracts";
import {
  augmentProviderTurnInputWithCodexContext,
  buildCodexSkillFragments,
  buildCodexSkillRoots,
  codexModeInstructionsForInteractionMode,
  discoverCodexSkills,
} from "./CodexSkillBridge.ts";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "t3-codex-skills-"));
}

async function writeSkill(root: string, dirName: string, contents: string) {
  const skillDir = path.join(root, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, contents, "utf8");
  return skillPath;
}

describe("CodexSkillBridge", () => {
  it("builds Codex-compatible project and user skill roots", async () => {
    const cwd = await makeTempDir();
    const codexHome = await makeTempDir();
    const homeDir = await makeTempDir();

    expect(
      buildCodexSkillRoots({
        cwd,
        codexHomePath: codexHome,
        homeDir,
        environment: {},
      }).map((root) => ({ path: root.path, scope: root.scope })),
    ).toEqual(
      expect.arrayContaining([
        { path: path.join(cwd, ".codex", "skills"), scope: "project" },
        { path: path.join(cwd, ".agents", "skills"), scope: "project" },
        { path: path.join(codexHome, "skills"), scope: "user" },
        { path: path.join(codexHome, "skills", ".system"), scope: "system" },
        { path: path.join(homeDir, ".agents", "skills"), scope: "user" },
      ]),
    );
  });

  it("discovers SKILL.md metadata from Codex skill roots", async () => {
    const cwd = await makeTempDir();
    const codexHome = await makeTempDir();
    const homeDir = await makeTempDir();
    const projectRoot = path.join(cwd, ".codex", "skills");
    const userRoot = path.join(homeDir, ".agents", "skills");
    const projectSkillPath = await writeSkill(
      projectRoot,
      "project-plan",
      [
        "---",
        "name: project-plan",
        "description: Plan project work",
        "metadata:",
        "  short-description: Project planner",
        "---",
        "Use project context.",
      ].join("\n"),
    );
    await writeSkill(
      userRoot,
      "personal-review",
      ["---", "name: personal-review", "description: Review changes", "---", "Review."].join("\n"),
    );

    const skills = await Effect.runPromise(
      discoverCodexSkills({
        cwd,
        codexHomePath: codexHome,
        homeDir,
        environment: {},
      }),
    );

    expect(skills).toEqual(
      expect.arrayContaining([
        {
          name: "project-plan",
          description: "Plan project work",
          shortDescription: "Project planner",
          path: projectSkillPath,
          scope: "project",
          enabled: true,
        },
        expect.objectContaining({
          name: "personal-review",
          scope: "user",
          enabled: true,
        }),
      ]),
    );
  });

  it("keeps cached system skills scoped as system", async () => {
    const cwd = await makeTempDir();
    const codexHome = await makeTempDir();
    const homeDir = await makeTempDir();
    await writeSkill(
      path.join(codexHome, "skills", ".system"),
      "imagegen",
      ["---", "name: imagegen", "description: Generate images", "---", "Generate."].join("\n"),
    );

    const skills = await Effect.runPromise(
      discoverCodexSkills({
        cwd,
        codexHomePath: codexHome,
        homeDir,
        environment: {},
      }),
    );

    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "imagegen",
          scope: "system",
        }),
      ]),
    );
    expect(skills).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "imagegen",
          scope: "user",
        }),
      ]),
    );
  });

  it("namespaces plugin-backed skills from the plugin manifest", async () => {
    const cwd = await makeTempDir();
    const codexHome = await makeTempDir();
    const homeDir = await makeTempDir();
    const pluginRoot = path.join(codexHome, "plugins", "cache", "openai-curated", "github");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "github" }),
      "utf8",
    );
    const skillPath = await writeSkill(
      path.join(pluginRoot, "skills"),
      "gh-fix-ci",
      ["---", "name: gh-fix-ci", "description: Fix CI", "---", "Fix checks."].join("\n"),
    );

    const skills = await Effect.runPromise(
      discoverCodexSkills({
        cwd,
        codexHomePath: codexHome,
        homeDir,
        environment: {},
      }),
    );
    const fragments = await Effect.runPromise(
      buildCodexSkillFragments("use $github:gh-fix-ci", {
        skills,
        environment: {},
      }),
    );

    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "github:gh-fix-ci",
          path: skillPath,
          scope: "user",
        }),
      ]),
    );
    expect(fragments[0]).toContain("<name>github:gh-fix-ci</name>");
  });

  it("renders explicitly selected skills using upstream Codex skill fragments", async () => {
    const cwd = await makeTempDir();
    const codexHome = await makeTempDir();
    const homeDir = await makeTempDir();
    const skillPath = await writeSkill(
      path.join(cwd, ".codex", "skills"),
      "graphify",
      ["---", "name: graphify", "description: Build a graph", "---", "Graph the codebase."].join(
        "\n",
      ),
    );

    const fragments = await Effect.runPromise(
      buildCodexSkillFragments("please use $graphify for this", {
        cwd,
        codexHomePath: codexHome,
        homeDir,
        environment: {},
      }),
    );

    expect(fragments).toEqual([
      `<skill>\n<name>graphify</name>\n<path>${skillPath}</path>\n---\nname: graphify\ndescription: Build a graph\n---\nGraph the codebase.\n</skill>`,
    ]);
  });

  it("augments Kiro-bound turns with Codex mode instructions and selected skills", async () => {
    const cwd = await makeTempDir();
    const codexHome = await makeTempDir();
    const homeDir = await makeTempDir();
    await writeSkill(
      path.join(cwd, ".codex", "skills"),
      "repo-audit",
      ["---", "name: repo-audit", "description: Audit", "---", "Audit deeply."].join("\n"),
    );

    const input = await Effect.runPromise(
      augmentProviderTurnInputWithCodexContext(
        {
          threadId: ThreadId.make("thread-skill"),
          input: "run $repo-audit",
          attachments: [],
          interactionMode: "plan",
        },
        {
          cwd,
          codexHomePath: codexHome,
          homeDir,
          environment: {},
        },
      ),
    );

    expect(input.input).toContain(codexModeInstructionsForInteractionMode("plan"));
    expect(input.input).toContain("<skill>\n<name>repo-audit</name>");
    expect(input.input).toContain("run $repo-audit");
  });
});
