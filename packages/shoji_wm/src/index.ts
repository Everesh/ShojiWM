import type {
  AppIconProps,
  ImageProps,
  Component,
  ComponentProps,
  WindowCompositionInteractionSnapshot,
  WindowCompositionContext,
  WindowCompositionFunction,
  WindowCompositionPhase,
  CompositionChild,
  CompositionElementNode,
  ReactiveWaylandWindow,
  ReactiveWaylandWindowHandle,
  ReactiveWaylandWindowSignals,
  CompositionNodeType,
  DisplayConfig,
  DisplayConfigDraft,
  DisplayModePreference,
  EffectInvalidationPolicyHandle,
  AutomaticEffectInvalidationPolicyHandle,
  BoxProps,
  ButtonProps,
  LabelProps,
  ManagedWindowProps,
  ManagedWindowAnimationEasing,
  ManagedWindowAnimationMode,
  ManagedWindowPoint,
  ManagedWindowPointAnimationOptions,
  ManagedWindowRect,
  ManagedWindowRectAnimationOptions,
  ManagedWindowScalarAnimationOptions,
  ManagedWindowScheduleAnimationOptions,
  ManagedWindowState,
  ManagedWindowTransform,
  MaybeSignal,
  SSDStyle,
  BackdropSourceHandle,
  XrayBackdropSourceHandle,
  ShaderInputHandle,
  BlendMode,
  BlendStageHandle,
  ShaderEffectProps,
  CompiledEffectHandle,
  DualKawaseBlurStageHandle,
  EffectInputHandle,
  EffectStageHandle,
  ImageSourceHandle,
  NamedTextureHandle,
  NoiseKind,
  NoiseStageHandle,
  EffectOutsets,
  OutputConfigEntry,
  OutputController,
  OutputConfigureContext,
  OutputConfigureFactory,
  OutputInfo,
  OutputMode,
  OutputPositionPreference,
  OutputResolutionPreference,
  OutputStateSnapshot,
  InputAccelProfile,
  InputClickMethod,
  InputConfigDraft,
  InputConfigureContext,
  InputConfigureFactory,
  InputController,
  InputDeviceConfig,
  InputDeviceInfo,
  InputDeviceKindFlags,
  InputScrollMethod,
  InputTapButtonMap,
  KeyboardInputConfig,
  PointerInputConfig,
  TouchpadInputConfig,
  ProcessController,
  ProcessEnv,
  ProcessLaunchSpec,
  ProcessSpawnSpec,
  SaveStageHandle,
  ShaderUniformMap,
  ShaderUniformValue,
  ShaderModuleHandle,
  UnitStageHandle,
  WindowEffectAssignment,
  WindowEffectHandle,
  WindowSourceHandle,
  SerializableCompositionChild,
  SerializedCompositionNode,
  WindowActionDescriptor,
  WindowActionType,
  WindowBorderProps,
  WindowManagerDefinition,
  WindowManagerEffectConfig,
  WindowManagerWindowController,
  WindowPosition,
  WindowSize,
  WindowSizeConstraints,
  ClientWindowProps,
  WindowProps,
  WindowTransform,
  TransformOrigin,
  WaylandWindowActions,
  WaylandWindowSnapshot,
  WaylandWindow,
  LayerPosition,
  ReactiveWaylandLayer,
  ReactiveWaylandLayerHandle,
  ReactiveWaylandLayerSignals,
  WaylandLayer,
  WaylandLayerAnchor,
  WaylandLayerDesiredSize,
  WaylandLayerEdge,
  WaylandLayerExclusiveZone,
  WaylandLayerKeyboardInteractivity,
  WaylandLayerKind,
  WaylandLayerMargin,
  WaylandLayerSnapshot,
  LayerController,
  LayerInsets,
  UsableAreaOptions,
  StartupOnceSpec,
  StartupProcessRunPolicy,
  StartupServiceSpec,
  ManagedProcessRestartPolicy,
  ManagedProcessReloadPolicy,
  KeyBindingController,
  KeyBindingOptions,
  KeyBindingEventPhase,
  PointerController,
  PreloadController,
  RuntimeController,
  DebugController,
  SSDRebuildSuppressionHandle,
  SSDRebuildSuppressionOptions,
  SSDRebuildSuppressionViolationPolicy,
} from "./types";
import { createWindowManagerEventController } from "./events";
import { suppressSSDRebuild, withSSDRebuildSuppressed } from "./runtime-hooks";
import {
  KEY_BINDING_CONTROLLER,
  beginKeyBindingRegistration,
  commitKeyBindingRegistration,
  invokeKeyBinding,
  takePendingKeyBindingConfig,
} from "./key";
import {
  POINTER_CONTROLLER,
  beginPointerConfigRegistration,
  commitPointerConfigRegistration,
  takePendingPointerConfig,
} from "./pointer";
import { INPUT_CONTROLLER, installInputDeviceChangeEmitter } from "./input";
import { OUTPUT_CONTROLLER, installOutputChangeEmitter } from "./output";
import { DEBUG_CONTROLLER, takePendingDebugConfig } from "./debug";
import { LAYER_CONTROLLER, updateLayerSnapshots } from "./layer";
import {
  PROCESS_CONTROLLER,
  beginProcessConfigRegistration,
  commitProcessConfigRegistration,
  drainPendingProcessActions,
  installProcessResolverBridge,
  takePendingProcessConfig,
} from "./process";
import { createElementNode } from "./runtime";
import {
  computed as createComputedSignal,
  isSignal as isReadonlySignal,
} from "./signals";
import { resolveAssetPath } from "./shader";
import { serializeCompositionTree } from "./serialize";
export {
  advanceAnimationFrame,
  hasActiveAnimations,
  createAnimationControllerWithStore,
  createAnimationController,
  animationVariable,
  createWindowAnimationControllerWithStore,
  createWindowAnimationController,
  milliseconds,
  seconds,
  type AnimationRepeatMode,
  type AnimationStartOptions,
  type AnimationController,
  type AnimationVariable,
  type WindowAnimationController,
} from "./animation";
export {
  backdropSource,
  blend,
  compileEffect,
  compileWindowEffect,
  dualKawaseBlur,
  get,
  imageSource,
  installAssetResolverBridge,
  installShaderResolverBridge,
  loadShader,
  resolveAssetPath,
  noise,
  save,
  shaderInput,
  shaderStage,
  unit,
  windowSource,
  xrayBackdropSource,
  type CompileEffectOptions,
  type CompileWindowEffectOptions,
} from "./shader";
export {
  cubicBezier,
  ease,
  easeIn,
  easeInOut,
  easeInOutCubic,
  easeOut,
  easeOutCubic,
  easeOutExpo,
  linear,
  type CubicBezierEasingFunction,
  type EasingFunction,
} from "./easing";
export {
  createWindowManagerEventController,
  type LayerCreateListener,
  type LayerDestroyListener,
  type LayerUpdateListener,
  type RuntimeDisableEvent,
  type RuntimeDisableListener,
  type RuntimeEnableEvent,
  type RuntimeEnableListener,
  type RuntimeLifecycleReason,
  type RuntimePersistedState,
  type WindowCloseListener,
  type WindowFirstCommitListener,
  type WindowFocusListener,
  type WindowInitialConfigureListener,
  type WindowManagerEventController,
  type WindowOpenListener,
  type WindowResizeEdges,
  type WindowResizeEvent,
  type WindowResizeListener,
  type WindowResizePhase,
  type WindowResizePoint,
  type WindowResizeRect,
  type WindowResizeSource,
  type RuntimeWindowResizeEvent,
  type RuntimeWindowMoveEvent,
  type RuntimeWindowMaximizeRequestEvent,
  type RuntimeWindowMinimizeRequestEvent,
  type RuntimeWindowActivateRequestEvent,
  type PointerModifierState,
  type PointerMoveAsyncListener,
  type GestureSwipeAsyncListener,
  type GestureSwipeEvent,
  type GestureSwipePhase,
  type OutputChangeEvent,
  type OutputChangeListener,
  type InputDeviceChangeEvent,
  type InputDeviceChangeListener,
  type PointerMoveEvent,
  type PointerMovePoint,
  type RuntimeEventConfig,
  type WindowMoveEvent,
  type WindowMoveListener,
  type WindowMovePhase,
  type WindowMovePoint,
  type WindowMoveRect,
  type WindowMoveSource,
  type WindowMaximizeRequestEvent,
  type WindowMaximizeRequestListener,
  type WindowMinimizeRequestEvent,
  type WindowMinimizeRequestListener,
  type WindowActivateRequestEvent,
  type WindowActivateRequestListener,
  type WindowActivateRequestSource,
  type WindowStateRequestSource,
  type WindowStartCloseListener,
} from "./events";
export { createReactiveWindow } from "./reactive-window";
export { createReactiveLayer } from "./reactive-layer";
export {
  OUTPUT_CONTROLLER,
  beginOutputConfigurationRegistration,
  commitOutputConfigurationRegistration,
  installOutputChangeEmitter,
  takePendingDisplayConfig,
  updateOutputState,
} from "./output";
export { LAYER_CONTROLLER, updateLayerSnapshots } from "./layer";
export { DEBUG_CONTROLLER, takePendingDebugConfig } from "./debug";
export {
  KEY_BINDING_CONTROLLER,
  beginKeyBindingRegistration,
  commitKeyBindingRegistration,
  invokeKeyBinding,
  takePendingKeyBindingConfig,
} from "./key";
export {
  POINTER_CONTROLLER,
  beginPointerConfigRegistration,
  commitPointerConfigRegistration,
  takePendingPointerConfig,
} from "./pointer";
export {
  INPUT_CONTROLLER,
  beginInputConfigurationRegistration,
  commitInputConfigurationRegistration,
  installInputDeviceChangeEmitter,
  takePendingInputConfig,
  updateInputState,
} from "./input";
export {
  PROCESS_CONTROLLER,
  beginProcessConfigRegistration,
  commitProcessConfigRegistration,
  drainPendingProcessActions,
  installProcessResolverBridge,
  takePendingProcessConfig,
} from "./process";
export {
  createComponentStateStore,
  createComputed,
  createState,
  onCleanup,
  useLayoutEffect,
  useMemo,
  useRef,
  useComputed,
  useEffect,
  useState,
  withComponentRenderRoot,
} from "./runtime";
export {
  createCompositionEvaluationCache,
  diffWindowSnapshot,
  shouldReevaluateComposition,
  type CompositionEvaluationCache,
  type CompositionEvaluationResult,
  type WindowSnapshotDiff,
} from "./reconcile";
export {
  computed,
  effect,
  isSignal,
  read,
  signal,
  type ReadonlySignal,
  type Signal,
  type SignalSetter,
} from "./signals";
export {
  createWindowState,
  dropWindowState,
  type WindowStateDefault,
  type WindowStateKey,
  type WindowStateStore,
} from "./window-state";
export {
  createWindowStack,
  type WindowStack,
  type WindowStackAddOptions,
  type WindowStackOptions,
  type WindowStackPlacement,
} from "./window-stack";
export {
  createPoll,
  createManagedPoll,
  installSchedulerBridge,
  type PollCallback,
  type PollDirtyMode,
  type PollHandle,
} from "./scheduler";
export {
  createIpcServer,
  defaultSocketPath,
  type IpcClient,
  type IpcHandler,
  type IpcRequestMessage,
  type IpcServer,
} from "./ipc";
export {
  dropLayerDependencies,
  dropWindowDependencies,
  enterLayerNodeDependencyScope,
  enterLayerDependencyScope,
  consumeManagedWindowOnlyFastPathInvalidated,
  enterWindowManagedDependencyScope,
  enterWindowNodeDependencyScope,
  enterWindowDependencyScope,
  installRuntimeHooks,
  isManagedWindowOnlyDirty,
  leaveLayerNodeDependencyScope,
  leaveLayerDependencyScope,
  leaveWindowManagedDependencyScope,
  leaveWindowNodeDependencyScope,
  leaveWindowDependencyScope,
  managedWindowOnlyDirtyIds,
  markManagedWindowDirty,
  markLayerDirty,
  markRuntimeDirty,
  markWindowDirty,
  suppressSSDRebuild,
  takeDirtyLayerNodeIds,
  takeManagedWindowOnlyDirty,
  takeDirtyWindowNodeIds,
  trackSignalRead,
  trackSignalWrite,
  withSSDRebuildSuppressed,
} from "./runtime-hooks";

