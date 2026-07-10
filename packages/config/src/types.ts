import type { ManagedWindowRect } from "shoji_wm/types";

export type SnapZone =
  | "maximize"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type LayoutSnapZone = Exclude<SnapZone, "maximize">;
export type SnapColumn = "left" | "right";

export interface SnapPreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapPreviewPayload {
  monitor: string;
  rect: SnapPreviewRect | null;
  kind: "floating" | "tiling";
}

export type SnapPreviewBroadcaster = (preview: SnapPreviewPayload) => void;
export type WorkspaceChangeBroadcaster = () => void;

export interface FloatingSnapLayout {
  splitX: number;
  leftSplitY: number;
  rightSplitY: number;
}

export interface LayoutOptions {
  suppressSSDRebuild?: boolean;
  animate?: boolean;
  preserveMissingActive?: boolean;
  cancelRectAnimations?: boolean;
}

export interface HybridWindowManagerSnapshot {
  currentMonitor: string;
  activeWorkspaceByMonitor: [string, number][];
  workspaces: WorkspaceSnapshot[];
}

export interface WorkspaceSnapshot {
  monitor: string;
  index: number;
  isTiled: boolean;
  activeWindowId: string | null;
  scrollOffset: number;
  windows: WorkspaceWindowSnapshot[];
}

export interface WorkspaceWindowSnapshot {
  id: string;
  tileWidth?: number;
  floatingRect?: ManagedWindowRect | null;
  restoreRect?: ManagedWindowRect | null;
  snapZone?: SnapZone | null;
  snapMonitor?: string | null;
  minimized: boolean;
  maximized: boolean;
}

export interface WorkspacesViewWindow {
  id: string;
  appId?: string;
  title: string;
  focused: boolean;
  lastFocusedAt: number;
}

export interface WorkspacesViewWorkspace {
  index: number;
  windowCount: number;
  isTiled: boolean;
  active: boolean;
  windows: WorkspacesViewWindow[];
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

// Note: Using 'any' for workspaces temporarily to avoid circular imports.
// We will type these properly once the Workspace class is built.
export interface WorkspaceGestureState {
  monitor: string;
  currentIndex: number;
  direction: -1 | 1;
  distance: number;
  fromWorkspace: any;
  toWorkspace: any | null;
  fromOffsetY: number;
  toOffsetY: number;
  fromOpacity: number;
  toOpacity: number;
}

export type WorkspaceGestureMode = "workspace-switch" | "workspace-scroll";

export interface WorkspaceGestureSpeedConfig {
  workspaceScrollFactor?: number;
  workspaceScrollKineticFactor?: number;
  workspaceSwitchFactor?: number;
  workspaceSwitchVelocityFactor?: number;
}

export interface ResolvedWorkspaceGestureSpeedConfig {
  workspaceScrollFactor: number;
  workspaceScrollKineticFactor: number;
  workspaceSwitchFactor: number;
  workspaceSwitchVelocityFactor: number;
}

export interface RectAnimationOptions {
  suppressSSDRebuild?: boolean;
}

export interface RectAnimationTarget {
  target: ManagedWindowRect;
  token: number;
}
