import type { OutputInfo, WaylandLayer, WaylandWindow } from "./types";

export type WindowOpenListener = (window: WaylandWindow) => void;
export type WindowInitialConfigureListener = (window: WaylandWindow) => void;
export type WindowFirstCommitListener = (window: WaylandWindow) => void;
export type WindowCloseListener = (window: WaylandWindow) => void;
export type WindowFocusListener = (
  window: WaylandWindow,
  focused: boolean,
) => void;
export type WindowStartCloseListener = (window: WaylandWindow) => void;
export type LayerCreateListener = (layer: WaylandLayer) => void;
export type LayerUpdateListener = (layer: WaylandLayer) => void;
export type LayerDestroyListener = (layer: WaylandLayer) => void;
export type RuntimeLifecycleReason = "initial" | "reload" | "shutdown";

export type RuntimePersistedState = Record<string, unknown>;

export interface RuntimeEnableEvent {
  readonly reason: Extract<RuntimeLifecycleReason, "initial" | "reload">;
  readonly isReloading: boolean;
  restore<T>(key: string): T | undefined;
  has(key: string): boolean;
}

export interface RuntimeDisableEvent {
  readonly reason: Extract<RuntimeLifecycleReason, "reload" | "shutdown">;
  readonly isReloading: boolean;
  persist<T>(key: string, value: T): void;
  delete(key: string): void;
}

export type RuntimeEnableListener = (event: RuntimeEnableEvent) => void;
export type RuntimeDisableListener = (event: RuntimeDisableEvent) => void;

export interface OutputChangeEvent {
  outputs: OutputInfo[];
  current: Record<string, OutputInfo>;
  added: OutputInfo[];
  removed: OutputInfo[];
  changed: OutputInfo[];
}

export type OutputChangeListener = (event: OutputChangeEvent) => void;

export interface WindowResizeEdges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

export interface WindowResizePoint {
  x: number;
  y: number;
}

export interface WindowResizeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowResizeSource = "ssd" | "client-csd" | "xwayland";
export type WindowResizePhase = "start" | "update" | "end" | "cancel";

export interface WindowResizeEvent {
  window: WaylandWindow;
  source: WindowResizeSource;
  phase: WindowResizePhase;
  edges: WindowResizeEdges;
  startPointer: WindowResizePoint;
  currentPointer: WindowResizePoint;
  delta: WindowResizePoint;
  startRect: WindowResizeRect;
  currentRect: WindowResizeRect;
  outputName?: string;
  timestamp: number;
}

export type WindowResizeListener = (event: WindowResizeEvent) => void;

export type RuntimeWindowResizeEvent = Omit<WindowResizeEvent, "window">;

export interface WindowMovePoint {
  x: number;
  y: number;
}

export interface WindowMoveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowMoveSource = "ssd" | "modifier" | "client-csd" | "xwayland";
export type WindowMovePhase = "start" | "update" | "end" | "cancel";

export interface WindowMoveEvent {
  window: WaylandWindow;
  source: WindowMoveSource;
  phase: WindowMovePhase;
  startPointer: WindowMovePoint;
  currentPointer: WindowMovePoint;
  delta: WindowMovePoint;
  startRect: WindowMoveRect;
  currentRect: WindowMoveRect;
  outputName?: string;
  timestamp: number;
}

export type WindowMoveListener = (event: WindowMoveEvent) => void;

export type RuntimeWindowMoveEvent = Omit<WindowMoveEvent, "window">;

export type WindowStateRequestSource =
  | "api"
  | "client-csd"
  | "xwayland"
  | "keybind";
export type WindowActivateRequestSource =
  | "api"
  | "xdg-activation"
  | "xwayland"
  | "keybind";

export interface WindowMaximizeRequestEvent {
  window: WaylandWindow;
  maximized: boolean;
  source: WindowStateRequestSource;
  timestamp: number;
}

export type WindowMaximizeRequestListener = (
  event: WindowMaximizeRequestEvent,
) => void;

export type RuntimeWindowMaximizeRequestEvent = Omit<
  WindowMaximizeRequestEvent,
  "window"
>;

export interface WindowMinimizeRequestEvent {
  window: WaylandWindow;
  minimized: boolean;
  source: WindowStateRequestSource;
  timestamp: number;
}

export type WindowMinimizeRequestListener = (
  event: WindowMinimizeRequestEvent,
) => void;

export type RuntimeWindowMinimizeRequestEvent = Omit<
  WindowMinimizeRequestEvent,
  "window"
>;

export interface WindowActivateRequestEvent {
  window: WaylandWindow;
  source: WindowActivateRequestSource;
  timestamp: number;
}

export type WindowActivateRequestListener = (
  event: WindowActivateRequestEvent,
) => void;

export type RuntimeWindowActivateRequestEvent = Omit<
  WindowActivateRequestEvent,
  "window"
>;

export interface PointerMovePoint {
  x: number;
  y: number;
}

export interface PointerModifierState {
  super: boolean;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
}

