// [LAW:one-source-of-truth] Canonical provider→adapter mapping.
// [LAW:locality-or-seam] Adding a provider = new adapter + one registerProvider() call.
import type { ProviderKind } from "../../shared/types";
import type { ProviderAdapter } from "./types";

const adapters = new Map<ProviderKind, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getProvider(id: ProviderKind): ProviderAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`No adapter registered for provider: ${id}`);
  return adapter;
}

export function getAllProviders(): ProviderAdapter[] {
  return [...adapters.values()];
}

// Test hook: clear the registry so tests can install fakes without leaking
// into subsequent tests. Not exposed to production code paths.
export function _resetRegistryForTesting(): void {
  adapters.clear();
}
