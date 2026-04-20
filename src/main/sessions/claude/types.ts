// [LAW:one-source-of-truth] Shape definitions for a Claude Code JSONL line.
// The adapter is the only enforcer of parsing behavior; other readers (e.g. the
// schema extractor at scripts/schema/extract-claude.ts) import these types so we
// don't have two competing definitions of what a line looks like.

export interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  [key: string]: unknown;
}

export interface ClaudeLine {
  type: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role?: string;
    content?: string | ClaudeContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  customTitle?: string;
  toolUseResult?: unknown;
  isSidechain?: boolean;
  [key: string]: unknown;
}
