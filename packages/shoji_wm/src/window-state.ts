import { signal, type Signal } from "./signals";
import type { WaylandWindow } from "./types";

export type WindowStateDefault<T> = T | ((window: WaylandWindow) => T);

/** A typed symbol used to address per-window state via `window.state`. / `window.state` 経由でウィンドウごとの状態にアクセスするための型付きシンボル。 */
export type WindowStateKey<T> = symbol & {
  readonly __windowStateValue?: T;
};

export interface WindowStateMetadata<T> {
  id: string;
  defaultValue?: WindowStateDefault<T>;
}

/**
 * A proxy object keyed by `WindowStateKey<T>` symbols. Indexing with a key
 * returns a `Signal<T>` scoped to the given window and lazily initialized with
 * the key's default value.
 * `WindowStateKey<T>` シンボルをキーとするプロキシオブジェクト。キーでインデックスすると、
 * そのウィンドウにスコープされ、キーのデフォルト値で遅延初期化された `Signal<T>` を返します。
 *
 * @example
 * ```ts
 * const isMinimized = createWindowState("minimized", { default: false });
 * // inside composition:
 * const minimized = window.state[isMinimized]; // Signal<boolean>
 * minimized.value; // false initially
 * ```
 */
export type WindowStateStore = {
  readonly [key: symbol]: Signal<any>;
};

type WindowStateSignals = Map<symbol, Signal<unknown>>;

const signalsByWindowId = new Map<string, WindowStateSignals>();
const metadataByKey = new Map<symbol, WindowStateMetadata<unknown>>();

/**
 * Declare a named per-window reactive state slot. Call once at module scope to
 * create a stable key; then access the state for any window via
 * `window.state[key]` which returns a `Signal<T>`.
 * 名前付きのウィンドウごとのリアクティブな状態スロットを宣言します。モジュールスコープで
 * 1 回呼んで安定したキーを作成し、`window.state[key]` 経由で任意のウィンドウの
 * 状態（`Signal<T>` として）にアクセスします。
 *
 * The optional `default` can be a value or a factory `(window) => value` for
 * window-dependent initial values.
 * オプションの `default` には値または `(window) => value` ファクトリーを渡せます。
 *
 * @example
 * ```ts
 * // Module scope — creates the key once
 * const isMinimized = createWindowState("minimized", { default: false });
 *
 * // In composition
 * COMPOSITOR.window.composition = (window) => {
 *   const minimized = window.state[isMinimized]; // Signal<boolean>
 *   return <ManagedWindow visible={minimized((v) => !v)} ... />;
 * };
 *
 * // From an event handler
 * COMPOSITOR.event.onFocus((window) => {
 *   window.state[isMinimized].set(false);
 * });
 * ```
 */
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
