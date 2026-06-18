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

/**
 * A plain value or a `ReadonlySignal<T>`. Composition functions accept both so
 * callers can pass either a static constant or a reactive signal.
 * 固定値または `ReadonlySignal<T>` のいずれかです。合成関数は両方を受け付けるので、
 * 静的な定数またはリアクティブなシグナルのどちらでも渡せます。
 */
export type MaybeSignal<T> = T | import("./signals").ReadonlySignal<T>;

/**
 * A mapped (visible) Wayland toplevel window. Reactive properties are
 * `ReadonlySignal<T>` — the compositor re-evaluates any composition code that
 * reads them whenever they change.
 * マップされた（表示中の）Wayland トップレベルウィンドウ。リアクティブなプロパティは
 * `ReadonlySignal<T>` です。読み取った合成コードは変更時にコンポジターが自動的に
 * 再評価します。
 *
 * @example Read reactive state / リアクティブな状態を読む
 * ```ts
 * COMPOSITOR.window.composition = (window) => {
 *   const focused = window.isFocused.value;
 *   const title = window.title.value;
 *   // ...
 * };
 * ```
 */
export interface WaylandWindow {
  /** Stable string identifier unique to this window for its lifetime. / ウィンドウのライフタイムを通じてユニークな安定した識別子。 */
  readonly id: string;
  /** Reactive window title as set by the client. / クライアントが設定するリアクティブなウィンドウタイトル。 */
  readonly title: import("./signals").ReadonlySignal<string>;
  /** Reactive app-id (e.g. `"org.gnome.Nautilus"`). `undefined` if the client did not set one. / リアクティブな app-id。クライアントが設定していない場合は `undefined`。 */
  readonly appId: import("./signals").ReadonlySignal<string | undefined>;
  /** Current logical position and size in global compositor coordinates. / グローバル座標でのウィンドウの現在の論理的な位置とサイズ。 */
  readonly position: WindowPosition;
  /** Alias for `position`. / `position` の別名。 */
  readonly rect: WindowPosition;
  /**
   * Per-window key/value state store. Keys are created with `createWindowState`;
   * reading a key returns a `Signal<T>` scoped to this window.
   * `createWindowState` で作成したキーで読み取ると、このウィンドウにスコープされた
   * `Signal<T>` を返すウィンドウごとの状態ストア。
   *
   * @example
   * ```ts
   * const isMinimized = createWindowState("minimized", { default: false });
   * // inside composition:
   * window.state[isMinimized].value; // Signal<boolean>
   * ```
   */
  readonly state: import("./window-state").WindowStateStore;
  /**
   * GPU transform applied to this window during composition. Write signals or
   * values to drive reactive transforms (scale, translate, opacity, origin).
   * 合成時にこのウィンドウに適用される GPU トランスフォーム。シグナルまたは値を
   * 書き込んでリアクティブなトランスフォーム（スケール・移動・不透明度・原点）を制御します。
   */
  readonly transform: WindowTransform;
  /**
   * Animation controller for this window. Start/stop/set named animation
   * variables and read their progress as signals.
   * このウィンドウ用のアニメーションコントローラー。名前付きアニメーション変数の
   * 開始・停止・設定とシグナルとしての進捗読み取りを行います。
   */
  readonly animation: import("./animation").AnimationController;
  /** `true` while this window holds keyboard focus. / キーボードフォーカスを持っている間 `true`。 */
  readonly isFocused: import("./signals").ReadonlySignal<boolean>;
  /** `true` when the window is in floating (non-tiled) mode. / ウィンドウがフローティング（非タイル）モードのとき `true`。 */
  readonly isFloating: import("./signals").ReadonlySignal<boolean>;
  /** `true` when the window is maximized. / ウィンドウが最大化されているとき `true`。 */
  readonly isMaximized: import("./signals").ReadonlySignal<boolean>;
  /** `true` when the window is fullscreen. / ウィンドウがフルスクリーンのとき `true`。 */
  readonly isFullscreen: import("./signals").ReadonlySignal<boolean>;
  /** Min/max size constraints as reported by the client. / クライアントが報告する最小・最大サイズ制約。 */
  readonly sizeConstraints: import("./signals").ReadonlySignal<WindowSizeConstraints>;
  /** `false` when the client has disabled interactive resize. / クライアントがインタラクティブリサイズを無効にしているとき `false`。 */
  readonly isResizable: import("./signals").ReadonlySignal<boolean>;
  /** `true` for child windows (dialogs, etc.) that are transient for another toplevel. / 別のトップレベルに対してトランジェントな子ウィンドウ（ダイアログ等）のとき `true`。 */
  readonly isTransient: import("./signals").ReadonlySignal<boolean>;
  /** `id` of the parent window if this is a transient, otherwise `undefined`. / トランジェントの場合は親ウィンドウの `id`、そうでない場合は `undefined`。 */
  readonly parentId: import("./signals").ReadonlySignal<string | undefined>;
  /** Window icon provided by the client or resolved from the desktop entry. / クライアントまたはデスクトップエントリから提供されるウィンドウアイコン。 */
  readonly icon: import("./signals").ReadonlySignal<WindowIcon | undefined>;
  /** Current pointer/drag interaction state for use in composition code. / 合成コードで使用するポインター・ドラッグの現在のインタラクション状態。 */
  readonly interaction: import("./signals").ReadonlySignal<WindowCompositionInteractionSnapshot>;
  /** Ask the client to close the window. / クライアントにウィンドウを閉じるよう要求します。 */
  close(): void;
  /** Ask the client to maximize. / クライアントに最大化を要求します。 */
  maximize(): void;
  /** Ask the client to unmaximize. / クライアントに最大化解除を要求します。 */
  unmaximize(): void;
  /** Ask the client to minimize. / クライアントに最小化を要求します。 */
  minimize(): void;
  /** Ask the client to enter fullscreen. / クライアントにフルスクリーン移行を要求します。 */
  fullscreen(): void;
  /** Ask the client to leave fullscreen. / クライアントにフルスクリーン解除を要求します。 */
  unfullscreen(): void;
  /**
   * Give keyboard focus to this window. Raises the window and notifies
   * `COMPOSITOR.event.onFocus` listeners.
   * このウィンドウにキーボードフォーカスを与えます。ウィンドウを前面に出し、
   * `COMPOSITOR.event.onFocus` リスナーに通知します。
   */
  focus(): void;
  /** Schedule a managed-window animation (position, size, etc.) via the SSD pipeline. / SSD パイプライン経由でマネージドウィンドウのアニメーション（位置・サイズ等）をスケジュールします。 */
  scheduleAnimation(options: ManagedWindowScheduleAnimationOptions): void;
  /** Cancel a running animation on this window. Pass a channel name to cancel only that channel. / 実行中のアニメーションをキャンセルします。チャンネル名を渡すとそのチャンネルのみキャンセルします。 */
  cancelAnimation(channel?: string): void;
  /**
   * Set how long the compositor waits before destroying the window surface after
   * the close sequence begins. Use this to match the close animation duration.
   * 閉じるシーケンス開始後、コンポジターがウィンドウサーフェスを破棄するまでの
   * 待機時間を設定します。閉じるアニメーションの長さに合わせるために使います。
   */
  setCloseAnimationDuration(durationMs: number): void;
  /** `true` if this window is running under XWayland (X11 compatibility layer). / XWayland（X11 互換レイヤー）上で動作するウィンドウのとき `true`。 */
  isXWayland(): boolean;
}

