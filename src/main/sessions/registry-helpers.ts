// [LAW:single-enforcer] Provider-routed session listing.
import type { ProviderKind, SessionInfo } from "../../shared/types";
import { getProvider } from "./registry";

export async function listSessions(
  provider: ProviderKind,
  projectPaths: string[],
): Promise<SessionInfo[]> {
  return getProvider(provider).listSessions(projectPaths);
}
