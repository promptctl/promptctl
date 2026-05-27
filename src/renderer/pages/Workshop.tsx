// Workshop tab — the fifth top-tab. Owns the launch lifecycle.
//
// [LAW:dataflow-not-control-flow] One page, two views, one
// discriminator. Search-param `launchId` selects between the list
// view and the detail view; neither view branches on "is this the
// primary launch" — they project off the registry's data.
//
// [LAW:locality-or-seam] The detail view is a separate component
// behind the launchId seam. Splitting a future view (e.g. "launch
// settings") is one more sub-route, not conditionals inside the
// existing component.

import { useState } from "react";
import { useSearchParams } from "react-router";
import { LaunchToolDialog } from "../components/LaunchToolDialog";
import { WorkshopLaunchList } from "../components/WorkshopLaunchList";
import { WorkshopLaunchDetail } from "../components/WorkshopLaunchDetail";
import type { LaunchId } from "../../shared/types";

export function Workshop() {
  const [searchParams] = useSearchParams();
  const launchId = searchParams.get("launchId");
  const [newLaunchOpen, setNewLaunchOpen] = useState(false);

  return (
    <div className="flex h-full flex-col p-6">
      {launchId === null ? (
        <WorkshopLaunchList onNewLaunch={() => setNewLaunchOpen(true)} />
      ) : (
        <WorkshopLaunchDetail launchId={launchId as LaunchId} />
      )}
      {newLaunchOpen && (
        <LaunchToolDialog onClose={() => setNewLaunchOpen(false)} />
      )}
    </div>
  );
}
