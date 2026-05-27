// [LAW:one-source-of-truth] Single registry of analyzers, mirrors the provider
// registry pattern (src/main/sessions/registry.ts). One registerAnalyzer call
// per analyzer; the IPC layer reads through getAnalyzerMetadata.
import type { AnalyzerMetadata, ProviderKind } from "../../../shared/types";
import type { Analyzer } from "./types";

const analyzers = new Map<string, Analyzer>();

export function registerAnalyzer(analyzer: Analyzer): void {
  analyzers.set(analyzer.id, analyzer);
}

export function getAnalyzer(id: string): Analyzer {
  const analyzer = analyzers.get(id);
  if (!analyzer) throw new Error(`No analyzer registered: ${id}`);
  return analyzer;
}

export function getAnalyzersForProvider(provider: ProviderKind): Analyzer[] {
  return [...analyzers.values()].filter((a) => a.providerId === provider);
}

export function getAnalyzerMetadata(
  provider: ProviderKind,
): AnalyzerMetadata[] {
  return getAnalyzersForProvider(provider).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
  }));
}

// Test seam: clear the registry so tests can install fakes without leaking
// into subsequent tests. Mirrors _resetRegistryForTesting in registry.ts.
export function _resetAnalyzersForTesting(): void {
  analyzers.clear();
}
