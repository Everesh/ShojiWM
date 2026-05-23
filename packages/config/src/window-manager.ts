import { animationVariable, createWindowStack, createWindowState, cubicBezier, read, seconds, WINDOW_MANAGER, type PointerMoveEvent, type ReadonlySignal, type WaylandWindow, type WindowActivateRequestEvent, type WindowMaximizeRequestEvent, type WindowMinimizeRequestEvent, type WindowMoveEvent, type WindowResizeEvent, type WindowResizeRect } from "shoji_wm";
import type { ManagedWindowRect, WindowSizeConstraints } from "shoji_wm/types";
import { playRectAnimation, stopRectAnimation } from "./window-animation";

export const WINDOW_STATE_RECT = createWindowState<ManagedWindowRect>("rect", {
    default: (window) => window.rect,
});
export const WINDOW_STATE_RESTORE_RECT = createWindowState<ManagedWindowRect | null>("restoreRect", {
    default: null,
});
export const WINDOW_STATE_MINIMIZED = createWindowState<boolean>("minimized", {
    default: false,
});
export const WINDOW_STATE_MAXIMIZED = createWindowState<boolean>("maximized", {
    default: false,
});
export const WINDOW_STATE_WORKSPACE_VISIBLE = createWindowState<boolean>("workspaceVisible", {
    default: true,
});
export const WINDOW_STATE_FLOATING_RECT = createWindowState<ManagedWindowRect | null>("floatingRect", {
    default: null,
});

