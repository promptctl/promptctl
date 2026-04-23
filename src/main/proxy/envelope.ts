// [LAW:single-enforcer] All ProxyEvent envelope fields (seq, recvNs) are
// stamped here — every emitter calls makeEnvelope() with just the requestId.
import type { ProxyEventEnvelope } from "../../shared/proxy-events";

let _seqCounter = 0;

export function nextSeq(): number {
  _seqCounter += 1;
  return _seqCounter;
}

export function makeEnvelope(requestId: string): ProxyEventEnvelope {
  return {
    requestId,
    seq: nextSeq(),
    // hrtime.bigint() is monotonic; narrow to Number for IPC-friendliness.
    // Number can hold ~9007 years of nanoseconds before precision loss.
    recvNs: Number(process.hrtime.bigint()),
  };
}

// Stable, short request IDs. Crypto-random hex, 16 chars (~8 bytes entropy)
// — enough to disambiguate per session, short enough to be readable in logs.
import { randomBytes } from "node:crypto";

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}
