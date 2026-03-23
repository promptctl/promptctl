import { CommandPanel } from "../components/CommandPanel";

export function CommandsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="mb-6 text-2xl font-bold tracking-tight text-neutral-100">
        Commands
      </h2>
      <CommandPanel />
    </div>
  );
}
