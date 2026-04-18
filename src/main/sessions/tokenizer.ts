// [LAW:single-enforcer] One tokenizer instance for the entire app.
import { encoding_for_model } from "tiktoken";

// cl200k_base is the closest publicly available encoding to Claude's tokenizer.
// Token counts are estimates — directionally correct, not exact.
const enc = encoding_for_model("gpt-4o");

export function countTokens(text: string): number {
  return enc.encode(text).length;
}

/** Keep the first and last `keep` tokens, replace the middle with ellipsis. */
export function truncateMiddle(text: string, keep: number = 100): string {
  const tokens = enc.encode(text);
  if (tokens.length <= keep * 2) return text;
  const head = enc.decode(tokens.slice(0, keep));
  const tail = enc.decode(tokens.slice(-keep));
  const dropped = tokens.length - keep * 2;
  return `${new TextDecoder().decode(head)}\n\n[…${dropped} tokens omitted…]\n\n${new TextDecoder().decode(tail)}`;
}
