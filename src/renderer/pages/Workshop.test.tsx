// [LAW:dataflow-not-control-flow] The Workshop page's view selection
// is a one-line projection of the URL search params. These tests pin
// the coercion at the boundary: both "key absent" (null) and "key
// present with no value" (empty string) collapse to "no selection",
// and any non-empty value selects the detail view.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the heavy children so the page test isolates the view-selection
// logic. The real components have their own dedicated unit tests.
vi.mock("../components/WorkshopLaunchList", () => ({
  WorkshopLaunchList: () => <div data-testid="stub-list" />,
}));
vi.mock("../components/WorkshopLaunchDetail", () => ({
  WorkshopLaunchDetail: ({ launchId }: { launchId: string }) => (
    <div data-testid="stub-detail" data-launch-id={launchId} />
  ),
}));
vi.mock("../components/LaunchToolDialog", () => ({
  LaunchToolDialog: () => <div data-testid="stub-dialog" />,
}));

import { installElectronMock } from "../../test/electron-mock";
import { Workshop } from "./Workshop";

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/workshop" element={<Workshop />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  installElectronMock();
});

describe("Workshop page — view selection", () => {
  it("renders the list when launchId is absent", () => {
    renderAt("/workshop");
    expect(screen.getByTestId("stub-list")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-detail")).toBeNull();
  });

  it("renders the list when launchId is present but empty (?launchId=)", () => {
    // URLSearchParams.get returns "" (not null) when the key has no
    // value. Without the boundary coercion the page would route the
    // empty string into <WorkshopLaunchDetail launchId="">, which then
    // shows "Launch not found" — a confusing dead-end for the user.
    renderAt("/workshop?launchId=");
    expect(screen.getByTestId("stub-list")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-detail")).toBeNull();
  });

  it("renders the detail view when launchId is non-empty", () => {
    renderAt("/workshop?launchId=L-1");
    expect(screen.queryByTestId("stub-list")).toBeNull();
    const detail = screen.getByTestId("stub-detail");
    expect(detail.getAttribute("data-launch-id")).toBe("L-1");
  });
});