export type {
  AppIconProps,
  BoxProps,
  ButtonProps,
  ImageFit,
  ImageProps,
  Component,
  WindowCompositionInteractionSnapshot,
  WindowCompositionContext,
  WindowCompositionFunction,
  WindowCompositionPhase,
  CompositionChild,
  CompositionElementNode,
  ReactiveWaylandWindow,
  ReactiveWaylandWindowHandle,
  ReactiveWaylandWindowSignals,
  CompositionNodeType,
  DisplayConfig,
  DisplayConfigDraft,
  DisplayModePreference,
  EffectInvalidationPolicyHandle,
  AutomaticEffectInvalidationPolicyHandle,
  LabelProps,
  ManagedWindowProps,
  ManagedWindowState,
  ManagedWindowTransform,
  MaybeSignal,
  SSDStyle,
  BackdropSourceHandle,
  XrayBackdropSourceHandle,
  ShaderInputHandle,
  BlendMode,
  BlendStageHandle,
  ShaderEffectProps,
  CompiledEffectHandle,
  DualKawaseBlurStageHandle,
  EffectInputHandle,
  EffectStageHandle,
  ImageSourceHandle,
  NamedTextureHandle,
  NoiseKind,
  NoiseStageHandle,
  EffectOutsets,
  OutputConfigEntry,
  OutputConfigureContext,
  OutputConfigureFactory,
  OutputController,
  OutputInfo,
  OutputMode,
  OutputPositionPreference,
  OutputResolutionPreference,
  OutputStateSnapshot,
  ProcessController,
  ProcessEnv,
  ProcessLaunchSpec,
  ProcessSpawnSpec,
  SaveStageHandle,
  ShaderUniformMap,
  ShaderUniformValue,
  ShaderModuleHandle,
  UnitStageHandle,
  WindowEffectAssignment,
  WindowEffectHandle,
  WindowSourceHandle,
  SerializableCompositionChild,
  SerializedCompositionNode,
  WindowActionDescriptor,
  WindowActionType,
  WindowBorderProps,
  WindowManagerDefinition,
  WindowManagerEffectConfig,
  WindowManagerWindowController,
  WindowPosition,
  WindowSize,
  WindowSizeConstraints,
  ClientWindowProps,
  WindowProps,
  WindowTransform,
  TransformOrigin,
  WaylandWindowActions,
  WaylandWindowSnapshot,
  WaylandWindow,
  LayerPosition,
  ReactiveWaylandLayer,
  ReactiveWaylandLayerHandle,
  ReactiveWaylandLayerSignals,
  WaylandLayer,
  WaylandLayerAnchor,
  WaylandLayerDesiredSize,
  WaylandLayerEdge,
  WaylandLayerExclusiveZone,
  WaylandLayerKeyboardInteractivity,
  WaylandLayerKind,
  WaylandLayerMargin,
  WaylandLayerSnapshot,
  LayerController,
  LayerInsets,
  UsableAreaOptions,
  StartupOnceSpec,
  StartupProcessRunPolicy,
  StartupServiceSpec,
  ManagedProcessRestartPolicy,
  ManagedProcessReloadPolicy,
  KeyBindingController,
  KeyBindingOptions,
  KeyBindingEventPhase,
  PointerController,
  InputAccelProfile,
  InputClickMethod,
  InputConfigDraft,
  InputConfigureContext,
  InputConfigureFactory,
  InputController,
  InputDeviceConfig,
  InputDeviceInfo,
  InputDeviceKindFlags,
  InputScrollMethod,
  InputTapButtonMap,
  KeyboardInputConfig,
  PointerInputConfig,
  TouchpadInputConfig,
  PreloadController,
  RuntimeController,
  DebugController,
  SSDRebuildSuppressionHandle,
  SSDRebuildSuppressionOptions,
  SSDRebuildSuppressionViolationPolicy,
} from "./types";
export {
  CompositionSerializationError,
  serializeCompositionTree,
} from "./serialize";

