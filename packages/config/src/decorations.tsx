import {
  AppIcon,
  Box,
  Button,
  ClientWindow,
  Image,
  ShaderEffect,
  Label,
  WindowBorder,
  backdropSource,
  compileEffect,
  dualKawaseBlur,
  computed,
  useState,
  loadShader,
  shaderStage,
  read,
  type SSDStyle,
  type WaylandWindow,
} from "shoji_wm";
import { ManagedWindow } from "shoji_wm";
import type { CompositionRenderable } from "shoji_wm/types";
import { HYBRID_WINDOW_MANAGER, FULLSCREEN_Z_INDEX } from "./state";
import { TITLEBAR_HEIGHT, WINDOW_BORDER_PX } from "./constants";
import {
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_TILED,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_RECT,
  WINDOW_STATE_WORKSPACE_VISIBLE,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
} from "./window_states";

export const WindowComposition = (window: WaylandWindow) => {
  const workspaceVisible = window.state[WINDOW_STATE_WORKSPACE_VISIBLE];
  const workspaceOffsetY = window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y];
  const workspaceOpacity = window.state[WINDOW_STATE_WORKSPACE_OPACITY];
  const tileDragging = window.state[WINDOW_STATE_TILE_DRAGGING];
  const managedRect = computed(() => {
    const rect = window.state[WINDOW_STATE_RECT]();
    return {
      x: read(rect.x),
      y: read(rect.y) + workspaceOffsetY(),
      width: read(rect.width),
      height: read(rect.height),
    };
  });
  const forceRectSize = computed(() => window.isResizable() && !window.isTransient());
  const tiled = computed(() => window.appId() === "mpv" || window.state[WINDOW_STATE_TILED]());
  const minimizeVisualIdle = window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE];
  const inactive = computed(() => minimizeVisualIdle() || (!workspaceVisible() && !tileDragging()));

  const borderColor = window.isFocused((focused) => (focused ? "#d7ba7d" : "#4f5666"));
  const titlebarBackground = window.isFocused((focused) => (focused ? "#1f243080" : "#2a2f3a80"));
  const titleColor = window.isFocused((focused) => (focused ? "#f5f7fa" : "#c9d1d9"));

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
      shaderStage(loadShader("./src/glsl/liquid-glass.frag"), {
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
    pipeline: [dualKawaseBlur({ radius: 4, passes: 2 })],
  });

  const appIcon = <AppIcon icon={window.icon} style={{ width: 16, height: 16 }} />;
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
  const minimizeButton = <MinimizeButton window={window} />;
  const maximizeButton = <MaximizeButton window={window} />;
  const closeButton = <CloseButton window={window} />;

  let innerComponents = (
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

  const TERMINALS = ["kitty", "ghostty", "Alacritty"];

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

  if (window.state[WINDOW_STATE_FULLSCREEN]()) {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={FULLSCREEN_Z_INDEX}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={workspaceOpacity}
        forceRectSize={forceRectSize}
        tiled={tiled}
        idle={inactive}
        interactive={inactive((value) => !value)}
        allowTearing={true}
      >
        <ClientWindow />
      </ManagedWindow>
    );
  }

  return (
    <ManagedWindow
      rect={managedRect}
      zIndex={HYBRID_WINDOW_MANAGER.getWindowZIndex(window)}
      visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
      opacity={workspaceOpacity}
      forceRectSize={forceRectSize}
      tiled={tiled}
      idle={inactive}
      interactive={inactive((value) => !value)}
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
        interaction={{
          resizeHitArea: { edgePx: 8, cornerPx: 14 },
        }}
      >
        <Box direction="row">{innerComponents}</Box>
      </WindowBorder>
    </ManagedWindow>
  );
};

export const CloseButton = ({ window }: { window: WaylandWindow }) => {
  const [hover, setHover] = useState(false);
  const borderColor = hover((h) => (h ? "#00000000" : "#F0808030"));

  let icon: CompositionRenderable | null = null;
  if (hover()) {
    icon = <Image src="./assets/x.svg" style={{ width: 16, height: 16, position: "absolute", zIndex: 1, pointerEvents: "none" }} />;
  }

  return (
    <Box style={{ position: "relative", flexShrink: 0 }}>
      <Button onHoverChange={setHover} style={{ width: 16, height: 16, borderRadius: 8, background: "#FFFFFF20", border: { px: 1, color: borderColor } }} onClick={window.close} />
      {icon}
    </Box>
  );
};

export const MaximizeButton = ({ window }: { window: WaylandWindow }) => {
  const [hover, setHover] = useState(false);
  const borderColor = computed(() => (!window.isResizable() ? "#00000000" : hover() ? "#00000000" : "#00BFFF30"));
  const shouldHover = computed(() => hover() && window.isResizable());

  let icon: CompositionRenderable | null = null;
  if (shouldHover()) {
    const src = window.isMaximized((maximized) => (maximized ? "./assets/minimize-2.svg" : "./assets/maximize-2.svg"));
    icon = <Image src={src} style={{ width: 16, height: 16, position: "absolute", zIndex: 1, pointerEvents: "none" }} />;
  }

  return (
    <Box style={{ position: "relative", flexShrink: 0 }}>
      <Button
        onHoverChange={setHover}
        style={{ width: 16, height: 16, borderRadius: 8, background: "#FFFFFF20", border: { px: 1, color: borderColor } }}
        onClick={() => {
          if (!read(window.isResizable)) return;
          if (read(window.isMaximized)) window.unmaximize();
          else window.maximize();
        }}
      />
      {icon}
    </Box>
  );
};

export const MinimizeButton = ({ window }: { window: WaylandWindow }) => {
  const [hover, setHover] = useState(false);
  const borderColor = hover((h) => (h ? "#00000000" : "#F8FF7530"));

  let icon: CompositionRenderable | null = null;
  if (hover()) {
    icon = <Image src="./assets/minus.svg" style={{ width: 16, height: 16, position: "absolute", zIndex: 1, pointerEvents: "none" }} />;
  }

  return (
    <Box style={{ position: "relative", flexShrink: 0 }}>
      <Button onHoverChange={setHover} style={{ width: 16, height: 16, borderRadius: 8, background: "#FFFFFF20", border: { px: 1, color: borderColor } }} onClick={() => window.minimize()} />
      {icon}
    </Box>
  );
};
