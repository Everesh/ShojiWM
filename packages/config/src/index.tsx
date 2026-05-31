import {
    AppIcon,
    Box,
    Button,
    ClientWindow,
    Image,
    ShaderEffect,
    Label,
    WINDOW_MANAGER,
    WindowBorder,
    backdropSource,
    compileEffect,
    dualKawaseBlur,
    type SSDStyle,
    type WaylandWindow,
    computed,
    useState,
    shaderStage,
    loadShader,
    ManagedWindow,
    read,
} from "shoji_wm";
import type { CompositionRenderable, ManagedWindowRect } from "shoji_wm/types";
import {
    HybridWindowManager,
    TITLEBAR_HEIGHT,
    WINDOW_BORDER_PX,
    WINDOW_STATE_MINIMIZED,
    WINDOW_STATE_TILE_DRAGGING,
    WINDOW_STATE_VISIBLE_OUTPUTS,
    WINDOW_STATE_RECT,
    WINDOW_STATE_WORKSPACE_VISIBLE,
} from "./window-manager";

const NOCTALIA_SHELL_PATH = "/home/bea4dev/Documents/development/noctalia-shell-shojiwm";
const HYBRID_WINDOW_MANAGER = new HybridWindowManager(naturalRootRect);

WINDOW_MANAGER.process.once("fcitx5", {
    command: ["fcitx5", "-d"],
    runPolicy: "once-per-session",
});
WINDOW_MANAGER.process.once("shell", {
    command: ["qs", "--path", NOCTALIA_SHELL_PATH],
    runPolicy: "once-per-session",
});


WINDOW_MANAGER.key.bind("terminal", "Super+T", () => {
    WINDOW_MANAGER.process.spawn({ command: ["kitty"] });
});
WINDOW_MANAGER.key.bind("launcher", "Super+A", () => {
    WINDOW_MANAGER.process.spawn({ command: ["qs", "--path", NOCTALIA_SHELL_PATH, "ipc", "call", "launcher", "toggle"] });
});
WINDOW_MANAGER.key.bind("clipboard", "Super+V", () => {
    WINDOW_MANAGER.process.spawn({ command: ["qs", "--path", NOCTALIA_SHELL_PATH, "ipc", "call", "launcher", "clipboard"] });
});
WINDOW_MANAGER.key.bind("screenshot", "Super+P", () => {
    WINDOW_MANAGER.process.spawn({ command: "hyprshot -m region --raw | swappy -f -" });
});
WINDOW_MANAGER.key.bind("screenshot-freeze", "Super+Ctrl+P", () => {
    WINDOW_MANAGER.process.spawn({ command: "hyprshot -m region --freeze --raw | swappy -f -" });
});
WINDOW_MANAGER.key.bind("toggle-tiling-mode", "Super+S", () => {
    HYBRID_WINDOW_MANAGER.toggleCurrentWorkspaceTiling();
});
WINDOW_MANAGER.key.bind("close-focused-window", "Super+Q", () => {
    HYBRID_WINDOW_MANAGER.closeFocusedWindow();
});
WINDOW_MANAGER.key.bind("tile-focus-left-quick", "Super+Left", () => {
    HYBRID_WINDOW_MANAGER.focusTile(-1);
});
WINDOW_MANAGER.key.bind("tile-focus-right-quick", "Super+Right", () => {
    HYBRID_WINDOW_MANAGER.focusTile(1);
});
WINDOW_MANAGER.key.bind("tile-focus-left", "Super+Ctrl+Left", () => {
    HYBRID_WINDOW_MANAGER.focusTile(-1);
});
WINDOW_MANAGER.key.bind("tile-focus-right", "Super+Ctrl+Right", () => {
    HYBRID_WINDOW_MANAGER.focusTile(1);
});
WINDOW_MANAGER.key.bind("workspace-prev", "Super+Ctrl+Up", () => {
    HYBRID_WINDOW_MANAGER.switchWorkspace(-1);
});
WINDOW_MANAGER.key.bind("workspace-next", "Super+Ctrl+Down", () => {
    HYBRID_WINDOW_MANAGER.switchWorkspace(1);
});

let fpsCounter = false;
WINDOW_MANAGER.key.bind("fps", "Super+Shift+F", () => {
    fpsCounter = !fpsCounter;
    WINDOW_MANAGER.debug.fpsCounter = fpsCounter;
})

