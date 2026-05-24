// [LAW:single-enforcer] One factory for mocking window.electronAPI in renderer tests.
import { vi, type Mock } from "vitest";

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * Mock implementation of window.electronAPI for renderer tests.
 *
 * `installElectronMock()` attaches a fresh mock to globalThis.window. The mock
 * owns a shared `handlers` map; `api.invoke` looks up `handlers[channel]` at
 * call time, so later `setInvokeHandlers` calls transparently take effect.
 *
 * Reset between tests by calling `installElectronMock()` again (it overwrites).
 */
export interface MockElectronAPI {
  invoke: Mock;
  send: Mock;
  on: Mock;
  writeClipboard: Mock;
  /** Channel → handler. `setInvokeHandlers` merges into this map. */
  handlers: Record<string, Handler>;
  // Map of channel → listeners for `on` testing helpers
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
  /** Trigger an `on` listener manually (simulates main → renderer event). */
  emit: (channel: string, ...args: unknown[]) => void;
}

export function installElectronMock(): MockElectronAPI {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const handlers: Record<string, Handler> = {};

  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel];
    if (!handler) return undefined;
    return await handler(...args);
  });

  const mock: MockElectronAPI = {
    invoke,
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
    handlers,
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
  (
    globalThis.window as unknown as { electronAPI: MockElectronAPI }
  ).electronAPI = mock;

  return mock;
}

/**
 * Register IPC handlers on the mock. Additive: handlers are merged onto any
 * previously registered ones (later keys override earlier ones), so `beforeEach`
 * can register baseline handlers and individual tests layer specific ones on top.
 *
 *   const api = installElectronMock();
 *   setInvokeHandlers(api, { "settings:load": () => defaults });
 *   setInvokeHandlers(api, { "session:undo": () => newMessages }); // keeps settings:load
 */
export function setInvokeHandlers(
  api: MockElectronAPI,
  handlers: Record<string, Handler>,
): void {
  Object.assign(api.handlers, handlers);
}
