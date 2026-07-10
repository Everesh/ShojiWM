import { read, type WindowResizeRect } from "shoji_wm";
import type { ManagedWindowRect, WindowSizeConstraints } from "shoji_wm/types";
import type { SnapZone, LayoutSnapZone, SnapColumn } from "./types";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function averageOr(values: number[], fallback: number): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function constrainedMax(
  constraints: WindowSizeConstraints,
  axis: "width" | "height",
  extra: number,
): number {
  const max = constraints.max?.[axis];
  return max && max > 0 ? max + extra : Number.POSITIVE_INFINITY;
}

export function resizeOriginForAxis(
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

export function managedRectContainsPoint(
  rect: ManagedWindowRect,
  x: number,
  y: number,
): boolean {
  const left = read(rect.x);
  const top = read(rect.y);
  return (
    x >= left &&
    x < left + read(rect.width) &&
    y >= top &&
    y < top + read(rect.height)
  );
}

export function rectCenterX(rect: ManagedWindowRect): number {
  return read(rect.x) + read(rect.width) / 2;
}

export function insetRect(
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

export function snapshotManagedRect(rect: ManagedWindowRect): ManagedWindowRect {
  return {
    x: read(rect.x),
    y: read(rect.y),
    width: read(rect.width),
    height: read(rect.height),
  };
}

export function managedRectEquals(
  a: ManagedWindowRect,
  b: ManagedWindowRect,
): boolean {
  return (
    read(a.x) === read(b.x) &&
    read(a.y) === read(b.y) &&
    read(a.width) === read(b.width) &&
    read(a.height) === read(b.height)
  );
}

// --- Snap Zone Helpers ---

export function isLayoutSnapZone(zone: SnapZone | null): zone is LayoutSnapZone {
  return zone !== null && zone !== "maximize";
}

export function isLeftSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "left" || zone === "top-left" || zone === "bottom-left";
}

export function isRightSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "right" || zone === "top-right" || zone === "bottom-right";
}

export function isTopSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "top-left" || zone === "top-right";
}

export function isBottomSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "bottom-left" || zone === "bottom-right";
}

export function snapColumn(zone: LayoutSnapZone): SnapColumn {
  return isLeftSnapZone(zone) ? "left" : "right";
}

export function snapZonesConflict(
  current: SnapZone | null,
  next: LayoutSnapZone,
): boolean {
  if (!isLayoutSnapZone(current)) {
    return false;
  }
  if (current === next) {
    return true;
  }

  if (next === "left") {
    return current === "top-left" || current === "bottom-left";
  }
  if (next === "right") {
    return current === "top-right" || current === "bottom-right";
  }
  if (current === "left") {
    return next === "top-left" || next === "bottom-left";
  }
  if (current === "right") {
    return next === "top-right" || next === "bottom-right";
  }
  return false;
}
