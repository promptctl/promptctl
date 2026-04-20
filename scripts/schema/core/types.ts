// Types for the extracted schema artifact and the in-memory accumulator.

export type ValueKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object"
  | "absent";

// --- Output schema shapes (what gets written to disk) ---

export interface FieldSchema {
  /** Distinct value kinds observed at this field. */
  valueKinds: ValueKind[];
  /** observedCount / parent totalCount. 0..1, rounded to 4 decimals. */
  presence: number;
  /** Redacted representative samples, one per distinct kind-signature (up to 3). */
  samples: string[];
  /** If the set of observed string values is small and bounded, enumerate them. */
  enum?: string[];
  /** If "array" was observed, shape of items. */
  arrayItem?: RecordSchema;
  /** If "object" was observed (and not an array), shape of the nested object. */
  nested?: RecordSchema;
}

export interface RecordSchema {
  totalCount: number;
  /** If present, this record is discriminated by the named field. */
  discriminator?: string;
  /** Populated when discriminator is set; keyed by discriminator value. */
  variants?: Record<string, RecordSchema>;
  /** Populated when not discriminated (or for common fields). */
  fields?: Record<string, FieldSchema>;
}

export interface ReferenceEdge {
  from: string;
  to: string;
  fromCount: number;
  resolvedCount: number;
  orphanRate: number;
  source: "declared" | "suggested";
  verified: boolean;
}

export interface Invariant {
  id: string;
  provider: string;
  source: "api-contract";
  statement: string;
  codeReferences: string[];
  observedViolations?: number;
  observedSamples?: string[];
}

export interface CorpusMeta {
  provider: string;
  corpusRoot: string;
  filesScanned: number;
  recordsScanned: number;
  parseErrors: number;
  extractedAt: string;
  extractorVersion: string;
}

export interface SchemaArtifact {
  corpusMeta: CorpusMeta;
  records: Record<string, RecordSchema>;
  references: ReferenceEdge[];
  suggestedReferences: ReferenceEdge[];
  invariants: Invariant[];
}
