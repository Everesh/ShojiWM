import { createWindowState } from "shoji_wm";
import type { ManagedWindowRect, WaylandWindow } from "shoji_wm/types";
import type { SnapZone } from "./types";

export const WINDOW_STATE_RECT = createWindowState<ManagedWindowRect>("rect", {
  default: (window: WaylandWindow) => window.rect,
});

export const WINDOW_STATE_RESTORE_RECT = createWindowState<ManagedWindowRect | null>("restoreRect", {
  default: null,
});

export const WINDOW_STATE_MINIMIZED = createWindowState<boolean>("minimized", {
  default: false,
});

export const WINDOW_STATE_MINIMIZE_VISUAL_IDLE = createWindowState<boolean>("minimizeVisualIdle", {
  default: false,
});

export const WINDOW_STATE_MAXIMIZED = createWindowState<boolean>("maximized", {
  default: false,
});

export const WINDOW_STATE_FULLSCREEN = createWindowState<boolean>("fullscreen", {
  default: false,
});

// Pre-fullscreen rect, kept separate from WINDOW_STATE_RESTORE_RECT so a
// window that was maximized before going fullscreen restores back to its
// maximized rect (and the maximize restore rect underneath stays intact).
export const WINDOW_STATE_FULLSCREEN_RESTORE_RECT = createWindowState<ManagedWindowRect | null>("fullscreenRestoreRect", {
  default: null,
});

export const WINDOW_STATE_WORKSPACE_VISIBLE = createWindowState<boolean>("workspaceVisible", {
  default: true,
});

export const WINDOW_STATE_WORKSPACE_OFFSET_Y = createWindowState<number>("workspaceOffsetY", {
  default: 0,
});

export const WINDOW_STATE_WORKSPACE_OPACITY = createWindowState<number>("workspaceOpacity", {
  default: 1,
});

export const WINDOW_STATE_TILE_DRAGGING = createWindowState<boolean>("tileDragging", {
  default: false,
});

export const WINDOW_STATE_TILED = createWindowState<boolean>("tiled", {
  default: false,
});

export const WINDOW_STATE_VISIBLE_OUTPUTS = createWindowState<string[] | null>("visibleOutputs", {
  default: null,
});

export const WINDOW_STATE_FLOATING_RECT = createWindowState<ManagedWindowRect | null>("floatingRect", {
  default: null,
});

export const WINDOW_STATE_SNAP_ZONE = createWindowState<SnapZone | null>("snapZone", {
  default: null,
});

export const WINDOW_STATE_SNAP_MONITOR = createWindowState<string | null>("snapMonitor", {
  default: null,
});
