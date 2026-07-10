import {
  COMPOSITOR,
  compileEffect,
  compileLayerEffect,
  compilePopupEffect,
  dualKawaseBlur,
  shaderStage,
  loadShader,
  backdropSource,
  layerSource,
  popupSource,
  type DisplayConfigDraft,
} from "shoji_wm";
import { createIpcServer } from "shoji_wm/ipc";
import { HYBRID_WINDOW_MANAGER, HOT_RELOAD_WINDOW_MANAGER_STATE } from "./state";
import { WindowComposition } from "./decorations";

// --- 1. Environment ---
COMPOSITOR.env.apply({
  QT_QPA_PLATFORM: "wayland;xcb",
  QT_QPA_PLATFORMTHEME: "qt6ct",
  QT_IM_MODULE: "fcitx",
  XMODIFIERS: "@im=fcitx",
  SDL_IM_MODULE: "fcitx",
  GLFW_IM_MODULE: "ibus",
  ELECTRON_OZONE_PLATFORM_HINT: "wayland",
});
COMPOSITOR.env.publish();

// --- 2. IPC & State Sync ---
const WORKSPACE_IPC = createIpcServer();
let lastWorkspacesJson = "";
let workspaceBroadcastQueued = false;

function broadcastWorkspaces() {
  const view = HYBRID_WINDOW_MANAGER.viewForIpc();
  const json = JSON.stringify(view);
  if (json === lastWorkspacesJson) return;
  lastWorkspacesJson = json;
  WORKSPACE_IPC.broadcast("workspaces.changed", view);
}

function scheduleWorkspaceBroadcast() {
  if (workspaceBroadcastQueued) return;
  workspaceBroadcastQueued = true;
  void Promise.resolve().then(() => {
    workspaceBroadcastQueued = false;
    broadcastWorkspaces();
  });
}

