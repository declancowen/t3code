export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
] as const;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const BROWSER_API_TRUSTED_ORIGINS = new Set([
  "https://app.t3.codes",
  "https://latest.app.t3.codes",
  "https://nightly.app.t3.codes",
]);

export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;
export const browserApiCorsMaxAgeSeconds = 600;

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function isBrowserApiCorsOriginAllowed(origin: string | undefined): origin is string {
  if (origin === undefined || origin.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length !== 0 ||
      url.password.length !== 0
    ) {
      return false;
    }

    return isLoopbackHostname(url.hostname) || BROWSER_API_TRUSTED_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

export function browserApiCorsHeadersForOrigin(origin: string | undefined) {
  if (!isBrowserApiCorsOriginAllowed(origin)) {
    return browserApiCorsHeaders;
  }

  return {
    ...browserApiCorsHeaders,
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  } as const;
}

export function browserApiCorsPreflightHeadersForOrigin(origin: string | undefined) {
  if (!isBrowserApiCorsOriginAllowed(origin)) {
    return {};
  }

  return {
    ...browserApiCorsHeadersForOrigin(origin),
    "access-control-max-age": String(browserApiCorsMaxAgeSeconds),
  } as const;
}
