// [LAW:single-enforcer] All ProxyEvent envelope fields (clientId, globalSeq,
// recvNs) are stamped here so event construction has one boundary.
import type { ProxyEventEnvelope } from "../../shared/proxy-events";

let _globalSeqCounter = 0;

export function nextGlobalSeq(): number {
  _globalSeqCounter += 1;
  return _globalSeqCounter;
}

export function makeEnvelope(
  requestId: string,
  clientId: string,
): ProxyEventEnvelope {
  return {
    requestId,
    clientId,
    globalSeq: nextGlobalSeq(),
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
