// [LAW:one-source-of-truth] App settings persisted to ~/.promptctl/settings.json.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SETTINGS_DIR = path.join(process.env.HOME ?? "", ".promptctl");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

export interface AppSettings {
  openaiApiKey: string;
  openaiModel: string;
  // Only used by the offline tokenizer calibration harness (scripts/calibrate-tokens.ts)
  // and any future count_tokens-backed UI affordance. Not used for chat completion.
  anthropicApiKey: string;
  lastRoute: string;
  // Tool-result compression thresholds. One operation dispatches both strategies
  // by token count, so these are the only knobs needed.
  compressSummarizeThreshold: number; // tokens at/above -> summarize via LLM
  compressTruncateThreshold: number; // tokens at/above (but below summarize) -> truncate
  compressKeepLastN: number; // preserve the last N tool results untouched
  // Live proxy settings — the proxy auto-starts on app launch, but stays
  // dormant (no HAR file) until the first request completes.
  proxyPort: number; // 0 = OS-assigned (default)
  proxyTarget: string; // upstream URL — defaults to api.anthropic.com
  proxyRecordingsDir: string; // directory for HAR recordings
}

const DEFAULTS: AppSettings = {
  openaiApiKey: "",
  openaiModel: "gpt-5.4",
  anthropicApiKey: "",
  lastRoute: "/loops",
  compressSummarizeThreshold: 5000,
  compressTruncateThreshold: 1000,
  compressKeepLastN: 3,
  proxyPort: 0,
  proxyTarget: "https://api.anthropic.com",
  proxyRecordingsDir: path.join(SETTINGS_DIR, "proxy-recordings"),
};

let cached: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
  if (cached) return cached;
  const loaded = await readFile(SETTINGS_FILE, "utf-8")
    .then((raw) => ({ ...DEFAULTS, ...JSON.parse(raw) }) as AppSettings)
    .catch(() => ({ ...DEFAULTS }));
  cached = loaded;
  return loaded;
}

export async function saveSettings(
  updates: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await loadSettings();
  const merged = { ...current, ...updates };
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf-8");
  cached = merged;
  return merged;
}
