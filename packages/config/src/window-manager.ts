import {
  createWindowStack,
  createWindowState,
  cubicBezier,
  createManagedPoll,
  markManagedWindowDirty,
  read,
  seconds,
  WINDOW_MANAGER,
  type EasingFunction,
  type GestureSwipeEvent,
  type OutputChangeEvent,
  type PointerMoveEvent,
  type PollHandle,
  type ReadonlySignal,
  type WaylandWindow,
  type WindowActivateRequestEvent,
  type WindowMaximizeRequestEvent,
  type WindowMinimizeRequestEvent,
  type WindowMoveEvent,
  type WindowResizeEvent,
  type WindowResizeRect,
} from "shoji_wm";
import type { ManagedWindowRect, WindowSizeConstraints } from "shoji_wm/types";
import { playRectAnimation, stopRectAnimation } from "./window-animation";

export const WINDOW_STATE_RECT = createWindowState<ManagedWindowRect>("rect", {
  default: (window) => window.rect,
});
export const WINDOW_STATE_RESTORE_RECT =
  createWindowState<ManagedWindowRect | null>("restoreRect", {
    default: null,
  });
export const WINDOW_STATE_MINIMIZED = createWindowState<boolean>("minimized", {
  default: false,
});
export const WINDOW_STATE_MAXIMIZED = createWindowState<boolean>("maximized", {
  default: false,
});
export const WINDOW_STATE_WORKSPACE_VISIBLE = createWindowState<boolean>(
  "workspaceVisible",
  {
    default: true,
  },
);
export const WINDOW_STATE_WORKSPACE_OFFSET_Y = createWindowState<number>(
  "workspaceOffsetY",
  {
    default: 0,
  },
);
export const WINDOW_STATE_WORKSPACE_OPACITY = createWindowState<number>(
  "workspaceOpacity",
  {
    default: 1,
  },
);
export const WINDOW_STATE_TILE_DRAGGING = createWindowState<boolean>(
  "tileDragging",
  {
    default: false,
  },
);
export const WINDOW_STATE_VISIBLE_OUTPUTS = createWindowState<string[] | null>(
  "visibleOutputs",
  {
    default: null,
  },
);
export const WINDOW_STATE_FLOATING_RECT =
  createWindowState<ManagedWindowRect | null>("floatingRect", {
    default: null,
  });

const OPEN_CLOSE_ANIMATION_DURATION = seconds(0.5);
const WINDOW_MANAGEMENT_ANIMATION_DURATION = seconds(0.3);
const UNMAXIMIZE_GRAB_ANIMATION_DURATION = 90;
const WINDOW_MANAGEMENT_EASING = cubicBezier(0.1, 0.9, 0.2, 1.0);
const WINDOW_OPEN_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
const WINDOW_CLOSE_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const TILE_ANIMATION_DURATION = seconds(0.5);
const WORKSPACE_SWITCH_ANIMATION_DURATION = seconds(0.5);
const WORKSPACE_GESTURE_FINGERS = 3;
const WORKSPACE_GESTURE_AXIS_LOCK_PX = 8;
const WORKSPACE_GESTURE_THRESHOLD_RATIO = 0.22;
const WORKSPACE_GESTURE_VELOCITY_THRESHOLD = 900;
const WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY = 120;
const WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY = 5000;
const WORKSPACE_KINETIC_SCROLL_STOP_VELOCITY = 18;
const WORKSPACE_KINETIC_SCROLL_TIME_CONSTANT_MS = 360;
const WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE = 120;
const TILE_DRAG_WORKSPACE_EDGE_PX = 80;
const TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS = 420;
const TILE_GAP = 12;
const TILE_MARGIN = 12;
const TILE_WIDTH_RATIO = 0.5;
const TILE_MIN_WIDTH = 240;
const MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback-last",
} as const;
const STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback",
} as const;
const MANAGED_WINDOW_ONLY_ANIMATION = {
  suppressSSDRebuild: true,
} as const;
interface LayoutOptions {
  suppressSSDRebuild?: boolean;
  animate?: boolean;
  preserveMissingActive?: boolean;
  cancelRectAnimations?: boolean;
}

interface HybridWindowManagerSnapshot {
  currentMonitor: string;
  activeWorkspaceByMonitor: [string, number][];
  workspaces: WorkspaceSnapshot[];
}

interface WorkspaceSnapshot {
  monitor: string;
  index: number;
  isTiled: boolean;
  activeWindowId: string | null;
  scrollOffset: number;
  windows: WorkspaceWindowSnapshot[];
}

interface WorkspaceWindowSnapshot {
  id: string;
  tileWidth?: number;
  floatingRect?: ManagedWindowRect | null;
  restoreRect?: ManagedWindowRect | null;
  minimized: boolean;
  maximized: boolean;
}

/**
 * Compact, serializable view of the workspace layout for external clients
 * (e.g. the bar) consumed over the IPC transport. Per-monitor so a per-output
 * bar can render just its own workspaces.
 */
export interface WorkspacesViewWorkspace {
  index: number;
  windowCount: number;
  isTiled: boolean;
  active: boolean;
}

export interface WorkspacesViewMonitor {
  name: string;
  active: number;
  workspaces: WorkspacesViewWorkspace[];
}

export interface WorkspacesView {
  currentMonitor: string;
  monitors: WorkspacesViewMonitor[];
}

interface WorkspaceGestureState {
  monitor: string;
  currentIndex: number;
  direction: -1 | 1;
  distance: number;
  fromWorkspace: Workspace;
  toWorkspace: Workspace | null;
  fromOffsetY: number;
  toOffsetY: number;
  fromOpacity: number;
  toOpacity: number;
}

type WorkspaceGestureMode = "workspace-switch" | "workspace-scroll";

export interface WorkspaceGestureSpeedConfig {
  /**
   * Horizontal three-finger swipe movement multiplier for scrolling inside a
   * tiled workspace.
   */
  workspaceScrollFactor?: number;
  /**
   * Horizontal release velocity multiplier for kinetic workspace scrolling.
   * Defaults to workspaceScrollFactor when omitted.
   */
  workspaceScrollKineticFactor?: number;
  /**
   * Vertical three-finger swipe movement multiplier for workspace switching.
   */
  workspaceSwitchFactor?: number;
  /**
   * Vertical release velocity multiplier for deciding whether to commit a
   * workspace switch. Defaults to workspaceSwitchFactor when omitted.
   */
  workspaceSwitchVelocityFactor?: number;
}

interface ResolvedWorkspaceGestureSpeedConfig {
  workspaceScrollFactor: number;
  workspaceScrollKineticFactor: number;
  workspaceSwitchFactor: number;
  workspaceSwitchVelocityFactor: number;
}

const DEFAULT_WORKSPACE_GESTURE_SPEED: ResolvedWorkspaceGestureSpeedConfig = {
  workspaceScrollFactor: 1,
  workspaceScrollKineticFactor: 1,
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
};

function hotReloadDebugEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env;
  const value = env?.SHOJI_HOT_RELOAD_DEBUG;
  return value !== undefined && value !== "" && value !== "0";
}

function hotReloadDebug(
  message: string,
  details: Record<string, unknown> = {},
): void {
  if (!hotReloadDebugEnabled()) {
    return;
  }
  console.info(`hot-reload ${message}`, JSON.stringify(details));
}