WINDOW_MANAGER.output.applyDisplayConfig((display) => {
    display["eDP-1"] = {
        resolution: "best",
        position: "auto",
        scale: 1.25,
    };
    display["eDP-2"] = {
        resolution: "best",
        position: "auto",
        scale: 1.8,
    };
    display["HDMI-A-1"] = {
        resolution: "best",
        position: "auto",
        scale: 1.5,
    };
    display["DP-1"] = {
        resolution: "best",
        position: "auto",
        scale: 1.5,
    };
    display["DP-4"] = {
        resolution: "best",
        position: "auto",
        scale: 1.5,
    };
    display["DP-2"] = {
        resolution: "best",
        position: "auto",
        scale: 1.6,
    };
});

WINDOW_MANAGER.effect.background_effect = compileEffect({
    input: backdropSource(),
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
    pipeline: [
        dualKawaseBlur({ radius: 4, passes: 2 }),
    ]
});

WINDOW_MANAGER.event.onOpen((window) => {
    HYBRID_WINDOW_MANAGER.onOpen(window);
});

WINDOW_MANAGER.event.onFirstCommit((window) => {
    HYBRID_WINDOW_MANAGER.onFirstCommit(window);
});

WINDOW_MANAGER.event.onStartClose((window) => {
    HYBRID_WINDOW_MANAGER.onStartClose(window);
});

WINDOW_MANAGER.event.onClose((window) => {
    HYBRID_WINDOW_MANAGER.onClose(window);
});

WINDOW_MANAGER.event.onFocus((window, focused) => {
    HYBRID_WINDOW_MANAGER.onFocus(window, focused);
});

WINDOW_MANAGER.event.onPointerMoveAsync((event) => {
    HYBRID_WINDOW_MANAGER.onPointerMove(event);
});

WINDOW_MANAGER.event.onWindowResize((event) => {
    HYBRID_WINDOW_MANAGER.onWindowResize(event);
});

WINDOW_MANAGER.pointer.bindWindowMoveModifier("Super");

WINDOW_MANAGER.event.onWindowMove((event) => {
    HYBRID_WINDOW_MANAGER.onWindowMove(event);
});

WINDOW_MANAGER.event.onWindowMaximizeRequest((event) => {
    HYBRID_WINDOW_MANAGER.onWindowMaximizeRequest(event);
});

WINDOW_MANAGER.event.onWindowMinimizeRequest((event) => {
    HYBRID_WINDOW_MANAGER.onWindowMinimizeRequest(event);
});

WINDOW_MANAGER.event.onWindowActivateRequest((event) => {
    HYBRID_WINDOW_MANAGER.onWindowActivateRequest(event);
});

function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
    const client = window.position;
    return {
        x: client.x - WINDOW_BORDER_PX,
        y: client.y - TITLEBAR_HEIGHT - WINDOW_BORDER_PX,
        width: client.width + WINDOW_BORDER_PX * 2,
        height: client.height + TITLEBAR_HEIGHT + WINDOW_BORDER_PX * 2,
    };
}

