// [LAW:one-source-of-truth] A promptctl:// URL carries everything the renderer needs;
// the renderer reads selection from the hash via useSearchParams. This module is the
// single place URL-shape rules live. Keep it pure so both cold-start (baked into
// loadURL) and warm-path (executeJavaScript("location.hash=...")) use the same
// translation.

const OPEN_HOST = "open";
// [LAW:one-source-of-truth] Session deep-links target the Context Workshop
// editor route. The new Workshop tab uses /workshop and is reached via
// launch-id deep links composed inside the renderer, not from external
// promptctl:// URLs (a launch is an in-app artifact and has no stable
// identity outside the running app).
const TARGET_ROUTE = "/context-workshop";

export interface DeepLinkParams {
  provider: string;
  sessionId: string;
}

export function parsePromptctlUrl(raw: string): DeepLinkParams | null {
  const url = tryParseUrl(raw);
  if (!url) return null;
  if (url.protocol !== "promptctl:") return null;
  if (url.hostname !== OPEN_HOST) return null;

  const provider = url.searchParams.get("provider");
  const sessionId = url.searchParams.get("sessionId");
  if (!provider || !sessionId) return null;

  return { provider, sessionId };
}

export function promptctlUrlToHash(raw: string): string | null {
  const params = parsePromptctlUrl(raw);
  if (!params) return null;
  const qs = new URLSearchParams({
    provider: params.provider,
    sessionId: params.sessionId,
  });
  return `#${TARGET_ROUTE}?${qs.toString()}`;
}

export function findPromptctlUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("promptctl://")) return arg;
  }
  return null;
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
