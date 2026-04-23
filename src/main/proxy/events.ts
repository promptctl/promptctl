// [LAW:single-enforcer] All ProxyEvents in the main process flow through this
// bus. Subscribers (HAR recorder, IPC broadcaster, in-memory log) attach here.
// [LAW:one-source-of-truth] Module-scope singleton; no second bus exists.
import { EventEmitter } from "node:events";

import type { ProxyEvent } from "../../shared/proxy-events";

const EVENT_NAME = "event";

class ProxyEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // The default limit (10) is fine for our subscriber count (HAR recorder,
    // IPC broadcaster, in-memory log buffer = 3) but bump it slightly so
    // adding a fourth subscriber later doesn't trigger a warning.
    this.emitter.setMaxListeners(32);
  }

  emit(event: ProxyEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  // Returns an unsubscribe function (idiomatic; matches Zustand stores
  // and DOM EventTarget patterns elsewhere in the app).
  subscribe(handler: (event: ProxyEvent) => void): () => void {
    this.emitter.on(EVENT_NAME, handler);
    return () => this.emitter.off(EVENT_NAME, handler);
  }
}

export const proxyEventBus = new ProxyEventBus();
