import type { ReactNode } from "react";
import { JsonlLineView } from "../jsonl-view/JsonlLineView";

export function RequestTab({ requestBody }: { requestBody: unknown }) {
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
            <JsonlLineView raw={system ?? null} />
          </Section>
          <Section title={`Messages (${messages.length})`}>
            <div className="space-y-2">
              {messages.map((message, index) => (
                <MessageView
                  key={messageKey(message, index)}
                  message={message}
                  index={index}
                />
              ))}
            </div>
          </Section>
          <Section title={`Tools (${tools.length})`}>
            <div className="space-y-2">
              {tools.map((tool, index) => (
                <JsonCard key={jsonKey(tool, index)} value={tool} />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <Section title="Request body">
          <JsonlLineView raw={requestBody} />
        </Section>
      )}
    </div>
  );
}

function MessageView({ message, index }: { message: unknown; index: number }) {
  const body = asRecord(message);
  const role = typeof body?.role === "string" ? body.role : "unknown";
  const content = body?.content;
  return (
    <details
      open
      className="rounded border border-neutral-800 bg-neutral-950"
      data-testid="request-message"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm text-neutral-200">
        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
          {role}
        </span>
        <span className="ml-2 text-neutral-500">message #{index}</span>
      </summary>
      <div className="border-t border-neutral-900">
        {Array.isArray(content) ? (
          <div className="space-y-2 p-3">
            {content.map((block, blockIndex) => (
              <JsonCard key={jsonKey(block, blockIndex)} value={block} />
            ))}
          </div>
        ) : (
          <JsonlLineView raw={content ?? null} />
        )}
      </div>
    </details>
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

function JsonCard({ value }: { value: unknown }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/50">
      <JsonlLineView raw={value} />
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageKey(message: unknown, index: number): string {
  const body = asRecord(message);
  return typeof body?.id === "string" ? body.id : `message-${index}`;
}

function jsonKey(value: unknown, index: number): string {
  const body = asRecord(value);
  return typeof body?.id === "string" ? body.id : `json-${index}`;
}
