import { PromptLibrary } from "../components/PromptLibrary";

export function PromptsPage() {
  return (
    <div className="flex h-full flex-col">
      <h2 className="mb-4 text-2xl font-bold tracking-tight text-neutral-100">
        Prompt Library
      </h2>
      <div className="min-h-0 flex-1">
        <PromptLibrary />
      </div>
    </div>
  );
}
