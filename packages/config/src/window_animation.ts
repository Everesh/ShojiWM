import {
    read,
    type EasingFunction,
    type WaylandWindow,
    type WindowStateKey,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";
import {
    CLOSE_ANIMATION_CHANNEL,
    MINIMIZE_ANIMATION_CHANNEL,
    OPEN_ANIMATION_CHANNEL,
    OPEN_CLOSE_ANIMATION_DURATION,
    WINDOW_CLOSE_EASING,
    WINDOW_MINIMIZE_OPACITY_EASING,
    WINDOW_MINIMIZE_RECT_EASING,
    WINDOW_OPEN_EASING,
    WINDOW_UNMINIMIZE_OPACITY_EASING,
    WINDOW_UNMINIMIZE_RECT_EASING,
} from "./constants";

// --- Rect Animation Types & State ---

export interface RectAnimationOptions {
    suppressSSDRebuild?: boolean;
}

interface RectAnimationTarget {
    target: ManagedWindowRect;
    token: number;
}

const activeRectAnimationTargetByWindow = new WeakMap<WaylandWindow, Map<symbol, RectAnimationTarget>>();
let rectAnimationToken = 0;

// --- Rect Animation Helpers ---

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

function activeRectTarget(window: WaylandWindow, windowRectState: WindowStateKey<ManagedWindowRect>): RectAnimationTarget | undefined {
    return activeRectAnimationTargetByWindow.get(window)?.get(windowRectState);
}

function setActiveRectTarget(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    target: RectAnimationTarget | undefined,
): void {
    let perWindow = activeRectAnimationTargetByWindow.get(window);
    if (!perWindow) {
        perWindow = new Map();
        activeRectAnimationTargetByWindow.set(window, perWindow);
    }

    if (target) {
        perWindow.set(windowRectState, target);
    } else {
        perWindow.delete(windowRectState);
    }
}

function clearActiveRectTarget(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    token: number,
): void {
    if (activeRectTarget(window, windowRectState)?.token === token) {
        setActiveRectTarget(window, windowRectState, undefined);
    }
}

// --- Core Rect Animation API ---

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
    const previousTarget = activeRectTarget(window, windowRectState)?.target;
    if (previousTarget && sameRect(previousTarget, target)) {
        return;
    }

    // TS keeps the declarative target. Rust owns the frame-by-frame visual
    // interpolation and falls back to this target when the scheduled animation
    // finishes or is cancelled.
    window.state[windowRectState].set(target);
    const token = ++rectAnimationToken;
    setActiveRectTarget(window, windowRectState, { target, token });
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
    setTimeout(() => {
        clearActiveRectTarget(window, windowRectState, token);
    }, duration);
}

export function stopRectAnimation(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
): void {
    setActiveRectTarget(window, windowRectState, undefined);
    window.cancelAnimation(rectAnimationChannel(windowRectState));
}

// --- State Transition Animations ---

export function scheduleOpenAnimation(window: WaylandWindow): void {
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

export function scheduleCloseAnimation(window: WaylandWindow): void {
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

export function scheduleMinimizeAnimation(
    window: WaylandWindow,
    minimized: boolean,
): void {
    window.scheduleAnimation({
        channel: MINIMIZE_ANIMATION_CHANNEL,
        rect: {
            from: minimized
                ? { x: 0, y: 0, width: 0, height: 0 }
                : { x: 0, y: 200, width: 0, height: 0 },
            to: minimized
                ? { x: 0, y: 120, width: 0, height: 0 }
                : { x: 0, y: 0, width: 0, height: 0 },
            duration: OPEN_CLOSE_ANIMATION_DURATION,
            easing: minimized
                ? WINDOW_MINIMIZE_RECT_EASING
                : WINDOW_UNMINIMIZE_RECT_EASING,
            mode: "add",
        },
        opacity: {
            from: minimized ? 1 : 0,
            to: minimized ? 0 : 1,
            duration: OPEN_CLOSE_ANIMATION_DURATION,
            easing: minimized
                ? WINDOW_MINIMIZE_OPACITY_EASING
                : WINDOW_UNMINIMIZE_OPACITY_EASING,
            mode: "override",
        },
    });
}