function sanitizeGestureSpeedFactor(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

const OPEN_ANIMATION_CHANNEL = "window.open";
const CLOSE_ANIMATION_CHANNEL = "window.close";
const WORKSPACE_VISUAL_ANIMATION_CHANNEL = "workspace.visual";
const WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.rect`;
const WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.opacity`;
export const WINDOW_BORDER_PX = 2;
export const TITLEBAR_HEIGHT = 30;
export const MAXIMIZED_WINDOW_PADDING = {
  top: 8,
  right: 8,
  bottom: 8,
  left: 8,
};

export class HybridWindowManager {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly activeWorkspaceByMonitor = new Map<string, number>();
  private readonly windowStack = createWindowStack();
  private readonly naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect;
  private currentMonitor: string;
  private isGrabbing = false;
  private tileDrag: {
    window: WaylandWindow;
    workspace: Workspace;
    lastWorkspaceSwitchAt: number;
  } | null = null;
  private floatingDrag: {
    window: WaylandWindow;
    workspace: Workspace;
    lastWorkspaceSwitchAt: number;
  } | null = null;
  private workspaceGesture: WorkspaceGestureState | null = null;
  private workspaceGestureMode: WorkspaceGestureMode | null = null;
  private workspaceScrollGestureRectAnimationsCancelled = false;
  private workspaceGestureSpeed = { ...DEFAULT_WORKSPACE_GESTURE_SPEED };
  private lastPointerPosition: PointerMoveEvent["position"] | null = null;

  public constructor(
    naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect,
  ) {
    this.currentMonitor = "";
    this.naturalRootRect = naturalRootRect;
    this.syncWorkspaces();
  }

  public configureWorkspaceGestureSpeed(
    config: WorkspaceGestureSpeedConfig,
  ): void {
    const workspaceScrollFactor = sanitizeGestureSpeedFactor(
      config.workspaceScrollFactor,
      DEFAULT_WORKSPACE_GESTURE_SPEED.workspaceScrollFactor,
    );
    const workspaceSwitchFactor = sanitizeGestureSpeedFactor(
      config.workspaceSwitchFactor,
      DEFAULT_WORKSPACE_GESTURE_SPEED.workspaceSwitchFactor,
    );
    this.workspaceGestureSpeed = {
      workspaceScrollFactor,
      workspaceScrollKineticFactor: sanitizeGestureSpeedFactor(
        config.workspaceScrollKineticFactor,
        workspaceScrollFactor,
      ),
      workspaceSwitchFactor,
      workspaceSwitchVelocityFactor: sanitizeGestureSpeedFactor(
        config.workspaceSwitchVelocityFactor,
        workspaceSwitchFactor,
      ),
    };
  }

  public onPointerMove(event: PointerMoveEvent) {
    this.syncWorkspaces();
    this.currentMonitor = event.outputName ?? this.currentMonitor;
    this.lastPointerPosition = event.position;
    this.focusTiledWindowAtPointer(event.position, event.outputName);
  }

  public onGestureSwipe(event: GestureSwipeEvent) {
    if (event.fingers !== WORKSPACE_GESTURE_FINGERS) {
      return;
    }

    this.syncWorkspaces();
    if (event.position) {
      this.lastPointerPosition = event.position;
    }

    if (event.phase === "begin") {
      this.workspaceGesture = null;
      this.workspaceGestureMode = null;
      this.workspaceScrollGestureRectAnimationsCancelled = false;
      this.currentMonitor = this.gestureMonitor(event);
      return;
    }

    if (event.phase === "update") {
      const mode = this.resolveWorkspaceGestureMode(event);
      if (mode === "workspace-scroll") {
        this.workspaceGesture = null;
        this.updateWorkspaceScrollGesture(event);
        return;
      }
      if (mode === "workspace-switch") {
        this.updateWorkspaceGesture(event);
      }
      return;
    }

    if (this.workspaceGestureMode === "workspace-scroll") {
      this.workspaceGestureMode = null;
      this.workspaceGesture = null;
      this.finishWorkspaceScrollGesture(event);
      this.workspaceScrollGestureRectAnimationsCancelled = false;
      this.focusTiledWindowAtPointer(
        event.position ?? this.lastPointerPosition,
        event.outputName,
      );
      return;
    }

    this.workspaceGestureMode = null;
    this.workspaceScrollGestureRectAnimationsCancelled = false;
    this.finishWorkspaceGesture(event);
  }

  public onOutputChange(event: OutputChangeEvent) {
    const liveMonitors = new Set(
      event.outputs
        .filter((output) => output.enabled)
        .map((output) => output.name),
    );
    if (liveMonitors.size === 0) {
      return;
    }

    const fallbackMonitor =
      (this.currentMonitor && liveMonitors.has(this.currentMonitor)
        ? this.currentMonitor
        : undefined) ?? Array.from(liveMonitors)[0];
    if (!fallbackMonitor) {
      return;
    }

    const orphanedWorkspaces = Array.from(this.workspaces.values()).filter(
      (workspace) => !liveMonitors.has(workspace.monitor),
    );
    if (orphanedWorkspaces.length === 0) {
      this.syncWorkspaces();
      this.refreshUsableAreaLayouts();
      return;
    }

    const orphanedActiveWorkspaceByMonitor = new Map(
      Array.from(this.activeWorkspaceByMonitor.entries()).filter(
        ([monitor]) => !liveMonitors.has(monitor),
      ),
    );

    for (const monitor of Array.from(this.activeWorkspaceByMonitor.keys())) {
      if (!liveMonitors.has(monitor)) {
        this.activeWorkspaceByMonitor.delete(monitor);
      }
    }

    for (const workspace of orphanedWorkspaces) {
      const oldKey = workspaceKey(workspace.monitor, workspace.index);
      this.workspaces.delete(oldKey);

      if (workspace.windowCount() === 0) {
        continue;
      }

      const targetMonitor = fallbackMonitor;
      const targetIndex = this.availableWorkspaceIndex(
        targetMonitor,
        workspace.index,
      );
      const wasActiveOnRemovedMonitor =
        orphanedActiveWorkspaceByMonitor.get(workspace.monitor) ===
        workspace.index;
      workspace.moveToMonitor(targetMonitor, targetIndex);
      this.workspaces.set(workspaceKey(targetMonitor, targetIndex), workspace);
      if (
        wasActiveOnRemovedMonitor ||
        !this.activeWorkspaceByMonitor.has(targetMonitor)
      ) {
        this.activeWorkspaceByMonitor.set(targetMonitor, targetIndex);
      }
      workspace.setVisible(workspace.isActive());
      workspace.applyLayout({
        suppressSSDRebuild: false,
        animate: false,
        preserveMissingActive: true,
      });
    }

    if (!liveMonitors.has(this.currentMonitor)) {
      this.currentMonitor = fallbackMonitor;
    }
    this.syncWorkspaces();
    this.refreshUsableAreaLayouts();
    this.syncWorkspaceVisibility();
  }

  public onOpen(window: WaylandWindow) {
    window.focus();
    this.windowStack.add(window);

    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
  }

  public snapshot(): HybridWindowManagerSnapshot {
    const snapshot = {
      currentMonitor: this.currentMonitor,
      activeWorkspaceByMonitor: Array.from(
        this.activeWorkspaceByMonitor.entries(),
      ),
      workspaces: Array.from(this.workspaces.values()).map((workspace) =>
        workspace.snapshot(),
      ),
    };
    hotReloadDebug("hybrid-snapshot", {
      currentMonitor: snapshot.currentMonitor,
      workspaceCount: snapshot.workspaces.length,
      workspaces: snapshot.workspaces.map((workspace) => ({
        monitor: workspace.monitor,
        index: workspace.index,
        isTiled: workspace.isTiled,
        activeWindowId: workspace.activeWindowId,
        windowIds: workspace.windows.map((window) => window.id),
      })),
    });
    return snapshot;
  }

  public restore(snapshot: HybridWindowManagerSnapshot) {
    hotReloadDebug("hybrid-restore", {
      currentMonitor: snapshot.currentMonitor,
      workspaceCount: snapshot.workspaces.length,
      workspaces: snapshot.workspaces.map((workspace) => ({
        monitor: workspace.monitor,
        index: workspace.index,
        isTiled: workspace.isTiled,
        activeWindowId: workspace.activeWindowId,
        windowIds: workspace.windows.map((window) => window.id),
      })),
    });
    this.currentMonitor = snapshot.currentMonitor;
    this.activeWorkspaceByMonitor.clear();
    for (const [monitor, index] of snapshot.activeWorkspaceByMonitor) {
      this.activeWorkspaceByMonitor.set(monitor, index);
    }
    this.workspaces.clear();
    for (const workspaceSnapshot of snapshot.workspaces) {
      const workspace = this.ensureWorkspace(
        workspaceSnapshot.monitor,
        workspaceSnapshot.index,
      );
      workspace.restore(workspaceSnapshot);
    }
  }

  public onFirstCommit(window: WaylandWindow) {
    if (!this.windowStack.has(window)) {
      this.windowStack.add(window, { at: "back" });
    }
    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);

    let restoredExistingWindow = false;
    const workspace =
      this.findWorkspaceRestoringWindow(window) ?? this.getCurrentWorkspace();
    if (workspace) {
      restoredExistingWindow = workspace.addWindow(window);
      this.raiseTiledWorkspaceFloatingWindows(workspace);
      this.syncWorkspaceVisibility();
    } else {
      window.state[WINDOW_STATE_RECT].set(this.naturalRootRect(window));
    }

    if (window.isMaximized()) {
      window.state[WINDOW_STATE_RESTORE_RECT].set(
        this.initialRestoreRectForMaximizedWindow(window),
      );
      window.state[WINDOW_STATE_RECT].set(this.maximizedRectForWindow(window));
      window.state[WINDOW_STATE_MAXIMIZED].set(true);
    }
    if (!restoredExistingWindow) {
      scheduleOpenAnimation(window);
    }
    hotReloadDebug("hybrid-first-commit", {
      windowId: window.id,
      title: window.title.peek(),
      workspace: workspace
        ? { monitor: workspace.monitor, index: workspace.index }
        : null,
      restoredExistingWindow,
      scheduledOpenAnimation: !restoredExistingWindow,
    });
  }

  public onStartClose(window: WaylandWindow) {
    scheduleCloseAnimation(window);

    for (const workspace of this.workspaces.values()) {
      const nextFocus = workspace.removeWindow(window);
      if (nextFocus !== undefined) {
        workspace.applyLayout();
        nextFocus?.focus();
        break;
      }
    }
    this.syncWorkspaceVisibility();
  }

  public onClose(window: WaylandWindow) {
    this.windowStack.remove(window);
    for (const workspace of this.workspaces.values()) {
      if (workspace.removeWindow(window) !== undefined) {
        workspace.applyLayout();
      }
    }
    this.syncWorkspaceVisibility();
  }

  public onFocus(window: WaylandWindow, focused: boolean) {
    if (focused) {
      this.windowStack.raise(window);
      const workspace = this.findWorkspaceForWindow(window);
      if (workspace?.isTiled && workspace.isActive()) {
        workspace.focusWindow(window);
        this.raiseTiledWorkspaceFloatingWindows(workspace);
      }
    }
  }

  public onWindowResize(event: WindowResizeEvent) {
    if (!read(event.window.isResizable)) {
      return;
    }

    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace?.isTiled && workspace.shouldTile(event.window)) {
      workspace.resizeTile(event);
      this.raiseTiledWorkspaceFloatingWindows(workspace);
      return;
    }

    const nextRect = this.constrainResizeRect(event);
    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    event.window.state[WINDOW_STATE_RECT].set(nextRect);
    workspace?.syncFloatingWindowRect(event.window, nextRect);
    this.raiseTiledWorkspaceFloatingWindows(workspace);
  }

  public onWindowMove(event: WindowMoveEvent) {
    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace?.isTiled && workspace.shouldTile(event.window)) {
      this.onTileWindowMove(event, workspace);
      this.raiseTiledWorkspaceFloatingWindows(workspace);
      return;
    }

    if (workspace?.isTiled && !workspace.shouldTile(event.window)) {
      this.onFloatingWindowMove(event, workspace);
      return;
    }

    if (event.phase === "start") {
      this.isGrabbing = true;
    }

    const window = event.window;
    if (window.state[WINDOW_STATE_MAXIMIZED]()) {
      const restoreRect =
        window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
      const width = read(restoreRect.width);
      const height = read(restoreRect.height);
      const nextRect = this.restoreRectForMaximizedMove(event, width, height);
      if (event.phase === "start") {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          nextRect,
          WINDOW_MANAGEMENT_EASING,
          UNMAXIMIZE_GRAB_ANIMATION_DURATION,
        );
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(nextRect);
      }
      window.state[WINDOW_STATE_RESTORE_RECT].set(nextRect);
      workspace?.syncFloatingWindowRect(window, nextRect);

      if (event.phase === "end") {
        this.isGrabbing = false;
        window.unmaximize();
      } else if (event.phase === "cancel") {
        this.isGrabbing = false;
      }
      return;
    }

    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(event.currentRect);
    workspace?.syncFloatingWindowRect(window, event.currentRect);

    if (event.phase === "end" || event.phase === "cancel") {
      this.isGrabbing = false;
    }
    this.raiseTiledWorkspaceFloatingWindows(workspace);
  }

  private onFloatingWindowMove(event: WindowMoveEvent, workspace: Workspace) {
    const window = event.window;
    if (
      event.phase === "start" ||
      !this.floatingDrag ||
      this.floatingDrag.window.id !== window.id
    ) {
      this.isGrabbing = true;
      this.floatingDrag = {
        window,
        workspace,
        lastWorkspaceSwitchAt: event.timestamp,
      };
    }

    const drag = this.floatingDrag;
    if (!drag) {
      return;
    }

    let nextRect: ManagedWindowRect = event.currentRect;
    if (window.state[WINDOW_STATE_MAXIMIZED]()) {
      const restoreRect =
        window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
      const width = read(restoreRect.width);
      const height = read(restoreRect.height);
      nextRect = this.restoreRectForMaximizedMove(event, width, height);
      window.state[WINDOW_STATE_RESTORE_RECT].set(nextRect);
    }

    if (window.state[WINDOW_STATE_MAXIMIZED]() && event.phase === "start") {
      playRectAnimation(
        window,
        WINDOW_STATE_RECT,
        nextRect,
        WINDOW_MANAGEMENT_EASING,
        UNMAXIMIZE_GRAB_ANIMATION_DURATION,
      );
    } else {
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(nextRect);
    }

    if (event.phase !== "cancel") {
      const targetWorkspace = this.workspaceForFloatingDrag(event, drag);
      if (targetWorkspace !== drag.workspace) {
        drag.workspace.removeFloatingWindow(window);
        drag.workspace.applyLayout();
        targetWorkspace.adoptFloatingWindow(window, nextRect);
        drag.workspace = targetWorkspace;
        this.syncWorkspaceVisibility();
        window.focus();
      } else {
        targetWorkspace.syncFloatingWindowRect(window, nextRect);
      }

      this.raiseTiledWorkspaceFloatingWindows(targetWorkspace);
    }

    if (event.phase === "end" || event.phase === "cancel") {
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(nextRect);
      drag.workspace.syncFloatingWindowRect(window, nextRect);
      this.raiseTiledWorkspaceFloatingWindows(drag.workspace);
      this.floatingDrag = null;
      this.isGrabbing = false;
      if (event.phase === "end" && window.state[WINDOW_STATE_MAXIMIZED]()) {
        window.unmaximize();
      }
    }
  }

  private onTileWindowMove(event: WindowMoveEvent, workspace: Workspace) {
    const window = event.window;
    if (
      event.phase === "start" ||
      !this.tileDrag ||
      this.tileDrag.window.id !== window.id
    ) {
      this.isGrabbing = true;
      workspace.beginTileDrag(window, event.currentRect);
      this.tileDrag = {
        window,
        workspace,
        lastWorkspaceSwitchAt: event.timestamp,
      };
    }

    const drag = this.tileDrag;
    if (!drag) {
      return;
    }

    if (event.phase === "end" || event.phase === "cancel") {
      drag.workspace.endTileDrag(window, event.phase === "cancel");
      this.tileDrag = null;
      this.isGrabbing = false;
      return;
    }

    let targetWorkspace = this.workspaceForTileDrag(event, drag);
    if (targetWorkspace !== drag.workspace) {
      drag.workspace.removeTileDragWindow(window);
      drag.workspace.applyLayout();
      targetWorkspace.adoptTileDragWindow(window, event.currentRect);
      drag.workspace = targetWorkspace;
      this.syncWorkspaceVisibility();
    }

    targetWorkspace.updateTileDrag(
      window,
      event.currentRect,
      event.currentPointer.x,
    );
  }

  public onWindowMaximizeRequest(event: WindowMaximizeRequestEvent) {
    const workspace = this.findWorkspaceForWindow(event.window);
    if (this.isGrabbing) {
      return;
    }

    const window = event.window;
    window.state[WINDOW_STATE_MINIMIZED].set(false);

    if (workspace?.isTiled && workspace.shouldTile(window)) {
      if (!event.maximized) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
        window.state[WINDOW_STATE_MAXIMIZED].set(false);
        workspace.applyLayout();
        this.raiseTiledWorkspaceFloatingWindows(workspace);
        return;
      }

      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MAXIMIZED].set(true);
      workspace.focusWindow(window);
      workspace.applyLayout();
      this.raiseTiledWorkspaceFloatingWindows(workspace);
      window.focus();
      return;
    }

    if (!event.maximized) {
      const restoreRect = window.state[WINDOW_STATE_RESTORE_RECT]();
      if (restoreRect) {
        workspace?.syncFloatingWindowRect(window, restoreRect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          restoreRect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
      }
      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MAXIMIZED].set(false);
      return;
    }

    if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
      const currentRect = window.state[WINDOW_STATE_RECT]();
      const currentWidth = read(currentRect.width);
      const currentHeight = read(currentRect.height);
      if (currentWidth > 1 && currentHeight > 1) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(currentRect);
      }
    }
    const maximizedRect = this.maximizedRectForWindow(window);
    workspace?.syncFloatingWindowRect(window, maximizedRect);
    playRectAnimation(
      window,
      WINDOW_STATE_RECT,
      maximizedRect,
      WINDOW_MANAGEMENT_EASING,
      WINDOW_MANAGEMENT_ANIMATION_DURATION,
    );
    window.state[WINDOW_STATE_MAXIMIZED].set(true);
    this.raiseTiledWorkspaceFloatingWindows(workspace);
  }

  public onWindowMinimizeRequest(event: WindowMinimizeRequestEvent) {
    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    event.window.state[WINDOW_STATE_MINIMIZED].set(event.minimized);
    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace?.isTiled) {
      workspace.applyLayout();
      this.raiseTiledWorkspaceFloatingWindows(workspace);
    }
  }

  public onWindowActivateRequest(event: WindowActivateRequestEvent) {
    event.window.state[WINDOW_STATE_MINIMIZED].set(false);
    event.window.focus();
    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace) {
      this.activateWorkspace(workspace.monitor, workspace.index);
    }
  }

  public toggleCurrentWorkspaceTiling() {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace) {
        return;
      }
      workspace.setTiled(!workspace.isTiled);
      this.raiseTiledWorkspaceFloatingWindows(workspace);
    });
  }

  public focusTile(direction: -1 | 1) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace?.isTiled) {
        return;
      }
      workspace.focusRelative(direction);
      this.raiseTiledWorkspaceFloatingWindows(workspace);
    });
  }

  public closeFocusedWindow() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (focused) {
        focused.close();
        return;
      }
    }
  }

  public refreshUsableAreaLayouts() {
    this.syncWorkspaces();
    for (const workspace of this.workspaces.values()) {
      workspace.refreshUsableAreaLayout();
    }
    this.syncWorkspaceVisibility();
  }

  public switchWorkspace(direction: -1 | 1) {
    const monitor = this.currentMonitor || WINDOW_MANAGER.output.list.at(0);
    if (!monitor) {
      return;
    }
    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    this.switchWorkspaceTo(monitor, Math.max(1, currentIndex + direction));
  }

  /**
   * Animated switch to an explicit workspace index on a monitor. Direction is
   * inferred from the current index so the same vertical slide/fade transition
   * as keyboard/gesture switching plays (used by the IPC `workspaces.activate`).
   */
  public switchWorkspaceTo(monitor: string, targetIndex: number) {
    this.workspaceGesture = null;
    this.syncWorkspaces();
    if (!monitor || targetIndex < 1) {
      return;
    }

    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    if (targetIndex === currentIndex) {
      return;
    }
    const direction: -1 | 1 = targetIndex > currentIndex ? 1 : -1;

    const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
    const toWorkspace = this.ensureWorkspace(monitor, targetIndex);
    const distance = this.workspaceTransitionDistance(monitor);

    this.activeWorkspaceByMonitor.set(monitor, targetIndex);
    this.currentMonitor = monitor;

    for (const workspace of this.workspaces.values()) {
      if (workspace === fromWorkspace || workspace === toWorkspace) {
        continue;
      }
      workspace.setVisible(workspace.isActive());
    }

    fromWorkspace.animateWorkspaceTransition({
      fromOffsetY: 0,
      toOffsetY: -direction * distance,
      fromOpacity: 1,
      toOpacity: 0,
      visibleAfter: false,
    });
    toWorkspace.prepareWorkspaceTransition(direction * distance, 0);
    toWorkspace.applyLayout();
    toWorkspace.animateWorkspaceTransition({
      fromOffsetY: direction * distance,
      toOffsetY: 0,
      fromOpacity: 0,
      toOpacity: 1,
      visibleAfter: true,
    });
    toWorkspace.focusActiveWindow();
    this.raiseTiledWorkspaceFloatingWindows(fromWorkspace);
    this.raiseTiledWorkspaceFloatingWindows(toWorkspace);
  }

  public getCurrentWorkspace(): Workspace | undefined {
    this.syncWorkspaces();
    return (
      this.workspaceForMonitor(this.currentMonitor) ??
      this.workspaces.values().next().value
    );
  }

  /**
   * Compact per-monitor workspace view for external clients (the bar) over IPC.
   */
  public viewForIpc(): WorkspacesView {
    this.syncWorkspaces();

    const byMonitor = new Map<string, WorkspacesViewWorkspace[]>();
    for (const workspace of this.workspaces.values()) {
      const active =
        this.activeWorkspaceByMonitor.get(workspace.monitor) ===
        workspace.index;
      const list = byMonitor.get(workspace.monitor) ?? [];
      list.push({
        index: workspace.index,
        windowCount: workspace.windowCount(),
        isTiled: workspace.isTiled,
        active,
      });
      byMonitor.set(workspace.monitor, list);
    }

    const monitors: WorkspacesViewMonitor[] = WINDOW_MANAGER.output.list.map(
      (name) => {
        const active = this.activeWorkspaceByMonitor.get(name) ?? 1;
        // Only surface workspaces that have windows, plus the active one
        // (which stays visible even while empty). Bare, empty, non-active
        // workspaces are hidden from the list.
        const workspaces = (byMonitor.get(name) ?? []).filter(
          (workspace) => workspace.windowCount > 0 || workspace.active,
        );
        if (!workspaces.some((workspace) => workspace.index === active)) {
          workspaces.push({
            index: active,
            windowCount: 0,
            isTiled: false,
            active: true,
          });
        }
        workspaces.sort((a, b) => a.index - b.index);
        return { name, active, workspaces };
      },
    );

    return { currentMonitor: this.currentMonitor, monitors };
  }

  /**
   * Activate a specific workspace on a monitor (external/IPC entry point).
   * Plays the same slide/fade transition as keyboard/gesture switching.
   */
  public activate(monitor: string, index: number) {
    if (!monitor || index < 1) {
      return;
    }
    this.switchWorkspaceTo(monitor, index);
  }

  public getWindowZIndex(window: WaylandWindow): ReadonlySignal<number> {
    return this.windowStack.zIndex(window);
  }

  private raiseTiledWorkspaceFloatingWindows(workspace: Workspace | undefined) {
    if (!workspace?.isTiled) {
      return;
    }

    const floating = workspace
      .floatingWindows()
      .filter((window) => this.windowStack.has(window))
      .sort(
        (a, b) =>
          this.windowStack.zIndexValue(a) - this.windowStack.zIndexValue(b),
      );

    for (const window of floating) {
      this.windowStack.raise(window);
    }
  }

  private syncWorkspaces() {
    for (const monitor of WINDOW_MANAGER.output.list) {
      if (!this.activeWorkspaceByMonitor.has(monitor)) {
        this.activeWorkspaceByMonitor.set(monitor, 1);
      }
      this.ensureWorkspace(
        monitor,
        this.activeWorkspaceByMonitor.get(monitor) ?? 1,
      );
    }

    if (
      !this.currentMonitor ||
      !WINDOW_MANAGER.output.list.includes(this.currentMonitor)
    ) {
      this.currentMonitor = WINDOW_MANAGER.output.list.at(0) ?? "";
    }
  }

  private workspaceForMonitor(monitor: string): Workspace | undefined {
    if (!monitor) {
      return undefined;
    }
    return this.ensureWorkspace(
      monitor,
      this.activeWorkspaceByMonitor.get(monitor) ?? 1,
    );
  }

  private ensureWorkspace(monitor: string, index: number): Workspace {
    const key = workspaceKey(monitor, index);
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      workspace = new Workspace(
        index,
        monitor,
        this.naturalRootRect,
        (window) => this.maximizedRectForWindow(window),
        (monitor) => this.getActiveWorkspaceIndex(monitor),
      );
      this.workspaces.set(key, workspace);
    }
    return workspace;
  }

  private getActiveWorkspaceIndex(monitor: string): number {
    return this.activeWorkspaceByMonitor.get(monitor) ?? 1;
  }

  private gestureMonitor(event: GestureSwipeEvent): string {
    const outputName = event.outputName;
    if (outputName && WINDOW_MANAGER.output.list.includes(outputName)) {
      return outputName;
    }
    return this.currentMonitor || WINDOW_MANAGER.output.list.at(0) || "";
  }

  private resolveWorkspaceGestureMode(
    event: GestureSwipeEvent,
  ): WorkspaceGestureMode | null {
    if (this.workspaceGestureMode) {
      return this.workspaceGestureMode;
    }

    const absX = Math.abs(event.totalX);
    const absY = Math.abs(
      event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor,
    );
    const scaledAbsX = absX * this.workspaceGestureSpeed.workspaceScrollFactor;
    if (Math.max(scaledAbsX, absY) < WORKSPACE_GESTURE_AXIS_LOCK_PX) {
      return null;
    }

    this.workspaceGestureMode =
      scaledAbsX > absY ? "workspace-scroll" : "workspace-switch";
    if (this.workspaceGestureMode === "workspace-scroll") {
      this.workspaceScrollGestureRectAnimationsCancelled = false;
    }
    return this.workspaceGestureMode;
  }

  private updateWorkspaceScrollGesture(event: GestureSwipeEvent) {
    const monitor = this.gestureMonitor(event);
    const workspace = this.workspaceForMonitor(monitor);
    if (!workspace?.isTiled) {
      return;
    }

    this.currentMonitor = monitor;
    workspace.stopKineticScroll();
    const deltaX =
      -event.deltaX * this.workspaceGestureSpeed.workspaceScrollFactor;
    const shouldCancelRectAnimations =
      !this.workspaceScrollGestureRectAnimationsCancelled;
    const scrolled = workspace.scrollBy(deltaX, {
      stopKinetic: false,
      cancelRectAnimations: shouldCancelRectAnimations,
    });
    if (scrolled && shouldCancelRectAnimations) {
      this.workspaceScrollGestureRectAnimationsCancelled = true;
    }
    this.focusTiledWindowAtPointer(
      event.position ?? this.lastPointerPosition,
      monitor,
    );
    this.raiseTiledWorkspaceFloatingWindows(workspace);
  }

  private finishWorkspaceScrollGesture(event: GestureSwipeEvent) {
    if (event.phase !== "end") {
      return;
    }

    const monitor = this.gestureMonitor(event);
    const workspace = this.workspaceForMonitor(monitor);
    if (!workspace?.isTiled) {
      return;
    }

    workspace.startKineticScroll(
      -event.velocityX *
        this.workspaceGestureSpeed.workspaceScrollKineticFactor,
      () => {
        this.focusTiledWindowAtPointer(
          event.position ?? this.lastPointerPosition,
          monitor,
        );
        this.raiseTiledWorkspaceFloatingWindows(workspace);
      },
    );
  }

  private updateWorkspaceGesture(event: GestureSwipeEvent) {
    const monitor = this.gestureMonitor(event);
    if (!monitor) {
      return;
    }

    const distance = Math.max(1, this.workspaceTransitionDistance(monitor));
    const scaledTotalY =
      event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor;
    const rawOffsetY = clamp(scaledTotalY, -distance, distance);
    if (Math.abs(rawOffsetY) < 1) {
      return;
    }

    const direction: -1 | 1 = rawOffsetY < 0 ? 1 : -1;
    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const nextIndex = currentIndex + direction;
    const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
    const toWorkspace =
      nextIndex >= 1 ? this.ensureWorkspace(monitor, nextIndex) : null;
    const targetChanged =
      this.workspaceGesture?.monitor !== monitor ||
      this.workspaceGesture.currentIndex !== currentIndex ||
      this.workspaceGesture.toWorkspace !== toWorkspace;

    this.currentMonitor = monitor;

    if (!toWorkspace) {
      if (targetChanged) {
        for (const workspace of this.workspaces.values()) {
          if (workspace === fromWorkspace) {
            continue;
          }
          workspace.setVisible(workspace.isActive());
        }
      }
      const resistanceOffsetY = rawOffsetY * 0.25;
      fromWorkspace.setWorkspaceGestureVisual(resistanceOffsetY, 1);
      this.workspaceGesture = {
        monitor,
        currentIndex,
        direction,
        distance,
        fromWorkspace,
        toWorkspace: null,
        fromOffsetY: resistanceOffsetY,
        toOffsetY: direction * distance,
        fromOpacity: 1,
        toOpacity: 0,
      };
      return;
    }

    const progress = clamp(Math.abs(rawOffsetY) / distance, 0, 1);
    const toOffsetY = direction * distance + rawOffsetY;
    const fromOpacity = 1 - progress;
    const toOpacity = progress;

    if (targetChanged) {
      for (const workspace of this.workspaces.values()) {
        if (workspace === fromWorkspace || workspace === toWorkspace) {
          continue;
        }
        workspace.setVisible(workspace.isActive());
      }
      toWorkspace.applyLayout();
    }

    fromWorkspace.setWorkspaceGestureVisual(rawOffsetY, fromOpacity);
    toWorkspace.setWorkspaceGestureVisual(toOffsetY, toOpacity);
    this.raiseTiledWorkspaceFloatingWindows(fromWorkspace);
    this.raiseTiledWorkspaceFloatingWindows(toWorkspace);

    this.workspaceGesture = {
      monitor,
      currentIndex,
      direction,
      distance,
      fromWorkspace,
      toWorkspace,
      fromOffsetY: rawOffsetY,
      toOffsetY,
      fromOpacity,
      toOpacity,
    };
  }

  private finishWorkspaceGesture(event: GestureSwipeEvent) {
    const gesture = this.workspaceGesture;
    this.workspaceGesture = null;
    if (!gesture) {
      return;
    }

    const shouldCommit =
      event.phase === "end" &&
      gesture.toWorkspace !== null &&
      (Math.abs(
        event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor,
      ) >=
        gesture.distance * WORKSPACE_GESTURE_THRESHOLD_RATIO ||
        Math.abs(
          event.velocityY *
            this.workspaceGestureSpeed.workspaceSwitchVelocityFactor,
        ) >= WORKSPACE_GESTURE_VELOCITY_THRESHOLD);

    if (shouldCommit && gesture.toWorkspace) {
      this.activeWorkspaceByMonitor.set(
        gesture.monitor,
        gesture.currentIndex + gesture.direction,
      );
      this.currentMonitor = gesture.monitor;
      gesture.fromWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.fromOffsetY,
        toOffsetY: -gesture.direction * gesture.distance,
        fromOpacity: gesture.fromOpacity,
        toOpacity: 0,
        visibleAfter: false,
      });
      gesture.toWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.toOffsetY,
        toOffsetY: 0,
        fromOpacity: gesture.toOpacity,
        toOpacity: 1,
        visibleAfter: true,
      });
      gesture.toWorkspace.focusActiveWindow();
      this.raiseTiledWorkspaceFloatingWindows(gesture.fromWorkspace);
      this.raiseTiledWorkspaceFloatingWindows(gesture.toWorkspace);
      return;
    }

    gesture.fromWorkspace.animateWorkspaceTransition({
      fromOffsetY: gesture.fromOffsetY,
      toOffsetY: 0,
      fromOpacity: gesture.fromOpacity,
      toOpacity: 1,
      visibleAfter: true,
    });
    if (gesture.toWorkspace) {
      gesture.toWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.toOffsetY,
        toOffsetY: gesture.direction * gesture.distance,
        fromOpacity: gesture.toOpacity,
        toOpacity: 0,
        visibleAfter: false,
      });
    }
    this.raiseTiledWorkspaceFloatingWindows(gesture.fromWorkspace);
  }

  private focusTiledWindowAtPointer(
    position: PointerMoveEvent["position"] | null | undefined,
    monitorHint?: string,
  ) {
    if (!position) {
      return;
    }

    const monitor =
      monitorHint && WINDOW_MANAGER.output.list.includes(monitorHint)
        ? monitorHint
        : (this.outputNameAt(position.x, position.y) ?? this.currentMonitor);
    const workspace = this.workspaceForMonitor(monitor);
    if (!workspace?.isTiled || !workspace.isActive()) {
      return;
    }

    const focused = workspace.focusWindowAtPoint(position.x, position.y);
    if (!focused) {
      return;
    }

    this.currentMonitor = monitor;
    this.raiseTiledWorkspaceFloatingWindows(workspace);
  }

  private availableWorkspaceIndex(monitor: string, preferredIndex: number) {
    if (!this.workspaces.has(workspaceKey(monitor, preferredIndex))) {
      return preferredIndex;
    }
    let index = 1;
    while (this.workspaces.has(workspaceKey(monitor, index))) {
      index += 1;
    }
    return index;
  }

  private activateWorkspace(monitor: string, index: number) {
    this.activeWorkspaceByMonitor.set(monitor, index);
    const workspace = this.ensureWorkspace(monitor, index);
    this.currentMonitor = monitor;
    this.syncWorkspaceVisibility();
    workspace.applyLayout();
    workspace.focusActiveWindow();
    this.raiseTiledWorkspaceFloatingWindows(workspace);
  }

  private syncWorkspaceVisibility() {
    for (const workspace of this.workspaces.values()) {
      workspace.setVisible(workspace.isActive());
    }
  }

  private findWorkspaceForWindow(window: WaylandWindow): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.hasWindow(window)) {
        return workspace;
      }
    }
    return undefined;
  }

  private findWorkspaceRestoringWindow(
    window: WaylandWindow,
  ): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.isRestoringWindow(window.id)) {
        return workspace;
      }
    }
    return undefined;
  }

  private workspaceForTileDrag(
    event: WindowMoveEvent,
    drag: NonNullable<HybridWindowManager["tileDrag"]>,
  ): Workspace {
    const monitor =
      event.outputName && WINDOW_MANAGER.output.list.includes(event.outputName)
        ? event.outputName
        : drag.workspace.monitor;
    let index = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const edgeDirection = this.tileDragWorkspaceEdgeDirection(
      monitor,
      event.currentPointer.y,
    );

    if (
      edgeDirection !== 0 &&
      event.timestamp - drag.lastWorkspaceSwitchAt >=
        TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS
    ) {
      const nextIndex = Math.max(1, index + edgeDirection);
      if (nextIndex !== index) {
        this.currentMonitor = monitor;
        this.switchWorkspace(edgeDirection);
        drag.lastWorkspaceSwitchAt = event.timestamp;
        index = this.activeWorkspaceByMonitor.get(monitor) ?? nextIndex;
      }
    }

    return this.ensureWorkspace(monitor, index);
  }

  private workspaceForFloatingDrag(
    event: WindowMoveEvent,
    drag: NonNullable<HybridWindowManager["floatingDrag"]>,
  ): Workspace {
    const monitor =
      event.outputName && WINDOW_MANAGER.output.list.includes(event.outputName)
        ? event.outputName
        : drag.workspace.monitor;
    let index = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const edgeDirection = this.tileDragWorkspaceEdgeDirection(
      monitor,
      event.currentPointer.y,
    );

    if (
      edgeDirection !== 0 &&
      event.timestamp - drag.lastWorkspaceSwitchAt >=
        TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS
    ) {
      const nextIndex = Math.max(1, index + edgeDirection);
      if (nextIndex !== index) {
        this.currentMonitor = monitor;
        this.switchWorkspace(edgeDirection);
        drag.lastWorkspaceSwitchAt = event.timestamp;
        index = this.activeWorkspaceByMonitor.get(monitor) ?? nextIndex;
      }
    }

    return this.ensureWorkspace(monitor, index);
  }

  private tileDragWorkspaceEdgeDirection(
    monitor: string,
    y: number,
  ): -1 | 0 | 1 {
    const rect = this.workspaceViewportRect(monitor);
    const top = read(rect.y);
    const height = read(rect.height);
    if (y < top + TILE_DRAG_WORKSPACE_EDGE_PX) {
      return -1;
    }
    if (y > top + height - TILE_DRAG_WORKSPACE_EDGE_PX) {
      return 1;
    }
    return 0;
  }

  private workspaceTransitionDistance(monitor: string): number {
    return read(this.workspaceViewportRect(monitor).height);
  }

  private workspaceViewportRect(monitor: string): ManagedWindowRect {
    const usable = WINDOW_MANAGER.layer.usableArea(monitor);
    if (usable) {
      return usable;
    }

    const output = WINDOW_MANAGER.output.current[monitor];
    if (output?.resolution) {
      return {
        x: output.position.x,
        y: output.position.y,
        width: output.resolution.width / output.scale,
        height: output.resolution.height / output.scale,
      };
    }

    return {
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    };
  }

  private constrainResizeRect(event: WindowResizeEvent): ManagedWindowRect {
    const constraints = event.window.sizeConstraints();
    const extra = this.clientToRootSizeExtra(event.window);
    const minWidth = Math.max(1, constraints.min?.width ?? 1) + extra.width;
    const minHeight = Math.max(1, constraints.min?.height ?? 1) + extra.height;
    const maxWidth = constrainedMax(constraints, "width", extra.width);
    const maxHeight = constrainedMax(constraints, "height", extra.height);

    const width = clamp(
      event.currentRect.width,
      minWidth,
      Math.max(minWidth, maxWidth),
    );
    const height = clamp(
      event.currentRect.height,
      minHeight,
      Math.max(minHeight, maxHeight),
    );

    return {
      x: resizeOriginForAxis(
        event.startRect,
        event.currentRect,
        width,
        event.edges.left,
        "x",
      ),
      y: resizeOriginForAxis(
        event.startRect,
        event.currentRect,
        height,
        event.edges.top,
        "y",
      ),
      width,
      height,
    };
  }

  private clientToRootSizeExtra(window: WaylandWindow): {
    width: number;
    height: number;
  } {
    const natural = this.naturalRootRect(window);
    return {
      width: Math.max(0, read(natural.width) - window.position.width),
      height: Math.max(0, read(natural.height) - window.position.height),
    };
  }

  private maximizedRectForWindow(window: WaylandWindow): ManagedWindowRect {
    const rect = window.state[WINDOW_STATE_RECT]();
    const centerX = read(rect.x) + read(rect.width) / 2;
    const centerY = read(rect.y) + read(rect.height) / 2;
    const outputName =
      this.outputNameAt(centerX, centerY) ?? this.currentMonitor;
    const output = outputName
      ? WINDOW_MANAGER.output.current[outputName]
      : undefined;
    const usable = outputName
      ? WINDOW_MANAGER.layer.usableArea(outputName)
      : undefined;

    if (usable) {
      return insetRect(
        {
          x: usable.x,
          y: usable.y,
          width: usable.width,
          height: usable.height,
        },
        MAXIMIZED_WINDOW_PADDING,
      );
    }
    if (output?.resolution) {
      return insetRect(
        {
          x: output.position.x,
          y: output.position.y,
          width: output.resolution.width / output.scale,
          height: output.resolution.height / output.scale,
        },
        MAXIMIZED_WINDOW_PADDING,
      );
    }
    return rect;
  }

  private initialRestoreRectForMaximizedWindow(
    window: WaylandWindow,
  ): ManagedWindowRect {
    const maximizedRect = this.maximizedRectForWindow(window);
    const width = Math.max(1, read(maximizedRect.width) * 0.7);
    const height = Math.max(1, read(maximizedRect.height) * 0.7);
    return {
      x: read(maximizedRect.x) + (read(maximizedRect.width) - width) / 2,
      y: read(maximizedRect.y) + (read(maximizedRect.height) - height) / 2,
      width,
      height,
    };
  }

  private restoreRectForMaximizedMove(
    event: WindowMoveEvent,
    width: number,
    height: number,
  ): ManagedWindowRect {
    const pointer = event.currentPointer;
    const titlebarCenterY = WINDOW_BORDER_PX + TITLEBAR_HEIGHT / 2;
    const pointerOffsetY =
      event.source === "modifier"
        ? height / 2
        : Math.min(height / 2, titlebarCenterY);

    return {
      x: pointer.x - width / 2,
      y: pointer.y - pointerOffsetY,
      width,
      height,
    };
  }

  private outputNameAt(x: number, y: number): string | undefined {
    for (const name of WINDOW_MANAGER.output.list) {
      const output = WINDOW_MANAGER.output.current[name];
      if (!output?.resolution) {
        continue;
      }
      const width = output.resolution.width / output.scale;
      const height = output.resolution.height / output.scale;
      if (
        x >= output.position.x &&
        y >= output.position.y &&
        x < output.position.x + width &&
        y < output.position.y + height
      ) {
        return name;
      }
    }
    return undefined;
  }
}

