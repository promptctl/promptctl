// [LAW:single-enforcer] One factory for @testing-library/user-event in
// renderer tests. Every `setup()` and every direct `userEvent.click(...)` in
// the renderer suite routes through here.
//
// [LAW:dataflow-not-control-flow] `userEvent.setup()` defaults to `delay: 0`,
// which inserts a real `setTimeout(0)` between every synthetic event in an
// interaction (one click expands to ~11 pointer/mouse events). Under 6-way
// parallel vitest workers each timer slips 10–100ms under CPU contention, so
// a chain of clicks that takes 200ms in isolation can drift past the 5s
// test budget — without anything deadlocking, with no state leak, with no
// fix you can find by reading the test. The bug lives in the timing.
//
// `delay: null` makes every interaction microtask-driven (`Promise.resolve()`
// instead of `setTimeout`), so test wall-time stops depending on scheduler
// fairness. That's the constraint this module exists to enforce: renderer
// tests must not be wall-clock dependent. New tests inherit the constraint
// by importing `setupUser` instead of calling `userEvent.setup()` directly.
import userEvent, { type UserEvent } from "@testing-library/user-event";

type SetupOptions = Parameters<typeof userEvent.setup>[0];

export function setupUser(options?: SetupOptions): UserEvent {
  return userEvent.setup({ delay: null, ...options });
}
