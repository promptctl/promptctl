import type { ReactNode } from "react";
import { JsonlLineView } from "../jsonl-view/JsonlLineView";
import { MessageView, messageKey } from "./MessageView";

export function RequestTab({
  requestBody,
  highlightSubstring,
}: {
  requestBody: unknown;
  highlightSubstring?: string;
}) {
  const body = asRecord(requestBody);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const system = body?.system;
  const model = typeof body?.model === "string" ? body.model : "--";
  const hasAnthropicShape =
    body !== null && (Array.isArray(body.messages) || "system" in body);

  return (
    <div className="space-y-4 p-4">
      {hasAnthropicShape ? (
        <>
          <Section title="Model">
            <div className="font-mono text-sm text-neutral-200">{model}</div>
          </Section>
          <Section title="System">
            <JsonlLineView
              raw={system ?? null}
              highlightSubstring={highlightSubstring}
            />
          </Section>
          <Section title={`Messages (${messages.length})`}>
            <div className="space-y-2">
              {messages.map((message, index) => (
                <MessageView
                  key={messageKey(message, index)}
                  message={message}
                  index={index}
                  highlightSubstring={highlightSubstring}
                />
              ))}
            </div>
          </Section>
          <Section title={`Tools (${tools.length})`}>
            <div className="space-y-2">
              {tools.map((tool, index) => (
                <JsonCard
                  key={jsonKey(tool, index)}
                  value={tool}
                  highlightSubstring={highlightSubstring}
                />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <Section title="Request body">
          <JsonlLineView
            raw={requestBody}
            highlightSubstring={highlightSubstring}
          />
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <h3 className="border-b border-neutral-900 px-3 py-2 text-xs font-medium text-neutral-500">
        {title}
      </h3>
      <div>{children}</div>
    </section>
  );
}

function JsonCard({
  value,
  highlightSubstring,
}: {
  value: unknown;
  highlightSubstring?: string;
}) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/50">
      <JsonlLineView raw={value} highlightSubstring={highlightSubstring} />
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonKey(value: unknown, index: number): string {
  const body = asRecord(value);
  return typeof body?.id === "string" ? body.id : `json-${index}`;
}
