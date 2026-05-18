import { signal, type Signal } from "./signals";
import type { WaylandWindow } from "./types";

export type WindowStateDefault<T> = T | ((window: WaylandWindow) => T);

export type WindowStateKey<T> = symbol & {
  readonly __windowStateValue?: T;
};

export interface WindowStateMetadata<T> {
  id: string;
  defaultValue?: WindowStateDefault<T>;
}

export type WindowStateStore = {
  readonly [key: symbol]: Signal<any>;
};

type WindowStateSignals = Map<symbol, Signal<unknown>>;

const signalsByWindowId = new Map<string, WindowStateSignals>();
const metadataByKey = new Map<symbol, WindowStateMetadata<unknown>>();

export function createWindowState<T>(
  id: string,
): WindowStateKey<T | undefined>;
export function createWindowState<T>(
  id: string,
  options: { default: WindowStateDefault<T> },
): WindowStateKey<T>;
export function createWindowState<T>(
  id: string,
  options?: { default: WindowStateDefault<T> },
): WindowStateKey<T | undefined> {
  const key = Symbol(id) as WindowStateKey<T | undefined>;
  metadataByKey.set(key, { id, defaultValue: options?.default });
  return key;
}

export function createWindowStateStore(getWindow: () => WaylandWindow): WindowStateStore {
  return new Proxy(Object.create(null) as WindowStateStore, {
    get(_target, property) {
      if (typeof property !== "symbol") {
        return undefined;
      }

      const metadata = windowStateMetadata(property);
      if (!metadata) {
        return undefined;
      }

      const window = getWindow();
      let signals = signalsByWindowId.get(window.id);
      if (!signals) {
        signals = new Map();
        signalsByWindowId.set(window.id, signals);
      }

      let existing = signals.get(property);
      if (!existing) {
        existing = signal(resolveInitialValue(window, metadata));
        signals.set(property, existing);
      }

      return existing;
    },
  });
}

export function dropWindowState(windowId: string): void {
  signalsByWindowId.delete(windowId);
}

function windowStateMetadata<T>(
  key: symbol,
): WindowStateMetadata<T> | undefined {
  return metadataByKey.get(key) as WindowStateMetadata<T> | undefined;
}

function resolveInitialValue<T>(
  window: WaylandWindow,
  metadata: WindowStateMetadata<T>,
): T | undefined {
  const defaultValue = metadata.defaultValue;
  if (typeof defaultValue === "function") {
    return (defaultValue as (window: WaylandWindow) => T)(window);
  }
  return defaultValue;
}
