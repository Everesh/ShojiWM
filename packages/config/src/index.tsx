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
    compileWindowEffect,
    dualKawaseBlur,
    type SSDStyle,
    type WaylandWindow,
    animationVariable,
    seconds,
    cubicBezier,
    computed,
    useState,
    shaderStage,
    loadShader,
    windowSource,
    ManagedWindow,
    createWindowState,
} from "shoji_wm";
import type { DecorationRenderable, ManagedWindowRect, WindowPosition } from "shoji_wm/types";

const NOCTALIA_SHELL_PATH = "/home/bea4dev/Documents/development/noctalia-shell-shojiwm";

/*
WINDOW_MANAGER.output.applyDisplayConfig((display) => {
    for (let displayName of WINDOW_MANAGER.output.list) {
        display[displayName] = {
            resolution: "best",
            position: "auto",
            scale: 2,
        };
    }
});*/

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

const openAnimation = animationVariable("window.open");

WINDOW_MANAGER.effect.background_effect = compileEffect({
    input: backdropSource(),
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
    pipeline: [
        dualKawaseBlur({ radius: 4, passes: 2 }),
    ]
});
/*
const windowShadowEffect = compileWindowEffect({
    input: windowSource({ include: "full" }),
    outsets: { left: 72, right: 72, top: 56, bottom: 96 },
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
    pipeline: [
        shaderStage(loadShader("./src/window-shadow.frag"), {
            uniforms: {
                shadow_color: [0.45, 0.45, 0.45],
                shadow_opacity: 0.5,
                shadow_offset_px: [24.0, 24.0],
            },
        }),
    ],
});

const windowFrontEffect = compileWindowEffect({
    input: windowSource({ include: "full" }),
    outsets: { left: 72, right: 72, top: 56, bottom: 96 },
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
    pipeline: [
        shaderStage(loadShader("./src/window-shadow.frag"), {
            uniforms: {
                shadow_color: [0.45, 0.45, 0.45],
                shadow_opacity: 0.5,
                shadow_offset_px: [-24.0, -24.0],
            },
        }),
    ],
});

const windowReplaceEffect = compileWindowEffect({
    input: windowSource({ include: "full" }),
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 4 },
    pipeline: [
        shaderStage(loadShader("./src/window-grayscale.frag")),
    ],
});

WINDOW_MANAGER.effect.window = (window) => ({
    behindRootSurface: windowShadowEffect,
    inFront: windowFrontEffect,
    replace: windowReplaceEffect,
});*/

const OPEN_CLOSE_ANIMATION_DURATION = seconds(1.0)

const DEFAULT_WINDOW_RECT: WindowPosition = { x: 100, y: 200, width: 1000, height: 700 };
const WINDOW_STATE_RECT = createWindowState<ManagedWindowRect>("rect", {
    default: (window) => window.rect ?? DEFAULT_WINDOW_RECT,
});

WINDOW_MANAGER.event.onOpen((window) => {
    window.state[WINDOW_STATE_RECT].set(window.rect ?? DEFAULT_WINDOW_RECT);
    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
    window.animation.start(openAnimation, {
        duration: OPEN_CLOSE_ANIMATION_DURATION,
        to: 1,
        easing: cubicBezier(0.1, 0.93, 0.1, 0.93)
    });
});

WINDOW_MANAGER.event.onStartClose((window) => {
    window.animation.start(openAnimation, {
        duration: OPEN_CLOSE_ANIMATION_DURATION,
        to: 0,
        easing: cubicBezier(0.1, 0.93, 0.1, 0.93)
    });
});

WINDOW_MANAGER.event.onFocus((window, focused) => {
    /*
    window.animation.start(focusAnimation, {
        duration: seconds(0.5),
        to: focused ? 1 : 0.9,
        easing: cubicBezier(0.1, 0.93, 0.1, 0.93)
    });*/
});

WINDOW_MANAGER.event.onWindowResize((event) => {
    event.window.state[WINDOW_STATE_RECT].set(event.currentRect);
});

WINDOW_MANAGER.decoration = (window: WaylandWindow) => {
    const openVariable = window.animation.signal(openAnimation);
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

    const borderColor = window.isFocused(focused => focused ? "#d7ba7d" : "#4f5666");
    const titlebarBackground = window.isFocused(focused => focused ? "#1f243080" : "#2a2f3a80");
    const titleColor = window.isFocused(focused => focused ? "#f5f7fa" : "#c9d1d9");

    const titlebarStyle: SSDStyle = {
        height: 30,
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
    const closeButton = (<CloseButton window={window} />);

    var innerComponents = (
        <Box direction="column">
            <ShaderEffect shader={titleOnlyShader} direction="row" style={titlebarStyle}>
                {appIcon}
                {label}
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
                    {closeButton}
                </Box>
                <ClientWindow />
            </ShaderEffect>
        );
    }

    return (
        <ManagedWindow
            rect={rect}
            clipToRect
            opacity={opacity}
        >
            <WindowBorder
                style={{
                    border: { px: 2, color: borderColor },
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

    const background = hover(hover => hover ? "#F08080" : "#F0808080");

    var icon: DecorationRenderable | null = null;
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
                    background: background,
                    border: { px: 1, color: "#f5f7fa" },
                }}
                onClick={window.close}
            />
            {icon}
        </Box>
    )
};

export { WINDOW_MANAGER };
