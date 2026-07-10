import {
  COMPOSITOR,
  createManagedPoll,
  markManagedWindowDirty,
  read,
  type EasingFunction,
  type PollHandle,
  type WaylandWindow,
  type WindowResizeEvent,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import { playRectAnimation, stopRectAnimation } from "./window_animation";
import type { LayoutOptions, WorkspaceSnapshot, WorkspaceWindowSnapshot } from "./types";
import {
  MANAGED_WINDOW_ONLY_ANIMATION,
  MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION,
  STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION,
  TILE_ANIMATION_DURATION,
  TILE_GAP,
  TILE_MARGIN,
  TILE_MIN_WIDTH,
  TILE_WIDTH_RATIO,
  WINDOW_MANAGEMENT_ANIMATION_DURATION,
  WINDOW_MANAGEMENT_EASING,
  WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE,
  WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY,
  WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY,
  WORKSPACE_KINETIC_SCROLL_STOP_VELOCITY,
  WORKSPACE_KINETIC_SCROLL_TIME_CONSTANT_MS,
  WORKSPACE_SWITCH_ANIMATION_DURATION,
  WORKSPACE_VISUAL_ANIMATION_CHANNEL,
  WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL,
  WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL,
} from "./constants";
import {
  WINDOW_STATE_FLOATING_RECT,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MAXIMIZED,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_RECT,
  WINDOW_STATE_RESTORE_RECT,
  WINDOW_STATE_SNAP_MONITOR,
  WINDOW_STATE_SNAP_ZONE,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_TILED,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
  WINDOW_STATE_WORKSPACE_VISIBLE,
} from "./window_states";
import { clamp, insetRect, managedRectEquals, rectCenterX, snapshotManagedRect } from "./geometry";

// --- Helpers ---

export function hotReloadDebugEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
  const value = env?.SHOJI_HOT_RELOAD_DEBUG;
  return value !== undefined && value !== "" && value !== "0";
}

export function hotReloadDebug(message: string, details: Record<string, unknown> = {}): void {
  if (!hotReloadDebugEnabled()) return;
  console.info(`hot-reload ${message}`, JSON.stringify(details));
}

export function withManagedWindowOnlySSDRebuildSuppressed<T>(
  callback: () => T,
  options: { strict?: boolean } = {},
): T {
  return COMPOSITOR.runtime.withSSDRebuildSuppressed(
    options.strict ? STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION : MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION,
    callback,
  );
}

export function scheduleWorkspaceVisualAnimation(
  window: WaylandWindow,
  fromOffsetY: number,
  toOffsetY: number,
  fromOpacity: number,
  toOpacity: number,
  easing: EasingFunction,
  duration: number,
): void {
  cancelWorkspaceVisualAnimation(window);
  window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
  window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(toOpacity);

  window.scheduleAnimation({
    channel: WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: fromOffsetY, width: 0, height: 0 },
      to: { x: 0, y: toOffsetY, width: 0, height: 0 },
      duration,
      easing,
      mode: "add",
    },
  });
  window.scheduleAnimation({
    channel: WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL,
    opacity: {
      from: fromOpacity,
      to: toOpacity,
      duration,
      easing,
      mode: "override",
    },
  });
}

export function resetWorkspaceVisualState(window: WaylandWindow, visible: boolean): void {
  cancelWorkspaceVisualAnimation(window);
  window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
  window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
  window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
}

export function cancelWorkspaceVisualAnimation(window: WaylandWindow): void {
  window.cancelAnimation(WORKSPACE_VISUAL_ANIMATION_CHANNEL);
  window.cancelAnimation(WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL);
  window.cancelAnimation(WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL);
}

// --- Workspace Class ---

export class Workspace {
  public index: number;
  private readonly windows: WaylandWindow[] = [];
  private readonly naturalRootRect: (window: WaylandWindow) => ManagedWindowRect;
  private readonly maximizedRootRect: (window: WaylandWindow) => ManagedWindowRect;
  private readonly activeWorkspaceIndex: (monitor: string) => number;
  private readonly tileWidthByWindowId = new Map<string, number>();
  private readonly restoredWindowStateById = new Map<string, WorkspaceWindowSnapshot>();
  private activeWindowId: string | null = null;
  private visibilityAnimationToken = 0;
  private draggingWindowId: string | null = null;
  private lastDraggingSlotRect: ManagedWindowRect | null = null;
  private lastAppliedTileViewportRect: ManagedWindowRect | null = null;
  private scrollOffset = 0;
  private kineticScrollPoll: PollHandle | null = null;
  private kineticScrollToken = 0;
  public monitor: string;
  public isTiled = false;

  public constructor(
    index: number,
    monitor: string,
    naturalRootRect: (window: WaylandWindow) => ManagedWindowRect,
    maximizedRootRect: (window: WaylandWindow) => ManagedWindowRect,
    activeWorkspaceIndex: (monitor: string) => number,
  ) {
    this.index = index;
    this.monitor = monitor;
    this.naturalRootRect = naturalRootRect;
    this.maximizedRootRect = maximizedRootRect;
    this.activeWorkspaceIndex = activeWorkspaceIndex;
  }

