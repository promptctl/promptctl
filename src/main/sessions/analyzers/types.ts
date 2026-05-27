// [LAW:one-type-per-behavior] Analyzer = heuristic that PROPOSES steps. Never
// mutates content. The matching step kind (in shared/types.StepKind) is what
// runs the actual transformation. Keeping the two distinct prevents heuristics
// from leaking into the mutating layer and vice versa.
import type {
  ProviderKind,
  AnalyzerMetadata,
  AnalyzerResult,
} from "../../../shared/types";
import type { TaskHandle } from "../../tasks/runner";

export interface Analyzer extends AnalyzerMetadata {
  readonly providerId: ProviderKind;
  run(filePath: string, taskHandle?: TaskHandle): Promise<AnalyzerResult>;
}
