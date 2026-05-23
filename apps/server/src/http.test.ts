import { describe, expect, it } from "vitest";

import { isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";
import { isBrowserApiCorsOriginAllowed } from "./httpCors.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });

  it("allows credentialed browser API CORS only for loopback and hosted app origins", () => {
    expect(isBrowserApiCorsOriginAllowed("http://localhost:5173")).toBe(true);
    expect(isBrowserApiCorsOriginAllowed("http://127.0.0.1:5173")).toBe(true);
    expect(isBrowserApiCorsOriginAllowed("http://[::1]:5173")).toBe(true);
    expect(isBrowserApiCorsOriginAllowed("https://app.t3.codes")).toBe(true);
    expect(isBrowserApiCorsOriginAllowed("https://latest.app.t3.codes")).toBe(true);
    expect(isBrowserApiCorsOriginAllowed("https://nightly.app.t3.codes")).toBe(true);

    expect(isBrowserApiCorsOriginAllowed("https://evil.example")).toBe(false);
    expect(isBrowserApiCorsOriginAllowed("http://remote-client.test:3773")).toBe(false);
    expect(isBrowserApiCorsOriginAllowed("https://app.t3.codes.evil.example")).toBe(false);
    expect(isBrowserApiCorsOriginAllowed("https://user@app.t3.codes")).toBe(false);
  });
});
