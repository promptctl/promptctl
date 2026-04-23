// [LAW:single-enforcer] All upstream HTTPS requests originate here.
// Module-singleton Agent so connection pooling persists across requests.
//
// Note: rejectUnauthorized: false is intentional. This is a developer tool
// for inspecting LLM-API traffic — including against test endpoints with
// self-signed certs. Strict cert validation is a later slice (and a setting,
// not a hard-coded rule).
import { Agent, request as undiciRequest, type Dispatcher } from "undici";

const agent = new Agent({
  connect: {
    // [LAW:dataflow-not-control-flow] One agent, one rule. No "is this a
    // test" branch — config drives behavior, not control flow.
    rejectUnauthorized: false,
  },
  // Slightly conservative defaults; LLM responses can be slow.
  connectTimeout: 30_000,
  headersTimeout: 60_000,
  bodyTimeout: 0, // 0 = no body timeout (SSE streams are long-lived)
});

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal?: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Dispatcher.ResponseData["body"];
}

// [LAW:single-enforcer] forward() is THE upstream call. Adds no logic beyond
// translating UpstreamRequest → undici.request and back.
export async function forward(req: UpstreamRequest): Promise<UpstreamResponse> {
  const res = await undiciRequest(req.url, {
    method: req.method as Dispatcher.HttpMethod,
    headers: req.headers,
    body: req.body ?? undefined,
    signal: req.signal,
    dispatcher: agent,
  });
  return {
    status: res.statusCode,
    headers: normalizeHeaders(res.headers),
    body: res.body,
  };
}

function normalizeHeaders(
  raw: Dispatcher.ResponseData["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

// Closes the agent and any pooled connections. Called on app shutdown.
export async function closeUpstream(): Promise<void> {
  await agent.close();
}
