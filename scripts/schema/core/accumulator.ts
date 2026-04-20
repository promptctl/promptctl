// [LAW:dataflow-not-control-flow] One generic merge. Provider-specific quirks are
// declarations at the call site (record kind labels, discriminator names), not
// branches inside the accumulator.
//
// The accumulator observes records labeled by a "kind" (e.g. "ClaudeLine") with
// an optional discriminator field ("type"). Records are split into variants by
// the discriminator value. Fields are observed recursively into nested
// records (for objects) and into per-item records for arrays. Array items are
// auto-discriminated on a `type` field when every item has one.

import { redactSample } from "./redact";
import type {
  FieldSchema,
  RecordSchema,
  ValueKind,
} from "./types";

const ENUM_MAX = 32;
const ENUM_VALUE_MAX_LEN = 40; // long strings are never enum-like; keep enums tight
const SAMPLE_MAX = 3;
// Objects with more distinct keys than this are treated as maps/dictionaries —
// the keys themselves are dynamic data (paths, ids) and must not be captured as
// field names in the schema.
const MAP_KEY_THRESHOLD = 50;

interface FieldObs {
  fieldName: string;
  observedCount: number;
  valueKindCounts: Map<ValueKind, number>;
  samplesBySig: Map<string, unknown>;
  stringValues: Set<string>;
  stringValueOverflow: boolean;
  arrayItem?: RecordObs;
  nested?: RecordObs;
}

interface RecordObs {
  totalCount: number;
  discriminator?: string;
  variants: Map<string, RecordObs>;
  fields: Map<string, FieldObs>;
  /** Set when distinct-key count exceeds MAP_KEY_THRESHOLD — object treated as a map. */
  isMap: boolean;
  /** Count of observations where this was used as a map (for presence math). */
  mapObservations: number;
  /** Summary of map key-kind & total unique key count when isMap. */
  mapDistinctKeys: number;
}

function newRecord(): RecordObs {
  return {
    totalCount: 0,
    variants: new Map(),
    fields: new Map(),
    isMap: false,
    mapObservations: 0,
    mapDistinctKeys: 0,
  };
}

function newField(name: string): FieldObs {
  return {
    fieldName: name,
    observedCount: 0,
    valueKindCounts: new Map(),
    samplesBySig: new Map(),
    stringValues: new Set(),
    stringValueOverflow: false,
  };
}

function valueKind(v: unknown): ValueKind {
  if (v === null) return "null";
  if (v === undefined) return "absent";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "absent";
}

// Distinct "shape signature" so we keep one sample per shape, not per occurrence.
// For scalars the signature is the kind; for arrays, kind + item-count bucket; for
// objects, kind + sorted-keys.
function shapeSig(v: unknown): string {
  if (Array.isArray(v)) return `array:${v.length === 0 ? 0 : v.length < 4 ? "s" : "m"}`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `object:${keys.join(",")}`;
  }
  return valueKind(v);
}

function incr<K>(m: Map<K, number>, k: K): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function observeFields(
  record: RecordObs,
  data: Record<string, unknown>,
  skipField?: string,
): void {
  if (record.isMap) {
    // Already classified as a map — just track distinct key cardinality (bounded)
    // and skip per-key field accumulation.
    record.mapObservations++;
    return;
  }

  // Grow the field set; if it crosses the map threshold, reset and flip to map.
  for (const [key, value] of Object.entries(data)) {
    if (key === skipField) continue;
    let field = record.fields.get(key);
    if (!field) {
      field = newField(key);
      record.fields.set(key, field);
      if (record.fields.size > MAP_KEY_THRESHOLD) {
        const keyCount = record.fields.size;
        record.fields.clear();
        record.isMap = true;
        record.mapObservations++;
        record.mapDistinctKeys = keyCount;
        return;
      }
    }
    field.observedCount++;
    observeValue(field, value);
  }
}

function observeValue(field: FieldObs, value: unknown): void {
  const kind = valueKind(value);
  incr(field.valueKindCounts, kind);

  const sig = shapeSig(value);
  if (!field.samplesBySig.has(sig) && field.samplesBySig.size < SAMPLE_MAX * 2) {
    field.samplesBySig.set(sig, value);
  }

  if (kind === "string" && !field.stringValueOverflow) {
    const s = value as string;
    if (s.length > ENUM_VALUE_MAX_LEN) {
      // Non-enum-like content (free text, paths, long ids). Don't track.
      field.stringValueOverflow = true;
      field.stringValues.clear();
    } else {
      field.stringValues.add(s);
      if (field.stringValues.size > ENUM_MAX) {
        field.stringValueOverflow = true;
        field.stringValues.clear();
      }
    }
  }

  if (kind === "array") {
    field.arrayItem ??= newRecord();
    for (const item of value as unknown[]) {
      observeArrayItem(field.arrayItem, item);
    }
  }

  if (kind === "object") {
    field.nested ??= newRecord();
    field.nested.totalCount++;
    observeFields(field.nested, value as Record<string, unknown>);
  }
}