WORKSPACE_IPC.handle("workspaces.get", () => HYBRID_WINDOW_MANAGER.viewForIpc());
WORKSPACE_IPC.handle("workspaces.switch", (params: any) => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(params?.direction === -1 ? -1 : 1);
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("workspaces.activate", (params: any) => {
  if (params?.monitor && typeof params.index === "number") {
    HYBRID_WINDOW_MANAGER.activate(params.monitor, params.index);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("workspaces.toggleTiling", (params: any) => {
  if (params?.monitor) HYBRID_WINDOW_MANAGER.toggleWorkspaceTilingForMonitor(params.monitor);
  else HYBRID_WINDOW_MANAGER.toggleCurrentWorkspaceTiling();
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("windows.activate", (params: any) => {
  if (typeof params?.windowId === "string") {
    HYBRID_WINDOW_MANAGER.activateWindowById(params.windowId);
    scheduleWorkspaceBroadcast();
  }
});

let lastSnapJson = "";
HYBRID_WINDOW_MANAGER.setSnapPreviewBroadcaster((preview) => {
  const json = JSON.stringify(preview);
  if (json === lastSnapJson) return;
  lastSnapJson = json;
  WORKSPACE_IPC.broadcast("snap.preview", preview);
});

HYBRID_WINDOW_MANAGER.setWorkspaceChangeBroadcaster(() => scheduleWorkspaceBroadcast());
COMPOSITOR.onDisable(() => WORKSPACE_IPC.close());

// --- 3. Hardware & Inputs ---
COMPOSITOR.output.configure((context) => {
  const display: DisplayConfigDraft = {};
  display["DP-4"] = { mode: "extend", resolution: "best", position: { x: 0, y: 600 }, scale: 1.0 };
  display["HDMI-A-2"] = { mode: "extend", resolution: "best", position: { x: 1920, y: 600 }, scale: 1.0 };
  display["DP-5"] = { mode: "extend", resolution: "best", position: { x: 1920, y: 0 }, scale: 1.0 };

  const isDocked = context.connected.some((output) => output.name === "HDMI-A-1");
  if (isDocked) {
    display["eDP-1"] = { mode: "disabled" };
    display["eDP-2"] = { mode: "disabled" };
  }
  return display;
});

COMPOSITOR.input.configure((input) => {
  input.global = {
    touchpad: { tapToClick: true, naturalScroll: true, scrollMethod: "twoFinger", disableWhileTyping: true, scrollFactor: 0.3 },
    pointer: { pointerAccel: 0.0, accelProfile: "flat" },
    keyboard: { options: "caps:ctrl_modifier", repeatRate: 60, repeatDelay: 250 },
  };
  input.device["Razer Razer Blade Keyboard"] = { keyboard: { layout: "us" } };
});

HYBRID_WINDOW_MANAGER.configureWorkspaceGestureSpeed({
  workspaceScrollFactor: 1.5,
  workspaceScrollKineticFactor: 1,
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
});

COMPOSITOR.pointer.bindWindowMoveModifier("Super");
COMPOSITOR.pointer.bindWindowResizeModifier("Super");

// --- 4. Dock Proximity ---
const DOCK_SHOW_ZONE_PX = 10;
const DOCK_HIDE_ZONE_PX = 120;
const dockProximityByMonitor = new Map<string, boolean>();

function pointerInBottomStrip(monitor: string, pointerX: number, pointerY: number, stripPx: number): boolean {
  const output = COMPOSITOR.output.get(monitor);
  if (!output || !output.resolution) return false;
  const width = output.resolution.width / output.scale;
  const height = output.resolution.height / output.scale;
  return pointerX >= output.position.x && pointerX < output.position.x + width && pointerY >= output.position.y + height - stripPx && pointerY < output.position.y + height;
}

function updateDockProximity(monitor: string, inside: boolean) {
  if (dockProximityByMonitor.get(monitor) === inside) return;
  dockProximityByMonitor.set(monitor, inside);
  WORKSPACE_IPC.broadcast("dock.proximity", { monitor, inside });
}

// --- 5. Keybindings ---
function toggleStartMenu() {
  const monitor = HYBRID_WINDOW_MANAGER.getCurrentMonitorName();
  COMPOSITOR.process.spawn({ command: ["ags", "request", "-i", "ags", "start-menu", "toggle", monitor] });
}

COMPOSITOR.key.bind("terminal", "Super+T", () => COMPOSITOR.process.spawn({ command: ["kitty"] }));
COMPOSITOR.key.bind("chrome", "Super+B", () => COMPOSITOR.process.spawn({ command: "google-chrome-stable --enable-features=OzonePlatform --ozone-platform=wayland" }));
COMPOSITOR.key.bind("discord", "Super+D", () => COMPOSITOR.process.spawn({ command: "discord --enable-features=UseOzonePlatform --ozone-platform=wayland --enable-wayland-ime --disable-gpu" }));
COMPOSITOR.key.bind("dolphin", "Super+E", () => COMPOSITOR.process.spawn({ command: "dolphin" }));
COMPOSITOR.key.bind("play", "XF86AudioPlay", () => COMPOSITOR.process.spawn({ command: "playerctl play-pause" }));
COMPOSITOR.key.bind("pause", "XF86AudioPause", () => COMPOSITOR.process.spawn({ command: "playerctl play-pause" }));
COMPOSITOR.key.bind("next", "XF86AudioNext", () => COMPOSITOR.process.spawn({ command: "playerctl next" }));
COMPOSITOR.key.bind("prev", "XF86AudioPrev", () => COMPOSITOR.process.spawn({ command: "playerctl previous" }));
COMPOSITOR.key.bind("term", "Super+Return", () => COMPOSITOR.process.spawn({ command: "alacritty" }));
COMPOSITOR.key.bind("rofi", "Super+Z", () => COMPOSITOR.process.spawn({ command: "rofi -show run" }));
COMPOSITOR.key.bind("zeditor", "Super+Shift+Z", () => COMPOSITOR.process.spawn({ command: "zeditor" }));
COMPOSITOR.key.bind("web", "Super+Shift+W", () => COMPOSITOR.process.spawn({ command: "firefox" }));
COMPOSITOR.key.bind("start-menu", "Super+A", toggleStartMenu);
COMPOSITOR.key.bind("start-menu-tap", "Super", toggleStartMenu, { on: "release" });
COMPOSITOR.key.bind("clipboard", "Super+V", () => {
  const monitor = HYBRID_WINDOW_MANAGER.getCurrentMonitorName();
  COMPOSITOR.process.spawn({ command: ["ags", "request", "-i", "ags", "clipboard", "toggle", monitor] });
});
COMPOSITOR.key.bind("screenshot", "Super+P", () => COMPOSITOR.process.spawn({ command: "hyprshot -m region --raw | swappy -f -" }));
COMPOSITOR.key.bind("screenshot-freeze", "Super+Ctrl+P", () => COMPOSITOR.process.spawn({ command: "hyprshot -m region --freeze --raw | swappy -f -" }));
COMPOSITOR.key.bind("close-focused-window-C", "Super+C", () => HYBRID_WINDOW_MANAGER.closeFocusedWindow());
COMPOSITOR.key.bind("close-focused-window", "Super+Q", () => HYBRID_WINDOW_MANAGER.closeFocusedWindow());
COMPOSITOR.key.bind("toggle-focused-window-maximize", "Super+M", () => HYBRID_WINDOW_MANAGER.toggleFocusedWindowMaximize());
COMPOSITOR.key.bind("toggle-tiling-mode", "Super+S", () => { HYBRID_WINDOW_MANAGER.toggleCurrentWorkspaceTiling(); scheduleWorkspaceBroadcast(); });
COMPOSITOR.key.bind("tile-focus-left-quick", "Super+Left", () => HYBRID_WINDOW_MANAGER.focusTile(-1));
COMPOSITOR.key.bind("tile-focus-right-quick", "Super+Right", () => HYBRID_WINDOW_MANAGER.focusTile(1));
COMPOSITOR.key.bind("tile-focus-left", "Super+Ctrl+Left", () => HYBRID_WINDOW_MANAGER.focusTile(-1));
COMPOSITOR.key.bind("tile-focus-right", "Super+Ctrl+Right", () => HYBRID_WINDOW_MANAGER.focusTile(1));
COMPOSITOR.key.bind("tile-move-left", "Super+Shift+Left", () => { HYBRID_WINDOW_MANAGER.moveFocusedTile(-1); scheduleWorkspaceBroadcast(); });
COMPOSITOR.key.bind("tile-move-right", "Super+Shift+Right", () => { HYBRID_WINDOW_MANAGER.moveFocusedTile(1); scheduleWorkspaceBroadcast(); });
COMPOSITOR.key.bind("window-move-workspace-prev", "Super+Shift+Up", () => { HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(-1); scheduleWorkspaceBroadcast(); });
COMPOSITOR.key.bind("window-move-workspace-next", "Super+Shift+Down", () => { HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(1); scheduleWorkspaceBroadcast(); });
COMPOSITOR.key.bind("workspace-prev", "Super+Ctrl+Up", () => { HYBRID_WINDOW_MANAGER.switchWorkspace(-1); scheduleWorkspaceBroadcast(); });
COMPOSITOR.key.bind("workspace-next", "Super+Ctrl+Down", () => { HYBRID_WINDOW_MANAGER.switchWorkspace(1); scheduleWorkspaceBroadcast(); });

let fpsCounter = false;
COMPOSITOR.key.bind("fps", "Super+Shift+F", () => { fpsCounter = !fpsCounter; COMPOSITOR.debug.fpsCounter = fpsCounter; });
let profileEnabled = false;
COMPOSITOR.key.bind("profile", "Super+Shift+T", () => { profileEnabled = !profileEnabled; COMPOSITOR.debug.enableProfile(profileEnabled); });

// --- 6. Effects & UI ---
COMPOSITOR.effect.background_effect = compileEffect({
  input: backdropSource(),
  invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
  pipeline: [dualKawaseBlur({ radius: 4, passes: 2 })],
});

const LAYER_BLUR_MASK = compileLayerEffect({
  input: backdropSource(),
  invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 2 }),
    shaderStage(loadShader("./src/glsl/layer-blur-mask.frag"), {
      textures: { layer_mask: layerSource() },
      uniforms: { opacity_threshold: 0.25, mask_feather: 0.04 },
    }),
  ],
});

COMPOSITOR.effect.layer = (layer) => layer.namespace() === "no_blur" ? {} : { behind: LAYER_BLUR_MASK };

const POPUP_BLUR = compilePopupEffect({
  input: backdropSource(),
  invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 2 }),
    shaderStage(loadShader("./src/glsl/layer-blur-mask.frag"), {
      textures: { layer_mask: popupSource() },
      uniforms: { opacity_threshold: 0.25, mask_feather: 0.04 },
    }),
  ],
});

