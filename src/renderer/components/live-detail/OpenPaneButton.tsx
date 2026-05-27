// [LAW:one-source-of-truth] The launchId on ClientInfo is the foreign
// key into the launch registry; paneId is projected from the launch
// row. No parallel paneId lookup, no fallback when the projection
// resolves to nothing — absence of a pane to open is information, not
// an error state to paper over.
//
// [LAW:no-defensive-null-guards] Render nothing when there is no
// paneId to focus. Both legitimate paths land here:
//   - untagged traffic (no launchId) — there is no pane to point at
//   - replay (synthetic launchId) — there is no live pane to point at
// The absence of the button is the correct UI for both.
import { useNavigate } from "react-router";
import { useProxyStore } from "../../store/proxy";
import { useLaunchStore } from "../../store/launches";
import { usePaneSelectionStore } from "../../store/pane-selection";

export function OpenPaneButton({ clientId }: { clientId: string }) {
  const launchId = useProxyStore(
    (s) => s.clients.get(clientId)?.launchId ?? null,
  );
  const launch = useLaunchStore((s) =>
    launchId === null ? undefined : s.byId(launchId),
  );
  const navigate = useNavigate();
  if (launch === undefined) return null;

  return (
    <button
      data-testid="open-pane-button"
      type="button"
      onClick={() => {
        usePaneSelectionStore.getState().selectPane(launch.paneId);
        navigate("/loops");
      }}
      className="shrink-0 rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-violet-500 hover:bg-neutral-700 hover:text-violet-200"
      title={`Open pane ${launch.paneId} (${launch.toolKind})`}
    >
      Open pane
    </button>
  );
}