const OPEN_CLOSE_ANIMATION_DURATION = seconds(0.5);
const WINDOW_MANAGEMENT_ANIMATION_DURATION = seconds(0.3);
const UNMAXIMIZE_GRAB_ANIMATION_DURATION = 90;
const WINDOW_MANAGEMENT_EASING = cubicBezier(0.1, 0.9, 0.2, 1.0);//cubicBezier(0.1, 1.1, 0.1, 1.1);
const WINDOW_CLOSE_EASING = cubicBezier(0.3, -0.3, 0, 1);
export const TILE_ANIMATION_DURATION = seconds(0.5);
const TILE_GAP = 12;
const TILE_MARGIN = 12;
const TILE_WIDTH_RATIO = 0.5;
const TILE_MIN_WIDTH = 240;
export const OPEN_ANIMATION = animationVariable("window.open");
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

    public constructor(naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect) {
        this.currentMonitor = "";
        this.syncWorkspaces();
        this.naturalRootRect = naturalRootRect;
    }

    public onPointerMove(event: PointerMoveEvent) {
        this.syncWorkspaces();
        this.currentMonitor = event.outputName ?? this.currentMonitor;
    }

    public onOpen(window: WaylandWindow) {
        window.focus();
        this.windowStack.add(window);

        window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
        window.animation.start(OPEN_ANIMATION, {
            duration: OPEN_CLOSE_ANIMATION_DURATION,
            to: 1,
            easing: WINDOW_MANAGEMENT_EASING,
        });
    }

    public onFirstCommit(window: WaylandWindow) {
        const workspace = this.getCurrentWorkspace();
        if (workspace) {
            workspace.addWindow(window);
            this.syncWorkspaceVisibility();
        } else {
            window.state[WINDOW_STATE_RECT].set(this.naturalRootRect(window));
        }

        if (window.isMaximized()) {
            window.state[WINDOW_STATE_RESTORE_RECT].set(this.initialRestoreRectForMaximizedWindow(window));
            window.state[WINDOW_STATE_RECT].set(this.maximizedRectForWindow(window));
            window.state[WINDOW_STATE_MAXIMIZED].set(true);
        }
    }

    public onStartClose(window: WaylandWindow) {
        window.animation.start(OPEN_ANIMATION, {
            duration: OPEN_CLOSE_ANIMATION_DURATION,
            to: 0,
            easing: WINDOW_CLOSE_EASING,
        });

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
            return;
        }

        stopRectAnimation(event.window, WINDOW_STATE_RECT);
        event.window.state[WINDOW_STATE_RECT].set(this.constrainResizeRect(event));
    }

    public onWindowMove(event: WindowMoveEvent) {
        const workspace = this.findWorkspaceForWindow(event.window);
        if (workspace?.isTiled && workspace.shouldTile(event.window)) {
            return;
        }

        if (event.phase === "start") {
            this.isGrabbing = true;
        }

        const window = event.window;
        if (window.state[WINDOW_STATE_MAXIMIZED]()) {
            const restoreRect = window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
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

        if (event.phase === "end" || event.phase === "cancel") {
            this.isGrabbing = false;
        }
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
                return;
            }

            window.state[WINDOW_STATE_RESTORE_RECT].set(null);
            window.state[WINDOW_STATE_MAXIMIZED].set(true);
            workspace.focusWindow(window);
            workspace.applyLayout();
            window.focus();
            return;
        }

        if (!event.maximized) {
            const restoreRect = window.state[WINDOW_STATE_RESTORE_RECT]();
            if (restoreRect) {
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
        playRectAnimation(
            window,
            WINDOW_STATE_RECT,
            this.maximizedRectForWindow(window),
            WINDOW_MANAGEMENT_EASING,
            WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
        window.state[WINDOW_STATE_MAXIMIZED].set(true);
    }

    public onWindowMinimizeRequest(event: WindowMinimizeRequestEvent) {
        stopRectAnimation(event.window, WINDOW_STATE_RECT);
        event.window.state[WINDOW_STATE_MINIMIZED].set(event.minimized);
        const workspace = this.findWorkspaceForWindow(event.window);
        if (workspace?.isTiled) {
            workspace.applyLayout();
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
        const workspace = this.getCurrentWorkspace();
        if (!workspace) {
            return;
        }
        workspace.setTiled(!workspace.isTiled);
    }

    public focusTile(direction: -1 | 1) {
        const workspace = this.getCurrentWorkspace();
        if (!workspace?.isTiled) {
            return;
        }
        workspace.focusRelative(direction);
    }

    public switchWorkspace(direction: -1 | 1) {
        this.syncWorkspaces();
        const monitor = this.currentMonitor || WINDOW_MANAGER.output.list.at(0);
        if (!monitor) {
            return;
        }

        const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
        this.activateWorkspace(monitor, Math.max(1, currentIndex + direction));
    }

    public getCurrentWorkspace(): Workspace | undefined {
        this.syncWorkspaces();
        return this.workspaceForMonitor(this.currentMonitor) ?? this.workspaces.values().next().value;
    }

    public getWindowZIndex(window: WaylandWindow): ReadonlySignal<number> {
        return this.windowStack.zIndex(window);
    }

    private syncWorkspaces() {
        for (const monitor of WINDOW_MANAGER.output.list) {
            if (!this.activeWorkspaceByMonitor.has(monitor)) {
                this.activeWorkspaceByMonitor.set(monitor, 1);
            }
            this.ensureWorkspace(monitor, this.activeWorkspaceByMonitor.get(monitor) ?? 1);
        }

        if (!this.currentMonitor || !WINDOW_MANAGER.output.list.includes(this.currentMonitor)) {
            this.currentMonitor = WINDOW_MANAGER.output.list.at(0) ?? "";
        }
    }

    private workspaceForMonitor(monitor: string): Workspace | undefined {
        if (!monitor) {
            return undefined;
        }
        return this.ensureWorkspace(monitor, this.activeWorkspaceByMonitor.get(monitor) ?? 1);
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
                () => this.getActiveWorkspaceIndex(monitor),
            );
            this.workspaces.set(key, workspace);
        }
        return workspace;
    }

    private getActiveWorkspaceIndex(monitor: string): number {
        return this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    }

    private activateWorkspace(monitor: string, index: number) {
        this.activeWorkspaceByMonitor.set(monitor, index);
        const workspace = this.ensureWorkspace(monitor, index);
        this.currentMonitor = monitor;
        this.syncWorkspaceVisibility();
        workspace.applyLayout();
        workspace.focusActiveWindow();
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

    private constrainResizeRect(event: WindowResizeEvent): ManagedWindowRect {
        const constraints = event.window.sizeConstraints();
        const extra = this.clientToRootSizeExtra(event.window);
        const minWidth = Math.max(1, constraints.min?.width ?? 1) + extra.width;
        const minHeight = Math.max(1, constraints.min?.height ?? 1) + extra.height;
        const maxWidth = constrainedMax(constraints, "width", extra.width);
        const maxHeight = constrainedMax(constraints, "height", extra.height);

        const width = clamp(event.currentRect.width, minWidth, Math.max(minWidth, maxWidth));
        const height = clamp(event.currentRect.height, minHeight, Math.max(minHeight, maxHeight));

        return {
            x: resizeOriginForAxis(event.startRect, event.currentRect, width, event.edges.left, "x"),
            y: resizeOriginForAxis(event.startRect, event.currentRect, height, event.edges.top, "y"),
            width,
            height,
        };
    }

    private clientToRootSizeExtra(window: WaylandWindow): { width: number; height: number } {
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
        const outputName = this.outputNameAt(centerX, centerY) ?? this.currentMonitor;
        const output = outputName ? WINDOW_MANAGER.output.current[outputName] : undefined;
        const usable = outputName ? WINDOW_MANAGER.layer.usableArea(outputName) : undefined;

        if (usable) {
            return insetRect({
                x: usable.x,
                y: usable.y,
                width: usable.width,
                height: usable.height,
            }, MAXIMIZED_WINDOW_PADDING);
        }
        if (output?.resolution) {
            return insetRect({
                x: output.position.x,
                y: output.position.y,
                width: output.resolution.width / output.scale,
                height: output.resolution.height / output.scale,
            }, MAXIMIZED_WINDOW_PADDING);
        }
        return rect;
    }

    private initialRestoreRectForMaximizedWindow(window: WaylandWindow): ManagedWindowRect {
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
        const pointerOffsetY = event.source === "modifier"
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
    public readonly index: number;
    private readonly windows: WaylandWindow[] = [];
    private readonly naturalRootRect: (window: WaylandWindow) => ManagedWindowRect;
    private readonly maximizedRootRect: (window: WaylandWindow) => ManagedWindowRect;
    private readonly activeWorkspaceIndex: () => number;
    private readonly tileWidthByWindowId = new Map<string, number>();
    private activeWindowId: string | null = null;
    private scrollOffset = 0;
    public readonly monitor: string;
    public isTiled = false;

    public constructor(
        index: number,
        monitor: string,
        naturalRootRect: (window: WaylandWindow) => ManagedWindowRect,
        maximizedRootRect: (window: WaylandWindow) => ManagedWindowRect,
        activeWorkspaceIndex: () => number,
    ) {
        this.index = index;
        this.monitor = monitor;
        this.naturalRootRect = naturalRootRect;
        this.maximizedRootRect = maximizedRootRect;
        this.activeWorkspaceIndex = activeWorkspaceIndex;
    }

    public addWindow(window: WaylandWindow) {
        if (this.windows.map(window => window.id).includes(window.id)) {
            return;
        }
        this.windows.push(window);
        this.activeWindowId = window.id;
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(this.isActive());

        if (!WINDOW_MANAGER.output.list.includes(this.monitor)) {
            return;
        }

        if (this.isTiled) {
            const initialRect = this.centeredFloatingRect(window);
            window.state[WINDOW_STATE_FLOATING_RECT].set(initialRect);
            this.setTileWidthFromRect(window, initialRect, true);
            this.scrollToWindow(window);
            this.applyLayout();
        } else {
            window.state[WINDOW_STATE_RECT].set(this.centeredFloatingRect(window));
        }
    }

    public removeWindow(window: WaylandWindow): WaylandWindow | null | undefined {
        const index = this.windows.findIndex((current) => current.id === window.id);
        if (index >= 0) {
            this.windows.splice(index, 1);
            this.tileWidthByWindowId.delete(window.id);
            let nextFocus: WaylandWindow | null = null;
            if (this.activeWindowId === window.id) {
                nextFocus = this.tileableWindows()[Math.min(index, this.tileableWindows().length - 1)] ?? null;
                this.activeWindowId = nextFocus?.id ?? null;
            }
            return nextFocus;
        }
        return undefined;
    }

    public hasWindow(window: WaylandWindow): boolean {
        return this.windows.some((current) => current.id === window.id);
    }

    public isActive(): boolean {
        return this.activeWorkspaceIndex() === this.index;
    }

    public setVisible(visible: boolean) {
        for (const window of this.windows) {
            window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
        }
    }

    public setTiled(tiled: boolean) {
        if (this.isTiled === tiled) {
            return;
        }

        const focusedWindow = this.focusedWindow();
        const focusedTileableWindow = focusedWindow && this.shouldTile(focusedWindow) && !focusedWindow.state[WINDOW_STATE_MINIMIZED]()
            ? focusedWindow
            : undefined;
        this.isTiled = tiled;
        if (tiled) {
            for (const window of this.tileableWindows()) {
                this.captureFloatingRect(window);
                this.setTileWidthFromRect(window, window.state[WINDOW_STATE_FLOATING_RECT]() ?? window.state[WINDOW_STATE_RECT](), true);
            }
            this.scrollOffset = 0;
            const tileable = this.tileableWindows();
            const previousActiveWindow = this.activeWindow(tileable);
            this.activeWindowId = (focusedTileableWindow ?? previousActiveWindow ?? tileable.at(0))?.id ?? null;
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
                playRectAnimation(window, WINDOW_STATE_RECT, rect, WINDOW_MANAGEMENT_EASING, WINDOW_MANAGEMENT_ANIMATION_DURATION);
            }
            window.state[WINDOW_STATE_FLOATING_RECT].set(null);
        }
        if (focusedTileableWindow) {
            this.activeWindowId = focusedTileableWindow.id;
            focusedTileableWindow.focus();
        }
    }

    public applyLayout() {
        if (!this.isTiled) {
            return;
        }

        const tileable = this.tileableWindows();
        if (tileable.length === 0) {
            this.activeWindowId = null;
            return;
        }

        if (!this.activeWindowId || !tileable.some((window) => window.id === this.activeWindowId)) {
            this.activeWindowId = tileable.at(-1)?.id ?? null;
        }

        this.clampScrollOffset(tileable.length);

        const viewportRect = this.tileViewportRect();
        const tileHeight = read(viewportRect.height);
        let nextX = read(viewportRect.x) - this.scrollOffset;

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
            playRectAnimation(
                window,
                WINDOW_STATE_RECT,
                rect,
                WINDOW_MANAGEMENT_EASING,
                TILE_ANIMATION_DURATION,
            );
            nextX += tileWidth + (index === tileable.length - 1 ? 0 : TILE_GAP);
        });
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
        const width = clamp(event.currentRect.width, minWidth, Math.max(minWidth, maxWidth));
        this.tileWidthByWindowId.set(event.window.id, width);
        this.scrollToWindow(event.window);
        this.applyLayout();
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

    public focusRelative(direction: -1 | 1) {
        const tileable = this.tileableWindows();
        if (tileable.length === 0) {
            return;
        }
        const currentIndex = Math.max(0, tileable.findIndex((window) => window.id === this.activeWindowId));
        const nextIndex = clamp(currentIndex + direction, 0, tileable.length - 1);
        this.activeWindowId = tileable[nextIndex].id;
        this.scrollToWindow(tileable[nextIndex]);
        this.applyLayout();
        this.focusActiveWindow();
    }

    public focusActiveWindow() {
        const active = this.windows.find((window) => window.id === this.activeWindowId);
        active?.focus();
    }

    public shouldTile(window: WaylandWindow): boolean {
        return window.isResizable() && !window.isTransient();
    }

    public getWindows(): WaylandWindow[] {
        return Array.from(this.windows);
    }

    private tileableWindows(): WaylandWindow[] {
        return this.windows.filter((window) => this.shouldTile(window) && !window.state[WINDOW_STATE_MINIMIZED]());
    }

    private focusedWindow(): WaylandWindow | undefined {
        return this.windows.find((window) => read(window.isFocused));
    }

    private activeWindow(windows = this.windows): WaylandWindow | undefined {
        return windows.find((window) => window.id === this.activeWindowId);
    }

    private captureFloatingRect(window: WaylandWindow) {
        if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
            window.state[WINDOW_STATE_FLOATING_RECT].set(window.state[WINDOW_STATE_RECT]());
        }
    }

    private centeredFloatingRect(window: WaylandWindow): ManagedWindowRect {
        const sizeRect = this.naturalRootRect(window);
        const monitor = WINDOW_MANAGER.output.current[this.monitor];
        if (!monitor?.resolution) {
            return sizeRect;
        }

        const usableRect = WINDOW_MANAGER.layer.usableArea(this.monitor);
        const logicalWidth = usableRect?.width ?? monitor.resolution.width / monitor.scale;
        const logicalHeight = usableRect?.height ?? monitor.resolution.height / monitor.scale;
        const logicalX = usableRect?.x ?? monitor.position.x;
        const logicalY = usableRect?.y ?? monitor.position.y;

        return {
            x: logicalX + (logicalWidth - read(sizeRect.width)) / 2,
            y: logicalY + (logicalHeight - read(sizeRect.height)) / 2,
            width: read(sizeRect.width),
            height: read(sizeRect.height),
        };
    }

    private scrollToWindow(window: WaylandWindow) {
        const tileable = this.tileableWindows();
        const index = tileable.findIndex((current) => current.id === window.id);
        if (index < 0) {
            return;
        }

        const viewportRect = this.tileViewportRect();
        const viewportWidth = read(viewportRect.width);
        const windowLeft = this.tileLeftForIndex(tileable, index, viewportRect);
        const windowRight = windowLeft + this.tileWidthForWindow(window, viewportRect);

        if (window.state[WINDOW_STATE_MAXIMIZED]()) {
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
        if (window.state[WINDOW_STATE_MAXIMIZED]()) {
            return read(this.maximizedRootRect(window).width);
        }

        const width = this.tileWidthByWindowId.get(window.id) ?? this.defaultTileWidth(viewportRect);
        return clamp(width, this.minTileWidth(window, viewportRect), Math.max(this.minTileWidth(window, viewportRect), this.maxTileWidth(window)));
    }

    private maximizedTileRect(window: WaylandWindow, x: number): ManagedWindowRect {
        const maximizedRect = this.maximizedRootRect(window);
        return {
            x,
            y: read(maximizedRect.y),
            width: read(maximizedRect.width),
            height: read(maximizedRect.height),
        };
    }

    private setTileWidthFromRect(window: WaylandWindow, rect: ManagedWindowRect, overwrite: boolean) {
        if (!overwrite && this.tileWidthByWindowId.has(window.id)) {
            return;
        }
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

    private tileContentWidth(tileable: WaylandWindow[], viewportRect: ManagedWindowRect): number {
        if (tileable.length === 0) {
            return 0;
        }
        return tileable.reduce((sum, window) => sum + this.tileWidthForWindow(window, viewportRect), 0)
            + (tileable.length - 1) * TILE_GAP;
    }

    private tileViewportRect(): ManagedWindowRect {
        const monitor = WINDOW_MANAGER.output.current[this.monitor];
        const usableRect = WINDOW_MANAGER.layer.usableArea(this.monitor);
        const base = usableRect ?? (monitor?.resolution ? {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.resolution.width / monitor.scale,
            height: monitor.resolution.height / monitor.scale,
        } : {
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
