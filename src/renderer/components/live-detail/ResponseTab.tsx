// [LAW:single-enforcer] Response content blocks render through the same
// registry as Request/Diff messages — see blocks.tsx.
import type { RequestRecord } from "../../../shared/proxy-events";
import { blockKey, renderBlock } from "./blocks";

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
          <div key={blockKey(block, index)}>
            {renderBlock(block, { index })}
          </div>
        ))
      )}
    </div>
  );
}