export type CompositionNode = CompositionChild;

/**
 * M2-T2 note:
 * These component placeholders already use the custom JSX runtime contract so
 * TSX snippets can be authored before concrete layout semantics land.
 */
export const Box = defineIntrinsicComponent<BoxProps>("Box");
export const Label = defineIntrinsicComponent<LabelProps>("Label");
export const Button = defineIntrinsicComponent<ButtonProps>("Button");
export const AppIcon = defineIntrinsicComponent<AppIconProps>("AppIcon");

const ImageIntrinsic = defineIntrinsicComponent<ImageProps>("Image");
export function Image(props: ImageProps) {
  const src = props.src;
  const resolved =
    typeof src === "string"
      ? resolveAssetPath(src)
      : isReadonlySignal(src)
        ? createComputedSignal(() => resolveAssetPath(src()))
        : src;
  return ImageIntrinsic({ ...props, src: resolved });
}
export const ShaderEffect =
  defineIntrinsicComponent<ShaderEffectProps>("ShaderEffect");
export const ManagedWindow =
  defineIntrinsicComponent<ManagedWindowProps>("ManagedWindow");
export const ClientWindow =
  defineIntrinsicComponent<ClientWindowProps>("Window");
export const Window = ClientWindow;
export const WindowBorder =
  defineIntrinsicComponent<WindowBorderProps>("WindowBorder");

