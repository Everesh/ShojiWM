import { seconds, cubicBezier } from "shoji_wm";
import type { ResolvedWorkspaceGestureSpeedConfig } from "./types";

// --- Window Geometry & Spacing ---
export const WINDOW_BORDER_PX = 1;
export const TITLEBAR_HEIGHT = 30;
export const MAXIMIZED_WINDOW_PADDING = {
  top: 8,
  right: 8,
  bottom: 8,
  left: 8,
};

// --- Snap Zones ---
export const SNAP_EDGE_PX = 16;
export const SNAP_CORNER_PX = 140;
export const SNAP_GAP_PX = 8;

// --- Tiling ---
export const TILE_GAP = 12;
export const TILE_MARGIN = 12;
export const TILE_WIDTH_RATIO = 0.5;
export const TILE_MIN_WIDTH = 240;
export const TILE_DRAG_WORKSPACE_EDGE_PX = 80;
export const TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS = 420;

// --- Gestures & Scrolling ---
export const WORKSPACE_GESTURE_FINGERS = 3;
export const WORKSPACE_GESTURE_AXIS_LOCK_PX = 8;
export const WORKSPACE_GESTURE_THRESHOLD_RATIO = 0.22;
export const WORKSPACE_GESTURE_VELOCITY_THRESHOLD = 900;

export const WORKSPACE_KINETIC_SCROLL_MIN_VELOCITY = 120;
export const WORKSPACE_KINETIC_SCROLL_MAX_VELOCITY = 5000;
export const WORKSPACE_KINETIC_SCROLL_STOP_VELOCITY = 18;
export const WORKSPACE_KINETIC_SCROLL_TIME_CONSTANT_MS = 360;
export const WORKSPACE_KINETIC_SCROLL_FALLBACK_REFRESH_RATE = 120;

export const DEFAULT_WORKSPACE_GESTURE_SPEED: ResolvedWorkspaceGestureSpeedConfig = {
  workspaceScrollFactor: 1,
  workspaceScrollKineticFactor: 1,
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
};

// --- Animation Durations & Easing ---
export const OPEN_CLOSE_ANIMATION_DURATION = seconds(0.5);
export const WINDOW_MANAGEMENT_ANIMATION_DURATION = seconds(0.3);
export const TILE_ANIMATION_DURATION = seconds(0.5);
export const WORKSPACE_SWITCH_ANIMATION_DURATION = seconds(0.5);
export const UNMAXIMIZE_GRAB_ANIMATION_DURATION = 90;

export const WINDOW_MANAGEMENT_EASING = cubicBezier(0.1, 0.9, 0.2, 1.0);
export const WINDOW_OPEN_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const WINDOW_CLOSE_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_MINIMIZE_RECT_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_UNMINIMIZE_RECT_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const WINDOW_MINIMIZE_OPACITY_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const WINDOW_UNMINIMIZE_OPACITY_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);

// --- Animation Channels ---
export const OPEN_ANIMATION_CHANNEL = "window.open";
export const CLOSE_ANIMATION_CHANNEL = "window.close";
export const MINIMIZE_ANIMATION_CHANNEL = "window.minimize";
export const WORKSPACE_VISUAL_ANIMATION_CHANNEL = "workspace.visual";
export const WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.rect`;
export const WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.opacity`;

// --- Optimization Flags ---
export const MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback-last",
} as const;

export const STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback",
} as const;

export const MANAGED_WINDOW_ONLY_ANIMATION = {
  suppressSSDRebuild: true,
} as const;
