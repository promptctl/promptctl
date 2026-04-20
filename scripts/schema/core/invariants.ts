// [LAW:one-source-of-truth] Hand-maintained API contracts. These are NOT
// corpus-derived; they're statements about what the Anthropic or Gemini API
// requires, which the corpus happens to reflect but can't prove. Each invariant
// cites the adapter line that enforces it (or should enforce it). The extractor
// runs a best-effort violation count over the corpus and annotates each entry.

import type { Invariant } from "./types";

export type InvariantDecl = Omit<Invariant, "source"> & { source: "api-contract" };

export const CLAUDE_INVARIANTS: InvariantDecl[] = [
  {
    id: "tool_use_tool_result_pairing",
    provider: "claude",
    source: "api-contract",
    statement:
      "Every tool_use block in an assistant message MUST be followed by a matching tool_result block (tool_result.tool_use_id === tool_use.id) in a subsequent user turn within the same session. The Anthropic API rejects sessions with orphaned tool_use or tool_result blocks.",
    codeReferences: [
      "src/main/sessions/claude/adapter.ts:57",
      "src/main/sessions/claude/adapter.ts:697",
    ],
  },
  {
    id: "parent_uuid_chain",
    provider: "claude",
    source: "api-contract",
    statement:
      "Claude Code appends lines in parent->child order; each line's parentUuid should reference a uuid earlier in the same file. Breaking the chain can cause Claude Code to misconstruct the conversation view on resume.",
    codeReferences: ["src/main/sessions/claude/adapter.ts:697"],
  },
  {
    id: "visible_type_preservation",
    provider: "claude",
    source: "api-contract",
    statement:
      "The adapter treats only user/assistant/system (with isSidechain !== true) as visible, editable messages. All other types (summary, custom-title, attachment, file-history-snapshot, last-prompt, pr-link) must be preserved verbatim across edits — Claude Code's resume flow, cache, and UI all depend on them.",
    codeReferences: [
      "src/main/sessions/claude/adapter.ts:57",
      "src/main/sessions/claude/adapter.ts:60",
    ],
  },
];

export const GEMINI_INVARIANTS: InvariantDecl[] = [
  {
    id: "session_object_shape",
    provider: "gemini",
    source: "api-contract",
    statement:
      "Gemini session files are a single JSON object with sessionId, projectHash, startTime, lastUpdated, kind, summary, and a messages array. The CLI expects all top-level fields to be present; dropping any of them may break resume.",
    codeReferences: ["src/main/sessions/gemini/adapter.ts:368"],
  },
  {
    id: "message_id_stability",
    provider: "gemini",
    source: "api-contract",
    statement:
      "Each message has a stable id used for diffing across session versions. Removing messages must preserve the remaining ids; renumbering would break version comparison.",
    codeReferences: ["src/main/sessions/gemini/adapter.ts:22"],
  },
];
