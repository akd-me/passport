import type { DomainEvent, EventBus } from "@passport/types";
import { logger } from "./logger.js";

type Handler = (event: DomainEvent) => void;

/** Synchronous, in-process fan-out. Unsubscribe functions are idempotent. */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<DomainEvent["type"], Set<Handler>>();
  private readonly anyHandlers = new Set<Handler>();

  on<T extends DomainEvent["type"]>(
    type: T,
    handler: (event: Extract<DomainEvent, { type: T }>) => void,
  ): () => void {
    let handlers = this.handlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(type, handlers);
    }
    // A wrapper keeps separate subscriptions independent even for the same callback.
    const callback: Handler = (event) => handler(event as Extract<DomainEvent, { type: T }>);
    handlers.add(callback);
    return () => {
      handlers.delete(callback);
      if (handlers.size === 0 && this.handlers.get(type) === handlers) {
        this.handlers.delete(type);
      }
    };
  }

  onAny(handler: Handler): () => void {
    const callback: Handler = (event) => handler(event);
    this.anyHandlers.add(callback);
    return () => {
      this.anyHandlers.delete(callback);
    };
  }

  emit(event: DomainEvent): void {
    // Snapshot both sets before dispatch, so subscription changes affect the next emit.
    const callbacks = [...(this.handlers.get(event.type) ?? []), ...this.anyHandlers];
    for (const callback of callbacks) {
      try {
        // The interface is synchronous; also isolate rejections from async consumers.
        const result: unknown = callback(event);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(result).catch(() =>
            logger.error("Event handler rejected", { eventType: event.type }),
          );
        }
      } catch {
        logger.error("Event handler failed", { eventType: event.type });
      }
    }
  }
}
