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

// [LAW:types-are-the-program] The function's contract is "give me a
// snapshot of the current history" — a snapshot is by definition immune
// to later mutation, including mutation of the returned value itself. A
// readonly type only documents intent; copying the backing array makes
// the snapshot guarantee structural rather than aspirational.
export function getHistory(): readonly string[] {
  return history.slice();
}

export function clearHistory(): void {
  history = [];
}