const WINDOW_CONTROLLER: WindowManagerWindowController = {
  composition: null,
  focus(window) {
    window.focus();
  },
};

const RUNTIME_CONTROLLER: RuntimeController = {
  suppressSSDRebuild,
  withSSDRebuildSuppressed,
};

const PRELOAD_CONTROLLER: PreloadController = {};

/**
 * Placeholder namespace for future WM-level entrypoints.
 */
export const WINDOW_MANAGER: WindowManagerDefinition = {
  event: createWindowManagerEventController(),
  onEnable(listener) {
    return this.event.onEnable(listener);
  },
  onDisable(listener) {
    return this.event.onDisable(listener);
  },
  preload: PRELOAD_CONTROLLER,
  effect: {
    background_effect: null,
  },
  output: OUTPUT_CONTROLLER,
  process: PROCESS_CONTROLLER,
  key: KEY_BINDING_CONTROLLER,
  pointer: POINTER_CONTROLLER,
  input: INPUT_CONTROLLER,
  runtime: RUNTIME_CONTROLLER,
  window: WINDOW_CONTROLLER,
  layer: LAYER_CONTROLLER,
  debug: DEBUG_CONTROLLER,
};

installOutputChangeEmitter((event) => {
  WINDOW_MANAGER.event.emitOutputChange(event);
});

installInputDeviceChangeEmitter((event) => {
  WINDOW_MANAGER.event.emitInputDeviceChange(event);
});

export function windowAction(action: WindowActionType): WindowActionDescriptor {
  return {
    kind: "window-action",
    action,
  };
}

function defineIntrinsicComponent<TProps extends ComponentProps>(
  type: CompositionNodeType,
): Component<TProps> {
  return function IntrinsicComponent(props: TProps): CompositionElementNode {
    return createElementNode(type, props as Record<string, unknown>);
  };
}