/**
 * A mapped layer-shell surface (bars, docks, overlays, wallpapers, etc.).
 * Reactive properties are `ReadonlySignal<T>` and automatically invalidate any
 * composition code that reads them.
 * マップされたレイヤーシェルサーフェス（バー・ドック・オーバーレイ・壁紙等）。
 * リアクティブなプロパティは `ReadonlySignal<T>` で、読み取った合成コードを
 * 自動的に無効化します。
 *
 * @example In an effect factory / エフェクトファクトリー内で
 * ```ts
 * COMPOSITOR.effect.layer = (layer) =>
 *   layer.namespace.value === "bar" ? { shader: panelBlur } : null;
 * ```
 */
export interface WaylandLayer {
  /** Stable string identifier unique to this layer for its lifetime. / レイヤーのライフタイムを通じてユニークな安定した識別子。 */
  readonly id: string;
  /** Reactive namespace string set by the client (e.g. `"bar"`, `"dock"`). / クライアントが設定するリアクティブな名前空間文字列（例: `"bar"`、`"dock"`）。 */
  readonly namespace: import("./signals").ReadonlySignal<string | undefined>;
  /** Reactive z-layer kind: `"background" | "bottom" | "top" | "overlay"`. / リアクティブな z レイヤー種別。 */
  readonly layer: import("./signals").ReadonlySignal<WaylandLayerKind>;
  /** Reactive name of the output this surface is placed on. / このサーフェスが配置される出力名（リアクティブ）。 */
  readonly outputName: import("./signals").ReadonlySignal<string>;
  /** Current logical position and size in global compositor coordinates. / グローバル座標での現在の論理的な位置とサイズ。 */
  readonly position: LayerPosition;
  /** Reactive anchor edges. / リアクティブなアンカーエッジ。 */
  readonly anchor: import("./signals").ReadonlySignal<WaylandLayerAnchor>;
  /** Reactive exclusive-zone request. / リアクティブな排他ゾーン要求。 */
  readonly exclusiveZone: import("./signals").ReadonlySignal<WaylandLayerExclusiveZone>;
  /** Reactive explicit exclusive edge (layer-shell v5+). `null` when not set. / リアクティブな明示的排他エッジ（レイヤーシェル v5+）。未設定時は `null`。 */
  readonly exclusiveEdge: import("./signals").ReadonlySignal<WaylandLayerEdge | null>;
  /** Reactive margin insets in logical pixels. / 論理ピクセル単位のリアクティブなマージンインセット。 */
  readonly margin: import("./signals").ReadonlySignal<WaylandLayerMargin>;
  /** Reactive keyboard interactivity mode. / リアクティブなキーボードインタラクティビティモード。 */
  readonly keyboardInteractivity: import("./signals").ReadonlySignal<WaylandLayerKeyboardInteractivity>;
  /** Reactive size the client requested. / クライアントが要求したリアクティブなサイズ。 */
  readonly desiredSize: import("./signals").ReadonlySignal<WaylandLayerDesiredSize>;
  /** Animation controller for this layer surface. / このレイヤーサーフェス用のアニメーションコントローラー。 */
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

/**
 * GPU transform applied to a window during composition. Each field accepts a
 * plain value or a `ReadonlySignal<number>` for reactive animation.
 * 合成時にウィンドウに適用される GPU トランスフォーム。各フィールドは固定値または
 * `ReadonlySignal<number>` によるリアクティブなアニメーションを受け付けます。
 *
 * @example Animate scale + opacity on open / オープン時にスケールと不透明度をアニメーション
 * ```ts
 * COMPOSITOR.event.onOpen((window) => {
 *   window.animation.start(openVar, { from: 0, to: 1, duration: ms(180) });
 * });
 * COMPOSITOR.window.composition = (window) => {
 *   const t = window.animation.variable(openVar);
 *   window.transform.scaleX = t((x) => 0.85 + x * 0.15);
 *   window.transform.scaleY = t((x) => 0.85 + x * 0.15);
 *   window.transform.opacity = t;
 *   // ...
 * };
 * ```
 */
export interface WindowTransform {
  /** Transform origin for scale operations. Defaults to the window center. / スケール操作のトランスフォーム原点。デフォルトはウィンドウ中央。 */
  origin: MaybeSignal<TransformOrigin>;
  /** Horizontal translation in logical pixels. / 論理ピクセル単位の水平移動量。 */
  translateX: MaybeSignal<number>;
  /** Vertical translation in logical pixels. / 論理ピクセル単位の垂直移動量。 */
  translateY: MaybeSignal<number>;
  /** Horizontal scale factor (`1.0` = no scale). / 水平スケール係数（`1.0` = スケールなし）。 */
  scaleX: MaybeSignal<number>;
  /** Vertical scale factor (`1.0` = no scale). / 垂直スケール係数（`1.0` = スケールなし）。 */
  scaleY: MaybeSignal<number>;
  /** Opacity from `0.0` (transparent) to `1.0` (opaque). / 不透明度（`0.0` = 透明、`1.0` = 不透明）。 */
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
 * A mapped xdg_popup, delivered to `COMPOSITOR.effect.popup` so effects
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

/**
 * Assigns GPU-composited visual effects to the four layers of the scene graph.
 * シーングラフの 4 つのレイヤーに GPU 合成エフェクトを割り当てます。
 *
 * All slots are independent — set only the ones you need.
 * 各スロットは独立しています。必要なものだけ設定してください。
 */
export interface CompositorEffectConfig {
  /**
   * Full-screen background effect rendered beneath all windows. Set to `null`
   * to disable.
   * すべてのウィンドウの下に描画されるフルスクリーン背景エフェクト。`null` で無効化。
   *
   * @example
   * ```ts
   * COMPOSITOR.effect.background_effect = compileEffect(({ backdrop }) =>
   *   dualKawaseBlur(backdrop(), { passes: 3, offset: 2.5 }),
   * );
   * ```
   */
  background_effect: CompiledEffectHandle | null;
  /**
   * Per-window effect factory. Called once per mapped toplevel; return `null`
   * to apply no effect to that window.
   * マップされたトップレベルウィンドウごとに1回呼ばれるエフェクトファクトリー。
   * そのウィンドウにエフェクトを適用しない場合は `null` を返します。
   *
   * @example
   * ```ts
   * COMPOSITOR.effect.window = (window) =>
   *   window.isFullscreen ? null : { shader: frostedGlass };
   * ```
   */
  window?: (window: WaylandWindow) => WindowEffectAssignment | null;
  /**
   * Per-layer-shell-surface effect factory.
   * レイヤーシェルサーフェスごとのエフェクトファクトリー。
   *
   * @example
   * ```ts
   * COMPOSITOR.effect.layer = (layer) =>
   *   layer.namespace === "bar" ? { shader: panelBlur } : null;
   * ```
   */
  layer?: (layer: WaylandLayer) => LayerEffectAssignment | null;
  /**
   * Per-popup effect factory. Covers both window-attached and layer-attached
   * popups; use `parentKind` to discriminate if needed.
   * ウィンドウ・レイヤー両方に付いたポップアップごとのエフェクトファクトリー。
   * 必要に応じて `parentKind` で区別できます。
   *
   * @example
   * ```ts
   * COMPOSITOR.effect.popup = (popup) =>
   *   popup.parentKind === "layer" ? { shader: tooltipBlur } : null;
   * ```
   */
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

/**
 * Read-only view onto connected outputs and the current display configuration.
 * Lets config code query output geometry and register a factory that produces a
 * `DisplayConfigDraft` whenever the connected-output set changes.
 * 接続中の出力と現在のディスプレイ設定への読み取り専用ビュー。出力のジオメトリを
 * 取得したり、接続中の出力セットが変わるたびに `DisplayConfigDraft` を返す
 * ファクトリーを登録したりできます。
 *
 * @example Configure multi-monitor layout / マルチモニターレイアウトを設定
 * ```ts
 * COMPOSITOR.output.configure((ctx) => ({
 *   "DP-1":  { resolution: { width: 2560, height: 1440, refreshRate: 144 } },
 *   "eDP-1": { resolution: "best", scale: 2 },
 * }));
 * ```
 *
 * @example Read output info / 出力情報を読む
 * ```ts
 * const hz = COMPOSITOR.output.get("DP-1")?.resolution?.refreshRate;
 * const [primary] = COMPOSITOR.output.outputs;
 * ```
 */
export interface OutputController {
  /** Names of all currently connected and enabled outputs. / 接続・有効な出力名の一覧。 */
  readonly list: string[];
  /** Snapshot of every connected output. / 接続中の全出力のスナップショット。 */
  readonly outputs: OutputInfo[];
  /** Snapshots keyed by output name. / 出力名をキーとしたスナップショット。 */
  readonly current: Record<string, OutputInfo>;
  /** Returns the snapshot for `outputName`, or `undefined` if not found. / 指定名の出力スナップショット。見つからない場合は `undefined`。 */
  get(outputName: string): OutputInfo | undefined;
  /** Returns the first output matching `predicate`. / `predicate` に一致する最初の出力を返します。 */
  find(predicate: (output: OutputInfo) => boolean): OutputInfo | undefined;
  /** All DRM modes reported by the driver for `outputName`. / ドライバーが報告する全 DRM モード。 */
  availableModes(outputName: string): OutputMode[];
  /**
   * Registers a factory that the compositor calls whenever the set of connected
   * outputs changes. The factory returns a `DisplayConfigDraft` (a map of output
   * name → config) describing the desired layout.
   * 接続中の出力セットが変わるたびにコンポジターが呼ぶファクトリーを登録します。
   * ファクトリーは希望のレイアウトを表す `DisplayConfigDraft` を返します。
   */
  configure(factory: OutputConfigureFactory): void;
  /**
   * Re-runs all registered `configure` factories immediately.
   * Useful after programmatically changing display state.
   * 登録済みの `configure` ファクトリーを即時再実行します。
   */
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

/**
 * Manages the environment variables inherited by child processes spawned via
 * `COMPOSITOR.process`. Changes take effect for processes started after the
 * call; running processes are unaffected unless you call `publish`.
 * `COMPOSITOR.process` で起動される子プロセスが継承する環境変数を管理します。
 * 変更は呼び出し後に起動されるプロセスに反映されます。実行中のプロセスには
 * `publish` を呼ばない限り影響しません。
 *
 * @example
 * ```ts
 * COMPOSITOR.env.set("QT_QPA_PLATFORM", "wayland;xcb");
 * COMPOSITOR.env.apply({
 *   MOZ_ENABLE_WAYLAND: 1,
 *   GDK_BACKEND: "wayland",
 *   XCURSOR_SIZE: 24,
 * });
 * ```
 */
export interface EnvController {
  /** Set a single environment variable. / 環境変数を 1 つ設定します。 */
  set(key: string, value: EnvValue): void;
  /** Remove an environment variable. / 環境変数を削除します。 */
  unset(key: string): void;
  /** Read the current value of a variable. / 変数の現在値を取得します。 */
  get(key: string): string | undefined;
  /**
   * Bulk set/unset. Pass `null` or `undefined` as a value to unset that key.
   * 一括設定。値に `null` または `undefined` を渡すとその変数を削除します。
   */
  apply(values: Record<string, EnvValue | null | undefined>): void;
  /**
   * Broadcast the current environment to running compositor services. If `keys`
   * is omitted, all currently-set variables are published.
   * 実行中のコンポジターサービスに現在の環境変数をブロードキャストします。
   * `keys` を省略するとすべての設定済み変数を公開します。
   */
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

/**
 * Launches and manages processes that are part of the desktop session.
 * デスクトップセッションに属するプロセスの起動と管理を行います。
 *
 * Three launch modes / 3 種類の起動モード:
 * - `once`    — run once at startup (optionally once per config version) / 起動時1回（設定バージョンごとも可）
 * - `service` — keep running with an optional restart policy / オプションの再起動ポリシーで常駐
 * - `spawn`   — fire-and-forget; compositor does not track the process / 追跡なし即時起動
 *
 * @example
 * ```ts
 * // One-shot: start foot server on first session launch
 * COMPOSITOR.process.once("shell", {
 *   command: ["foot", "--server"],
 *   runPolicy: "once-per-session",
 * });
 *
 * // Service: cliphist stays alive and restarts on failure
 * COMPOSITOR.process.service("cliphist", {
 *   command: "wl-paste --watch cliphist store",
 *   restart: "on-failure",
 * });
 *
 * // Spawn: open a terminal on demand
 * COMPOSITOR.process.spawn({ command: ["kitty"] });
 * ```
 */
export interface ProcessController {
  /**
   * Run a command once at session startup. By default runs once per session;
   * set `runPolicy: "once-per-config-version"` to re-run when the config changes.
   * セッション起動時に1回だけ実行します。デフォルトはセッションごとに1回。
   * 設定変更時に再実行したい場合は `runPolicy: "once-per-config-version"` を指定します。
   */
  once(id: string, spec: StartupOnceSpec): void;
  /**
   * Start a long-running service. The compositor monitors the process and
   * restarts it according to `restart` policy.
   * 常駐サービスを起動します。コンポジターがプロセスを監視し、`restart`
   * ポリシーに従って再起動します。
   */
  service(id: string, spec: StartupServiceSpec): void;
  /**
   * Launch a process and forget it. The compositor does not track or restart it.
   * プロセスを起動して追跡しません。コンポジターは再起動も監視もしません。
   */
  spawn(spec: ProcessSpawnSpec): void;
}

export type KeyBindingEventPhase = "press" | "release";

export interface KeyBindingOptions {
  on?: KeyBindingEventPhase;
}

/**
 * Registers compositor-level keyboard shortcuts.
 * コンポジターレベルのキーボードショートカットを登録します。
 *
 * Shortcuts are identified by a string `id` (shown in help UIs). The `shortcut`
 * string uses modifier+key notation such as `"Super+T"` or `"Super+Shift+Left"`.
 * ショートカットは文字列 `id` で識別されます（ヘルプ UI などに表示されます）。
 * `shortcut` は `"Super+T"` や `"Super+Shift+Left"` のような記法を使います。
 *
 * @example
 * ```ts
 * COMPOSITOR.key.bind("launch-terminal", "Super+T", () => {
 *   COMPOSITOR.process.spawn({ command: ["kitty"] });
 * });
 *
 * // Tap binding: fires on Super key release / タップバインド: Superキーリリースで発火
 * COMPOSITOR.key.bind("launcher", "Super", openLauncher, { on: "release" });
 * ```
 */
export interface KeyBindingController {
  /**
   * Register a shortcut. `id` must be unique; registering the same id twice
   * replaces the previous binding.
   * ショートカットを登録します。`id` は一意である必要があります。
   * 同じ `id` を2回登録すると前のバインドが上書きされます。
   */
  bind(
    id: string,
    shortcut: string,
    handler: () => void,
    options?: KeyBindingOptions,
  ): void;
}

/**
 * Compositor-level pointer (mouse/touchpad cursor) configuration.
 * コンポジターレベルのポインター（マウス・タッチパッドカーソル）設定。
 *
 * For per-device settings (acceleration, scroll method, …) use
 * `COMPOSITOR.input.configure` instead.
 * デバイスごとの設定（加速度・スクロール方式など）は `COMPOSITOR.input.configure`
 * を使ってください。
 *
 * @example
 * ```ts
 * // Hold Super and drag any window to move it without grabbing its title bar
 * // Super を押しながら任意のウィンドウをドラッグして移動（タイトルバー不要）
 * COMPOSITOR.pointer.bindWindowMoveModifier("Super");
 * ```
 */
export interface PointerController {
  /**
   * Set the modifier key that lets the user drag any window by holding the
   * modifier and clicking anywhere on the window surface.
   * 指定したモディファイアキーを押しながらウィンドウ上の任意の場所をクリック
   * してドラッグできるようにします。
   */
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

/**
 * Provides access to the currently connected input devices and lets config
 * code adjust per-device settings (keyboard layout, touchpad behaviour, pointer
 * acceleration, and so on).
 * 接続中の入力デバイスへのアクセスと、デバイスごとの設定（キーボードレイアウト・
 * タッチパッド挙動・ポインター加速度など）の調整を提供します。
 *
 * `configure` is the main entry-point: mutate the `InputConfigDraft` passed to
 * your factory, then the compositor applies the diff. Call `reconfigure` to
 * re-run all registered factories (e.g. after a device hotplug event).
 * `configure` がメインのエントリーポイントです。ファクトリーに渡された
 * `InputConfigDraft` を変更すると、コンポジターが差分を適用します。
 * デバイスのホットプラグ後など再実行したい場合は `reconfigure` を呼びます。
 *
 * @example Global touchpad + keyboard defaults / グローバルなタッチパッド・キーボードのデフォルト
 * ```ts
 * COMPOSITOR.input.configure((input) => {
 *   input.global = {
 *     touchpad: { tapToClick: true, naturalScroll: true, disableWhileTyping: true },
 *     keyboard: { layout: "us", options: "ctrl:nocaps" },
 *   };
 * });
 * ```
 *
 * @example Per-device override / デバイスごとの上書き
 * ```ts
 * COMPOSITOR.input.configure((input, ctx) => {
 *   for (const device of ctx.devices) {
 *     if (device.kind.touchpad) {
 *       input.device[device.key] = { touchpad: { scrollMethod: "twoFinger" } };
 *     }
 *   }
 * });
 * ```
 */
export interface InputController {
  /** All currently connected input devices. / 接続中の入力デバイス一覧。 */
  readonly devices: InputDeviceInfo[];
  /** Devices keyed by their unique key string. / ユニークなキー文字列をキーとしたデバイス一覧。 */
  readonly current: Record<string, InputDeviceInfo>;
  /** Returns the device for `deviceKey`, or `undefined` if not found. / 指定キーのデバイス。見つからない場合は `undefined`。 */
  get(deviceKey: string): InputDeviceInfo | undefined;
  /** Returns the first device matching `predicate`. / `predicate` に一致する最初のデバイスを返します。 */
  find(
    predicate: (device: InputDeviceInfo) => boolean,
  ): InputDeviceInfo | undefined;
  /**
   * Registers a factory that the compositor calls whenever the set of connected
   * input devices changes. Mutate `input` (an `InputConfigDraft`) to apply
   * global or per-device settings.
   * 入力デバイスのセットが変わるたびにコンポジターが呼ぶファクトリーを登録します。
   * `input`（`InputConfigDraft`）を変更してグローバルまたはデバイスごとの設定を適用します。
   */
  configure(factory: InputConfigureFactory): void;
  /**
   * Re-runs all registered `configure` factories immediately.
   * 登録済みの `configure` ファクトリーを即時再実行します。
   */
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

/**
 * The root API object exposed to ShojiWM config scripts.
 * ShojiWM の設定スクリプトに公開されるルート API オブジェクト。
 *
 * Every field is a scoped controller covering one functional area: events,
 * effects, outputs, input devices, environment, processes, key bindings, and
 * so on. Typically you call methods at module top-level; the compositor then
 * invokes your listeners and effect functions reactively at runtime.
 * 各フィールドはイベント・エフェクト・出力・入力デバイス・環境変数・プロセス・
 * キーバインドなど、1 つの機能領域をカバーするコントローラーです。
 *
 * @example Hot-reload lifecycle / ホットリロードライフサイクル
 * ```ts
 * COMPOSITOR.onEnable((event) => {
 *   const saved = event.restore<{ count: number }>("my-state");
 *   if (saved) count = saved.count;
 * });
 * COMPOSITOR.onDisable((event) => {
 *   event.persist("my-state", { count });
 * });
 * ```
 */
export interface CompositorDefinition {
  /**
   * Lifecycle and window/layer/output/input event bus.
   * ウィンドウ・レイヤー・出力・入力のライフサイクルイベントバス。
   *
   * @example
   * ```ts
   * COMPOSITOR.event.onOpen((window) => console.log("opened", window.id));
   * COMPOSITOR.event.onFocus((window, focused) => {
   *   window.animation.start(focusVar, { to: focused ? 1 : 0, duration: ms(120) });
   * });
   * ```
   */
  event: import("./events").CompositorEventController;
  /**
   * Shorthand for `COMPOSITOR.event.onEnable`. Returns an unsubscribe function.
   * `COMPOSITOR.event.onEnable` のショートハンド。解除関数を返します。
   *
   * @example
   * ```ts
   * COMPOSITOR.onEnable((event) => {
   *   const saved = event.restore<MyState>("key");
   *   if (saved) restore(saved);
   * });
   * ```
   */
  onEnable(listener: import("./events").RuntimeEnableListener): () => void;
  /**
   * Shorthand for `COMPOSITOR.event.onDisable`. Use `event.persist` inside the
   * listener to save state that survives a config hot-reload.
   * `COMPOSITOR.event.onDisable` のショートハンド。リスナー内で `event.persist` を
   * 呼ぶとホットリロードをまたいで状態を保持できます。
   *
   * @example
   * ```ts
   * COMPOSITOR.onDisable((event) => {
   *   event.persist("my-state", snapshot());
   * });
   * ```
   */
  onDisable(listener: import("./events").RuntimeDisableListener): () => void;
  preload: PreloadController;
  /**
   * Scene-graph effect assignments: background, per-window, per-layer, per-popup.
   * シーングラフのエフェクト設定。背景・ウィンドウごと・レイヤーごと・ポップアップごと。
   *
   * @example Background blur / 背景ブラー
   * ```ts
   * COMPOSITOR.effect.background_effect = compileEffect(({ backdrop }) =>
   *   dualKawaseBlur(backdrop(), { passes: 4, offset: 3 }),
   * );
   * ```
   *
   * @example Per-window effect / ウィンドウごとのエフェクト
   * ```ts
   * COMPOSITOR.effect.window = (window) =>
   *   window.isFullscreen ? null : { shader: frostedGlass };
   * ```
   */
  effect: CompositorEffectConfig;
  /**
   * Output (monitor) access and display layout configuration.
   * 出力（モニター）へのアクセスとディスプレイレイアウト設定。
   *
   * @example Configure outputs / 出力を設定
   * ```ts
   * COMPOSITOR.output.configure((ctx) => ({
   *   "DP-1":  { resolution: { width: 2560, height: 1440, refreshRate: 144 } },
   *   "eDP-1": { resolution: "best", scale: 2 },
   * }));
   * ```
   *
   * @example Read current output info / 現在の出力情報を取得
   * ```ts
   * const info = COMPOSITOR.output.get("DP-1");
   * console.log(info?.resolution?.refreshRate);
   * ```
   */
  output: OutputController;
  /**
   * Input device enumeration and per-device configuration.
   * 入力デバイスの列挙とデバイスごとの設定。
   *
   * @example Configure touchpad and keyboard / タッチパッドとキーボードを設定
   * ```ts
   * COMPOSITOR.input.configure((input) => {
   *   input.global = {
   *     touchpad: { tapToClick: true, naturalScroll: true, disableWhileTyping: true },
   *     keyboard: { layout: "us", options: "ctrl:nocaps" },
   *   };
   * });
   * ```
   */
  input: InputController;
  /**
   * Environment variable controller for child processes spawned by the compositor.
   * コンポジターが起動する子プロセスが継承する環境変数を管理します。
   *
   * @example
   * ```ts
   * COMPOSITOR.env.set("QT_QPA_PLATFORM", "wayland;xcb");
   * COMPOSITOR.env.apply({ MOZ_ENABLE_WAYLAND: 1, GDK_BACKEND: "wayland" });
   * ```
   */
  env: EnvController;
  /**
   * Process lifecycle management: one-shot startup, managed services, and ad-hoc spawns.
   * プロセスライフサイクル管理。起動時ワンショット・マネージドサービス・即時起動の 3 種類。
   *
   * @example One-shot on first session / セッション初回のみ起動
   * ```ts
   * COMPOSITOR.process.once("shell", { command: ["foot", "--server"] });
   * ```
   *
   * @example Managed service with auto-restart / 自動再起動つきマネージドサービス
   * ```ts
   * COMPOSITOR.process.service("cliphist", {
   *   command: "wl-paste --watch cliphist store",
   *   restart: "on-failure",
   * });
   * ```
   *
   * @example Spawn on demand / オンデマンド起動
   * ```ts
   * COMPOSITOR.key.bind("terminal", "Super+T", () => {
   *   COMPOSITOR.process.spawn({ command: ["kitty"] });
   * });
   * ```
   */
  process: ProcessController;
  /**
   * Compositor-level keyboard shortcut bindings.
   * コンポジターレベルのキーボードショートカットバインド。
   *
   * @example
   * ```ts
   * COMPOSITOR.key.bind("launch-terminal", "Super+T", () => {
   *   COMPOSITOR.process.spawn({ command: ["kitty"] });
   * });
   * // Tap binding (fires on key release) / タップバインド（キーリリース時に発火）
   * COMPOSITOR.key.bind("launcher", "Super", openLauncher, { on: "release" });
   * ```
   */
  key: KeyBindingController;
  /**
   * Compositor-level pointer (mouse) configuration.
   * コンポジターレベルのポインター（マウス）設定。
   *
   * @example Drag windows with Super held / Super を押しながらウィンドウをドラッグ
   * ```ts
   * COMPOSITOR.pointer.bindWindowMoveModifier("Super");
   * ```
   */
  pointer: PointerController;
  runtime: RuntimeController;
  /**
   * Per-window scene-tree composition. Assign a function to control what chrome
   * (borders, shadows, managed-window placement) wraps each toplevel window.
   * ウィンドウごとのシーンツリー合成。各トップレベルウィンドウをラップするクローム
   * （ボーダー・影・ManagedWindow の配置）を制御する関数を割り当てます。
   *
   * @example
   * ```tsx
   * COMPOSITOR.window.composition = (window) => (
   *   <ManagedWindow rect={layoutRect(window)} zIndex={getZIndex(window)}>
   *     <WindowBorder style={{ borderRadius: 8, border: { px: 1, color: "#ffffff33" } }}>
   *       <ClientWindow />
   *     </WindowBorder>
   *   </ManagedWindow>
   * );
   * ```
   */
  window: CompositorWindowController;
  /**
   * Layer-shell surface access and usable-area queries.
   * レイヤーシェルサーフェスへのアクセスと使用可能エリアのクエリ。
   *
   * @example Place windows below the top bar / トップバーの下にウィンドウを配置
   * ```ts
   * const usable = COMPOSITOR.layer.usableArea("DP-1");
   * // usable.y is already offset past the bar / usable.y はバーの下から始まります
   * ```
   *
   * @example Get reserved insets / 予約済みインセットを取得
   * ```ts
   * const { top, bottom } = COMPOSITOR.layer.reservedInsets("DP-1");
   * ```
   */
  layer: LayerController;
  /**
   * Debug knobs — toggles and overlays that don't affect production behavior.
   * デバッグ用トグルとオーバーレイ。本番動作には影響しません。
   *
   * @example Toggle FPS overlay / FPS オーバーレイを切り替え
   * ```ts
   * COMPOSITOR.key.bind("toggle-fps", "Super+Shift+F", () => {
   *   COMPOSITOR.debug.fpsCounter = !COMPOSITOR.debug.fpsCounter;
   * });
   * ```
   */
  debug: DebugController;
  /**
   * Optional default display mode applied before `output.configure` fires.
   * `output.configure` が呼ばれる前に適用されるデフォルト表示モード（省略可）。
   */
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

export interface CompositorWindowController {
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
   * `COMPOSITOR.event.onFocus` listeners all fire just as they would for
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