export class Workspace {
  public index: number;
  private readonly windows: WaylandWindow[] = [];
  private readonly naturalRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly maximizedRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly activeWorkspaceIndex: (monitor: string) => number;
  private readonly tileWidthByWindowId = new Map<string, number>();
  private readonly restoredWindowStateById = new Map<
    string,
    WorkspaceWindowSnapshot
  >();
  private activeWindowId: string | null = null;
  private visibilityAnimationToken = 0;
  private draggingWindowId: string | null = null;
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
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
        continue;
      }

      if (!this.isTiled || !this.shouldTile(window)) {
        const rect = this.clampRectToViewport(
          window.state[WINDOW_STATE_RECT](),
        );
        window.state[WINDOW_STATE_RECT].set(rect);
        window.state[WINDOW_STATE_FLOATING_RECT].set(
          this.isTiled ? this.viewportRectToFloatingContentRect(rect) : null,
        );
      }
    }
  }

  public addWindow(window: WaylandWindow): boolean {
    if (this.windows.map((window) => window.id).includes(window.id)) {
      hotReloadDebug("workspace-add-existing-skip", {
        monitor: this.monitor,
        index: this.index,
        windowId: window.id,
        windowIds: this.windows.map((window) => window.id),
      });
      return false;
    }
    this.windows.push(window);
    const restored = this.restoredWindowStateById.get(window.id);
    this.activeWindowId = restored ? this.activeWindowId : window.id;
    if (restored) {
      window.cancelAnimation();
      hotReloadDebug("workspace-add-restored-cancel-animation", {
        monitor: this.monitor,
        index: this.index,
        windowId: window.id,
        activeWindowId: this.activeWindowId,
        restoredWindowIds: Array.from(this.restoredWindowStateById.keys()),
        windowIds: this.windows.map((window) => window.id),
      });
      this.restoredWindowStateById.delete(window.id);
      window.state[WINDOW_STATE_FLOATING_RECT].set(
        restored.floatingRect ?? null,
      );
      window.state[WINDOW_STATE_RESTORE_RECT].set(restored.restoreRect ?? null);
      window.state[WINDOW_STATE_MINIMIZED].set(restored.minimized);
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

    if (!WINDOW_MANAGER.output.list.includes(this.monitor)) {
      return restored !== undefined;
    }

    if (restored?.floatingRect && !this.isTiled) {
      window.state[WINDOW_STATE_RECT].set(restored.floatingRect);
    } else if (this.isTiled && this.shouldTile(window)) {
      const initialRect = this.centeredFloatingRect(window);
      window.state[WINDOW_STATE_FLOATING_RECT].set(
        restored?.floatingRect ?? initialRect,
      );
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
      const contentRect =
        restored?.floatingRect ??
        this.viewportRectToFloatingContentRect(initialRect);
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      window.state[WINDOW_STATE_RECT].set(
        this.floatingContentRectToViewportRect(contentRect),
      );
    } else {
      window.state[WINDOW_STATE_RECT].set(this.centeredFloatingRect(window));
    }
    hotReloadDebug("workspace-add-window", {
      monitor: this.monitor,
      index: this.index,
      windowId: window.id,
      restored: restored !== undefined,
      isTiledWorkspace: this.isTiled,
      shouldTile: this.shouldTile(window),
      activeWindowId: this.activeWindowId,
      windowIds: this.windows.map((window) => window.id),
      rect: window.state[WINDOW_STATE_RECT](),
      floatingRect: window.state[WINDOW_STATE_FLOATING_RECT](),
    });
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
        nextFocus =
          this.tileableWindows()[
            Math.min(index, this.tileableWindows().length - 1)
          ] ?? null;
        this.activeWindowId = nextFocus?.id ?? null;
      }
      return nextFocus;
    }
    return undefined;
  }

  public removeTileDragWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }
    this.windows.splice(index, 1);
    this.draggingWindowId = null;
  }

  public removeFloatingWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }
    this.windows.splice(index, 1);
    if (this.activeWindowId === window.id) {
      this.activeWindowId =
        this.activeWindow(this.tileableWindows())?.id ?? null;
    }
  }

  public hasWindow(window: WaylandWindow): boolean {
    return this.windows.some((current) => current.id === window.id);
  }

  public windowCount(): number {
    return this.windows.length;
  }

  public isRestoringWindow(windowId: string): boolean {
    return this.restoredWindowStateById.has(windowId);
  }

  public isActive(): boolean {
    return this.activeWorkspaceIndex(this.monitor) === this.index;
  }

  public refreshUsableAreaLayout() {
    if (!WINDOW_MANAGER.output.list.includes(this.monitor)) {
      return;
    }

    if (this.isTiled) {
      this.applyLayout({
        suppressSSDRebuild: false,
        animate: false,
        preserveMissingActive: true,
      });
      return;
    }

    for (const window of this.windows) {
      if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
        continue;
      }
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
      // Same ordering rule as prepare: schedule first, then flip
      // VISIBLE. For from-workspace this is mostly a no-op (VISIBLE was
      // already true), but for to-workspace's second call this keeps
      // the same invariant in case prepareWorkspaceTransition's hold
      // animation has already completed (e.g., rapid switches).
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

    setTimeout(
      () => {
        if (this.visibilityAnimationToken !== token) {
          return;
        }
        withManagedWindowOnlySSDRebuildSuppressed(() => {
          this.setVisible(options.visibleAfter);
        });
      },
      Math.max(
        0,
        WORKSPACE_SWITCH_ANIMATION_DURATION - VISIBILITY_COMMIT_BEFORE_END_MS,
      ),
    );
  }

  public setTiled(tiled: boolean) {
    if (this.isTiled === tiled) {
      return;
    }

    this.stopKineticScroll();

    const focusedWindow = this.focusedWindow();
    const focusedTileableWindow =
      focusedWindow &&
      this.shouldTile(focusedWindow) &&
      !focusedWindow.state[WINDOW_STATE_MINIMIZED]()
        ? focusedWindow
        : undefined;
    this.isTiled = tiled;
    if (tiled) {
      this.scrollOffset = 0;
      for (const window of this.tileableWindows()) {
        this.captureFloatingRect(window);
        this.setTileWidthFromRect(
          window,
          window.state[WINDOW_STATE_FLOATING_RECT]() ??
            window.state[WINDOW_STATE_RECT](),
          true,
        );
      }
      for (const window of this.floatingWindows()) {
        this.captureFloatingRect(window);
      }
      const tileable = this.tileableWindows();
      const previousActiveWindow = this.activeWindow(tileable);
      this.activeWindowId =
        (focusedTileableWindow ?? previousActiveWindow ?? tileable.at(0))?.id ??
        null;
      if (focusedTileableWindow) {
        this.scrollToWindow(focusedTileableWindow);
      }
      this.applyLayout();
      focusedTileableWindow?.focus();
      return;
    }

    for (const window of this.windows) {
      const rect = window.state[WINDOW_STATE_FLOATING_RECT]();
      if (rect) {
        const viewportRect = this.shouldTile(window)
          ? rect
          : this.floatingContentRectToViewportRect(rect);
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
    if (!this.isTiled) {
      return;
    }

    const tileable = this.tileableWindows();
    const animate = options.animate ?? true;
    const suppressSSDRebuild = options.suppressSSDRebuild ?? true;
    const canSuppress = this.canSuppressLayoutSSDRebuild(tileable);
    const animationOptions =
      animate && suppressSSDRebuild && canSuppress
        ? MANAGED_WINDOW_ONLY_ANIMATION
        : undefined;

    if (tileable.length === 0) {
      this.activeWindowId = null;
      hotReloadDebug("workspace-apply-layout-empty", {
        monitor: this.monitor,
        index: this.index,
        animate,
        suppressSSDRebuild,
        canSuppress,
        floatingWindowIds: this.floatingWindows().map((window) => window.id),
      });
      this.applyFloatingLayout(animationOptions, animate);
      return;
    }

    if (
      !this.activeWindowId ||
      !tileable.some((window) => window.id === this.activeWindowId)
    ) {
      if (!options.preserveMissingActive) {
        this.activeWindowId = tileable.at(-1)?.id ?? null;
      }
    }

    this.clampScrollOffset(tileable.length);

    const viewportRect = this.tileViewportRect();
    const tileHeight = read(viewportRect.height);
    let nextX = read(viewportRect.x) - this.scrollOffset;
    const appliedRects: Record<string, ManagedWindowRect> = {};

    tileable.forEach((window, index) => {
      const tileWidth = this.tileWidthForWindow(window, viewportRect);
      const rect = window.state[WINDOW_STATE_MAXIMIZED]()
        ? this.maximizedTileRect(window, nextX)
        : {
            x: nextX,
            y: read(viewportRect.y),
            width: tileWidth,
            height: tileHeight,
          };
      appliedRects[window.id] = rect;
      if (window.id !== this.draggingWindowId) {
        if (animate) {
          playRectAnimation(
            window,
            WINDOW_STATE_RECT,
            rect,
            WINDOW_MANAGEMENT_EASING,
            TILE_ANIMATION_DURATION,
            animationOptions,
          );
        } else {
          if (options.cancelRectAnimations !== false) {
            stopRectAnimation(window, WINDOW_STATE_RECT);
          }
          window.state[WINDOW_STATE_RECT].set(rect);
        }
      }
      nextX += tileWidth + (index === tileable.length - 1 ? 0 : TILE_GAP);
    });

    hotReloadDebug("workspace-apply-layout", {
      monitor: this.monitor,
      index: this.index,
      animate,
      suppressSSDRebuild,
      canSuppress,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      tileableWindowIds: tileable.map((window) => window.id),
      floatingWindowIds: this.floatingWindows().map((window) => window.id),
      appliedRects,
    });
    this.applyFloatingLayout(animationOptions, animate);
  }

  public resizeTile(event: WindowResizeEvent) {
    const tileable = this.tileableWindows();
    if (!tileable.some((window) => window.id === event.window.id)) {
      return;
    }

    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    this.activeWindowId = event.window.id;

    const viewportRect = this.tileViewportRect();
    const minWidth = this.minTileWidth(event.window, viewportRect);
    const maxWidth = this.maxTileWidth(event.window);
    const width = clamp(
      event.currentRect.width,
      minWidth,
      Math.max(minWidth, maxWidth),
    );
    this.tileWidthByWindowId.set(event.window.id, width);
    this.scrollToWindow(event.window);
    this.applyLayout();
  }

  public beginTileDrag(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.shouldTile(window)) {
      return;
    }
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    window.state[WINDOW_STATE_MAXIMIZED].set(false);
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
    if (!this.hasWindow(window)) {
      this.windows.push(window);
    }
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
    if (!this.hasWindow(window)) {
      this.windows.push(window);
    }
    const visible = this.isActive();
    this.syncWindowVisibleOutputs(window);
    resetWorkspaceVisualState(window, visible);
    window.state[WINDOW_STATE_FLOATING_RECT].set(
      this.viewportRectToFloatingContentRect(rect),
    );
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  public updateTileDrag(
    window: WaylandWindow,
    rect: ManagedWindowRect,
    pointerX: number,
  ) {
    if (this.draggingWindowId !== window.id) {
      this.beginTileDrag(window, rect);
    }
    this.activeWindowId = window.id;
    this.moveTileWindowToIndex(
      window,
      this.tileInsertionIndexForPointer(window, pointerX),
    );
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
    this.scrollToWindow(window);
    this.applyLayout();
  }

  public endTileDrag(window: WaylandWindow, cancelled: boolean) {
    if (this.draggingWindowId !== window.id) {
      return;
    }
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
    if (!cancelled && this.isActive()) {
      window.focus();
    }
  }

  public focusWindow(window: WaylandWindow) {
    if (!this.shouldTile(window)) {
      return;
    }
    if (this.activeWindowId === window.id) {
      return;
    }
    this.activeWindowId = window.id;
    this.scrollToWindow(window);
    this.applyLayout();
  }

  public focusWindowAtPoint(x: number, y: number): WaylandWindow | undefined {
    if (!this.isTiled) {
      return undefined;
    }

    const window = this.tileableWindowAtPoint(x, y);
    if (!window) {
      return undefined;
    }

    if (this.activeWindowId === window.id && read(window.isFocused)) {
      return undefined;
    }

    const previousActiveWindowId = this.activeWindowId;
    this.activeWindowId = window.id;
    window.focus();
    if (previousActiveWindowId !== window.id) {
      this.reapplyStaticManagedLayout();
    }
    return window;
  }

  private reapplyStaticManagedLayout(): void {
    if (!this.isTiled) {
      return;
    }

    const tileable = this.tileableWindows();
    if (tileable.length === 0) {
      return;
    }

    withManagedWindowOnlySSDRebuildSuppressed(
      () => {
        this.applyLayout({
          animate: false,
          preserveMissingActive: true,
          cancelRectAnimations: false,
        });
      },
      { strict: true },
    );
    for (const window of tileable) {
      markManagedWindowDirty(window.id);
    }
  }

  public scrollBy(
    deltaX: number,
    options: {
      stopKinetic?: boolean;
      suppressSSDRebuild?: boolean;
      cancelRectAnimations?: boolean;
    } = {},
  ): boolean {
    if (!this.isTiled || deltaX === 0) {
      return false;
    }
    if (options.stopKinetic !== false) {
      this.stopKineticScroll();
    }

    const before = this.scrollOffset;
    this.scrollOffset += deltaX;
    const tileable = this.tileableWindows();
    this.clampScrollOffset(tileable.length);
    if (this.scrollOffset === before) {
      return false;
    }

    const cancelRectAnimations = options.cancelRectAnimations ?? true;
    const apply = () =>
      this.applyLayout({
        animate: false,
        preserveMissingActive: true,
        cancelRectAnimations,
      });
    if (options.suppressSSDRebuild === false) {
      apply();
    } else {
      withManagedWindowOnlySSDRebuildSuppressed(apply, { strict: true });
    }
    for (const window of tileable) {
      markManagedWindowDirty(window.id);
    }
    return true;
  }

  public startKineticScroll(
    initialVelocityX: number,
    onFrame?: () => void,
  ): void {
    this.stopKineticScroll();
    if (
      !this.isTiled ||
      Math.abs(initialVelocityX) < WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY
    ) {
      return;
    }

    let velocityX = clamp(
      initialVelocityX,
      -WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY,
      WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY,
    );
    let lastTime: number | null = null;
    const token = this.kineticScrollToken + 1;
    this.kineticScrollToken = token;
    const intervalMs = this.kineticScrollIntervalMs();
    let firstStep = true;

    const step = (dtMs: number): boolean => {
      const deltaX = (velocityX * dtMs) / 1000;
      const scrolled = this.scrollBy(deltaX, {
        stopKinetic: false,
        cancelRectAnimations: firstStep,
      });
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

    if (!step(intervalMs)) {
      return;
    }

    this.kineticScrollPoll = createManagedPoll(
      intervalMs,
      (handle) => {
        if (this.kineticScrollToken !== token || !this.isTiled) {
          handle.cancel();
          if (this.kineticScrollPoll === handle) {
            this.kineticScrollPoll = null;
          }
          return;
        }

        const now = handle.nowMs;
        const dtMs = Math.max(
          1,
          lastTime === null ? intervalMs : now - lastTime,
        );
        lastTime = now;
        step(dtMs);
      },
      "none",
    );
  }

  public stopKineticScroll(): void {
    this.kineticScrollToken += 1;
    if (this.kineticScrollPoll) {
      this.kineticScrollPoll.cancel();
      this.kineticScrollPoll = null;
    }
  }

  private kineticScrollIntervalMs(): number {
    const refreshRate =
      WINDOW_MANAGER.output.current[this.monitor]?.resolution?.refreshRate ??
      WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE;
    return 1000 / Math.max(1, refreshRate);
  }

  public focusRelative(direction: -1 | 1) {
    const tileable = this.tileableWindows();
    if (tileable.length === 0) {
      return;
    }
    const currentIndex = Math.max(
      0,
      tileable.findIndex((window) => window.id === this.activeWindowId),
    );
    const nextIndex = clamp(currentIndex + direction, 0, tileable.length - 1);
    this.activeWindowId = tileable[nextIndex].id;
    this.scrollToWindow(tileable[nextIndex]);
    this.applyLayout();
    this.focusActiveWindow();
  }

  public focusActiveWindow() {
    const active = this.windows.find(
      (window) => window.id === this.activeWindowId,
    );
    active?.focus();
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
      windows: this.windows.map((window) => ({
        id: window.id,
        tileWidth: this.tileWidthByWindowId.get(window.id),
        floatingRect: window.state[WINDOW_STATE_FLOATING_RECT](),
        restoreRect: window.state[WINDOW_STATE_RESTORE_RECT](),
        minimized: window.state[WINDOW_STATE_MINIMIZED](),
        maximized: window.state[WINDOW_STATE_MAXIMIZED](),
      })),
    };
  }

  public restore(snapshot: WorkspaceSnapshot) {
    this.isTiled = snapshot.isTiled;
    this.activeWindowId = snapshot.activeWindowId;
    this.scrollOffset = snapshot.scrollOffset;
    this.tileWidthByWindowId.clear();
    this.restoredWindowStateById.clear();
    for (const window of snapshot.windows) {
      if (window.tileWidth !== undefined) {
        this.tileWidthByWindowId.set(window.id, window.tileWidth);
      }
      this.restoredWindowStateById.set(window.id, window);
    }
    hotReloadDebug("workspace-restore", {
      monitor: this.monitor,
      index: this.index,
      isTiled: this.isTiled,
      activeWindowId: this.activeWindowId,
      scrollOffset: this.scrollOffset,
      restoredWindowIds: Array.from(this.restoredWindowStateById.keys()),
    });
  }

  public getWindows(): WaylandWindow[] {
    return Array.from(this.windows);
  }

  private syncWindowVisibleOutputs(window: WaylandWindow) {
    window.state[WINDOW_STATE_VISIBLE_OUTPUTS].set(
      this.isTiled && !window.state[WINDOW_STATE_TILE_DRAGGING]()
        ? [this.monitor]
        : null,
    );
  }

  private canSuppressLayoutSSDRebuild(_tileable: WaylandWindow[]): boolean {
    // Opening windows may still be building decoration structure, labels,
    // icons, and shader inputs. SSD rebuild suppression is global, so using
    // it for existing windows' layout animation would also hide those
    // initial decoration updates until an unrelated interaction occurs.
    return true;
  }

  private tileableWindows(): WaylandWindow[] {
    return this.windows.filter(
      (window) =>
        this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED](),
    );
  }

  public focusedWindow(): WaylandWindow | undefined {
    return this.windows.find((window) => read(window.isFocused));
  }

  public syncFloatingWindowRect(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
  ) {
    if (!this.isTiled || this.shouldTile(window)) {
      return;
    }
    window.state[WINDOW_STATE_FLOATING_RECT].set(
      this.viewportRectToFloatingContentRect(viewportRect),
    );
  }

  private activeWindow(windows = this.windows): WaylandWindow | undefined {
    return windows.find((window) => window.id === this.activeWindowId);
  }

  private tileableWindowAtPoint(
    x: number,
    y: number,
  ): WaylandWindow | undefined {
    return this.tileableWindows().find((window) => {
      const rect = window.state[WINDOW_STATE_RECT]();
      const left = read(rect.x);
      const top =
        read(rect.y) + window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y]();
      const right = left + read(rect.width);
      const bottom = top + read(rect.height);
      return x >= left && x < right && y >= top && y < bottom;
    });
  }

  private tileInsertionIndexForPointer(
    window: WaylandWindow,
    pointerX: number,
  ): number {
    const tileable = this.tileableWindows().filter(
      (current) => current.id !== window.id,
    );
    const viewportRect = this.tileViewportRect();
    const contentX = pointerX - read(viewportRect.x) + this.scrollOffset;
    let left = 0;

    for (let index = 0; index < tileable.length; index++) {
      const width = this.tileWidthForWindow(tileable[index], viewportRect);
      if (contentX < left + width / 2) {
        return index;
      }
      left += width + TILE_GAP;
    }

    return tileable.length;
  }

  private moveTileWindowToIndex(window: WaylandWindow, tileIndex: number) {
    const currentIndex = this.windows.findIndex(
      (current) => current.id === window.id,
    );
    if (currentIndex < 0) {
      return;
    }

    this.windows.splice(currentIndex, 1);
    const tileableWithoutWindow = this.tileableWindows();
    const beforeWindow = tileableWithoutWindow[tileIndex];

    if (beforeWindow) {
      const insertIndex = this.windows.findIndex(
        (current) => current.id === beforeWindow.id,
      );
      this.windows.splice(Math.max(0, insertIndex), 0, window);
      return;
    }

    let lastTileableIndex = -1;
    for (let index = 0; index < this.windows.length; index++) {
      if (this.shouldTile(this.windows[index])) {
        lastTileableIndex = index;
      }
    }
    this.windows.splice(lastTileableIndex + 1, 0, window);
  }

  private captureFloatingRect(window: WaylandWindow) {
    if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
      const rect = this.isTiled
        ? this.viewportRectToFloatingContentRect(
            window.state[WINDOW_STATE_RECT](),
          )
        : window.state[WINDOW_STATE_RECT]();
      window.state[WINDOW_STATE_FLOATING_RECT].set(rect);
    }
  }

  public floatingWindows(): WaylandWindow[] {
    return this.windows.filter(
      (window) =>
        !this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED](),
    );
  }

  private applyFloatingLayout(
    animationOptions: LayoutOptions | undefined,
    animate = true,
  ) {
    for (const window of this.floatingWindows()) {
      const contentRect =
        window.state[WINDOW_STATE_FLOATING_RECT]() ??
        this.viewportRectToFloatingContentRect(
          this.centeredFloatingRect(window),
        );
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      const rect = this.floatingContentRectToViewportRect(contentRect);
      if (animate) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          TILE_ANIMATION_DURATION,
          animationOptions,
        );
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(rect);
      }
      hotReloadDebug("workspace-apply-floating-layout", {
        monitor: this.monitor,
        index: this.index,
        animate,
        windowId: window.id,
        rect,
        contentRect,
      });
    }
  }

  private centeredFloatingRect(window: WaylandWindow): ManagedWindowRect {
    const sizeRect = this.naturalRootRect(window);
    const monitor = WINDOW_MANAGER.output.current[this.monitor];
    if (!monitor?.resolution) {
      return sizeRect;
    }

    const usableRect = WINDOW_MANAGER.layer.usableArea(this.monitor);
    const logicalWidth =
      usableRect?.width ?? monitor.resolution.width / monitor.scale;
    const logicalHeight =
      usableRect?.height ?? monitor.resolution.height / monitor.scale;
    const logicalX = usableRect?.x ?? monitor.position.x;
    const logicalY = usableRect?.y ?? monitor.position.y;

    return {
      x: logicalX + (logicalWidth - read(sizeRect.width)) / 2,
      y: logicalY + (logicalHeight - read(sizeRect.height)) / 2,
      width: read(sizeRect.width),
      height: read(sizeRect.height),
    };
  }

  private viewportRectToFloatingContentRect(
    rect: ManagedWindowRect,
  ): ManagedWindowRect {
    return {
      x: read(rect.x) + this.scrollOffset,
      y: read(rect.y),
      width: read(rect.width),
      height: read(rect.height),
    };
  }

  private floatingContentRectToViewportRect(
    rect: ManagedWindowRect,
  ): ManagedWindowRect {
    return {
      x: read(rect.x) - this.scrollOffset,
      y: read(rect.y),
      width: read(rect.width),
      height: read(rect.height),
    };
  }

  private clampRectToViewport(rect: ManagedWindowRect): ManagedWindowRect {
    const viewport = this.tileViewportRect();
    const width = read(rect.width);
    const height = read(rect.height);
    const minX = read(viewport.x);
    const minY = read(viewport.y);
    const maxX = minX + Math.max(0, read(viewport.width) - width);
    const maxY = minY + Math.max(0, read(viewport.height) - height);
    return {
      x: clamp(read(rect.x), minX, maxX),
      y: clamp(read(rect.y), minY, maxY),
      width,
      height,
    };
  }

  private scrollToWindow(window: WaylandWindow) {
    this.stopKineticScroll();

    const tileable = this.tileableWindows();
    const index = tileable.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }

    const viewportRect = this.tileViewportRect();
    const viewportWidth = read(viewportRect.width);
    const windowLeft = this.tileLeftForIndex(tileable, index, viewportRect);
    const windowRight =
      windowLeft + this.tileWidthForWindow(window, viewportRect);

    if (window.state[WINDOW_STATE_MAXIMIZED]()) {
      this.scrollOffset =
        windowLeft + (windowRight - windowLeft) / 2 - viewportWidth / 2;
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
    const contentWidth = this.tileContentWidth(
      tileable.slice(0, tileCount),
      viewportRect,
    );
    const maxScrollOffset = Math.max(0, contentWidth - viewportWidth);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxScrollOffset);
  }

  private tileWidthForWindow(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
  ): number {
    if (window.state[WINDOW_STATE_MAXIMIZED]()) {
      return read(this.maximizedRootRect(window).width);
    }

    const width =
      this.tileWidthByWindowId.get(window.id) ??
      this.defaultTileWidth(viewportRect);
    return clamp(
      width,
      this.minTileWidth(window, viewportRect),
      Math.max(
        this.minTileWidth(window, viewportRect),
        this.maxTileWidth(window),
      ),
    );
  }

  private maximizedTileRect(
    window: WaylandWindow,
    x: number,
  ): ManagedWindowRect {
    const maximizedRect = this.maximizedRootRect(window);
    return {
      x,
      y: read(maximizedRect.y),
      width: read(maximizedRect.width),
      height: read(maximizedRect.height),
    };
  }

  private setTileWidthFromRect(
    window: WaylandWindow,
    rect: ManagedWindowRect,
    overwrite: boolean,
  ) {
    if (!overwrite && this.tileWidthByWindowId.has(window.id)) {
      return;
    }
    const viewportRect = this.tileViewportRect();
    this.tileWidthByWindowId.set(
      window.id,
      clamp(
        read(rect.width),
        this.minTileWidth(window, viewportRect),
        Math.max(
          this.minTileWidth(window, viewportRect),
          this.maxTileWidth(window),
        ),
      ),
    );
  }

  private defaultTileWidth(viewportRect: ManagedWindowRect): number {
    return Math.max(
      TILE_MIN_WIDTH,
      read(viewportRect.width) * TILE_WIDTH_RATIO,
    );
  }

  private minTileWidth(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
  ): number {
    const constraints = window.sizeConstraints();
    const extra = this.rootClientWidthExtra(window);
    return Math.max(
      TILE_MIN_WIDTH,
      (constraints.min?.width ?? 1) + extra,
      read(viewportRect.width) * 0.2,
    );
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

  private tileLeftForIndex(
    tileable: WaylandWindow[],
    index: number,
    viewportRect: ManagedWindowRect,
  ): number {
    let left = 0;
    for (let i = 0; i < index; i++) {
      left += this.tileWidthForWindow(tileable[i], viewportRect) + TILE_GAP;
    }
    return left;
  }

  private tileContentWidth(
    tileable: WaylandWindow[],
    viewportRect: ManagedWindowRect,
  ): number {
    if (tileable.length === 0) {
      return 0;
    }
    return (
      tileable.reduce(
        (sum, window) => sum + this.tileWidthForWindow(window, viewportRect),
        0,
      ) +
      (tileable.length - 1) * TILE_GAP
    );
  }

  private tileViewportRect(): ManagedWindowRect {
    const monitor = WINDOW_MANAGER.output.current[this.monitor];
    const usableRect = WINDOW_MANAGER.layer.usableArea(this.monitor);
    const base =
      usableRect ??
      (monitor?.resolution
        ? {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.resolution.width / monitor.scale,
            height: monitor.resolution.height / monitor.scale,
          }
        : {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
          });

    return insetRect(base, {
      top: TILE_MARGIN,
      right: TILE_MARGIN,
      bottom: TILE_MARGIN,
      left: TILE_MARGIN,
    });
  }
}

