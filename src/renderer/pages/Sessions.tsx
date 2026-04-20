import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { SessionEditor } from "../components/SessionEditor";
import { useSessionStore } from "../store/sessions";
import type { ProviderKind } from "../../shared/types";

const VALID_PROVIDERS: ReadonlySet<ProviderKind> = new Set([
  "claude",
  "gemini",
  "codex",
]);

// [LAW:one-source-of-truth] The URL carries the deep-link (provider, sessionId).
// This effect is the single site where URL → store selection flows; tree clicks
// call selectSession directly, deep links call selectSessionById.
function useDeepLinkSelection() {
  const [searchParams] = useSearchParams();
  const provider = searchParams.get("provider");
  const sessionId = searchParams.get("sessionId");
  const selectSessionById = useSessionStore((s) => s.selectSessionById);

  useEffect(() => {
    if (!provider || !sessionId) return;
    if (!VALID_PROVIDERS.has(provider as ProviderKind)) return;
    selectSessionById(provider as ProviderKind, sessionId);
  }, [provider, sessionId, selectSessionById]);
}

export function SessionsPage() {
  useDeepLinkSelection();
  return (
    <div className="flex h-full flex-col">
      <h2 className="mb-4 text-2xl font-bold tracking-tight text-neutral-100">
        Session Editor
      </h2>
      <div className="min-h-0 flex-1">
        <SessionEditor />
      </div>
    </div>
  );
}
