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
import { HybridWindowManager, OPEN_ANIMATION, WINDOW_STATE_MINIMIZED, WINDOW_STATE_RECT } from "./window-manager";

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

WINDOW_MANAGER.output.applyDisplayConfig((display) => {
    display["eDP-1"] = {
        resolution: "best",
        position: "auto",
        scale: 1.25,
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

const WINDOW_BORDER_PX = 2;
const TITLEBAR_HEIGHT = 30;

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
    const openVariable = window.animation.signal(OPEN_ANIMATION);
    const opacity = openVariable;
    const translateY = openVariable(variable => (1 - variable) * 200);
    const rect = computed(() => {
        const base = window.state[WINDOW_STATE_RECT]();
        const dy = translateY();
        return {
            x: base.x,
            y: base.y + dy,
            width: base.width,
            height: base.height,
        };
    });
    const forceRectSize = computed(() => window.isResizable() && !window.isTransient());
    const minimized = window.state[WINDOW_STATE_MINIMIZED];

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
            dualKawaseBlur({ radius: 2, passes: 2 }),
            shaderStage(loadShader("./src/liquid-glass.frag"), {
                uniforms: {
                    glass_radius_px: 10.0,
                    distortion_depth: 0.2,
                    distortion_strength: 0.15,
                    chromatic_shift_px: 3.0,
                    glass_tint: 0.9,
                },
            }),
        ],
    });

    const titleOnlyShader = compileEffect({
        input: backdropSource(),
        invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
        pipeline: [
            dualKawaseBlur({ radius: 2, passes: 2 }),
            shaderStage(loadShader("./src/liquid-glass.frag"), {
                uniforms: {
                    glass_radius_px: 10.0,
                    distortion_depth: 0.3,
                    distortion_strength: 0.1,
                    chromatic_shift_px: 3.0,
                    glass_tint: 0.9,
                },
            }),
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
            rect={rect}
            zIndex={HYBRID_WINDOW_MANAGER.getWindowZIndex(window)}
            forceRectSize={forceRectSize}
            idle={minimized}
            interactive={minimized(value => !value)}
            opacity={opacity}
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
