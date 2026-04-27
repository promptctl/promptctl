import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ResizableSplit } from "./ResizableSplit";

beforeEach(() => {
  cleanup();
  // jsdom doesn't implement PointerCapture; stub so onPointerDown doesn't throw.
  const noop = (): void => undefined;
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = noop;
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = noop;
  }
});

describe("ResizableSplit", () => {
  it("renders both children with the sized child constrained to defaultSize", () => {
    render(
      <ResizableSplit
        orientation="horizontal"
        side="before"
        defaultSize={400}
        minSize={100}
        maxSize={800}
        testId="split"
      >
        <div data-testid="left">L</div>
        <div data-testid="right">R</div>
      </ResizableSplit>,
    );
    expect(screen.getByTestId("left")).toBeInTheDocument();
    expect(screen.getByTestId("right")).toBeInTheDocument();
    expect(screen.getByTestId("split-first")).toHaveStyle({ width: "400px" });
    expect(screen.getByTestId("split-second")).not.toHaveStyle({
      width: "400px",
    });
  });

  it("clamps defaultSize into [minSize, maxSize] on mount", () => {
    render(
      <ResizableSplit
        orientation="horizontal"
        side="before"
        defaultSize={50}
        minSize={100}
        maxSize={800}
        testId="split"
      >
        <div>L</div>
        <div>R</div>
      </ResizableSplit>,
    );
    expect(screen.getByTestId("split-first")).toHaveStyle({ width: "100px" });
  });

  it("grows the sized pane when dragged in the +direction with side='before'", () => {
    render(
      <ResizableSplit
        orientation="horizontal"
        side="before"
        defaultSize={400}
        minSize={100}
        maxSize={800}
        testId="split"
      >
        <div>L</div>
        <div>R</div>
      </ResizableSplit>,
    );
    const handle = screen.getByTestId("split-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500, clientY: 0 });
    expect(screen.getByTestId("split-first")).toHaveStyle({ width: "500px" });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 500, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000, clientY: 0 });
    expect(screen.getByTestId("split-first")).toHaveStyle({ width: "500px" });
  });

  it("inverts drag direction with side='after'", () => {
    render(
      <ResizableSplit
        orientation="horizontal"
        side="after"
        defaultSize={400}
        minSize={100}
        maxSize={800}
        testId="split"
      >
        <div>L</div>
        <div>R</div>
      </ResizableSplit>,
    );
    const handle = screen.getByTestId("split-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500, clientY: 0 });
    expect(screen.getByTestId("split-second")).toHaveStyle({ width: "500px" });
  });

  it("clamps drag to maxSize", () => {
    render(
      <ResizableSplit
        orientation="horizontal"
        side="before"
        defaultSize={400}
        minSize={100}
        maxSize={500}
        testId="split"
      >
        <div>L</div>
        <div>R</div>
      </ResizableSplit>,
    );
    const handle = screen.getByTestId("split-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 5000, clientY: 0 });
    expect(screen.getByTestId("split-first")).toHaveStyle({ width: "500px" });
  });

  it("clamps drag to minSize", () => {
    render(
      <ResizableSplit
        orientation="horizontal"
        side="before"
        defaultSize={400}
        minSize={150}
        maxSize={800}
        testId="split"
      >
        <div>L</div>
        <div>R</div>
      </ResizableSplit>,
    );
    const handle = screen.getByTestId("split-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -5000, clientY: 0 });
    expect(screen.getByTestId("split-first")).toHaveStyle({ width: "150px" });
  });

  it("supports vertical orientation by sizing height", () => {
    render(
      <ResizableSplit
        orientation="vertical"
        side="before"
        defaultSize={200}
        minSize={50}
        maxSize={400}
        testId="split"
      >
        <div>top</div>
        <div>bottom</div>
      </ResizableSplit>,
    );
    expect(screen.getByTestId("split-first")).toHaveStyle({ height: "200px" });
    expect(screen.getByTestId("split-handle")).toHaveAttribute(
      "data-orientation",
      "vertical",
    );
    const handle = screen.getByTestId("split-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0, clientY: 250 });
    expect(screen.getByTestId("split-first")).toHaveStyle({ height: "250px" });
  });
});