export interface PointerMoveEvent {
  position: PointerMovePoint;
  delta: PointerMovePoint;
  outputName?: string;
  modifiers: PointerModifierState;
  timestamp: number;
}

export type PointerMoveAsyncListener = (
  event: PointerMoveEvent,
) => void | Promise<void>;

export interface RuntimeEventConfig {
  pointerMoveAsync: boolean;
}

export interface WindowManagerEventController {
  onEnable(listener: RuntimeEnableListener): () => void;
  onDisable(listener: RuntimeDisableListener): () => void;
  onOpen(listener: WindowOpenListener): () => void;
  onInitialConfigure(listener: WindowInitialConfigureListener): () => void;
  onFirstCommit(listener: WindowFirstCommitListener): () => void;
  onClose(listener: WindowCloseListener): () => void;
  onFocus(listener: WindowFocusListener): () => void;
  onStartClose(listener: WindowStartCloseListener): () => void;
  onWindowResize(listener: WindowResizeListener): () => void;
  onWindowMove(listener: WindowMoveListener): () => void;
  onWindowMaximizeRequest(listener: WindowMaximizeRequestListener): () => void;
  onWindowMinimizeRequest(listener: WindowMinimizeRequestListener): () => void;
  onWindowActivateRequest(listener: WindowActivateRequestListener): () => void;
  onOutputChange(listener: OutputChangeListener): () => void;
  onPointerMoveAsync(listener: PointerMoveAsyncListener): () => void;
  onCreateLayer(listener: LayerCreateListener): () => void;
  onUpdateLayer(listener: LayerUpdateListener): () => void;
  onDestroyLayer(listener: LayerDestroyListener): () => void;
  emitOpen(window: WaylandWindow): void;
  emitInitialConfigure(window: WaylandWindow): void;
  emitFirstCommit(window: WaylandWindow): void;
  emitClose(window: WaylandWindow): void;
  emitFocus(window: WaylandWindow, focused: boolean): void;
  emitStartClose(window: WaylandWindow): void;
  emitWindowResize(
    window: WaylandWindow,
    event: RuntimeWindowResizeEvent,
  ): boolean;
  emitWindowMove(window: WaylandWindow, event: RuntimeWindowMoveEvent): boolean;
  emitWindowMaximizeRequest(
    window: WaylandWindow,
    event: RuntimeWindowMaximizeRequestEvent,
  ): boolean;
  emitWindowMinimizeRequest(
    window: WaylandWindow,
    event: RuntimeWindowMinimizeRequestEvent,
  ): boolean;
  emitWindowActivateRequest(
    window: WaylandWindow,
    event: RuntimeWindowActivateRequestEvent,
  ): boolean;
  emitOutputChange(event: OutputChangeEvent): void;
  emitPointerMoveAsync(event: PointerMoveEvent): Promise<boolean>;
  emitCreateLayer(layer: WaylandLayer): void;
  emitUpdateLayer(layer: WaylandLayer): void;
  emitDestroyLayer(layer: WaylandLayer): void;
  emitEnable(
    reason: RuntimeEnableEvent["reason"],
    state?: RuntimePersistedState,
  ): void;
  emitDisable(reason: RuntimeDisableEvent["reason"]): RuntimePersistedState;
  takePendingEventConfig(): RuntimeEventConfig | undefined;
}

