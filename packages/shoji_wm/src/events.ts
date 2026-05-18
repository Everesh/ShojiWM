import type { WaylandLayer, WaylandWindow } from "./types";

export type WindowOpenListener = (window: WaylandWindow) => void;
export type WindowCloseListener = (window: WaylandWindow) => void;
export type WindowFocusListener = (window: WaylandWindow, focused: boolean) => void;
export type WindowStartCloseListener = (window: WaylandWindow) => void;
export type LayerCreateListener = (layer: WaylandLayer) => void;
export type LayerDestroyListener = (layer: WaylandLayer) => void;

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

export interface WindowManagerEventController {
  onOpen(listener: WindowOpenListener): () => void;
  onClose(listener: WindowCloseListener): () => void;
  onFocus(listener: WindowFocusListener): () => void;
  onStartClose(listener: WindowStartCloseListener): () => void;
  onWindowResize(listener: WindowResizeListener): () => void;
  onWindowMove(listener: WindowMoveListener): () => void;
  onCreateLayer(listener: LayerCreateListener): () => void;
  onDestroyLayer(listener: LayerDestroyListener): () => void;
  emitOpen(window: WaylandWindow): void;
  emitClose(window: WaylandWindow): void;
  emitFocus(window: WaylandWindow, focused: boolean): void;
  emitStartClose(window: WaylandWindow): void;
  emitWindowResize(window: WaylandWindow, event: RuntimeWindowResizeEvent): boolean;
  emitWindowMove(window: WaylandWindow, event: RuntimeWindowMoveEvent): boolean;
  emitCreateLayer(layer: WaylandLayer): void;
  emitDestroyLayer(layer: WaylandLayer): void;
}

export function createWindowManagerEventController(): WindowManagerEventController {
  const openListeners = new Set<WindowOpenListener>();
  const closeListeners = new Set<WindowCloseListener>();
  const focusListeners = new Set<WindowFocusListener>();
  const startCloseListeners = new Set<WindowStartCloseListener>();
  const resizeListeners = new Set<WindowResizeListener>();
  const moveListeners = new Set<WindowMoveListener>();
  const createLayerListeners = new Set<LayerCreateListener>();
  const destroyLayerListeners = new Set<LayerDestroyListener>();

  return {
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
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
    onCreateLayer(listener) {
      createLayerListeners.add(listener);
      return () => createLayerListeners.delete(listener);
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
    emitCreateLayer(layer) {
      for (const listener of createLayerListeners) {
        listener(layer);
      }
    },
    emitDestroyLayer(layer) {
      for (const listener of destroyLayerListeners) {
        listener(layer);
      }
    },
  };
}