COMPOSITOR.effect.popup = (popup) => popup.parentKind === "window" ? {} : { behind: POPUP_BLUR };

// Set the TSX UI composition
COMPOSITOR.window.composition = WindowComposition;

// --- 7. Window Manager Events ---
COMPOSITOR.event.onOpen((window) => HYBRID_WINDOW_MANAGER.onOpen(window));
COMPOSITOR.event.onFirstCommit((window) => { HYBRID_WINDOW_MANAGER.onFirstCommit(window); scheduleWorkspaceBroadcast(); });
COMPOSITOR.event.onStartClose((window) => { HYBRID_WINDOW_MANAGER.onStartClose(window); scheduleWorkspaceBroadcast(); });
COMPOSITOR.event.onClose((window) => { HYBRID_WINDOW_MANAGER.onClose(window); scheduleWorkspaceBroadcast(); });
COMPOSITOR.event.onFocus((window, focused) => {
  HYBRID_WINDOW_MANAGER.onFocus(window, focused);
  if (focused) { HYBRID_WINDOW_MANAGER.recordFocus(window.id); scheduleWorkspaceBroadcast(); }
});

COMPOSITOR.event.onPointerMoveAsync((event) => {
  HYBRID_WINDOW_MANAGER.onPointerMove(event);
  const pointerX = event.position.x;
  const pointerY = event.position.y;
  for (const monitor of COMPOSITOR.output.list) {
    const onTrackedMonitor = monitor === event.outputName;
    const wasInside = dockProximityByMonitor.get(monitor) === true;
    const inside = onTrackedMonitor && pointerInBottomStrip(monitor, pointerX, pointerY, wasInside ? DOCK_HIDE_ZONE_PX : DOCK_SHOW_ZONE_PX);
    updateDockProximity(monitor, inside);
  }
});