function workspaceKey(monitor: string, index: number): string {
  return `${monitor}:${index}`;
}

function constrainedMax(
  constraints: WindowSizeConstraints,
  axis: "width" | "height",
  extra: number,
): number {
  const max = constraints.max?.[axis];
  return max && max > 0 ? max + extra : Number.POSITIVE_INFINITY;
}

function resizeOriginForAxis(
  start: WindowResizeRect,
  current: WindowResizeRect,
  constrainedSize: number,
  negativeEdge: boolean,
  axis: "x" | "y",
): number {
  if (!negativeEdge) {
    return current[axis];
  }

  const startSize = axis === "x" ? start.width : start.height;
  return start[axis] + startSize - constrainedSize;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function insetRect(
  rect: ManagedWindowRect,
  padding: { top: number; right: number; bottom: number; left: number },
): ManagedWindowRect {
  const width = Math.max(1, read(rect.width) - padding.left - padding.right);
  const height = Math.max(1, read(rect.height) - padding.top - padding.bottom);
  return {
    x: read(rect.x) + padding.left,
    y: read(rect.y) + padding.top,
    width,
    height,
  };
}

function withManagedWindowOnlySSDRebuildSuppressed<T>(
  callback: () => T,
  options: { strict?: boolean } = {},
): T {
  return WINDOW_MANAGER.runtime.withSSDRebuildSuppressed(
    options.strict
      ? STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION
      : MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION,
    callback,
  );
}

// Rect deltas use `add` so open/close/workspace motion can layer on top of
// override-mode layout animation. Open/close opacity uses `multiply`; workspace
// opacity is a separate override channel so an inactive workspace whose base
// opacity is already 0 can still fade back in deterministically.

function scheduleOpenAnimation(window: WaylandWindow): void {
  window.scheduleAnimation({
    channel: OPEN_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: 200, width: 0, height: 0 },
      to: { x: 0, y: 0, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_OPEN_EASING,
      mode: "add",
    },
    opacity: {
      from: 0,
      to: 1,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_OPEN_EASING,
      mode: "multiply",
    },
  });
}

function scheduleCloseAnimation(window: WaylandWindow): void {
  window.scheduleAnimation({
    channel: CLOSE_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: 0, width: 0, height: 0 },
      to: { x: 0, y: 120, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_CLOSE_EASING,
      mode: "add",
    },
    opacity: {
      from: 1,
      to: 0,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_CLOSE_EASING,
      mode: "multiply",
    },
  });
}

function scheduleWorkspaceVisualAnimation(
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

function resetWorkspaceVisualState(
  window: WaylandWindow,
  visible: boolean,
): void {
  cancelWorkspaceVisualAnimation(window);
  window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
  window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
  window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
}

function cancelWorkspaceVisualAnimation(window: WaylandWindow): void {
  window.cancelAnimation(WORKSPACE_VISUAL_ANIMATION_CHANNEL);
  window.cancelAnimation(WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL);
  window.cancelAnimation(WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL);
}