export function createWindowManagerEventController(): WindowManagerEventController {
  const enableListeners = new Set<RuntimeEnableListener>();
  const disableListeners = new Set<RuntimeDisableListener>();
  const openListeners = new Set<WindowOpenListener>();
  const initialConfigureListeners = new Set<WindowInitialConfigureListener>();
  const firstCommitListeners = new Set<WindowFirstCommitListener>();
  const closeListeners = new Set<WindowCloseListener>();
  const focusListeners = new Set<WindowFocusListener>();
  const startCloseListeners = new Set<WindowStartCloseListener>();
  const resizeListeners = new Set<WindowResizeListener>();
  const moveListeners = new Set<WindowMoveListener>();
  const maximizeRequestListeners = new Set<WindowMaximizeRequestListener>();
  const minimizeRequestListeners = new Set<WindowMinimizeRequestListener>();
  const activateRequestListeners = new Set<WindowActivateRequestListener>();
  const outputChangeListeners = new Set<OutputChangeListener>();
  const pointerMoveAsyncListeners = new Set<PointerMoveAsyncListener>();
  const createLayerListeners = new Set<LayerCreateListener>();
  const updateLayerListeners = new Set<LayerUpdateListener>();
  const destroyLayerListeners = new Set<LayerDestroyListener>();
  let pendingEventConfig = false;

  function markEventConfigDirty(): void {
    pendingEventConfig = true;
  }

  return {
    onEnable(listener) {
      enableListeners.add(listener);
      return () => enableListeners.delete(listener);
    },
    onDisable(listener) {
      disableListeners.add(listener);
      return () => disableListeners.delete(listener);
    },
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    onInitialConfigure(listener) {
      initialConfigureListeners.add(listener);
      return () => initialConfigureListeners.delete(listener);
    },
    onFirstCommit(listener) {
      firstCommitListeners.add(listener);
      return () => firstCommitListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onFocus(listener) {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    onStartClose(listener) {
      startCloseListeners.add(listener);
      return () => startCloseListeners.delete(listener);
    },
    onWindowResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    onWindowMove(listener) {
      moveListeners.add(listener);
      return () => moveListeners.delete(listener);
    },
    onWindowMaximizeRequest(listener) {
      maximizeRequestListeners.add(listener);
      return () => maximizeRequestListeners.delete(listener);
    },
    onWindowMinimizeRequest(listener) {
      minimizeRequestListeners.add(listener);
      return () => minimizeRequestListeners.delete(listener);
    },
    onWindowActivateRequest(listener) {
      activateRequestListeners.add(listener);
      return () => activateRequestListeners.delete(listener);
    },
    onOutputChange(listener) {
      outputChangeListeners.add(listener);
      return () => outputChangeListeners.delete(listener);
    },
    onPointerMoveAsync(listener) {
      pointerMoveAsyncListeners.add(listener);
      markEventConfigDirty();
      return () => {
        pointerMoveAsyncListeners.delete(listener);
        markEventConfigDirty();
      };
    },
    onCreateLayer(listener) {
      createLayerListeners.add(listener);
      return () => createLayerListeners.delete(listener);
    },
    onUpdateLayer(listener) {
      updateLayerListeners.add(listener);
      return () => updateLayerListeners.delete(listener);
    },
    onDestroyLayer(listener) {
      destroyLayerListeners.add(listener);
      return () => destroyLayerListeners.delete(listener);
    },
    emitOpen(window) {
      for (const listener of openListeners) {
        listener(window);
      }
    },
    emitInitialConfigure(window) {
      for (const listener of initialConfigureListeners) {
        listener(window);
      }
    },
    emitFirstCommit(window) {
      for (const listener of firstCommitListeners) {
        listener(window);
      }
    },
    emitClose(window) {
      for (const listener of closeListeners) {
        listener(window);
      }
    },
    emitFocus(window, focused) {
      for (const listener of focusListeners) {
        listener(window, focused);
      }
    },
    emitStartClose(window) {
      for (const listener of startCloseListeners) {
        listener(window);
      }
    },
    emitWindowResize(window, event) {
      if (resizeListeners.size === 0) {
        return false;
      }
      for (const listener of resizeListeners) {
        listener({ ...event, window });
      }
      return true;
    },
    emitWindowMove(window, event) {
      if (moveListeners.size === 0) {
        return false;
      }
      for (const listener of moveListeners) {
        listener({ ...event, window });
      }
      return true;
    },
    emitWindowMaximizeRequest(window, event) {
      if (maximizeRequestListeners.size === 0) {
        return false;
      }
      for (const listener of maximizeRequestListeners) {
        listener({ ...event, window });
      }
      return true;
    },
    emitWindowMinimizeRequest(window, event) {
      if (minimizeRequestListeners.size === 0) {
        return false;
      }
      for (const listener of minimizeRequestListeners) {
        listener({ ...event, window });
      }
      return true;
    },
    emitWindowActivateRequest(window, event) {
      if (activateRequestListeners.size === 0) {
        return false;
      }
      for (const listener of activateRequestListeners) {
        listener({ ...event, window });
      }
      return true;
    },
    emitOutputChange(event) {
      for (const listener of outputChangeListeners) {
        listener(event);
      }
    },
    async emitPointerMoveAsync(event) {
      if (pointerMoveAsyncListeners.size === 0) {
        return false;
      }
      for (const listener of pointerMoveAsyncListeners) {
        await listener(event);
      }
      return true;
    },
    emitCreateLayer(layer) {
      for (const listener of createLayerListeners) {
        listener(layer);
      }
    },
    emitUpdateLayer(layer) {
      for (const listener of updateLayerListeners) {
        listener(layer);
      }
    },
    emitDestroyLayer(layer) {
      for (const listener of destroyLayerListeners) {
        listener(layer);
      }
    },
    emitEnable(reason, state = {}) {
      const snapshot = { ...state };
      const event: RuntimeEnableEvent = {
        reason,
        isReloading: reason === "reload",
        restore(key) {
          return snapshot[key] as never;
        },
        has(key) {
          return Object.prototype.hasOwnProperty.call(snapshot, key);
        },
      };
      for (const listener of enableListeners) {
        listener(event);
      }
    },
    emitDisable(reason) {
      const next: RuntimePersistedState = {};
      const event: RuntimeDisableEvent = {
        reason,
        isReloading: reason === "reload",
        persist(key, value) {
          next[key] = value;
        },
        delete(key) {
          delete next[key];
        },
      };
      for (const listener of disableListeners) {
        listener(event);
      }
      return next;
    },
    takePendingEventConfig() {
      if (!pendingEventConfig) {
        return undefined;
      }
      pendingEventConfig = false;
      return {
        pointerMoveAsync: pointerMoveAsyncListeners.size > 0,
      };
    },
  };
}
