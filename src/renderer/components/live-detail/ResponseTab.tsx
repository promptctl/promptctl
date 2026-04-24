import type {
  AnthropicContentBlock,
  RequestRecord,
} from "../../../shared/proxy-events";
import { JsonlLineView } from "../jsonl-view/JsonlLineView";

export function ResponseTab({ record }: { record: RequestRecord }) {
  const blocks = record.assembledResponse?.content ?? [];
  return (
    <div className="space-y-3 p-4">
      {blocks.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-500">
          (no content yet - request still streaming or assembly failed)
        </div>
      ) : (
        blocks.map((block, index) => (
          <ContentBlock
            key={blockKey(block, index)}
            block={block}
            index={index}
          />
        ))
      )}
    </div>
  );
}

function ContentBlock({
  block,
  index,
}: {
  block: AnthropicContentBlock;
  index: number;
}) {
  if (isTextBlock(block)) {
    return (
      <section className="rounded border border-neutral-800 bg-neutral-950">
        <h3 className="border-b border-neutral-900 px-3 py-2 text-xs font-medium text-neutral-500">
          text #{index}
        </h3>
        <pre className="whitespace-pre-wrap p-3 text-sm text-neutral-200">
          {block.text}
        </pre>
      </section>
    );
  }
  if (isToolUseBlock(block)) {
    return (
      <section className="rounded border border-neutral-800 bg-neutral-950">
        <h3 className="border-b border-neutral-900 px-3 py-2 text-xs font-medium text-neutral-500">
          tool_use - <span className="text-neutral-200">{block.name}</span>
        </h3>
        <JsonlLineView raw={block.input} />
      </section>
    );
  }
  return (
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <h3 className="border-b border-neutral-900 px-3 py-2 text-xs font-medium text-neutral-500">
        {block.type} #{index}
      </h3>
      <JsonlLineView raw={block} />
    </section>
  );
}

function blockKey(block: AnthropicContentBlock, index: number): string {
  const id = "id" in block ? block.id : null;
  return typeof id === "string" ? id : `${block.type}-${index}`;
}

function isTextBlock(
  block: AnthropicContentBlock,
): block is { type: "text"; text: string } {
  return block.type === "text" && typeof block.text === "string";
}

function isToolUseBlock(block: AnthropicContentBlock): block is {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
} {
  return (
    block.type === "tool_use" &&
    "name" in block &&
    typeof block.name === "string" &&
    "input" in block &&
    typeof block.input === "object" &&
    block.input !== null &&
    !Array.isArray(block.input)
  );
}