function observeArrayItem(arrayItem: RecordObs, item: unknown): void {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    arrayItem.totalCount++;
    return;
  }

  const typeVal = (item as Record<string, unknown>).type;
  const useDiscriminator =
    typeof typeVal === "string" && arrayItem.discriminator !== undefined
      ? arrayItem.discriminator === "type"
      : arrayItem.discriminator === undefined && typeof typeVal === "string";

  if (useDiscriminator) {
    arrayItem.discriminator = "type";
    let variant = arrayItem.variants.get(typeVal as string);
    if (!variant) {
      variant = newRecord();
      arrayItem.variants.set(typeVal as string, variant);
    }
    variant.totalCount++;
    arrayItem.totalCount++;
    observeFields(variant, item as Record<string, unknown>, "type");
  } else {
    arrayItem.totalCount++;
    observeFields(arrayItem, item as Record<string, unknown>);
  }
}

// --- Public API ---

export class SchemaAccumulator {
  private kinds: Map<string, RecordObs> = new Map();

  /**
   * Observe a top-level record. `kindLabel` identifies the record class (e.g.
   * "ClaudeLine"). If `discriminator` is provided, the record is split into
   * variants keyed by the discriminator field's value.
   */
  observeRecord(
    kindLabel: string,
    record: Record<string, unknown>,
    discriminator?: string,
  ): void {
    let obs = this.kinds.get(kindLabel);
    if (!obs) {
      obs = newRecord();
      if (discriminator) obs.discriminator = discriminator;
      this.kinds.set(kindLabel, obs);
    }
    obs.totalCount++;

    if (obs.discriminator) {
      const variantKey =
        typeof record[obs.discriminator] === "string"
          ? (record[obs.discriminator] as string)
          : "<absent>";
      let variant = obs.variants.get(variantKey);
      if (!variant) {
        variant = newRecord();
        obs.variants.set(variantKey, variant);
      }
      variant.totalCount++;
      observeFields(variant, record, obs.discriminator);
    } else {
      observeFields(obs, record);
    }
  }

  /** Convert accumulated observations to the serializable schema shape. */
  finalize(): Record<string, RecordSchema> {
    const out: Record<string, RecordSchema> = {};
    const sortedKinds = [...this.kinds.keys()].sort();
    for (const kind of sortedKinds) {
      out[kind] = finalizeRecord(this.kinds.get(kind)!);
    }
    return out;
  }
}

function finalizeRecord(obs: RecordObs): RecordSchema {
  const schema: RecordSchema = { totalCount: obs.totalCount };

  if (obs.discriminator) {
    schema.discriminator = obs.discriminator;
    const variants: Record<string, RecordSchema> = {};
    const keys = [...obs.variants.keys()].sort();
    for (const k of keys) {
      variants[k] = finalizeRecord(obs.variants.get(k)!);
    }
    schema.variants = variants;
  }

  if (obs.isMap) {
    // Represent dynamic-key objects as a map, not per-key fields. Key values
    // are PII (paths, ids) and must not appear in the committed schema.
    schema.fields = {
      "<map>": {
        valueKinds: ["object"],
        presence: 1,
        samples: [`<map: distinct keys ≥ ${obs.mapDistinctKeys}>`],
      },
    };
  } else if (obs.fields.size > 0) {
    const fields: Record<string, FieldSchema> = {};
    const keys = [...obs.fields.keys()].sort();
    for (const k of keys) {
      fields[k] = finalizeField(obs.fields.get(k)!, obs.totalCount);
    }
    schema.fields = fields;
  }

  return schema;
}

function finalizeField(obs: FieldObs, parentCount: number): FieldSchema {
  const valueKinds = [...obs.valueKindCounts.keys()].sort();
  const presence =
    parentCount === 0 ? 0 : Math.round((obs.observedCount / parentCount) * 10_000) / 10_000;

  const samples: string[] = [];
  const sigs = [...obs.samplesBySig.keys()].sort();
  for (const sig of sigs.slice(0, SAMPLE_MAX)) {
    samples.push(redactSample(obs.samplesBySig.get(sig), { fieldName: obs.fieldName }));
  }

  const field: FieldSchema = { valueKinds, presence, samples };

  if (!obs.stringValueOverflow && obs.stringValues.size > 0) {
    // Redact each enum value — even short strings may contain paths/secrets.
    field.enum = [...obs.stringValues]
      .sort()
      .map((v) => redactSample(v, { fieldName: obs.fieldName }));
  }

  if (obs.arrayItem) field.arrayItem = finalizeRecord(obs.arrayItem);
  if (obs.nested) field.nested = finalizeRecord(obs.nested);

  return field;
}