  public moveToMonitor(monitor: string, index: number) {
    this.monitor = monitor;
    this.index = index;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_FULLSCREEN]()) {
        window.state[WINDOW_STATE_RECT].set(this.fullscreenRootRect(window));
        continue;
      }
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
        continue;
      }

      if (!this.isTiled || !this.shouldTile(window)) {
        const rect = this.clampRectToViewport(window.state[WINDOW_STATE_RECT]());
        window.state[WINDOW_STATE_RECT].set(rect);
        window.state[WINDOW_STATE_FLOATING_RECT].set(
          this.isTiled ? this.viewportRectToFloatingContentRect(rect) : null,
        );
      }
    }
  }

  public addWindow(window: WaylandWindow): boolean {
    if (this.windows.map((window) => window.id).includes(window.id)) {
      hotReloadDebug("workspace-add-existing-skip", { monitor: this.monitor, index: this.index, windowId: window.id });
      return false;
    }
    this.windows.push(window);
    const restored = this.restoredWindowStateById.get(window.id);
    const isTileableInCurrentMode = !this.isTiled || this.shouldTile(window);
    if (!restored && isTileableInCurrentMode) {
      this.activeWindowId = window.id;
    }
    if (restored) {
      window.cancelAnimation();
      this.restoredWindowStateById.delete(window.id);
      window.state[WINDOW_STATE_FLOATING_RECT].set(restored.floatingRect ?? null);
      window.state[WINDOW_STATE_RESTORE_RECT].set(restored.restoreRect ?? null);
      window.state[WINDOW_STATE_SNAP_ZONE].set(restored.snapZone ?? null);
      window.state[WINDOW_STATE_SNAP_MONITOR].set(restored.snapMonitor ?? null);
      window.state[WINDOW_STATE_MINIMIZED].set(restored.minimized);
      window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE].set(restored.minimized);
      window.state[WINDOW_STATE_MAXIMIZED].set(restored.maximized);
      if (restored.tileWidth !== undefined) {
        this.tileWidthByWindowId.set(window.id, restored.tileWidth);
      }
    }
    const visible = this.isActive();
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    this.syncWindowVisibleOutputs(window);

    if (!COMPOSITOR.output.list.includes(this.monitor)) {
      return restored !== undefined;
    }

    if (restored?.floatingRect && !this.isTiled) {
      window.state[WINDOW_STATE_RECT].set(restored.floatingRect);
    } else if (this.isTiled && this.shouldTile(window)) {
      const initialRect = this.centeredFloatingRect(window);
      window.state[WINDOW_STATE_FLOATING_RECT].set(restored?.floatingRect ?? initialRect);
      if (restored?.tileWidth === undefined) {
        this.setTileWidthFromRect(window, initialRect, true);
        this.scrollToWindow(window);
      }
      this.applyLayout({
        suppressSSDRebuild: false,
        animate: restored === undefined,
        preserveMissingActive: restored !== undefined,
      });
    } else if (this.isTiled) {
      const initialRect = this.centeredFloatingRect(window);
      const contentRect = restored?.floatingRect ?? this.viewportRectToFloatingContentRect(initialRect);
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      window.state[WINDOW_STATE_RECT].set(this.floatingContentRectToViewportRect(contentRect));
    } else {
      window.state[WINDOW_STATE_RECT].set(this.centeredFloatingRect(window));
    }
    return restored !== undefined;
  }

  public removeWindow(window: WaylandWindow): WaylandWindow | null | undefined {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index >= 0) {
      this.windows.splice(index, 1);
      this.tileWidthByWindowId.delete(window.id);
      if (this.draggingWindowId === window.id) {
        this.draggingWindowId = null;
        window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
      }
      let nextFocus: WaylandWindow | null = null;
      if (this.activeWindowId === window.id) {
        nextFocus = this.tileableWindows()[Math.min(index, this.tileableWindows().length - 1)] ?? null;
        this.activeWindowId = nextFocus?.id ?? null;
      }
      return nextFocus;
    }
    return undefined;
  }

  public removeTileDragWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) return;
    this.windows.splice(index, 1);
    this.draggingWindowId = null;
  }

  public removeFloatingWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) return;
    this.windows.splice(index, 1);
    if (this.activeWindowId === window.id) {
      this.activeWindowId = this.activeWindow(this.tileableWindows())?.id ?? null;
    }
  }

  public hasWindow(window: WaylandWindow): boolean {
    return this.windows.some((current) => current.id === window.id);
  }

  public windowCount(): number {
    return this.windows.length;
  }

  public listWindows(): WaylandWindow[] {
    return this.windows.slice();
  }

  public findWindowById(windowId: string): WaylandWindow | undefined {
    return this.windows.find((window) => window.id === windowId);
  }

  public isActiveWindowId(windowId: string): boolean {
    return this.activeWindowId === windowId;
  }

  public moveFocusedTile(direction: -1 | 1): boolean {
    if (!this.isTiled) return false;
    const focused = this.focusedWindow();
    if (!focused || !this.shouldTile(focused)) return false;

    const tileable = this.tileableWindows();
    const currentIndex = tileable.findIndex((window) => window.id === focused.id);
    if (currentIndex < 0) return false;

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= tileable.length) return false;

    this.stopKineticScroll();
    this.activeWindowId = focused.id;
    this.moveTileWindowToIndex(focused, nextIndex);
    this.scrollToWindow(focused);
    this.applyLayout();
    focused.focus();
    return true;
  }

  public takeWindowForMove(window: WaylandWindow): { window: WaylandWindow; snapshot: WorkspaceWindowSnapshot } | null {
    if (!this.hasWindow(window)) return null;
    const snapshot = this.snapshotWindow(window);
    this.removeWindow(window);
    return { window, snapshot };
  }

  public addMovedWindow(window: WaylandWindow, snapshot: WorkspaceWindowSnapshot): boolean {
    this.restoredWindowStateById.set(window.id, snapshot);
    return this.addWindow(window);
  }

  public isRestoringWindow(windowId: string): boolean {
    return this.restoredWindowStateById.has(windowId);
  }

  public isActive(): boolean {
    return this.activeWorkspaceIndex(this.monitor) === this.index;
  }

  public refreshUsableAreaLayout() {
    if (!COMPOSITOR.output.list.includes(this.monitor)) return;

    if (this.isTiled) {
      const nextViewportRect = this.tileViewportRect();
      if (this.lastAppliedTileViewportRect && managedRectEquals(this.lastAppliedTileViewportRect, nextViewportRect)) {
        return;
      }
      this.applyLayout({ suppressSSDRebuild: false, animate: false, preserveMissingActive: true });
      return;
    }

    for (const window of this.windows) {
      if (!window.state[WINDOW_STATE_MAXIMIZED]()) continue;
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
    }
  }

  public setVisible(visible: boolean) {
    this.visibilityAnimationToken += 1;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    }
  }

  public prepareWorkspaceTransition(offsetY: number, opacity: number) {
    this.visibilityAnimationToken += 1;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(offsetY);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(opacity);
    }
  }

  public setWorkspaceGestureVisual(offsetY: number, opacity: number) {
    this.visibilityAnimationToken += 1;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      cancelWorkspaceVisualAnimation(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(offsetY);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(opacity);
    }
  }

  public animateWorkspaceTransition(options: {
    fromOffsetY: number;
    toOffsetY: number;
    fromOpacity: number;
    toOpacity: number;
    visibleAfter: boolean;
  }) {
    const token = this.visibilityAnimationToken + 1;
    this.visibilityAnimationToken = token;

    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      scheduleWorkspaceVisualAnimation(
        window,
        options.fromOffsetY,
        options.toOffsetY,
        options.fromOpacity,
        options.toOpacity,
        WINDOW_MANAGEMENT_EASING,
        WORKSPACE_SWITCH_ANIMATION_DURATION,
      );
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    }

    const VISIBILITY_COMMIT_BEFORE_END_MS = 32;
    setTimeout(() => {
      if (this.visibilityAnimationToken !== token) return;
      withManagedWindowOnlySSDRebuildSuppressed(() => {
        this.setVisible(options.visibleAfter);
      });
    }, Math.max(0, WORKSPACE_SWITCH_ANIMATION_DURATION - VISIBILITY_COMMIT_BEFORE_END_MS));
  }

  public setTiled(tiled: boolean) {
    if (this.isTiled === tiled) return;
    this.stopKineticScroll();

    const focusedWindow = this.focusedWindow();
    const focusedTileableWindow =
      focusedWindow && this.shouldTile(focusedWindow) && !focusedWindow.state[WINDOW_STATE_MINIMIZED]()
        ? focusedWindow
        : undefined;
    this.isTiled = tiled;

    if (tiled) {
      this.scrollOffset = 0;
      for (const window of this.windows) this.syncWindowVisibleOutputs(window);
      for (const window of this.tileableWindows()) {
        this.captureFloatingRect(window);
        this.setTileWidthFromRect(window, window.state[WINDOW_STATE_FLOATING_RECT]() ?? window.state[WINDOW_STATE_RECT](), true);
      }
      for (const window of this.floatingWindows()) this.captureFloatingRect(window);
      const tileable = this.tileableWindows();
      const previousActiveWindow = this.activeWindow(tileable);
      this.activeWindowId = (focusedTileableWindow ?? previousActiveWindow ?? tileable.at(0))?.id ?? null;
      if (focusedTileableWindow) this.scrollToWindow(focusedTileableWindow);
      this.applyLayout();
      focusedTileableWindow?.focus();
      return;
    }

    for (const window of this.windows) {
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          this.maximizedRootRect(window),
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
          MANAGED_WINDOW_ONLY_ANIMATION,
        );
        window.state[WINDOW_STATE_FLOATING_RECT].set(null);
        this.syncWindowVisibleOutputs(window);
        continue;
      }
      const rect = window.state[WINDOW_STATE_FLOATING_RECT]();
      if (rect) {
        const viewportRect = this.shouldTile(window) ? rect : this.floatingContentRectToViewportRect(rect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          viewportRect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
          MANAGED_WINDOW_ONLY_ANIMATION,
        );
      }
      window.state[WINDOW_STATE_FLOATING_RECT].set(null);
      this.syncWindowVisibleOutputs(window);
    }
    if (focusedTileableWindow) {
      this.activeWindowId = focusedTileableWindow.id;
      focusedTileableWindow.focus();
    }
  }

  public applyLayout(options: LayoutOptions = {}) {
    if (!this.isTiled) return;

    const tileable = this.tileableWindows();
    const animate = options.animate ?? true;
    const suppressSSDRebuild = options.suppressSSDRebuild ?? true;
    const canSuppress = this.canSuppressLayoutSSDRebuild(tileable);
    const animationOptions = animate && suppressSSDRebuild && canSuppress ? MANAGED_WINDOW_ONLY_ANIMATION : undefined;

    if (tileable.length === 0) {
      this.activeWindowId = null;
      this.applyFloatingLayout(animationOptions, animate);
      return;
    }

    if (!this.activeWindowId || !tileable.some((window) => window.id === this.activeWindowId)) {
      if (!options.preserveMissingActive) this.activeWindowId = tileable.at(-1)?.id ?? null;
    }

    this.clampScrollOffset(tileable.length);

    const viewportRect = this.tileViewportRect();
    this.lastAppliedTileViewportRect = snapshotManagedRect(viewportRect);
    const tileHeight = read(viewportRect.height);
    let nextX = read(viewportRect.x) - this.scrollOffset;
    this.lastDraggingSlotRect = null;

    tileable.forEach((window, index) => {
      const tileWidth = this.tileWidthForWindow(window, viewportRect);
      const rect = window.state[WINDOW_STATE_FULLSCREEN]()
        ? this.fullscreenRootRect(window)
        : window.state[WINDOW_STATE_MAXIMIZED]()
          ? this.maximizedTileRect(window, nextX)
          : { x: nextX, y: read(viewportRect.y), width: tileWidth, height: tileHeight };

      if (window.id === this.draggingWindowId) this.lastDraggingSlotRect = rect;

      if (window.id !== this.draggingWindowId) {
        if (animate) {
          playRectAnimation(window, WINDOW_STATE_RECT, rect, WINDOW_MANAGEMENT_EASING, TILE_ANIMATION_DURATION, animationOptions);
        } else {
          if (options.cancelRectAnimations !== false) stopRectAnimation(window, WINDOW_STATE_RECT);
          window.state[WINDOW_STATE_RECT].set(rect);
        }
      }
      nextX += tileWidth + (index === tileable.length - 1 ? 0 : TILE_GAP);
    });

    this.applyFloatingLayout(animationOptions, animate);
  }

  public resizeTile(event: WindowResizeEvent) {
    const tileable = this.tileableWindows();
    if (!tileable.some((window) => window.id === event.window.id)) return;

    if ((event.phase === "start" || event.phase === "update") && event.window.state[WINDOW_STATE_MAXIMIZED]()) {
      event.window.state[WINDOW_STATE_MAXIMIZED].set(false);
      event.window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      event.window.unmaximize();
    }

    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    this.activeWindowId = event.window.id;

    const viewportRect = this.tileViewportRect();
    const minWidth = this.minTileWidth(event.window, viewportRect);
    const maxWidth = this.maxTileWidth(event.window);
    const width = clamp(event.currentRect.width, minWidth, Math.max(minWidth, maxWidth));
    this.tileWidthByWindowId.set(event.window.id, width);
    this.scrollToWindow(event.window);
    this.applyLayout();
  }

  public draggingSlotRect(): ManagedWindowRect | null {
    return this.draggingWindowId ? this.lastDraggingSlotRect : null;
  }

  public beginTileDrag(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.shouldTile(window)) return;
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    const wasMaximized = window.state[WINDOW_STATE_MAXIMIZED]();
    window.state[WINDOW_STATE_MAXIMIZED].set(false);
    window.state[WINDOW_STATE_RESTORE_RECT].set(null);
    if (wasMaximized) window.unmaximize();
    window.state[WINDOW_STATE_TILE_DRAGGING].set(true);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
    this.setTileWidthFromRect(window, window.state[WINDOW_STATE_RECT](), false);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
    this.applyLayout();
  }

  public adoptTileDragWindow(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.hasWindow(window)) this.windows.push(window);
    const visible = this.isActive();
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    this.setTileWidthFromRect(window, rect, false);
    window.state[WINDOW_STATE_TILE_DRAGGING].set(true);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  public adoptFloatingWindow(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.hasWindow(window)) this.windows.push(window);
    const visible = this.isActive();
    this.activeWindowId = window.id;
    this.syncWindowVisibleOutputs(window);
    resetWorkspaceVisualState(window, visible);
    window.state[WINDOW_STATE_FLOATING_RECT].set(this.isTiled ? this.viewportRectToFloatingContentRect(rect) : rect);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  public updateTileDrag(window: WaylandWindow, rect: ManagedWindowRect, pointerX: number) {
    if (this.draggingWindowId !== window.id) this.beginTileDrag(window, rect);
    this.activeWindowId = window.id;
    this.moveTileWindowToIndex(window, this.tileInsertionIndexForPointer(window, pointerX));
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
    this.scrollToWindow(window);
    this.applyLayout();
  }

  public endTileDrag(window: WaylandWindow, cancelled: boolean) {
    if (this.draggingWindowId !== window.id) return;
    this.draggingWindowId = null;
    window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(this.isActive() ? 1 : 0);
    if (!cancelled) {
      this.activeWindowId = window.id;
      this.scrollToWindow(window);
    }
    this.applyLayout();
    if (!cancelled && this.isActive()) window.focus();
  }

  public focusWindow(window: WaylandWindow) {
    if (!this.shouldTile(window)) return;
    if (this.activeWindowId === window.id) return;
    this.activeWindowId = window.id;
    this.scrollToWindow(window);
    this.applyLayout();
  }

  public panToWindow(window: WaylandWindow) {
    if (!this.isTiled || !this.shouldTile(window)) return;
    this.activeWindowId = window.id;
    this.scrollToWindow(window, { force: true });
    this.applyLayout();
  }

  public focusWindowUnderPointer(window: WaylandWindow): WaylandWindow | undefined {
    if (!this.isTiled || !this.hasWindow(window) || window.state[WINDOW_STATE_MINIMIZED]()) return undefined;
    const focused = this.focusedWindow();
    if (focused && focused.id !== window.id && this.areTransientRelatives(focused, window)) return undefined;
    if (read(window.isFocused)) return undefined;

    if (this.shouldTile(window)) {
      const previousActiveWindowId = this.activeWindowId;
      this.activeWindowId = window.id;
      if (previousActiveWindowId !== window.id) this.reapplyStaticManagedLayout();
    }
    window.focus();
    return window;
  }

  private areTransientRelatives(a: WaylandWindow, b: WaylandWindow): boolean {
    return this.isTransientChildOf(a, b) || this.isTransientChildOf(b, a) || this.hasUnparentedTransientAffinity(a, b);
  }

  private isTransientChildOf(child: WaylandWindow, parent: WaylandWindow): boolean {
    return child.isTransient() && child.parentId() === parent.id;
  }

  private hasUnparentedTransientAffinity(a: WaylandWindow, b: WaylandWindow): boolean {
    const transient = !this.shouldTile(a) && a.isTransient() ? a : null;
    const other = transient === a ? b : !this.shouldTile(b) && b.isTransient() ? b : null;
    if (!transient || !other || transient.parentId()) return false;
    return transient.appId() !== undefined && transient.appId() === other.appId();
  }

  private reapplyStaticManagedLayout(): void {
    if (!this.isTiled) return;
    const tileable = this.tileableWindows();
    if (tileable.length === 0) return;

    withManagedWindowOnlySSDRebuildSuppressed(
      () => { this.applyLayout({ animate: false, preserveMissingActive: true, cancelRectAnimations: false }); },
      { strict: true },
    );
    for (const window of tileable) markManagedWindowDirty(window.id);
  }

  public scrollBy(deltaX: number, options: { stopKinetic?: boolean; suppressSSDRebuild?: boolean; cancelRectAnimations?: boolean } = {}): boolean {
    if (!this.isTiled || deltaX === 0) return false;
    if (options.stopKinetic !== false) this.stopKineticScroll();

    const before = this.scrollOffset;
    this.scrollOffset += deltaX;
    const tileable = this.tileableWindows();
    this.clampScrollOffset(tileable.length);
    if (this.scrollOffset === before) return false;

    const cancelRectAnimations = options.cancelRectAnimations ?? true;
    const apply = () => this.applyLayout({ animate: false, preserveMissingActive: true, cancelRectAnimations });

    if (options.suppressSSDRebuild === false) {
      apply();
    } else {
      withManagedWindowOnlySSDRebuildSuppressed(apply, { strict: true });
    }

    for (const window of tileable) markManagedWindowDirty(window.id);
    return true;
  }

  public startKineticScroll(initialVelocityX: number, onFrame?: () => void): void {
    this.stopKineticScroll();
    if (!this.isTiled || Math.abs(initialVelocityX) < WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY) return;

    let velocityX = clamp(initialVelocityX, -WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY, WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY);
    let lastTime: number | null = null;
    const token = this.kineticScrollToken + 1;
    this.kineticScrollToken = token;
    const intervalMs = this.kineticScrollIntervalMs();
    let firstStep = true;

    const step = (dtMs: number): boolean => {
      const deltaX = (velocityX * dtMs) / 1000;
      const scrolled = this.scrollBy(deltaX, { stopKinetic: false, cancelRectAnimations: firstStep });
      firstStep = false;
      if (!scrolled) {
        this.stopKineticScroll();
        return false;
      }
      onFrame?.();
      velocityX *= Math.exp(-dtMs / WORKSPACE_KINETIC_SCROLL_TIME_CONSTANT_MS);
      if (Math.abs(velocityX) < WORKSPACE_KINETIC_SCROLL_STOP_VELOCITY) {
        this.stopKineticScroll();
        return false;
      }
      return true;
    };

    if (!step(intervalMs)) return;

    this.kineticScrollPoll = createManagedPoll(intervalMs, (handle) => {
      if (this.kineticScrollToken !== token || !this.isTiled) {
        handle.cancel();
        if (this.kineticScrollPoll === handle) this.kineticScrollPoll = null;
        return;
      }
      const now = handle.nowMs;
      const dtMs = Math.max(1, lastTime === null ? intervalMs : now - lastTime);
      lastTime = now;
      step(dtMs);
    }, "none");
  }

  public stopKineticScroll(): void {
    this.kineticScrollToken += 1;
    if (this.kineticScrollPoll) {
      this.kineticScrollPoll.cancel();
      this.kineticScrollPoll = null;
    }
  }

  private kineticScrollIntervalMs(): number {
    const refreshRate = COMPOSITOR.output.current[this.monitor]?.resolution?.refreshRate ?? WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE;
    return 1000 / Math.max(1, refreshRate);
  }

  public focusRelative(direction: -1 | 1) {
    const tileable = this.tileableWindows();
    if (tileable.length === 0) return;

    const activeIndex = tileable.findIndex((window) => window.id === this.activeWindowId);
    const fallbackIndex = this.focusFallbackTileIndex(tileable, direction);
    const currentIndex = activeIndex >= 0 ? activeIndex : (fallbackIndex ?? (direction < 0 ? tileable.length : -1));
    const nextIndex = clamp(currentIndex + direction, 0, tileable.length - 1);

    this.activeWindowId = tileable[nextIndex].id;
    this.scrollToWindow(tileable[nextIndex]);
    this.applyLayout();
    this.focusActiveWindow();
  }

  private focusFallbackTileIndex(tileable: WaylandWindow[], direction: -1 | 1): number | undefined {
    const focused = this.focusedWindow();
    if (!focused || this.shouldTile(focused)) return undefined;

    const focusedCenter = rectCenterX(focused.state[WINDOW_STATE_RECT]());
    const candidates = tileable
      .map((window, index) => ({ index, center: rectCenterX(window.state[WINDOW_STATE_RECT]()) }))
      .filter(({ center }) => direction < 0 ? center < focusedCenter : center > focusedCenter);

    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => direction < 0 ? b.center - a.center : a.center - b.center);
    return candidates[0].index - direction;
  }

  public focusActiveWindow() {
    this.windows.find((window) => window.id === this.activeWindowId)?.focus();
  }

  public shouldTile(window: WaylandWindow): boolean {
    return window.isResizable() && !window.isTransient();
  }

  public snapshot(): WorkspaceSnapshot {
    return {
      monitor: this.monitor,
      index: this.index,
      isTiled: this.isTiled,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      windows: this.windows.map((window) => this.snapshotWindow(window)),
    };
  }

  public restore(snapshot: WorkspaceSnapshot) {
    this.isTiled = snapshot.isTiled;
    this.activeWindowId = snapshot.activeWindowId;
    this.scrollOffset = snapshot.scrollOffset;
    this.tileWidthByWindowId.clear();
    this.restoredWindowStateById.clear();
    for (const window of snapshot.windows) {
      if (window.tileWidth !== undefined) this.tileWidthByWindowId.set(window.id, window.tileWidth);
      this.restoredWindowStateById.set(window.id, window);
    }
  }

  public getWindows(): WaylandWindow[] {
    return Array.from(this.windows);
  }

  private snapshotWindow(window: WaylandWindow): WorkspaceWindowSnapshot {
    return {
      id: window.id,
      tileWidth: this.tileWidthByWindowId.get(window.id),
      floatingRect: window.state[WINDOW_STATE_FLOATING_RECT](),
      restoreRect: window.state[WINDOW_STATE_RESTORE_RECT](),
      snapZone: window.state[WINDOW_STATE_SNAP_ZONE](),
      snapMonitor: window.state[WINDOW_STATE_SNAP_MONITOR](),
      minimized: window.state[WINDOW_STATE_MINIMIZED](),
      maximized: window.state[WINDOW_STATE_MAXIMIZED](),
    };
  }

  private syncWindowVisibleOutputs(window: WaylandWindow) {
    window.state[WINDOW_STATE_TILED].set(this.isTiled && this.shouldTile(window));
    window.state[WINDOW_STATE_VISIBLE_OUTPUTS].set(this.isTiled ? [this.monitor] : null);
  }

  private canSuppressLayoutSSDRebuild(_tileable: WaylandWindow[]): boolean {
    return true;
  }

  private tileableWindows(): WaylandWindow[] {
    return this.windows.filter((window) => this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED]());
  }

  public focusedWindow(): WaylandWindow | undefined {
    return this.windows.find((window) => read(window.isFocused));
  }

  public syncFloatingWindowRect(window: WaylandWindow, viewportRect: ManagedWindowRect) {
    if (!this.isTiled) {
      window.state[WINDOW_STATE_FLOATING_RECT].set(viewportRect);
      return;
    }
    if (this.shouldTile(window)) return;
    window.state[WINDOW_STATE_FLOATING_RECT].set(this.viewportRectToFloatingContentRect(viewportRect));
  }

  private activeWindow(windows = this.windows): WaylandWindow | undefined {
    return windows.find((window) => window.id === this.activeWindowId);
  }

  private tileInsertionIndexForPointer(window: WaylandWindow, pointerX: number): number {
    const tileable = this.tileableWindows().filter((current) => current.id !== window.id);
    const viewportRect = this.tileViewportRect();
    const contentX = pointerX - read(viewportRect.x) + this.scrollOffset;
    let left = 0;

    for (let index = 0; index < tileable.length; index++) {
      const width = this.tileWidthForWindow(tileable[index], viewportRect);
      if (contentX < left + width / 2) return index;
      left += width + TILE_GAP;
    }
    return tileable.length;
  }

  private moveTileWindowToIndex(window: WaylandWindow, tileIndex: number) {
    const currentIndex = this.windows.findIndex((current) => current.id === window.id);
    if (currentIndex < 0) return;

    this.windows.splice(currentIndex, 1);
    const tileableWithoutWindow = this.tileableWindows();
    const beforeWindow = tileableWithoutWindow[tileIndex];

    if (beforeWindow) {
      const insertIndex = this.windows.findIndex((current) => current.id === beforeWindow.id);
      this.windows.splice(Math.max(0, insertIndex), 0, window);
      return;
    }

    let lastTileableIndex = -1;
    for (let index = 0; index < this.windows.length; index++) {
      if (this.shouldTile(this.windows[index])) lastTileableIndex = index;
    }
    this.windows.splice(lastTileableIndex + 1, 0, window);
  }

  private captureFloatingRect(window: WaylandWindow) {
    if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
      const rect = this.isTiled ? this.viewportRectToFloatingContentRect(window.state[WINDOW_STATE_RECT]()) : window.state[WINDOW_STATE_RECT]();
      window.state[WINDOW_STATE_FLOATING_RECT].set(rect);
    }
  }

  public floatingWindows(): WaylandWindow[] {
    return this.windows.filter((window) => !this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED]());
  }

  private applyFloatingLayout(animationOptions: LayoutOptions | undefined, animate = true) {
    for (const window of this.floatingWindows()) {
      if (window.state[WINDOW_STATE_MAXIMIZED]()) continue;

      const contentRect = window.state[WINDOW_STATE_FLOATING_RECT]() ?? this.viewportRectToFloatingContentRect(this.centeredFloatingRect(window));
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      const rect = this.floatingContentRectToViewportRect(contentRect);

      if (animate) {
        playRectAnimation(window, WINDOW_STATE_RECT, rect, WINDOW_MANAGEMENT_EASING, TILE_ANIMATION_DURATION, animationOptions);
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(rect);
      }
    }
  }

  private centeredFloatingRect(window: WaylandWindow): ManagedWindowRect {
    const sizeRect = this.naturalRootRect(window);
    const monitor = COMPOSITOR.output.current[this.monitor];
    if (!monitor?.resolution) return sizeRect;

    const usableRect = COMPOSITOR.layer.usableArea(this.monitor);
    const logicalWidth = usableRect?.width ?? monitor.resolution.width / monitor.scale;
    const logicalHeight = usableRect?.height ?? monitor.resolution.height / monitor.scale;
    const logicalX = usableRect?.x ?? monitor.position.x;
    const logicalY = usableRect?.y ?? monitor.position.y;

    let width = read(sizeRect.width);
    let height = read(sizeRect.height);
    const DEGENERATE_SIZE_PX = 50;
    if (width < DEGENERATE_SIZE_PX || height < DEGENERATE_SIZE_PX) {
      width = Math.round(logicalWidth * 0.6);
      height = Math.round(logicalHeight * 0.7);
    }

    return { x: logicalX + (logicalWidth - width) / 2, y: logicalY + (logicalHeight - height) / 2, width, height };
  }

  private viewportRectToFloatingContentRect(rect: ManagedWindowRect): ManagedWindowRect {
    return { x: read(rect.x) + this.scrollOffset, y: read(rect.y), width: read(rect.width), height: read(rect.height) };
  }

  private floatingContentRectToViewportRect(rect: ManagedWindowRect): ManagedWindowRect {
    return { x: read(rect.x) - this.scrollOffset, y: read(rect.y), width: read(rect.width), height: read(rect.height) };
  }

  private clampRectToViewport(rect: ManagedWindowRect): ManagedWindowRect {
    const viewport = this.tileViewportRect();
    const width = read(rect.width);
    const height = read(rect.height);
    const minX = read(viewport.x);
    const minY = read(viewport.y);
    const maxX = minX + Math.max(0, read(viewport.width) - width);
    const maxY = minY + Math.max(0, read(viewport.height) - height);
    return { x: clamp(read(rect.x), minX, maxX), y: clamp(read(rect.y), minY, maxY), width, height };
  }

  private scrollToWindow(window: WaylandWindow, options: { force?: boolean } = {}) {
    this.stopKineticScroll();
    const tileable = this.tileableWindows();
    const index = tileable.findIndex((current) => current.id === window.id);
    if (index < 0) return;

    const viewportRect = this.tileViewportRect();
    const viewportWidth = read(viewportRect.width);
    const windowLeft = this.tileLeftForIndex(tileable, index, viewportRect);
    const windowRight = windowLeft + this.tileWidthForWindow(window, viewportRect);

    if (window.state[WINDOW_STATE_MAXIMIZED]() || options.force) {
      this.scrollOffset = windowLeft + (windowRight - windowLeft) / 2 - viewportWidth / 2;
    } else if (windowLeft < this.scrollOffset) {
      this.scrollOffset = windowLeft;
    } else if (windowRight > this.scrollOffset + viewportWidth) {
      this.scrollOffset = windowRight - viewportWidth;
    }
    this.clampScrollOffset(tileable.length);
  }

  private clampScrollOffset(tileCount: number) {
    const tileable = this.tileableWindows();
    const viewportRect = this.tileViewportRect();
    const viewportWidth = read(viewportRect.width);
    const contentWidth = this.tileContentWidth(tileable.slice(0, tileCount), viewportRect);
    const maxScrollOffset = Math.max(0, contentWidth - viewportWidth);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxScrollOffset);
  }

  private tileWidthForWindow(window: WaylandWindow, viewportRect: ManagedWindowRect): number {
    if (window.state[WINDOW_STATE_MAXIMIZED]()) return read(this.maximizedRootRect(window).width);
    const width = this.tileWidthByWindowId.get(window.id) ?? this.defaultTileWidth(viewportRect);
    return clamp(width, this.minTileWidth(window, viewportRect), Math.max(this.minTileWidth(window, viewportRect), this.maxTileWidth(window)));
  }

  private maximizedTileRect(window: WaylandWindow, x: number): ManagedWindowRect {
    const maximizedRect = this.maximizedRootRect(window);
    return { x, y: read(maximizedRect.y), width: read(maximizedRect.width), height: read(maximizedRect.height) };
  }

  private setTileWidthFromRect(window: WaylandWindow, rect: ManagedWindowRect, overwrite: boolean) {
    if (!overwrite && this.tileWidthByWindowId.has(window.id)) return;
    const viewportRect = this.tileViewportRect();
    this.tileWidthByWindowId.set(
      window.id,
      clamp(read(rect.width), this.minTileWidth(window, viewportRect), Math.max(this.minTileWidth(window, viewportRect), this.maxTileWidth(window))),
    );
  }

  private defaultTileWidth(viewportRect: ManagedWindowRect): number {
    return Math.max(TILE_MIN_WIDTH, read(viewportRect.width) * TILE_WIDTH_RATIO);
  }

  private minTileWidth(window: WaylandWindow, viewportRect: ManagedWindowRect): number {
    const constraints = window.sizeConstraints();
    const extra = this.rootClientWidthExtra(window);
    return Math.max(TILE_MIN_WIDTH, (constraints.min?.width ?? 1) + extra, read(viewportRect.width) * 0.2);
  }

  private maxTileWidth(window: WaylandWindow): number {
    const constraints = window.sizeConstraints();
    const extra = this.rootClientWidthExtra(window);
    const max = constraints.max?.width;
    return max && max > 0 ? max + extra : Number.POSITIVE_INFINITY;
  }

  private rootClientWidthExtra(window: WaylandWindow): number {
    const natural = this.naturalRootRect(window);
    return Math.max(0, read(natural.width) - window.position.width);
  }

  private tileLeftForIndex(tileable: WaylandWindow[], index: number, viewportRect: ManagedWindowRect): number {
    let left = 0;
    for (let i = 0; i < index; i++) left += this.tileWidthForWindow(tileable[i], viewportRect) + TILE_GAP;
    return left;
  }

  private tileContentWidth(tileable: WaylandWindow[], viewportRect: ManagedWindowRect): number {
    if (tileable.length === 0) return 0;
    return tileable.reduce((sum, window) => sum + this.tileWidthForWindow(window, viewportRect), 0) + (tileable.length - 1) * TILE_GAP;
  }

  private tileViewportRect(): ManagedWindowRect {
    const monitor = COMPOSITOR.output.current[this.monitor];
    const usableRect = COMPOSITOR.layer.usableArea(this.monitor);
    const base = usableRect ??
      (monitor?.resolution
        ? { x: monitor.position.x, y: monitor.position.y, width: monitor.resolution.width / monitor.scale, height: monitor.resolution.height / monitor.scale }
        : { x: 0, y: 0, width: 1280, height: 720 });

    return insetRect(base, { top: TILE_MARGIN, right: TILE_MARGIN, bottom: TILE_MARGIN, left: TILE_MARGIN });
  }

  private fullscreenRootRect(window: WaylandWindow): ManagedWindowRect {
    const monitor = COMPOSITOR.output.current[this.monitor];
    if (monitor?.resolution) {
      return { x: monitor.position.x, y: monitor.position.y, width: monitor.resolution.width / monitor.scale, height: monitor.resolution.height / monitor.scale };
    }
    return window.state[WINDOW_STATE_RECT]();
  }
}
