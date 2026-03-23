import { SessionEditor } from "../components/SessionEditor";

export function SessionsPage() {
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
