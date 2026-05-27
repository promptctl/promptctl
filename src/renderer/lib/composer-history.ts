// [LAW:locality-or-seam] Composer history is renderer-process scope: it
// survives unmounting CommandBar but does not persist across renderer
// reloads. One history ring per renderer session matches the shell-history
// convention without needing settings or disk.
//
// [LAW:single-enforcer] One ring. Tests reset it via clearHistory(); no
// component owns its own copy.

const HISTORY_CAP = 50;

let history: string[] = [];

export function recordHistory(entry: string): void {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return;
  if (history[history.length - 1] === trimmed) return;
  history.push(trimmed);
  if (history.length > HISTORY_CAP) history.shift();
}

export function getHistory(): readonly string[] {
  return history;
}

export function clearHistory(): void {
  history = [];
}