WINDOW_MANAGER.window.composition = (window: WaylandWindow) => {
    const workspaceVisible = window.state[WINDOW_STATE_WORKSPACE_VISIBLE];
    const tileDragging = window.state[WINDOW_STATE_TILE_DRAGGING];
    const forceRectSize = computed(() => window.isResizable() && !window.isTransient());
    const minimized = window.state[WINDOW_STATE_MINIMIZED];
    const inactive = computed(() => minimized() || (!workspaceVisible() && !tileDragging()));

    const borderColor = window.isFocused(focused => focused ? "#d7ba7d" : "#4f5666");
    const titlebarBackground = window.isFocused(focused => focused ? "#1f243080" : "#2a2f3a80");
    const titleColor = window.isFocused(focused => focused ? "#f5f7fa" : "#c9d1d9");

    const titlebarStyle: SSDStyle = {
        height: TITLEBAR_HEIGHT,
        paddingX: 8,
        gap: 8,
        alignItems: "center",
        background: titlebarBackground,
    };

    const backgroundShader = compileEffect({
        input: backdropSource(),
        invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
        pipeline: [
            dualKawaseBlur({ radius: 4, passes: 2 }),
            /*
            shaderStage(loadShader("./src/liquid-glass.frag"), {
                uniforms: {
                    glass_radius_px: 10.0,
                    distortion_depth: 0.2,
                    distortion_strength: 0.15,
                    chromatic_shift_px: 3.0,
                    glass_tint: 0.9,
                },
            }),*/
        ],
    });

    const titleOnlyShader = compileEffect({
        input: backdropSource(),
        invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
        pipeline: [
            dualKawaseBlur({ radius: 4, passes: 2 }),
        ],
    });

    const appIcon = (<AppIcon icon={window.icon} style={{ width: 16, height: 16 }} />);
    const label = (
        <Label
            text={window.title}
            style={{
                color: titleColor,
                fontFamily: ["Noto Sans CJK JP", "Noto Color Emoji"],
                fontSize: 13,
                fontWeight: 600,
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
            }}
        />
    );
    const minimizeButton = (<MinimizeButton window={window} />);
    const maximizeButton = (<MaximizeButton window={window} />);
    const closeButton = (<CloseButton window={window} />);

    var innerComponents = (
        <Box direction="column">
            <ShaderEffect shader={titleOnlyShader} direction="row" style={titlebarStyle}>
                {appIcon}
                {label}
                {minimizeButton}
                {maximizeButton}
                {closeButton}
            </ShaderEffect>
            <ClientWindow />
        </Box>
    );

    const TERMINALS = ["kitty", "ghostty"];

    if (TERMINALS.includes(window.appId() ?? "")) {
        innerComponents = (
            <ShaderEffect shader={backgroundShader} direction="column">
                <Box direction="row" style={titlebarStyle}>
                    {appIcon}
                    {label}
                    {minimizeButton}
                    {maximizeButton}
                    {closeButton}
                </Box>
                <ClientWindow />
            </ShaderEffect>
        );
    }

    return (
        <ManagedWindow
            rect={window.state[WINDOW_STATE_RECT]}
            zIndex={HYBRID_WINDOW_MANAGER.getWindowZIndex(window)}
            visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
            forceRectSize={forceRectSize}
            idle={inactive}
            interactive={inactive(value => !value)}
        >
            <WindowBorder
                style={{
                    border: { px: WINDOW_BORDER_PX, color: borderColor },
                    borderRadius: 10,
                    background: "#10131900",
                    padding: 0,
                    paddingX: 0,
                    paddingRight: 0,
                }}
            >
                <Box direction="row">
                    {innerComponents}
                </Box>
            </WindowBorder>
        </ManagedWindow>
    );
};

const CloseButton = ({ window }: { window: WaylandWindow }) => {
    const [hover, setHover] = useState(false);

    const borderColor = hover(hover => hover ? "#00000000" : "#F0808030");

    var icon: CompositionRenderable | null = null;
    if (hover()) {
        icon = (
            <Image
                src="./assets/x.svg"
                style={{
                    width: 16,
                    height: 16,
                    position: "absolute",
                    zIndex: 1,
                    pointerEvents: "none"
                }}
            />
        );
    }

    return (
        <Box style={{ position: "relative", flexShrink: 0 }}>
            <Button
                onHoverChange={setHover}
                style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    background: "#FFFFFF20",
                    border: { px: 1, color: borderColor },
                }}
                onClick={window.close}
            />
            {icon}
        </Box>
    )
};

const MaximizeButton = ({ window }: { window: WaylandWindow }) => {
    const [hover, setHover] = useState(false);

    const borderColor = hover(hover => hover ? "#00000000" : "#00BFFF30");

    var icon: CompositionRenderable | null = null;
    if (hover()) {
        const src = window.isMaximized(maximized => {
            return maximized ? "./assets/minimize-2.svg" : "./assets/maximize-2.svg";
        });

        icon = (
            <Image
                src={src}
                style={{
                    width: 16,
                    height: 16,
                    position: "absolute",
                    zIndex: 1,
                    pointerEvents: "none"
                }}
            />
        );
    }

    return (
        <Box style={{ position: "relative", flexShrink: 0 }}>
            <Button
                onHoverChange={setHover}
                style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    background: "#FFFFFF20",
                    border: { px: 1, color: borderColor },
                }}
                onClick={() => {
                    if (read(window.isMaximized)) {
                        window.unmaximize();
                    } else {
                        window.maximize();
                    }
                }}
            />
            {icon}
        </Box>
    )
};

const MinimizeButton = ({ window }: { window: WaylandWindow }) => {
    const [hover, setHover] = useState(false);

    const borderColor = hover(hover => hover ? "#00000000" : "#F8FF7530");

    var icon: CompositionRenderable | null = null;
    if (hover()) {
        icon = (
            <Image
                src="./assets/minus.svg"
                style={{
                    width: 16,
                    height: 16,
                    position: "absolute",
                    zIndex: 1,
                    pointerEvents: "none"
                }}
            />
        );
    }

    return (
        <Box style={{ position: "relative", flexShrink: 0 }}>
            <Button
                onHoverChange={setHover}
                style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    background: "#FFFFFF20",
                    border: { px: 1, color: borderColor },
                }}
                onClick={() => window.minimize()}
            />
            {icon}
        </Box>
    )
};
