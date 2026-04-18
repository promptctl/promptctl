// [LAW:single-enforcer] LLM-powered session transformation operations.
import { chatComplete } from "./client";
import type { MessageSummary } from "../../shared/types";
import type { TaskHandle } from "../tasks/runner";

export interface CompressSuggestion {
  indices: number[]; // logical message indices to remove
  reason: string;
}

export interface TopicSegment {
  topic: string;
  startIndex: number;
  endIndex: number;
  tokenCount: number;
  relevant: boolean; // true = keep, false = remove for focus
}

/**
 * Analyze messages and suggest which ones to remove for compression.
 * Returns groups of removable messages with explanations.
 */
export async function suggestCompression(
  messages: MessageSummary[],
  handle?: TaskHandle,
): Promise<CompressSuggestion[]> {
  handle?.reportProgress(0, 2, "Sending conversation to model");
  // Build a compact representation of the conversation for the LLM
  const lines = messages.map(
    (m) =>
      `[${m.index}] ${m.type} (${m.tokens} tok) ${m.flags.length > 0 ? `{${m.flags.join(",")}}` : ""}: ${m.preview.slice(0, 120)}`,
  );

  const response = await chatComplete(
    `You are a conversation analyst. You analyze AI coding session transcripts and identify messages that can be removed to extract only the core context worth seeding into a new conversation.

The goal is to distill a large conversation down to its essential context — the decisions, conclusions, and information that would be valuable when continuing this work in a fresh session.

Messages that are safe to remove:
- Tool results whose content was already summarized by the assistant in a later message
- Redundant back-and-forth where the same thing was attempted multiple times (keep only the final successful attempt)
- System/info messages with no conversational value
- Large tool outputs where the assistant already extracted the relevant information
- Intermediate exploration that led nowhere or was superseded by later work

Messages that must NOT be removed:
- User instructions and decisions
- Assistant conclusions, plans, and final implementations
- Tool results that haven't been summarized yet
- Messages that establish context needed by later messages
- Thinking-only messages (shown as 0 tokens) — the API strips these for free, removing them saves nothing

Return a JSON array of objects: [{"indices": [1, 2, 3], "reason": "brief explanation"}]
Group related removals together (e.g., a failed attempt spanning multiple messages).
Only suggest removals where you're confident the information is not needed for context recovery.`,
    `Here is the conversation (${messages.length} messages, ${messages.reduce((s, m) => s + m.tokens, 0)} total tokens):\n\n${lines.join("\n")}`,
    handle?.signal,
  );
  handle?.throwIfCancelled();
  handle?.reportProgress(1, 2, "Parsing suggestions");

  try {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const out = JSON.parse(jsonMatch[0]) as CompressSuggestion[];
    handle?.reportProgress(2, 2);
    return out;
  } catch {
    handle?.reportProgress(2, 2);
    return [];
  }
}

/**
 * Segment a conversation into topics and identify which are relevant to a focus query.
 */
export async function segmentTopics(
  messages: MessageSummary[],
  focusQuery: string,
  handle?: TaskHandle,
): Promise<TopicSegment[]> {
  handle?.reportProgress(0, 2, "Sending conversation to model");
  const lines = messages.map(
    (m) =>
      `[${m.index}] ${m.type} (${m.tokens} tok): ${m.preview.slice(0, 120)}`,
  );

  const response = await chatComplete(
    `You are a conversation analyst. You segment AI coding session transcripts into topic blocks and identify which blocks are relevant to a user's focus query.

A topic block is a contiguous sequence of messages about the same task or subject. Boundaries occur when:
- The user changes direction ("now let's work on X")
- A new task begins after the previous one is complete
- The subject matter shifts significantly

Return a JSON array of topic segments:
[{"topic": "short description", "startIndex": 0, "endIndex": 5, "tokenCount": 1234, "relevant": true}]

Set "relevant": true for segments that are related to the focus query, false for segments that are not.
Be inclusive — if a segment provides context needed to understand a relevant segment, mark it relevant too.`,
    `Focus query: "${focusQuery}"\n\nConversation (${messages.length} messages):\n\n${lines.join("\n")}`,
    handle?.signal,
  );
  handle?.throwIfCancelled();
  handle?.reportProgress(1, 2, "Parsing segments");

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const out = JSON.parse(jsonMatch[0]) as TopicSegment[];
    handle?.reportProgress(2, 2);
    return out;
  } catch {
    handle?.reportProgress(2, 2);
    return [];
  }
}
