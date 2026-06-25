import {
    read,
    type EasingFunction,
    type WaylandWindow,
    type WindowStateKey,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";

export interface RectAnimationOptions {
    suppressSSDRebuild?: boolean;
}

const lastRectAnimationTargetByWindow = new WeakMap<WaylandWindow, Map<symbol, ManagedWindowRect>>();

function rectAnimationChannel(windowRectState: WindowStateKey<ManagedWindowRect>): string {
    return `rect:${windowRectState.description ?? "anon"}`;
}

function snapshotRect(rect: ManagedWindowRect): ManagedWindowRect {
    return {
        x: read(rect.x),
        y: read(rect.y),
        width: read(rect.width),
        height: read(rect.height),
    };
}

function sameRect(a: ManagedWindowRect, b: ManagedWindowRect): boolean {
    return read(a.x) === read(b.x)
        && read(a.y) === read(b.y)
        && read(a.width) === read(b.width)
        && read(a.height) === read(b.height);
}

function lastRectTarget(window: WaylandWindow, windowRectState: WindowStateKey<ManagedWindowRect>): ManagedWindowRect | undefined {
    return lastRectAnimationTargetByWindow.get(window)?.get(windowRectState);
}

function setLastRectTarget(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    target: ManagedWindowRect | undefined,
): void {
    let perWindow = lastRectAnimationTargetByWindow.get(window);
    if (!perWindow) {
        perWindow = new Map();
        lastRectAnimationTargetByWindow.set(window, perWindow);
    }

    if (target) {
        perWindow.set(windowRectState, target);
    } else {
        perWindow.delete(windowRectState);
    }
}

export function playRectAnimation(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    to: ManagedWindowRect,
    easing: EasingFunction,
    duration: number,
    _options: RectAnimationOptions = {},
): void {
    const from = snapshotRect(window.state[windowRectState]());
    const target = snapshotRect(to);

    // Layout/focus updates can ask for the same target repeatedly while Rust is
    // already interpolating toward it. Re-scheduling the same channel in that
    // case races with focus-driven reevaluations and can leave one window using
    // an older animated rect for a frame. Treat rect animation requests as
    // idempotent at the declarative target level.
    const previousTarget = lastRectTarget(window, windowRectState);
    if (previousTarget && sameRect(previousTarget, target)) {
        return;
    }

    // TS keeps the declarative target. Rust owns the frame-by-frame visual
    // interpolation and falls back to this target when the scheduled animation
    // finishes or is cancelled.
    window.state[windowRectState].set(target);
    setLastRectTarget(window, windowRectState, target);
    window.scheduleAnimation({
        channel: rectAnimationChannel(windowRectState),
        rect: {
            from,
            to: target,
            duration,
            easing,
            mode: "override",
        },
    });
}

export function stopRectAnimation(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
): void {
    setLastRectTarget(window, windowRectState, undefined);
    window.cancelAnimation(rectAnimationChannel(windowRectState));
}
