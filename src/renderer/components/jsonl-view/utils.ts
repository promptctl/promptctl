// Pure formatting helpers for the jsonl-view renderers. No React here.
// [LAW:one-source-of-truth] Formatting lives in one module; every renderer
// reaches for the same helper so a timestamp looks identical in every row,
// preview, or expansion.

export function fmtClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function fmtRelTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function kfmt(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// Tail of a path (last two segments). Full path goes in the tooltip.
export function pathTail(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

// Shorten a Claude model string for display ("claude-sonnet-4-5" → "sonnet-4-5").
export function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
