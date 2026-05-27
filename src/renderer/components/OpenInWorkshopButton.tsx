// Cross-tab deep link into the Workshop detail view. Mirrors
// OpenPaneButton's shape: read launchId off the surface (either a
// proxy client or a launch row), navigate when the row resolves,
// render nothing when it doesn't.
//
// [LAW:one-source-of-truth] The Workshop detail view keys off
// launchId. Untagged traffic and replays produce no button; pointing
// at "the first launch" would be wrong, so absence is the correct UI.
//
// [LAW:no-defensive-null-guards] Two entry shapes, one resolution:
// the caller hands either a clientId (Live's RequestDetail) or a
// launchId (Loops' PaneViewer). Both resolve to a launchId or null,
// and the button renders only when the lookup resolves.

import { useNavigate } from "react-router";
import type { LaunchId } from "../../shared/types";
import { useLaunchStore } from "../store/launches";
import { useProxyStore } from "../store/proxy";
import { launchDetailRoute } from "./WorkshopLaunchList";

interface FromClient {
  readonly clientId: string;
}
interface FromLaunch {
  readonly launchId: LaunchId;
}

export function OpenInWorkshopButton(props: FromClient | FromLaunch) {
  const launchId = useProxyStore((s) =>
    "clientId" in props
      ? (s.clients.get(props.clientId)?.launchId ?? null)
      : props.launchId,
  );
  // For the launch-direct entry, also verify the registry has the row
  // so we don't ship a deep link to a stale id. The lookup is cheap
  // and the failure mode (button on a vanished launch) is worth
  // closing.
  const launch = useLaunchStore((s) =>
    launchId === null ? undefined : s.byId(launchId),
  );
  const navigate = useNavigate();
  if (launch === undefined) return null;

  return (
    <button
      data-testid="open-in-workshop-button"
      type="button"
      onClick={() => navigate(launchDetailRoute(launch.launchId))}
      className="shrink-0 rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-violet-500 hover:bg-neutral-700 hover:text-violet-200"
      title={`Open launch ${launch.launchId} in Workshop`}
    >
      Open in Workshop
    </button>
  );
}
