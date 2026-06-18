export interface WaylandWindowSnapshot {
  readonly id: string;
  readonly title: string;
  readonly appId?: string;
  readonly position: WindowPosition;
  readonly rect: WindowPosition;
  readonly isFocused: boolean;
  readonly isFloating: boolean;
  readonly isMaximized: boolean;
  readonly isFullscreen: boolean;
  readonly isXwayland: boolean;
  readonly sizeConstraints: WindowSizeConstraints;
  readonly isResizable: boolean;
  readonly isTransient: boolean;
  readonly parentId?: string;
  readonly icon?: WindowIcon;
  readonly interaction: WindowCompositionInteractionSnapshot;
}

export type WaylandLayerKind = "background" | "bottom" | "top" | "overlay";

export type WaylandLayerEdge = "top" | "bottom" | "left" | "right";

export type WaylandLayerKeyboardInteractivity =
  | "none"
  | "onDemand"
  | "exclusive";

/**
 * Anchored edges. `true` for each edge the client requested. A layer with all
 * four `true` means it stretches across the entire output; `top + bottom +
 * left` for example pins to three edges and stretches vertically.
 */
export interface WaylandLayerAnchor {
  readonly top: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

/**
 * Exclusive-zone request from the client. See `zwlr_layer_surface_v1`.
 *
 * - `exclusive` — surface reserves `size` logical pixels along its anchored
 *   edge; other surfaces avoid this strip.
 * - `neutral` — surface participates in avoidance but reserves nothing.
 * - `dontCare` — surface opts out; compositor may extend it under reserved
 *   zones.
 */
export type WaylandLayerExclusiveZone =
  | { readonly mode: "exclusive"; readonly size: number }
  | { readonly mode: "neutral" }
  | { readonly mode: "dontCare" };

export interface WaylandLayerMargin {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface WaylandLayerDesiredSize {
  readonly width: number;
  readonly height: number;
}

export interface WaylandLayerSnapshot {
  readonly id: string;
  readonly namespace?: string;
  readonly layer: WaylandLayerKind;
  readonly outputName: string;
  readonly position: LayerPosition;
  readonly anchor: WaylandLayerAnchor;
  readonly exclusiveZone: WaylandLayerExclusiveZone;
  /**
   * The single edge the client wants its exclusive zone applied to (since
   * layer-shell v5). `null` when the client did not select an unambiguous
   * edge — fall back to the implicit edge derived from `anchor`.
   */
  readonly exclusiveEdge: WaylandLayerEdge | null;
  readonly margin: WaylandLayerMargin;
  readonly keyboardInteractivity: WaylandLayerKeyboardInteractivity;
  /** Size the client asked for in its layer-shell `set_size` request. */
  readonly desiredSize: WaylandLayerDesiredSize;
}

export type MaybeSignal<T> = T | import("./signals").ReadonlySignal<T>;

export interface WaylandWindow {
  readonly id: string;
  readonly title: import("./signals").ReadonlySignal<string>;
  readonly appId: import("./signals").ReadonlySignal<string | undefined>;
  readonly position: WindowPosition;
  readonly rect: WindowPosition;
  readonly state: import("./window-state").WindowStateStore;
  readonly transform: WindowTransform;
  readonly animation: import("./animation").AnimationController;
  readonly isFocused: import("./signals").ReadonlySignal<boolean>;
  readonly isFloating: import("./signals").ReadonlySignal<boolean>;
  readonly isMaximized: import("./signals").ReadonlySignal<boolean>;
  readonly isFullscreen: import("./signals").ReadonlySignal<boolean>;
  readonly sizeConstraints: import("./signals").ReadonlySignal<WindowSizeConstraints>;
  readonly isResizable: import("./signals").ReadonlySignal<boolean>;
  readonly isTransient: import("./signals").ReadonlySignal<boolean>;
  readonly parentId: import("./signals").ReadonlySignal<string | undefined>;
  readonly icon: import("./signals").ReadonlySignal<WindowIcon | undefined>;
  readonly interaction: import("./signals").ReadonlySignal<WindowCompositionInteractionSnapshot>;
  close(): void;
  maximize(): void;
  unmaximize(): void;
  minimize(): void;
  fullscreen(): void;
  unfullscreen(): void;
  focus(): void;
  scheduleAnimation(options: ManagedWindowScheduleAnimationOptions): void;
  cancelAnimation(channel?: string): void;
  setCloseAnimationDuration(durationMs: number): void;
  isXWayland(): boolean;
}

export interface WaylandLayer {
  readonly id: string;
  readonly namespace: import("./signals").ReadonlySignal<string | undefined>;
  readonly layer: import("./signals").ReadonlySignal<WaylandLayerKind>;
  readonly outputName: import("./signals").ReadonlySignal<string>;
  readonly position: LayerPosition;
  readonly anchor: import("./signals").ReadonlySignal<WaylandLayerAnchor>;
  readonly exclusiveZone: import("./signals").ReadonlySignal<WaylandLayerExclusiveZone>;
  readonly exclusiveEdge: import("./signals").ReadonlySignal<WaylandLayerEdge | null>;
  readonly margin: import("./signals").ReadonlySignal<WaylandLayerMargin>;
  readonly keyboardInteractivity: import("./signals").ReadonlySignal<WaylandLayerKeyboardInteractivity>;
  readonly desiredSize: import("./signals").ReadonlySignal<WaylandLayerDesiredSize>;
  readonly animation: import("./animation").AnimationController;
}

export interface WindowPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowSizeConstraints {
  min?: WindowSize;
  max?: WindowSize;
}

export interface LayerPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowTransform {
  origin: MaybeSignal<TransformOrigin>;
  translateX: MaybeSignal<number>;
  translateY: MaybeSignal<number>;
  scaleX: MaybeSignal<number>;
  scaleY: MaybeSignal<number>;
  opacity: MaybeSignal<number>;
}

export interface TransformOrigin {
  x: MaybeSignal<number>;
  y: MaybeSignal<number>;
}

export interface ManagedWindowRect {
  x: MaybeSignal<number>;
  y: MaybeSignal<number>;
  width: MaybeSignal<number>;
  height: MaybeSignal<number>;
}

export interface ManagedWindowPoint {
  x: MaybeSignal<number>;
  y: MaybeSignal<number>;
}

export type ManagedWindowAnimationMode =
  | "override"
  | "add"
  | "sub"
  | "multiply";

export type ManagedWindowAnimationEasing =
  | "linear"
  | import("./easing").EasingFunction
  | { kind: "linear" }
  | {
      kind: "cubicBezier";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };

export interface ManagedWindowRectAnimationOptions {
  from?: ManagedWindowRect;
  to: ManagedWindowRect;
  duration: number;
  easing?: ManagedWindowAnimationEasing;
  mode?: Exclude<ManagedWindowAnimationMode, "multiply">;
}

export interface ManagedWindowPointAnimationOptions {
  from?: ManagedWindowPoint;
  to: ManagedWindowPoint;
  duration: number;
  easing?: ManagedWindowAnimationEasing;
  mode?: Exclude<ManagedWindowAnimationMode, "multiply">;
}

export interface ManagedWindowScalarAnimationOptions {
  from?: MaybeSignal<number>;
  to: MaybeSignal<number>;
  duration: number;
  easing?: ManagedWindowAnimationEasing;
  mode?: ManagedWindowAnimationMode;
}

export interface ManagedWindowScheduleAnimationOptions {
  channel?: string;
  rect?: ManagedWindowRectAnimationOptions;
  offset?: ManagedWindowPointAnimationOptions;
  opacity?: ManagedWindowScalarAnimationOptions;
}

export interface ManagedWindowTransform {
  origin?: MaybeSignal<TransformOrigin>;
  translateX?: MaybeSignal<number>;
  translateY?: MaybeSignal<number>;
  scale?: MaybeSignal<number>;
  scaleX?: MaybeSignal<number>;
  scaleY?: MaybeSignal<number>;
}

export interface ManagedWindowState {
  managed: boolean;
  rect?: WindowPosition;
  workspace?: string | number;
  visibleOutputs?: string[] | null;
  visible: boolean;
  idle: boolean;
  interactive: boolean;
  forceRectSize: boolean;
  tiled: boolean;
  /**
   * Per-window tearing permission. `undefined` means "unspecified" — the compositor falls back
   * to the client's `wp_tearing_control` hint. A concrete value overrides that hint.
   */
  allowTearing?: boolean;
  zIndex?: number;
  transform: WindowTransform;
}

export type PrimitiveChild = string | number;
export type WindowIcon = string | { name?: string; bytes?: Uint8Array };

export interface WindowCompositionInteractionSnapshot {
  hoveredIds: string[];
  activeIds: string[];
}

export type InteractionChangeHandler = (state: boolean) => void;

export interface CompositionElementNode {
  kind: "element";
  type: CompositionNodeType;
  key: string | number | null;
  props: Record<string, unknown>;
  children: CompositionChild[];
}

export type CompositionChild = CompositionElementNode | PrimitiveChild;
export type CompositionRenderable =
  | CompositionChild
  | null
  | undefined
  | false
  | true;

export type CompositionNodeType =
  | "Box"
  | "Label"
  | "Button"
  | "AppIcon"
  | "Image"
  | "ShaderEffect"
  | "ManagedWindow"
  | "Window"
  | "WindowBorder"
  | "Fragment";

export interface ComponentProps {
  children?: CompositionRenderable | CompositionRenderable[];
  onHoverChange?: InteractionChangeHandler;
  onActiveChange?: InteractionChangeHandler;
}

export type Component<TProps extends ComponentProps = ComponentProps> = (
  props: TProps,
) => CompositionRenderable;

export type Direction = "row" | "column" | "horizontal" | "vertical";
export type AlignItems = "start" | "center" | "end" | "stretch";
export type JustifyContent = "start" | "center" | "end" | "space-between";
export type FontWeight = "normal" | "medium" | "semibold" | "bold" | number;
export type FontFamily = string | string[];
export type NoiseKind = "salt";
export type BlendMode = "normal" | "add" | "screen" | "multiply";
export interface OnSourceDamageBoxInvalidationHandle {
  kind: "on-source-damage-box";
  antiArtifactMargin: MaybeSignal<number>;
}

export interface AlwaysInvalidationHandle {
  kind: "always";
}

export type AutomaticEffectInvalidationPolicyHandle =
  | OnSourceDamageBoxInvalidationHandle
  | AlwaysInvalidationHandle;

export interface ManualInvalidationHandle {
  kind: "manual";
  dirtyWhen: MaybeSignal<boolean>;
  base?: AutomaticEffectInvalidationPolicyHandle;
}

export type EffectInvalidationPolicyHandle =
  | AutomaticEffectInvalidationPolicyHandle
  | ManualInvalidationHandle;
export type ShaderUniformScalar = MaybeSignal<number>;
export type ShaderUniformValue =
  | ShaderUniformScalar
  | readonly [ShaderUniformScalar, ShaderUniformScalar]
  | readonly [ShaderUniformScalar, ShaderUniformScalar, ShaderUniformScalar]
  | readonly [
      ShaderUniformScalar,
      ShaderUniformScalar,
      ShaderUniformScalar,
      ShaderUniformScalar,
    ];
export type ShaderUniformMap = Record<string, ShaderUniformValue>;

export interface BackdropBlurOptions {
  radius?: number;
  passes?: number;
}

export interface ShaderModuleHandle {
  kind: "shader-module";
  path: string;
}

export interface ShaderStageHandle {
  kind: "shader-stage";
  shader: ShaderModuleHandle;
  uniforms?: ShaderUniformMap;
  /** Additional sampler2D uniforms, keyed by their GLSL uniform names. */
  textures?: Record<string, EffectInputHandle>;
}

export interface ShaderInputHandle {
  kind: "shader-input";
  shader: ShaderModuleHandle;
  uniforms?: ShaderUniformMap;
  /** Additional sampler2D uniforms, keyed by their GLSL uniform names. */
  textures?: Record<string, EffectInputHandle>;
}

export interface BackdropSourceHandle {
  kind: "backdrop-source";
}

export interface XrayBackdropSourceHandle {
  kind: "xray-backdrop-source";
}

export interface ImageSourceHandle {
  kind: "image-source";
  path: string;
}

export interface NamedTextureHandle {
  kind: "named-texture";
  name: string;
}

export interface NoiseStageHandle {
  kind: "noise";
  noiseKind: NoiseKind;
  amount?: number;
}

export interface DualKawaseBlurStageHandle {
  kind: "dual-kawase-blur";
  radius?: number;
  passes?: number;
}

export interface SaveStageHandle {
  kind: "save";
  name: string;
}

export interface BlendStageHandle {
  kind: "blend";
  input: EffectInputHandle;
  mode?: BlendMode;
  alpha?: number;
}

export interface UnitStageHandle {
  kind: "unit";
  effect: CompiledEffectHandle;
}

export type EffectInputHandle =
  | BackdropSourceHandle
  | XrayBackdropSourceHandle
  | ShaderInputHandle
  | ImageSourceHandle
  | NamedTextureHandle
  | WindowSourceHandle
  | LayerSourceHandle
  | PopupSourceHandle;

export type EffectStageHandle =
  | ShaderStageHandle
  | NoiseStageHandle
  | DualKawaseBlurStageHandle
  | SaveStageHandle
  | BlendStageHandle
  | UnitStageHandle;

/**
 * How the alpha channel of the effect's output is treated when the result is
 * composited onto the screen.
 *
 * - `"opaque"` (default): force alpha to 1.0 at the end of the pipeline.
 *   Backdrop captures are cleared to transparent black and the blur chain
 *   smears uncovered border texels inward, so the alpha of a plain backdrop
 *   pipeline is noise rather than signal; forcing it opaque hides dark halos
 *   and see-through fringes at the blur edges. Correct for the common
 *   "frosted glass" case where the backdrop is already-composited screen
 *   content.
 * - `"preserve"`: keep the pipeline's alpha output intact. For pipelines
 *   that intentionally produce transparency (e.g. masking the blur against a
 *   layer's own alpha). Opting in makes the pipeline responsible for
 *   producing meaningful alpha everywhere, including the blur edge regions.
 *
 * This is an explicit declaration; the compositor never infers it from the
 * pipeline contents (such as whether a layer source is referenced), so adding
 * a texture input never silently changes edge-artifact handling.
 */
export type EffectAlphaMode = "opaque" | "preserve";

export interface CompiledEffectHandle {
  kind: "compiled-effect";
  input: EffectInputHandle;
  invalidate: EffectInvalidationPolicyHandle;
  pipeline: EffectStageHandle[];
  /** Output alpha handling. Defaults to `"opaque"`. See {@link EffectAlphaMode}. */
  alpha?: EffectAlphaMode;
}

export interface WindowSourceHandle {
  kind: "window-source";
  include: "full" | "root-surface";
}

export interface LayerSourceHandle {
  kind: "layer-source";
  include: "full" | "root-surface";
}

export type LayerEffectInputHandle =
  | LayerSourceHandle
  | BackdropSourceHandle
  | XrayBackdropSourceHandle;

/** The popup's own rendered content as an effect input. */
export interface PopupSourceHandle {
  kind: "popup-source";
  include: "full" | "root-surface";
}

/**
 * Inputs allowed for popup effects. Note that a backdrop input on the
 * `behind` slot must be resolvable from the framebuffer at draw time. It may
 * additionally use popupSource() as a named shader texture, but cannot use
 * xray/window/layer sources: popups render inline with their parent's element
 * stream, so there is no offline "scene below the popup" capture path.
 */
export type PopupEffectInputHandle = PopupSourceHandle | BackdropSourceHandle;

export type EffectOutsets =
  | number
  | {
      left?: number;
      right?: number;
      top?: number;
      bottom?: number;
    };

export interface WindowEffectHandle {
  kind: "window-effect";
  effect: CompiledEffectHandle;
  outsets?: EffectOutsets;
}

export interface WindowEffectAssignment {
  behind?: WindowEffectHandle | null;
  behindRootSurface?: WindowEffectHandle | null;
  inFront?: WindowEffectHandle | null;
  replace?: WindowEffectHandle | null;
}

export interface LayerEffectHandle {
  kind: "layer-effect";
  effect: CompiledEffectHandle;
  outsets?: EffectOutsets;
}

export interface LayerEffectAssignment {
  /** Backdrop inputs are supported in this slot for per-layer background effects. */
  behind?: LayerEffectHandle | null;
  behindRootSurface?: LayerEffectHandle | null;
  inFront?: LayerEffectHandle | null;
  replace?: LayerEffectHandle | null;
}

export interface PopupEffectHandle {
  kind: "popup-effect";
  effect: CompiledEffectHandle;
  outsets?: EffectOutsets;
}

export interface PopupEffectAssignment {
  /**
   * Drawn between the popup and the content below it. Accepts popupSource()
   * inputs (e.g. a drop shadow derived from the popup's own alpha) or a
   * framebuffer-resolvable backdrop effect, optionally sampling popupSource()
   * as a named shader texture for masking.
   */
  behind?: PopupEffectHandle | null;
  behindRootSurface?: PopupEffectHandle | null;
  /** Drawn on top of the popup. popupSource() inputs only. */
  inFront?: PopupEffectHandle | null;
  /** Replaces the popup's own rendering. popupSource() inputs only. */
  replace?: PopupEffectHandle | null;
}

/**
 * A mapped xdg_popup, delivered to `WINDOW_MANAGER.effect.popup` so effects
 * can be assigned per popup. Covers popups attached to layer-shell surfaces
 * (`parentKind: "layer"`) and to toplevel windows (`parentKind: "window"`);
 * use `parentKind` to discriminate if an effect should only apply to one
 * of them. For window popups, effects are composited while the parent
 * window's visual transform is identity — during window animations the popup
 * temporarily falls back to its raw rendering.
 */
export interface WaylandPopup {
  readonly id: string;
  /** Runtime id of the root surface this popup belongs to. */
  readonly parentId: string;
  readonly parentKind: "layer" | "window";
  readonly outputName: string;
  /** Output-local logical rect of the popup's geometry box. */
  readonly position: { x: number; y: number; width: number; height: number };
}

export interface WindowManagerEffectConfig {
  background_effect: CompiledEffectHandle | null;
  window?: (window: WaylandWindow) => WindowEffectAssignment | null;
  layer?: (layer: WaylandLayer) => LayerEffectAssignment | null;
  popup?: (popup: WaylandPopup) => PopupEffectAssignment | null;
}

export interface OutputMode {
  width: number;
  height: number;
  refreshRate: number;
}

export type OutputResolutionPreference =
  | "best"
  | {
      width: number;
      height: number;
      refreshRate?: number;
    };

export type OutputPositionPreference =
  | "auto"
  | {
      x: number;
      y: number;
    };

export interface OutputExtendConfigEntry {
  mode?: "extend";
  resolution?: OutputResolutionPreference;
  position?: OutputPositionPreference;
  scale?: number;
}

export interface OutputDisabledConfigEntry {
  mode: "disabled";
}

export interface OutputMirrorConfigEntry {
  mode: "mirror";
  source: string;
}

export type OutputConfigEntry =
  | OutputExtendConfigEntry
  | OutputDisabledConfigEntry
  | OutputMirrorConfigEntry;

export type DisplayConfigDraft = Record<string, OutputConfigEntry | null>;

export interface OutputStateSnapshot {
  name?: string;
  description?: string;
  make?: string;
  model?: string;
  serial?: string;
  connector?: string;
  enabled?: boolean;
  resolution?: OutputMode;
  position: {
    x: number;
    y: number;
  };
  scale: number;
  availableModes: OutputMode[];
}

export interface OutputInfo extends OutputStateSnapshot {
  name: string;
  enabled: boolean;
}

export interface OutputConfigureContext {
  connected: OutputInfo[];
  outputs: OutputInfo[];
  current: Record<string, OutputInfo>;
}

export type OutputConfigureFactory = (
  context: OutputConfigureContext,
) => DisplayConfigDraft;

export interface OutputController {
  readonly list: string[];
  readonly outputs: OutputInfo[];
  readonly current: Record<string, OutputInfo>;
  get(outputName: string): OutputInfo | undefined;
  find(predicate: (output: OutputInfo) => boolean): OutputInfo | undefined;
  availableModes(outputName: string): OutputMode[];
  configure(factory: OutputConfigureFactory): void;
  reconfigure(): void;
}

/** Logical-pixel insets reserved by exclusive-zone layers on each edge. */
export interface LayerInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Optional filter for usableArea/reservedInsets computations. */
export interface UsableAreaOptions {
  /**
   * If supplied, only layers for which `filter(layer)` returns `true` are
   * considered when summing exclusive zones. Use this to ignore overlays,
   * scope to a namespace, etc.
   */
  filter?: (layer: WaylandLayerSnapshot) => boolean;
}

/**
 * Read-only view onto the layer-shell surfaces the compositor currently has
 * mapped. Snapshots reflect committed protocol state — anchor, exclusive
 * zone, margins, keyboard-interactivity — so config code can answer
 * questions like "how much vertical space is reserved on DP-1?" without
 * tracking lifecycle events itself.
 *
 * The controller is intentionally read-only for now. Per-layer actions
 * (focus, dismiss, …) and compositor-side placement will land on this same
 * surface later — adding them is non-breaking.
 */
export interface LayerController {
  /** Ids of every currently-mapped layer surface. */
  readonly list: string[];
  /** All current layer snapshots, keyed by id. */
  readonly current: Record<string, WaylandLayerSnapshot>;
  /** Snapshots filtered to a single output (matched by `Output.name()`). */
  forOutput(outputName: string): WaylandLayerSnapshot[];
  /**
   * Output rect minus the area reserved by exclusive-zone layers. Returns
   * the usable rectangle in global logical coordinates, suitable for
   * placing windows without occluding bars / docks / panels.
   *
   * Returns `null` when the output isn't registered or has no current
   * resolution (so its logical size can't be derived).
   */
  usableArea(
    outputName: string,
    options?: UsableAreaOptions,
  ): WindowPosition | null;
  /**
   * Per-edge reserved pixels for `outputName`. Useful when you want to do
   * your own arithmetic on the bare numbers (e.g., snap a tile `+8px` below
   * the top bar). Always returns an object; missing outputs or empty layer
   * sets yield zero insets.
   */
  reservedInsets(outputName: string, options?: UsableAreaOptions): LayerInsets;
}

export type EnvValue = string | number | boolean;
export type ProcessEnv = Record<string, EnvValue>;

export interface EnvUpdateOperation {
  key: string;
  value?: string;
}

export interface EnvUpdatePayload {
  operations: EnvUpdateOperation[];
  publish: string[];
}

export interface EnvController {
  set(key: string, value: EnvValue): void;
  unset(key: string): void;
  get(key: string): string | undefined;
  apply(values: Record<string, EnvValue | null | undefined>): void;
  publish(keys?: Iterable<string>): void;
}

/**
 * How a process is launched.
 *
 * - When `command` is a single string, it's run via `/bin/sh -lc <command>`,
 *   so shell features like pipes, redirection and environment expansion work.
 * - When `command` is a string array, it's exec'd directly with no shell
 *   involvement (each element is one argv entry, taken literally).
 */
export interface ProcessCommandSpec {
  command: string | string[];
}

export type ProcessLaunchSpec = ProcessCommandSpec;

export interface ProcessBaseSpec {
  cwd?: string;
  env?: ProcessEnv;
}

export type StartupProcessRunPolicy =
  | "once-per-session"
  | "once-per-config-version";

export type ManagedProcessRestartPolicy = "never" | "on-failure" | "on-exit";

export type ManagedProcessReloadPolicy = "keep-if-unchanged" | "always-restart";

export type StartupOnceSpec = ProcessBaseSpec &
  ProcessLaunchSpec & {
    runPolicy?: StartupProcessRunPolicy;
  };

export type StartupServiceSpec = ProcessBaseSpec &
  ProcessLaunchSpec & {
    restart?: ManagedProcessRestartPolicy;
    reload?: ManagedProcessReloadPolicy;
  };

export type ProcessSpawnSpec = ProcessBaseSpec & ProcessLaunchSpec;

export interface ProcessController {
  once(id: string, spec: StartupOnceSpec): void;
  service(id: string, spec: StartupServiceSpec): void;
  spawn(spec: ProcessSpawnSpec): void;
}

export type KeyBindingEventPhase = "press" | "release";

export interface KeyBindingOptions {
  on?: KeyBindingEventPhase;
}

export interface KeyBindingController {
  bind(
    id: string,
    shortcut: string,
    handler: () => void,
    options?: KeyBindingOptions,
  ): void;
}

export interface PointerController {
  bindWindowMoveModifier(modifier: string): void;
}

export interface InputDeviceKindFlags {
  keyboard: boolean;
  pointer: boolean;
  touchpad: boolean;
  touch: boolean;
  tabletTool: boolean;
  tabletPad: boolean;
  gesture: boolean;
  switch: boolean;
}

export interface InputDeviceInfo {
  key: string;
  name: string;
  sysname?: string;
  vendor?: number;
  product?: number;
  kind: InputDeviceKindFlags;
}

export type InputAccelProfile = "adaptive" | "flat";
export type InputClickMethod = "buttonAreas" | "clickfinger";
export type InputScrollMethod = "none" | "twoFinger" | "edge" | "onButtonDown";
export type InputTapButtonMap = "leftRightMiddle" | "leftMiddleRight";

export interface KeyboardInputConfig {
  repeatRate?: number;
  repeatDelay?: number;
  rules?: string;
  model?: string;
  layout?: string;
  variant?: string;
  options?: string;
}

export interface PointerInputConfig {
  pointerAccel?: number;
  accelProfile?: InputAccelProfile;
  leftHanded?: boolean;
  naturalScroll?: boolean;
  middleEmulation?: boolean;
}

export interface TouchpadInputConfig extends PointerInputConfig {
  tapToClick?: boolean;
  tapButtonMap?: InputTapButtonMap;
  clickMethod?: InputClickMethod;
  scrollMethod?: InputScrollMethod;
  scrollFactor?: number;
  disableWhileTyping?: boolean;
}

export interface InputDeviceConfig {
  keyboard?: KeyboardInputConfig;
  pointer?: PointerInputConfig;
  touchpad?: TouchpadInputConfig;
}

export interface InputConfigDraft {
  global?: InputDeviceConfig;
  device: Record<string, InputDeviceConfig | null>;
}

export interface InputConfigureContext {
  devices: InputDeviceInfo[];
  current: Record<string, InputDeviceInfo>;
}

export type InputConfigureFactory = (
  input: InputConfigDraft,
  context: InputConfigureContext,
) => void;

export interface InputController {
  readonly devices: InputDeviceInfo[];
  readonly current: Record<string, InputDeviceInfo>;
  get(deviceKey: string): InputDeviceInfo | undefined;
  find(
    predicate: (device: InputDeviceInfo) => boolean,
  ): InputDeviceInfo | undefined;
  configure(factory: InputConfigureFactory): void;
  reconfigure(): void;
}

export interface BorderValue {
  px: MaybeSignal<number>;
  color: MaybeSignal<string>;
}

export interface WindowResizeHitArea {
  edgePx?: MaybeSignal<number>;
  cornerPx?: MaybeSignal<number>;
}

export interface WindowBorderInteraction {
  resizeHitArea?: MaybeSignal<number> | WindowResizeHitArea;
}

export type SSDPosition = "relative" | "absolute";
export type SSDOverflow = "visible" | "hidden";
export type SSDPointerEvents = "auto" | "none";

export interface SSDTransform {
  translateX?: MaybeSignal<number>;
  translateY?: MaybeSignal<number>;
  scale?: MaybeSignal<number>;
  scaleX?: MaybeSignal<number>;
  scaleY?: MaybeSignal<number>;
}

export interface SSDStyle {
  width?: MaybeSignal<number | string>;
  height?: MaybeSignal<number | string>;
  minWidth?: MaybeSignal<number>;
  minHeight?: MaybeSignal<number>;
  maxWidth?: MaybeSignal<number>;
  maxHeight?: MaybeSignal<number>;
  flexGrow?: MaybeSignal<number>;
  flexShrink?: MaybeSignal<number>;
  gap?: MaybeSignal<number>;
  padding?: MaybeSignal<number>;
  paddingX?: MaybeSignal<number>;
  paddingY?: MaybeSignal<number>;
  paddingTop?: MaybeSignal<number>;
  paddingRight?: MaybeSignal<number>;
  paddingBottom?: MaybeSignal<number>;
  paddingLeft?: MaybeSignal<number>;
  margin?: MaybeSignal<number>;
  marginX?: MaybeSignal<number>;
  marginY?: MaybeSignal<number>;
  marginTop?: MaybeSignal<number>;
  marginRight?: MaybeSignal<number>;
  marginBottom?: MaybeSignal<number>;
  marginLeft?: MaybeSignal<number>;
  position?: MaybeSignal<SSDPosition>;
  zIndex?: MaybeSignal<number>;
  inset?: MaybeSignal<number>;
  top?: MaybeSignal<number>;
  right?: MaybeSignal<number>;
  bottom?: MaybeSignal<number>;
  left?: MaybeSignal<number>;
  overflow?: MaybeSignal<SSDOverflow>;
  pointerEvents?: MaybeSignal<SSDPointerEvents>;
  transform?: MaybeSignal<SSDTransform>;
  alignItems?: MaybeSignal<AlignItems>;
  justifyContent?: MaybeSignal<JustifyContent>;
  background?: MaybeSignal<string>;
  color?: MaybeSignal<string>;
  opacity?: MaybeSignal<number>;
  border?: MaybeSignal<BorderValue>;
  borderTop?: MaybeSignal<BorderValue>;
  borderRight?: MaybeSignal<BorderValue>;
  borderBottom?: MaybeSignal<BorderValue>;
  borderLeft?: MaybeSignal<BorderValue>;
  borderFit?: MaybeSignal<"normal" | "fit-children">;
  borderRadius?: MaybeSignal<number>;
  visible?: MaybeSignal<boolean>;
  cursor?: MaybeSignal<string>;
  fontSize?: MaybeSignal<number>;
  fontWeight?: MaybeSignal<FontWeight>;
  fontFamily?: MaybeSignal<FontFamily>;
  textAlign?: MaybeSignal<"start" | "center" | "end">;
  lineHeight?: MaybeSignal<number>;
}

export interface BoxProps extends ComponentProps {
  direction?: Direction;
  split?: Direction;
  style?: SSDStyle;
  id?: string;
}

export interface LabelProps extends ComponentProps {
  text?: MaybeSignal<string>;
  style?: SSDStyle;
  id?: string;
}

export interface ButtonProps extends ComponentProps {
  style?: SSDStyle;
  id?: string;
  onClick?: WindowActionDescriptor | (() => void);
}

export interface AppIconProps extends ComponentProps {
  icon?: MaybeSignal<WindowIcon | undefined>;
  style?: SSDStyle;
  id?: string;
}

export type ImageFit = "contain" | "cover" | "fill";

export interface ImageProps extends ComponentProps {
  src: MaybeSignal<string>;
  style?: SSDStyle;
  fit?: MaybeSignal<ImageFit>;
  id?: string;
}

export interface ShaderEffectProps extends ComponentProps {
  shader: CompiledEffectHandle;
  direction?: Direction;
  split?: Direction;
  style?: SSDStyle;
  id?: string;
}

export interface ManagedWindowProps extends ComponentProps {
  rect?: MaybeSignal<ManagedWindowRect>;
  workspace?: MaybeSignal<string | number>;
  visibleOutputs?: MaybeSignal<string[] | null>;
  visible?: MaybeSignal<boolean>;
  idle?: MaybeSignal<boolean>;
  interactive?: MaybeSignal<boolean>;
  forceRectSize?: MaybeSignal<boolean>;
  tiled?: MaybeSignal<boolean>;
  /**
   * Whether this window may tear (immediate/async page flips) while it is fullscreen and on the
   * direct-scanout fast path.
   *
   * This is the compositor's source of truth: when set it overrides the client's
   * `wp_tearing_control` hint; when left undefined the compositor falls back to that hint.
   * Tearing still only actually happens while the window is fullscreen, directly scanned out, and
   * the pointer is hidden — so `allowTearing={() => window.isFullscreen.value}` is a typical
   * pattern for games (works for native Wayland and X11/Xwayland clients alike, since it does not
   * require the client to send `wp_tearing_control`).
   */
  allowTearing?: MaybeSignal<boolean>;
  zIndex?: MaybeSignal<number>;
  opacity?: MaybeSignal<number>;
  transform?: MaybeSignal<ManagedWindowTransform>;
  id?: string;
}

export interface ClientWindowProps extends ComponentProps {
  style?: SSDStyle;
  id?: string;
  children?: never;
}

export type WindowProps = ClientWindowProps;

export interface WindowBorderProps extends ComponentProps {
  style?: SSDStyle;
  interaction?: WindowBorderInteraction;
  id?: string;
}

export type WindowCompositionPhase = "preconfigure" | "render";

export interface WindowCompositionContext {
  readonly phase: WindowCompositionPhase;
  readonly isPreview: boolean;
}

export type WindowCompositionFunction = (
  window: WaylandWindow,
  context: WindowCompositionContext,
) => CompositionRenderable;

export interface WindowManagerDefinition {
  event: import("./events").WindowManagerEventController;
  onEnable(listener: import("./events").RuntimeEnableListener): () => void;
  onDisable(listener: import("./events").RuntimeDisableListener): () => void;
  preload: PreloadController;
  effect: WindowManagerEffectConfig;
  output: OutputController;
  input: InputController;
  env: EnvController;
  process: ProcessController;
  key: KeyBindingController;
  pointer: PointerController;
  runtime: RuntimeController;
  window: WindowManagerWindowController;
  layer: LayerController;
  debug: DebugController;
  display?: DisplayConfig;
}

export interface PreloadController {}

/**
 * Debug knobs. Toggles here are surfaced into compositor overlays / logs and
 * do not affect production behavior. Read-write properties take effect on the
 * next scheduler tick.
 */
export interface DebugController {
  /**
   * When true, the compositor draws a small FPS / frame-time overlay in the
   * top-left corner of every output. The overlay uses a pre-rasterized glyph
   * atlas (built once on first enable) so toggling it has near-zero per-frame
   * cost beyond the composite of ~6-8 glyph buffers.
   */
  fpsCounter: boolean;
}

export type SSDRebuildSuppressionViolationPolicy =
  | "warn"
  | "fallback-last"
  | "fallback"
  | "throw"
  | "suppress-unsafe";

export interface SSDRebuildSuppressionOptions {
  /**
   * Allow updates that only affect <ManagedWindow> props to stay on the managed-window fast path.
   * Decoration tree/style/text/image/shader updates are treated as violations.
   */
  allowManagedWindowOnly?: boolean;
  /**
   * Restrict suppression to specific windows. Decoration updates for other
   * windows fall back to the normal rebuild path instead of being delayed by
   * an unrelated animation.
   */
  windowIds?: readonly string[];
  /**
   * Restrict suppression to specific layers. Decoration updates for other
   * layers fall back to the normal rebuild path.
   */
  layerIds?: readonly string[];
  /**
   * - "fallback": warn and fall back to the normal SSD rebuild path for the violating update.
   * - "warn": warn and keep suppressing SSD rebuilds, applying only managed-window updates.
   * - "fallback-last": warn, keep suppressing during the active scope, then rebuild
   *   windows/layers that had decoration-affecting changes when the scope is released.
   * - "throw": throw immediately when a decoration-affecting update is detected.
   * - "suppress-unsafe": keep suppressing without warning. Intended for tightly-scoped
   *   benchmarking or code that can prove only <ManagedWindow> props change.
   */
  onViolation?: SSDRebuildSuppressionViolationPolicy;
}

export interface SSDRebuildSuppressionHandle {
  release(): void;
}

export interface RuntimeController {
  suppressSSDRebuild(
    options?: SSDRebuildSuppressionOptions,
  ): SSDRebuildSuppressionHandle;
  withSSDRebuildSuppressed<T>(
    options: SSDRebuildSuppressionOptions | undefined,
    callback: () => T,
  ): T;
}

export type DisplayModePreference =
  | "auto"
  | {
      width: number;
      height: number;
      refreshMhz?: number;
    };

export interface DisplayConfig {
  defaultMode?: DisplayModePreference;
}

export interface ReactiveWaylandWindowSignals {
  id: import("./signals").ReadonlySignal<string>;
  title: import("./signals").ReadonlySignal<string>;
  appId: import("./signals").ReadonlySignal<string | undefined>;
  positionX: import("./signals").ReadonlySignal<number>;
  positionY: import("./signals").ReadonlySignal<number>;
  positionWidth: import("./signals").ReadonlySignal<number>;
  positionHeight: import("./signals").ReadonlySignal<number>;
  isFocused: import("./signals").ReadonlySignal<boolean>;
  isFloating: import("./signals").ReadonlySignal<boolean>;
  isMaximized: import("./signals").ReadonlySignal<boolean>;
  isFullscreen: import("./signals").ReadonlySignal<boolean>;
  sizeConstraints: import("./signals").ReadonlySignal<WindowSizeConstraints>;
  isResizable: import("./signals").ReadonlySignal<boolean>;
  isTransient: import("./signals").ReadonlySignal<boolean>;
  parentId: import("./signals").ReadonlySignal<string | undefined>;
  icon: import("./signals").ReadonlySignal<WindowIcon | undefined>;
  interaction: import("./signals").ReadonlySignal<WindowCompositionInteractionSnapshot>;
  transformOriginX: import("./signals").Signal<number>;
  transformOriginY: import("./signals").Signal<number>;
  transformTranslateX: import("./signals").Signal<number>;
  transformTranslateY: import("./signals").Signal<number>;
  transformScaleX: import("./signals").Signal<number>;
  transformScaleY: import("./signals").Signal<number>;
  transformOpacity: import("./signals").Signal<number>;
}

export interface ReactiveWaylandLayerSignals {
  id: import("./signals").ReadonlySignal<string>;
  namespace: import("./signals").ReadonlySignal<string | undefined>;
  layer: import("./signals").ReadonlySignal<WaylandLayerKind>;
  outputName: import("./signals").ReadonlySignal<string>;
  positionX: import("./signals").ReadonlySignal<number>;
  positionY: import("./signals").ReadonlySignal<number>;
  positionWidth: import("./signals").ReadonlySignal<number>;
  positionHeight: import("./signals").ReadonlySignal<number>;
  anchor: import("./signals").ReadonlySignal<WaylandLayerAnchor>;
  exclusiveZone: import("./signals").ReadonlySignal<WaylandLayerExclusiveZone>;
  exclusiveEdge: import("./signals").ReadonlySignal<WaylandLayerEdge | null>;
  margin: import("./signals").ReadonlySignal<WaylandLayerMargin>;
  keyboardInteractivity: import("./signals").ReadonlySignal<WaylandLayerKeyboardInteractivity>;
  desiredSize: import("./signals").ReadonlySignal<WaylandLayerDesiredSize>;
}

export interface ReactiveWaylandWindow extends WaylandWindow {
  readonly signals: ReactiveWaylandWindowSignals;
}

export interface ReactiveWaylandLayer extends WaylandLayer {
  readonly signals: ReactiveWaylandLayerSignals;
}

export interface WaylandWindowActions {
  close(): void;
  maximize(): void;
  unmaximize(): void;
  minimize(): void;
  fullscreen(): void;
  unfullscreen(): void;
  focus(): void;
  scheduleAnimation(options: ManagedWindowScheduleAnimationOptions): void;
  cancelAnimation(channel?: string): void;
  setCloseAnimationDuration(durationMs: number): void;
  isXWayland(): boolean;
}

export interface WindowManagerWindowController {
  /**
   * Per-window composition function. Returns the scene tree (chrome,
   * managed-window placements, effects) for a given `WaylandWindow`. The
   * compositor reevaluates this whenever the window's reactive inputs
   * change, so signal reads inside the function automatically track
   * dependencies.
   *
   * Set to `null` (the default) to leave windows undecorated.
   */
  composition: WindowCompositionFunction | null;
  /**
   * Request keyboard focus for `window`. The compositor raises it, updates
   * keyboard focus, and emits the usual focus-changed notifications — so
   * `isFocused` signals, composition reevaluation, and
   * `WINDOW_MANAGER.event.onFocus` listeners all fire just as they would for
   * a user-initiated focus change.
   */
  focus(window: WaylandWindow): void;
}

export interface ReactiveWaylandWindowHandle {
  readonly window: ReactiveWaylandWindow;
  readonly transform: WindowTransform;
  update(snapshot: WaylandWindowSnapshot): void;
  updateManagedWindow(state: ManagedWindowState): void;
}

export interface ReactiveWaylandLayerHandle {
  readonly layer: ReactiveWaylandLayer;
  update(snapshot: WaylandLayerSnapshot): void;
}

export type WindowActionType =
  | "close"
  | "maximize"
  | "unmaximize"
  | "minimize"
  | "fullscreen"
  | "unfullscreen";

export interface WindowActionDescriptor {
  kind: "window-action";
  action: WindowActionType;
}

export type SerializableCompositionChild =
  | SerializedCompositionNode
  | PrimitiveChild;

export interface SerializedCompositionNode {
  kind: CompositionNodeType;
  nodeId: string;
  props: Record<string, unknown>;
  children: SerializableCompositionChild[];
}
