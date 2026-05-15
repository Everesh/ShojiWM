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
    useState,
    computed,
    shaderInput,
    shaderStage,
    loadShader,
    windowSource,
} from "shoji_wm";
import type { DecorationRenderable, Direction, MaybeSignal } from "shoji_wm/types";

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

WINDOW_MANAGER.process.once("xdg-portal-env", {
    command:
        "export XDG_SESSION_TYPE=wayland && " +
        "systemctl --user import-environment " +
        "WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP XDG_SESSION_TYPE && " +
        "systemctl --user reset-failed xdg-desktop-portal xdg-desktop-portal-wlr 2>/dev/null; " +
        "systemctl --user restart xdg-desktop-portal xdg-desktop-portal-wlr",
    runPolicy: "once-per-session",
});
// Workaround for the xdg-desktop-portal-wlr (xdpw) 30 fps cap.
//
// xdpw commit ca7a3e2e dropped PW_STREAM_FLAG_DRIVER, which makes its
// screencast PipeWire stream piggy-back on the audio sink driver's quantum
// (default 1024/48000 ≈ 21.3 ms). Combined with the wlr-screencopy
// request/reply round-trip, OBS / portal-based screen sharing tools cap at
// ~19-30 fps regardless of the configured target. ShojiWM's own
// wlr-screencopy implementation is fine — wf-recorder records at full rate
// without any workaround. See docs/screencast-30fps-xdpw-bug.md and
// https://github.com/emersion/xdg-desktop-portal-wlr/pull/370 for details.
//
// Forcing PipeWire's graph quantum to 256/48000 ≈ 5.3 ms gives the video
// stream enough headroom to complete its cycle within one display vblank.
// Audio side-effects are negligible at this quantum on a modern CPU, but
// because it is a system-wide PipeWire setting, this is opt-in: uncomment
// the block below if you actually do screencast through OBS / Discord /
// Vesktop / etc. and want 60 fps.
//
// WINDOW_MANAGER.process.once("pipewire-screencast-quantum", {
//     command: "pw-metadata -n settings 0 clock.force-quantum 256",
//     runPolicy: "once-per-session",
// });
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

const openAnimation = animationVariable("window.open")
const focusAnimation = animationVariable("window.focus");

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

WINDOW_MANAGER.event.onOpen((window) => {
    window.setCloseAnimationDuration(seconds(2.0));
    window.animation.start(openAnimation, {
        duration: seconds(2.0),
        to: 1,
        easing: cubicBezier(0.1, 0.93, 0.1, 0.93)
    });
    window.animation.set(focusAnimation, window.isFocused() ? 1 : 1);
});

WINDOW_MANAGER.event.onStartClose((window) => {
    window.animation.start(openAnimation, {
        duration: seconds(2.0),
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

WINDOW_MANAGER.decoration = (window: WaylandWindow) => {
    const scale = window.animation.signal(focusAnimation);
    const openVariable = window.animation.signal(openAnimation);
    const opacity = openVariable;
    const translateY = openVariable(variable => (1 - variable) * 200);

    window.transform.origin = { x: 0.5, y: 0.5 };
    window.transform.translateX = 0;
    window.transform.translateY = translateY;
    window.transform.scaleX = scale;
    window.transform.scaleY = scale;
    window.transform.opacity = opacity;

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
            dualKawaseBlur({ radius: 4, passes: 2 }),
            shaderStage(loadShader("./src/liquid-glass.frag"), {
                uniforms: {
                    inset_px: 0.0,
                    border_radius_px: 10.0,
                    edge_width_px: 10.0,
                    edge_softness_px: 0.0,
                    max_warp_px: 20.0,
                    interior_warp_px: 0.0,
                    white_tint: 0.0,
                    edge_highlight: 0.0,
                },
            }),
        ],
    });

    return (
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
                <Box direction="column">
                    <ShaderEffect shader={backgroundShader} direction="row" style={titlebarStyle}>
                        <AppIcon icon={window.icon} style={{ width: 16, height: 16 }} />
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
                        <CloseButton window={window} />
                    </ShaderEffect>
                    <ClientWindow />
                </Box>
            </Box>
        </WindowBorder>
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