COMPOSITOR.event.onGestureSwipeAsync((event) => { HYBRID_WINDOW_MANAGER.onGestureSwipe(event); scheduleWorkspaceBroadcast(); });
COMPOSITOR.event.onOutputChange((event) => { HYBRID_WINDOW_MANAGER.onOutputChange(event); scheduleWorkspaceBroadcast(); });
COMPOSITOR.event.onCreateLayer(() => HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts());
COMPOSITOR.event.onUpdateLayer(() => HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts());
COMPOSITOR.event.onDestroyLayer(() => HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts());
COMPOSITOR.event.onWindowResize((event) => HYBRID_WINDOW_MANAGER.onWindowResize(event));
COMPOSITOR.event.onWindowMove((event) => HYBRID_WINDOW_MANAGER.onWindowMove(event));
COMPOSITOR.event.onWindowMaximizeRequest((event) => HYBRID_WINDOW_MANAGER.onWindowMaximizeRequest(event));
COMPOSITOR.event.onWindowMinimizeRequest((event) => HYBRID_WINDOW_MANAGER.onWindowMinimizeRequest(event));
COMPOSITOR.event.onWindowFullscreenRequest((event) => HYBRID_WINDOW_MANAGER.onWindowFullscreenRequest(event));
COMPOSITOR.event.onWindowActivateRequest((event) => { HYBRID_WINDOW_MANAGER.onWindowActivateRequest(event); scheduleWorkspaceBroadcast(); });

// --- 8. Start Processes ---
COMPOSITOR.process.once("ashell", { command: "ashell", runPolicy: "once-per-session" });
COMPOSITOR.process.once("dunst", { command: "dunst", runPolicy: "once-per-session" });
COMPOSITOR.process.once("shell", { command: "cd ~/.config/shoji-bar-2 && GTK_A11Y=none ags run app.tsx", runPolicy: "once-per-session" });
COMPOSITOR.process.service("cliphist-text", { command: ["wl-paste", "--type", "text", "--watch", "cliphist", "store"], restart: "on-exit" });
COMPOSITOR.process.service("cliphist-image", { command: ["wl-paste", "--type", "image", "--watch", "cliphist", "store"], restart: "on-exit" });

// --- 9. Hot Reloading ---
COMPOSITOR.onDisable((event) => {
  if (event.isReloading) event.persist(HOT_RELOAD_WINDOW_MANAGER_STATE, HYBRID_WINDOW_MANAGER.snapshot());
});

COMPOSITOR.onEnable((event) => {
  if (event.isReloading) {
    const snapshot = event.restore<ReturnType<typeof HYBRID_WINDOW_MANAGER.snapshot>>(HOT_RELOAD_WINDOW_MANAGER_STATE);
    if (snapshot) HYBRID_WINDOW_MANAGER.restore(snapshot);
  }
});

export default COMPOSITOR;
