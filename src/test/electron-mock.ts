// [LAW:single-enforcer] One factory for mocking window.electronAPI in renderer tests.
import { vi, type Mock } from "vitest";

/**
 * Mock implementation of window.electronAPI for renderer tests.
 *
 * Use `installElectronMock()` in beforeEach to attach a fresh mock to globalThis.window.
 * Each call returns the same `invoke` mock so tests can configure handlers per test:
 *
 *   const api = installElectronMock();
 *   api.invoke.mockImplementation(async (channel, ...args) => {
 *     if (channel === "session:undo") return "v1 content";
 *     return undefined;
 *   });
 *
 * Reset between tests by calling `installElectronMock()` again (it overwrites).
 */
export interface MockElectronAPI {
  invoke: Mock;
  send: Mock;
  on: Mock;
  writeClipboard: Mock;
  // Map of channel → listeners for `on` testing helpers
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  /** Trigger an `on` listener manually (simulates main → renderer event). */
  emit: (channel: string, ...args: unknown[]) => void;
}

export function installElectronMock(): MockElectronAPI {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const mock: MockElectronAPI = {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
      return () => {
        const current = listeners.get(channel) ?? [];
        listeners.set(
          channel,
          current.filter((l) => l !== listener),
        );
      };
    }),
    writeClipboard: vi.fn(),
    listeners,
    emit: (channel: string, ...args: unknown[]) => {
      const list = listeners.get(channel) ?? [];
      for (const listener of list) listener(...args);
    },
  };

  // Assigning to global window for tests
  if (!globalThis.window) {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  }
  (globalThis.window as unknown as { electronAPI: MockElectronAPI }).electronAPI = mock;

  return mock;
}

/**
 * Configure invoke to return values per channel.
 * Pass a record mapping channel → handler. Unmapped channels return undefined.
 */
export function setInvokeHandlers(
  api: MockElectronAPI,
  handlers: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>,
): void {
  api.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel];
    if (!handler) return undefined;
    return await handler(...args);
  });
}
