// [LAW:single-enforcer] Thin client for Anthropic's /v1/messages/count_tokens.
// The endpoint is free to call and returns ground-truth input token counts for
// an arbitrary message structure. Used by scripts/calibrate-tokens.ts to learn
// per-content-kind correction factors for the local tiktoken-based estimator.
//
// Not wired to chat completion — src/main/llm/client.ts owns that concern for
// OpenAI and should not grow a second provider. Here we only count tokens.

import { loadSettings } from "../settings/store";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | unknown[];
      is_error?: boolean;
    }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: string; data: string };
    };

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface CountTokensRequest {
  model?: string; // default "claude-opus-4-7"
  system?: string;
  tools?: AnthropicTool[];
  thinking?: { type: "enabled"; budget_tokens: number };
  messages: AnthropicMessage[];
}

export interface CountTokensOptions {
  apiKey?: string; // overrides settings + env
  maxRetries?: number; // default 3
}

const ENDPOINT = "https://api.anthropic.com/v1/messages/count_tokens";
const DEFAULT_MODEL = "claude-opus-4-7";
const BASE_BACKOFF_MS = 500;

async function resolveApiKey(override: string | undefined): Promise<string> {
  if (override) return override;
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return envKey;
  const settings = await loadSettings();
  if (settings.anthropicApiKey) return settings.anthropicApiKey;
  throw new Error(
    "Anthropic API key not configured. Set ANTHROPIC_API_KEY env var, " +
      "add it to ~/.promptctl/settings.json, or set it in the app's Settings page.",
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Returns the number of input tokens the API would bill for the given request.
 * Throws on unrecoverable errors; retries 429/5xx up to maxRetries with
 * exponential backoff, honoring Retry-After when the server provides it.
 */
export async function countTokens(
  req: CountTokensRequest,
  opts: CountTokensOptions = {},
  signal?: AbortSignal,
): Promise<number> {
  const apiKey = await resolveApiKey(opts.apiKey);
  const maxRetries = opts.maxRetries ?? 3;
  const body = JSON.stringify({ model: DEFAULT_MODEL, ...req });

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
      signal,
    });

    if (res.ok) {
      const data = (await res.json()) as { input_tokens: number };
      if (typeof data.input_tokens !== "number") {
        throw new Error(
          `count_tokens response missing input_tokens: ${JSON.stringify(data)}`,
        );
      }
      return data.input_tokens;
    }

    const retriable = res.status === 429 || res.status >= 500;
    const errText = await res.text().catch(() => "");
    lastError = new Error(
      `count_tokens HTTP ${res.status}: ${errText || res.statusText}`,
    );
    if (!retriable || attempt === maxRetries) throw lastError;

    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : BASE_BACKOFF_MS * 2 ** attempt;
    await sleep(retryAfterMs, signal);
  }

  throw lastError ?? new Error("count_tokens failed after retries");
}
