// [LAW:single-enforcer] One tokenizer instance for the entire app.
// [LAW:dataflow-not-control-flow] Per-kind estimation dispatches on the `kind`
// tag in the input, not branches scattered across callers. The adapter emits
// BillableChunk[]; this module sums them using per-kind char divisors.
//
// This is an INTERIM ESTIMATOR, not a calibrated tokenizer. The per-kind
// divisors give a rough char→token ratio (English prose ≈ 3.0, code/JSON ≈ 2.5)
// that is directionally correct but not precise. An accurate local tokenizer
// is tracked separately; when it lands, replace the body of countTokensByKind
// with a call into it. The public surface (countTokensByKind, sumChunks,
// countTokens, truncateMiddle) is the seam.
//
// tiktoken stays imported for truncateMiddle — it's the right tool for
// preserving token-ish boundaries when trimming text, even though it uses
// OpenAI's vocabulary.
import { encoding_for_model } from "tiktoken";
import type { BillableChunk, ContentKind } from "../../shared/types";

const enc = encoding_for_model("gpt-4o");

const KIND_CHAR_DIVISORS: Record<ContentKind, number> = {
  user_text: 3.0,
  assistant_text: 2.5,
  system_text: 2.5,
  tool_use_input: 2.5,
  tool_result_string: 2.5,
  tool_result_array: 2.5,
  thinking_text: 2.5,
  thinking_signature: 1.0,
};

/** Interim estimate: chars / kind-specific divisor. */
export function countTokensByKind(text: string, kind: ContentKind): number {
  const divisor = KIND_CHAR_DIVISORS[kind] ?? 3.0;
  return Math.round(text.length / divisor);
}

/** Sum token estimates over a tagged-chunk array. */
export function sumChunks(chunks: BillableChunk[]): number {
  let total = 0;
  for (const chunk of chunks)
    total += countTokensByKind(chunk.text, chunk.kind);
  return total;
}

/**
 * Back-compat for callers that don't have a ContentKind handy yet.
 * Treats the text as `assistant_text` — the most common kind. Prefer
 * countTokensByKind / sumChunks for new code.
 */
export function countTokens(text: string): number {
  return countTokensByKind(text, "assistant_text");
}

/** Keep the first and last `keep` tokens, replace the middle with ellipsis. */
export function truncateMiddle(text: string, keep = 100): string {
  const tokens = enc.encode(text);
  if (tokens.length <= keep * 2) return text;
  const head = enc.decode(tokens.slice(0, keep));
  const tail = enc.decode(tokens.slice(-keep));
  const dropped = tokens.length - keep * 2;
  return `${new TextDecoder().decode(head)}\n\n[…${dropped} tokens omitted…]\n\n${new TextDecoder().decode(tail)}`;
}
