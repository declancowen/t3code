export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
] as const;

export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;

export function isBrowserApiCorsOriginAllowed(origin: string | undefined): origin is string {
  if (origin === undefined || origin.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
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
