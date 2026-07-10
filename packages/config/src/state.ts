import type { WaylandWindow } from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import { HybridWindowManager } from "./manager";
import { TITLEBAR_HEIGHT, WINDOW_BORDER_PX } from "./constants";

export function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
  const client = window.position;
  return {
    x: client.x - WINDOW_BORDER_PX,
    y: client.y - TITLEBAR_HEIGHT - WINDOW_BORDER_PX,
    width: client.width + WINDOW_BORDER_PX * 2,
    height: client.height + TITLEBAR_HEIGHT + WINDOW_BORDER_PX * 2,
  };
}

export const HYBRID_WINDOW_MANAGER = new HybridWindowManager(naturalRootRect);
export const HOT_RELOAD_WINDOW_MANAGER_STATE = "config.hybrid-window-manager";
export const FULLSCREEN_Z_INDEX = 2_000_000_000;
