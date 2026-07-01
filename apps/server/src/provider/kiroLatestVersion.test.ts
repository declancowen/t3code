import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  fetchKiroLatestVersion,
  makeKiroLatestVersionSource,
  resolveKiroPlatformTarget,
  selectLatestKiroVersion,
  type KiroReleaseManifest,
} from "./kiroLatestVersion.ts";

const manifest = (
  versions: ReadonlyArray<{
    version: string;
    packages: ReadonlyArray<{
      os?: string;
      architecture?: string;
      channel?: string;
    }>;
  }>,
): KiroReleaseManifest => ({ versions });

const stableManifest = manifest([
  {
    version: "2.6.1",
    packages: [
      { os: "macos", architecture: "universal", channel: "stable" },
      { os: "linux", architecture: "x86_64", channel: "stable" },
      { os: "linux", architecture: "aarch64", channel: "stable" },
      { os: "windows", architecture: "x86_64", channel: "stable" },
    ],
  },
  {
    version: "2.6.0",
    packages: [{ os: "macos", architecture: "universal", channel: "stable" }],
  },
  {
    // Newer string, but not stable — must be ignored.
    version: "2.7.0",
    packages: [{ os: "macos", architecture: "universal", channel: "beta" }],
  },
  {
    // Legacy entry without channel/os metadata — must be ignored.
    version: "0.7.0",
    packages: [{ architecture: "universal" }],
  },
]);

const makeStubHttpClient = (body: unknown, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );

it("maps Node platform/arch onto release targets", () => {
  expect(resolveKiroPlatformTarget({ platform: "darwin", arch: "arm64" })).toEqual({
    os: "macos",
    architecture: null,
  });
  expect(resolveKiroPlatformTarget({ platform: "linux", arch: "x64" })).toEqual({
    os: "linux",
    architecture: "x86_64",
  });
  expect(resolveKiroPlatformTarget({ platform: "linux", arch: "arm64" })).toEqual({
    os: "linux",
    architecture: "aarch64",
  });
  expect(resolveKiroPlatformTarget({ platform: "win32", arch: "x64" })).toEqual({
    os: "windows",
    architecture: "x86_64",
  });
});

it("returns null for unsupported platforms and architectures", () => {
  expect(resolveKiroPlatformTarget({ platform: "freebsd", arch: "x64" })).toBeNull();
  expect(resolveKiroPlatformTarget({ platform: "linux", arch: "ia32" })).toBeNull();
});

it("selects the newest stable version matching the platform", () => {
  expect(selectLatestKiroVersion(stableManifest, { os: "macos", architecture: null })).toBe(
    "2.6.1",
  );
  expect(selectLatestKiroVersion(stableManifest, { os: "linux", architecture: "aarch64" })).toBe(
    "2.6.1",
  );
});

it("ignores versions without a stable package for the requested architecture", () => {
  const macOnly = manifest([
    { version: "3.0.0", packages: [{ os: "macos", architecture: "universal", channel: "stable" }] },
    {
      version: "2.6.1",
      packages: [{ os: "linux", architecture: "x86_64", channel: "stable" }],
    },
  ]);
  // Only 2.6.1 ships a linux/x86_64 stable build, even though 3.0.0 is newer.
  expect(selectLatestKiroVersion(macOnly, { os: "linux", architecture: "x86_64" })).toBe("2.6.1");
});

it("returns null when nothing matches", () => {
  expect(
    selectLatestKiroVersion(manifest([{ version: "1.0.0", packages: [] }]), {
      os: "linux",
      architecture: "x86_64",
    }),
  ).toBeNull();
  expect(selectLatestKiroVersion(manifest([]), { os: "macos", architecture: null })).toBeNull();
});

it.effect("fetchKiroLatestVersion resolves the latest stable version from the manifest", () =>
  fetchKiroLatestVersion({ target: { os: "macos", architecture: null } }).pipe(
    Effect.tap((version) => Effect.sync(() => expect(version).toBe("2.6.1"))),
    Effect.provide(makeStubHttpClient(stableManifest)),
  ),
);

it.effect("fetchKiroLatestVersion resolves null on non-2xx responses", () =>
  fetchKiroLatestVersion({ target: { os: "macos", architecture: null } }).pipe(
    Effect.tap((version) => Effect.sync(() => expect(version).toBeNull())),
    Effect.provide(makeStubHttpClient({}, 503)),
  ),
);

it.effect("fetchKiroLatestVersion resolves null on malformed payloads", () =>
  fetchKiroLatestVersion({ target: { os: "macos", architecture: null } }).pipe(
    Effect.tap((version) => Effect.sync(() => expect(version).toBeNull())),
    Effect.provide(makeStubHttpClient({ versions: "not-an-array" })),
  ),
);

it("builds a platform-scoped source for supported platforms", () => {
  const source = makeKiroLatestVersionSource({ platform: "linux", arch: "arm64" });
  expect(source?.cacheKey).toBe("kiro-release:linux:aarch64");

  const macSource = makeKiroLatestVersionSource({ platform: "darwin", arch: "arm64" });
  expect(macSource?.cacheKey).toBe("kiro-release:macos:universal");
});

it("does not build a source for unsupported platforms", () => {
  expect(makeKiroLatestVersionSource({ platform: "freebsd", arch: "x64" })).toBeNull();
});
