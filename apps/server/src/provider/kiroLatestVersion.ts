/**
 * Kiro CLI latest-version source.
 *
 * Kiro CLI is not published to npm — it ships through the same release manifest
 * the CLI itself reads for `kiro-cli update` (the `fig_install` index at
 * `https://desktop-release.q.us-east-1.amazonaws.com/index.json`). This module
 * fetches that manifest and selects the newest stable version available for the
 * running platform so provider version advisories can detect updates, mirroring
 * the npm-registry check used for Codex/Claude.
 *
 * @module provider/kiroLatestVersion
 */
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ProviderLatestVersionSource } from "./providerMaintenance.ts";

const DEFAULT_RELEASE_BASE_URL = "https://desktop-release.q.us-east-1.amazonaws.com";
const MANIFEST_PATH = "index.json";
const MANIFEST_TIMEOUT_MS = 4_000;
const STABLE_CHANNEL = "stable";

const KiroReleasePackage = Schema.Struct({
  os: Schema.optional(Schema.String),
  architecture: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
});

const KiroReleaseVersion = Schema.Struct({
  version: Schema.String,
  packages: Schema.optional(Schema.Array(KiroReleasePackage)),
});
type KiroReleaseVersion = typeof KiroReleaseVersion.Type;

export const KiroReleaseManifest = Schema.Struct({
  versions: Schema.optional(Schema.Array(KiroReleaseVersion)),
});
export type KiroReleaseManifest = typeof KiroReleaseManifest.Type;

const decodeKiroReleaseManifest = Schema.decodeUnknownEffect(KiroReleaseManifest);

/**
 * The platform a Kiro release package must target to count as installable.
 * `architecture` is `null` for macOS, whose packages ship as a single
 * `universal` build (so any architecture matches).
 */
export interface KiroPlatformTarget {
  readonly os: "macos" | "linux" | "windows";
  readonly architecture: string | null;
}

function mapNodeArchToReleaseArch(arch: string): string | null {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      return null;
  }
}

/**
 * Map a Node.js `platform`/`arch` pair onto the release manifest's target
 * descriptors. Returns `null` for platforms Kiro does not publish for, in which
 * case no latest-version source is created.
 */
export function resolveKiroPlatformTarget(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): KiroPlatformTarget | null {
  switch (input.platform) {
    case "darwin":
      // macOS ships a single universal build, so architecture is irrelevant.
      return { os: "macos", architecture: null };
    case "linux": {
      const architecture = mapNodeArchToReleaseArch(input.arch);
      return architecture ? { os: "linux", architecture } : null;
    }
    case "win32": {
      const architecture = mapNodeArchToReleaseArch(input.arch);
      return architecture ? { os: "windows", architecture } : null;
    }
    default:
      return null;
  }
}

function manifestEntryMatchesTarget(
  entry: KiroReleaseVersion,
  target: KiroPlatformTarget,
): boolean {
  return (entry.packages ?? []).some(
    (pkg) =>
      pkg.channel === STABLE_CHANNEL &&
      pkg.os === target.os &&
      (target.architecture === null || pkg.architecture === target.architecture),
  );
}

/**
 * Select the highest stable semver version in the manifest that ships a package
 * for `target`. Entries with unparseable versions or no matching package are
 * ignored. Returns `null` when nothing matches.
 */
export function selectLatestKiroVersion(
  manifest: KiroReleaseManifest,
  target: KiroPlatformTarget,
): string | null {
  let latest: string | null = null;
  for (const entry of manifest.versions ?? []) {
    if (!parseSemver(entry.version)) {
      continue;
    }
    if (!manifestEntryMatchesTarget(entry, target)) {
      continue;
    }
    if (latest === null || compareSemverVersions(latest, entry.version) < 0) {
      latest = entry.version;
    }
  }
  return latest;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Fetch the Kiro release manifest and resolve the latest stable version for the
 * given platform target. Network/parse failures resolve to `null` so version
 * advisories degrade gracefully (status `unknown`) rather than erroring.
 */
export const fetchKiroLatestVersion = Effect.fn("fetchKiroLatestVersion")(function* (input: {
  readonly target: KiroPlatformTarget;
  readonly baseUrl?: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? DEFAULT_RELEASE_BASE_URL);
  const request = HttpClientRequest.get(`${baseUrl}/${MANIFEST_PATH}`).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(MANIFEST_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const manifest = yield* httpResponse.json.pipe(
    Effect.flatMap(decodeKiroReleaseManifest),
    Effect.orElseSucceed(() => null),
  );
  if (!manifest) {
    return null;
  }
  return selectLatestKiroVersion(manifest, input.target);
});

/**
 * Build a {@link ProviderLatestVersionSource} for Kiro CLI, or `null` when the
 * running platform has no published Kiro release (so the provider falls back to
 * an `unknown` version advisory instead of a bogus update prompt).
 */
export function makeKiroLatestVersionSource(input?: {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly baseUrl?: string;
}): ProviderLatestVersionSource | null {
  const target = resolveKiroPlatformTarget({
    platform: input?.platform ?? process.platform,
    arch: input?.arch ?? process.arch,
  });
  if (!target) {
    return null;
  }
  return {
    cacheKey: `kiro-release:${target.os}:${target.architecture ?? "universal"}`,
    fetchLatestVersion: fetchKiroLatestVersion({
      target,
      ...(input?.baseUrl ? { baseUrl: input.baseUrl } : {}),
    }),
  };
}
