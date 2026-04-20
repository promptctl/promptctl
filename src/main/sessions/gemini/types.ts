// [LAW:one-source-of-truth] Shape definitions for a Gemini CLI JSON session file.
// The adapter is the only enforcer of parsing behavior; other readers (e.g. the
// schema extractor at scripts/schema/extract-gemini.ts) import these types so we
// don't have two competing definitions.

export type RawContent =
  | { text: string }
  | { toolCalls: unknown[] }
  | { functionResponse: unknown }
  | Record<string, unknown>;

export interface RawMessage {
  id: string;
  timestamp: string;
  type: string;
  content?: string | RawContent[];
  displayContent?: unknown[];
  [key: string]: unknown;
}

export interface RawSession {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: RawMessage[];
  kind: string;
  summary: string;
}
