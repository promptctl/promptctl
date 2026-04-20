// [LAW:single-enforcer] All sample-value redaction routes through redactSample.
// Deterministic: same input → same output. Committed artifacts must never leak PII.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const PATH_RE = /(?:\/Users\/|\/home\/|~\/|\/tmp\/|\/var\/)[^\s"']+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"']+/g;
const SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g;

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "api_key",
  "secret",
  "token",
  "authorization",
  "cookie",
  "password",
  "bearer",
  "access_token",
  "refresh_token",
  "auth",
]);

export interface RedactOptions {
  fieldName?: string; // leaf field name — used for the denylist
  maxLen?: number; // above this, tier-3 (descriptor-only). Default 120.
}

export function isSecretField(name: string | undefined): boolean {
  if (!name) return false;
  return SECRET_FIELD_NAMES.has(name.toLowerCase());
}

/** A "structural" key: short, identifier-like, no path/space/special chars. */
function isStructuralKey(k: string): boolean {
  if (k.length === 0 || k.length > 30) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(k);
}

/**
 * Normalize + redact a single primitive sample. Returns the string form suitable
 * for committing to the schema artifact.
 *
 * - Booleans/numbers/nulls: stringified as-is.
 * - Timestamps: `<TIMESTAMP>`.
 * - UUIDs: `<UUID>`.
 * - Secret-named fields: `<SECRET>` regardless of content.
 * - Long text (> maxLen): descriptor `<text: ~N chars>`.
 * - Short strings: substring-redact paths, emails, urls, secrets.
 */
export function redactSample(value: unknown, opts: RedactOptions = {}): string {
  const maxLen = opts.maxLen ?? 120;

  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);

  if (isSecretField(opts.fieldName)) return "<SECRET>";

  if (typeof value === "string") {
    if (UUID_RE.test(value)) return "<UUID>";
    if (TIMESTAMP_RE.test(value)) return "<TIMESTAMP>";
    if (value.length > maxLen) return `<text: ~${value.length} chars>`;
    return value
      .replace(SECRET_RE, "<SECRET>")
      .replace(URL_RE, "<URL>")
      .replace(EMAIL_RE, "<EMAIL>")
      .replace(PATH_RE, "<PATH>");
  }

  if (Array.isArray(value)) {
    return `<array: ${value.length} items>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    // Keys may themselves be paths / secrets / long strings. Normalize each.
    const safeKeys = keys
      .slice(0, 5)
      .map((k) => (isStructuralKey(k) ? k : "<dyn>"));
    return `<object: keys=[${safeKeys.join(",")}]${keys.length > 5 ? "..." : ""}>`;
  }
  return String(value);
}
