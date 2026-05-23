import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Socket, createConnection } from "node:net";
import { format } from "node:util";
import { existsSync } from "node:fs";

function findConfigRoot(entryPath: string): string {
  let dir = dirname(resolve(entryPath));
  while (dir !== dirname(dir)) {
    if (existsSync(`${dir}/package.json`)) {
      return dir;
    }
    dir = dirname(dir);
  }
  return dirname(resolve(entryPath));
}

import {
  advanceAnimationFrame,
  beginKeyBindingRegistration,
  beginPointerConfigRegistration,
  beginProcessConfigRegistration,
  commitKeyBindingRegistration,
  commitPointerConfigRegistration,
  commitProcessConfigRegistration,
  drainPendingProcessActions,
  hasActiveAnimations,
  type CompiledEffectHandle,
  createReactiveLayer,
  createWindowAnimationControllerWithStore,
  createCompositionEvaluationCache,
  type WindowCompositionContext,
  createManagedPoll,
  dropLayerDependencies,
  dropWindowDependencies,
  dropWindowState,
  enterLayerDependencyScope,
  isSignal,
  installAssetResolverBridge,
  installProcessResolverBridge,
  installRuntimeHooks,
  enterWindowDependencyScope,
  invokeKeyBinding,
  takePendingDisplayConfig,
  takePendingKeyBindingConfig,
  takePendingPointerConfig,
  takePendingProcessConfig,
  leaveWindowDependencyScope,
  leaveLayerDependencyScope,
  read,
  takeDirtyLayerNodeIds,
  takeDirtyWindowNodeIds,
  type WindowManagerEventController,
  installSchedulerBridge,
  type CompositionEvaluationCache,
  type DisplayConfigDraft,
  type WindowCompositionFunction,
  type OutputStateSnapshot,
  type PollCallback,
  type PollDirtyMode,
  type PollHandle,
  type RuntimeWindowResizeEvent,
  type RuntimeWindowMoveEvent,
  type RuntimeWindowMaximizeRequestEvent,
  type RuntimeWindowMinimizeRequestEvent,
  type RuntimeWindowActivateRequestEvent,
  type PointerMoveEvent,
  type RuntimeEventConfig,
  updateOutputState,
  updateLayerSnapshots,
  WINDOW_MANAGER,
  type WaylandLayerSnapshot,
  type WaylandLayer,
  type WaylandWindowActions,
  type WaylandWindowSnapshot,
  type WindowEffectAssignment,
  type ManagedWindowState,
  type WindowTransform,
} from "shoji_wm";

interface EvaluateRequest {
  requestId: number;
  kind: "evaluate";
  snapshot: WaylandWindowSnapshot;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface EvaluatePreviewRequest {
  requestId: number;
  kind: "evaluatePreview";
  snapshot: WaylandWindowSnapshot;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface SchedulerTickRequest {
  requestId: number;
  kind: "schedulerTick";
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface WindowClosedRequest {
  requestId: number;
  kind: "windowClosed";
  windowId: string;
  displayState: Record<string, OutputStateSnapshot>;
}

interface StartCloseRequest {
  requestId: number;
  kind: "startClose";
  windowId: string;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface EvaluateCachedRequest {
  requestId: number;
  kind: "evaluateCached";
  windowId: string;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface InvokeHandlerRequest {
  requestId: number;
  kind: "invokeHandler";
  windowId: string;
  handlerId: string;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface InvokeKeyBindingRequest {
  requestId: number;
  kind: "invokeKeyBinding";
  bindingId: string;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface WindowResizeRequest {
  requestId: number;
  kind: "windowResize";
  windowId: string;
  event: RuntimeWindowResizeEvent;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface WindowMoveRequest {
  requestId: number;
  kind: "windowMove";
  windowId: string;
  event: RuntimeWindowMoveEvent;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface WindowMaximizeRequest {
  requestId: number;
  kind: "windowMaximizeRequest";
  windowId: string;
  snapshot: WaylandWindowSnapshot;
  event: RuntimeWindowMaximizeRequestEvent;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface WindowMinimizeRequest {
  requestId: number;
  kind: "windowMinimizeRequest";
  windowId: string;
  snapshot: WaylandWindowSnapshot;
  event: RuntimeWindowMinimizeRequestEvent;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface WindowActivateRequest {
  requestId: number;
  kind: "windowActivateRequest";
  windowId: string;
  snapshot: WaylandWindowSnapshot;
  event: RuntimeWindowActivateRequestEvent;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface PointerMoveAsyncRequest {
  requestId: number;
  kind: "pointerMoveAsync";
  event: PointerMoveEvent;
  nowMs: number;
  displayState: Record<string, OutputStateSnapshot>;
}

interface GetEffectConfigRequest {
  requestId: number;
  kind: "getEffectConfig";
  displayState: Record<string, OutputStateSnapshot>;
}

interface EvaluateLayerEffectsRequest {
  requestId: number;
  kind: "evaluateLayerEffects";
  outputName: string;
  nowMs: number;
  layers: WaylandLayerSnapshot[];
  displayState: Record<string, OutputStateSnapshot>;
}

type RuntimeRequest =
  | EvaluateRequest
  | EvaluatePreviewRequest
  | SchedulerTickRequest
  | WindowClosedRequest
  | StartCloseRequest
  | EvaluateCachedRequest
  | InvokeHandlerRequest
  | InvokeKeyBindingRequest
  | WindowResizeRequest
  | WindowMoveRequest
  | WindowMaximizeRequest
  | WindowMinimizeRequest
  | WindowActivateRequest
  | PointerMoveAsyncRequest
  | GetEffectConfigRequest
  | EvaluateLayerEffectsRequest;

type RuntimeRequestWithTimestamp = Extract<RuntimeRequest, { nowMs: number }>;

interface EvaluateSuccess {
  requestId: number;
  ok: true;
  kind: "evaluate" | "evaluatePreview";
  serialized: unknown;
  transform: WindowTransform;
  managedWindow: ManagedWindowState;
  windowEffects?: WindowEffectAssignment | null;
  dirtyNodeIds?: string[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface SchedulerTickSuccess {
  requestId: number;
  ok: true;
  kind: "schedulerTick";
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface WindowClosedSuccess {
  requestId: number;
  ok: true;
  kind: "windowClosed";
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface RuntimeWindowAction {
  windowId: string;
  action: "close" | "finalizeClose" | "maximize" | "unmaximize" | "minimize" | "focus";
}

interface InvokeHandlerSuccess {
  requestId: number;
  ok: true;
  kind: "invokeHandler";
  invoked: boolean;
  serialized?: unknown;
  transform?: WindowTransform;
  managedWindow?: ManagedWindowState;
  windowEffects?: WindowEffectAssignment | null;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface InvokeKeyBindingSuccess {
  requestId: number;
  ok: true;
  kind: "invokeKeyBinding";
  invoked: boolean;
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface WindowResizeSuccess {
  requestId: number;
  ok: true;
  kind: "windowResize";
  invoked: boolean;
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface WindowMoveSuccess {
  requestId: number;
  ok: true;
  kind: "windowMove";
  invoked: boolean;
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface WindowStateRequestSuccess {
  requestId: number;
  ok: true;
  kind: "windowMaximizeRequest" | "windowMinimizeRequest" | "windowActivateRequest";
  invoked: boolean;
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface StartCloseSuccess {
  requestId: number;
  ok: true;
  kind: "startClose";
  invoked: boolean;
  serialized?: unknown;
  transform?: WindowTransform;
  managedWindow?: ManagedWindowState;
  windowEffects?: WindowEffectAssignment | null;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface PointerMoveAsyncSuccess {
  requestId: number;
  ok: true;
  kind: "pointerMoveAsync";
  invoked: boolean;
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface GetEffectConfigSuccess {
  requestId: number;
  ok: true;
  kind: "getEffectConfig";
  backgroundEffect?: CompiledEffectHandle | null;
  displayConfig?: { outputs: DisplayConfigDraft };
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface EvaluateLayerEffectsSuccess {
  requestId: number;
  ok: true;
  kind: "evaluateLayerEffects";
  effects: RuntimeLayerEffectAssignment[];
  nextPollInMs?: number;
  displayConfig?: { outputs: DisplayConfigDraft };
  keyBindingConfig?: { entries: RuntimeKeyBindingConfigEntry[] };
  pointerConfig?: RuntimePointerConfig;
  eventConfig?: RuntimeEventConfig;
  processConfig?: { entries: RuntimeProcessConfigEntry[] };
  processActions?: RuntimeProcessSpawnAction[];
}

interface RuntimeFailure {
  requestId: number;
  ok: false;
  error: string;
  displayConfig?: { outputs: DisplayConfigDraft };
}

interface RuntimeLayerEffectAssignment {
  layerId: string;
  effect: CompiledEffectHandle | null;
}

interface RuntimeEffectConfig {
  background_effect: CompiledEffectHandle | null;
  window?: (window: ReturnType<typeof createCompositionEvaluationCache>["window"]) => WindowEffectAssignment | null;
}

interface RuntimeProcessConfigEntry {
  id: string;
  kind: "once" | "service";
  cwd?: string;
  env?: Record<string, string>;
  command?: string[];
  shell?: string;
  runPolicy?: "once-per-session" | "once-per-config-version";
  restart?: "never" | "on-failure" | "on-exit";
  reload?: "keep-if-unchanged" | "always-restart";
}

interface RuntimeProcessSpawnAction {
  cwd?: string;
  env?: Record<string, string>;
  command?: string[];
  shell?: string;
}

interface RuntimeKeyBindingConfigEntry {
  id: string;
  shortcut: string;
  on: "press" | "release";
}

interface RuntimePointerConfig {
  windowMoveModifier?: string;
}

function pendingDisplayConfigPayload():
  | { outputs: DisplayConfigDraft }
  | undefined {
  const outputs = takePendingDisplayConfig();
  return outputs ? { outputs } : undefined;
}

function pendingProcessConfigPayload():
  | { entries: RuntimeProcessConfigEntry[] }
  | undefined {
  const entries = takePendingProcessConfig() as RuntimeProcessConfigEntry[] | undefined;
  return entries ? { entries } : undefined;
}

function pendingProcessActionsPayload():
  | RuntimeProcessSpawnAction[]
  | undefined {
  const actions = drainPendingProcessActions() as RuntimeProcessSpawnAction[];
  return actions.length > 0 ? actions : undefined;
}

function pendingKeyBindingConfigPayload():
  | { entries: RuntimeKeyBindingConfigEntry[] }
  | undefined {
  const entries = takePendingKeyBindingConfig() as
    | RuntimeKeyBindingConfigEntry[]
    | undefined;
  return entries ? { entries } : undefined;
}

function pendingPointerConfigPayload(): RuntimePointerConfig | undefined {
  return takePendingPointerConfig() as RuntimePointerConfig | undefined;
}

function pendingEventConfigPayload(
  events: WindowManagerEventController,
): RuntimeEventConfig | undefined {
  return events.takePendingEventConfig();
}

const cacheByWindowId = new Map<string, RuntimeCacheEntry>();
const openedWindowIds = new Set<string>();
const initialConfiguredWindowIds = new Set<string>();
const firstCommittedWindowIds = new Set<string>();
const animationEntriesByWindowId = new Map<string, Map<symbol, unknown>>();
const cacheByLayerId = new Map<string, RuntimeLayerEntry>();
const openedLayerIds = new Set<string>();
const animationEntriesByLayerId = new Map<string, Map<symbol, unknown>>();
const polls = new Map<number, RuntimePoll>();
const dirtyWindowIds = new Set<string>();
const dirtyLayerIds = new Set<string>();
let runtimeDirty = false;
let nextPollId = 1;
let currentSchedulerTimeMs = 0;
let lastAnimationAdvanceMs: number | undefined;

const RENDER_COMPOSITION_CONTEXT: WindowCompositionContext = {
  phase: "render",
  isPreview: false,
};

const PRECONFIGURE_COMPOSITION_CONTEXT: WindowCompositionContext = {
  phase: "preconfigure",
  isPreview: true,
};

interface RuntimeCacheEntry {
  latestSnapshot: WaylandWindowSnapshot;
  cache: CompositionEvaluationCache;
  animationEntries: Map<symbol, unknown>;
  pendingActions: RuntimeWindowAction[];
  closeAnimationDurationMs: number;
  closeStarted: boolean;
  preconfigured: boolean;
  closePoll?: PollHandle;
}

interface RuntimeLayerEntry {
  latestSnapshot: WaylandLayerSnapshot;
  layer: ReturnType<typeof createReactiveLayer>["layer"];
  update(snapshot: WaylandLayerSnapshot): void;
}

interface RuntimePoll {
  intervalMs: number;
  nextRunAtMs: number;
  callback: PollCallback;
  handle: PollHandle;
  nowMs: number;
  dirtyMode: PollDirtyMode;
}

function installRuntimeConsoleBridge() {
  const original = { ...console };
  const emit = (level: "debug" | "info" | "warn" | "error", args: unknown[]) => {
    const message = format(...args);
    process.stderr.write(
      `__SHOJI_RUNTIME_LOG__${JSON.stringify({ level, message })}\n`,
    );
  };

  console.debug = (...args: unknown[]) => emit("debug", args);
  console.log = (...args: unknown[]) => emit("info", args);
  console.info = (...args: unknown[]) => emit("info", args);
  console.warn = (...args: unknown[]) => emit("warn", args);
  console.error = (...args: unknown[]) => emit("error", args);

  return original;
}

function hasRuntimeTimestamp(request: RuntimeRequest): request is RuntimeRequestWithTimestamp {
  return "nowMs" in request;
}

function beginRuntimeTurn(nowMs: number): void {
  currentSchedulerTimeMs = nowMs;
  if (lastAnimationAdvanceMs === nowMs) {
    return;
  }
  lastAnimationAdvanceMs = nowMs;
  // A runtime turn may evaluate declarations or run user handlers, both of
  // which can start animations. Synchronizing once at the turn boundary keeps
  // every newly-created timeline anchored to the compositor timestamp for this
  // request instead of the previous composition evaluation.
  advanceAnimationFrame(nowMs);
}

// --- Diagnostic counters (SHOJI_RUNTIME_STATS=1) -----------------------------
const statsEnabled = process.env.SHOJI_RUNTIME_STATS === "1";
const stats = {
  evaluate: 0,
  schedulerTick: 0,
  schedulerTickDirty: 0,
  invokeHandler: 0,
  invokeKeyBinding: 0,
  windowResize: 0,
  windowMove: 0,
  windowMaximizeRequest: 0,
  windowMinimizeRequest: 0,
  windowActivateRequest: 0,
  pointerMoveAsync: 0,
  getEffectConfig: 0,
  evaluateLayerEffects: 0,
  evaluateLayerEffectsAnim: 0,
  markWindowDirty: 0,
  markRuntimeDirty: 0,
  markLayerDirty: 0,
};
function startStatsLogger(): void {
  if (!statsEnabled) return;
  setInterval(() => {
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const snapshot = { ...stats };
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) {
      stats[key] = 0;
    }
    console.error("[stats/1s]", JSON.stringify(snapshot));
  }, 1000).unref();
}

async function main() {
  const configPath = process.argv[2];
  const socketPath = process.argv[3];
  if (!configPath) {
    throw new Error("usage: tsx tools/composition-runtime.ts <config-path> [socket-path]");
  }
  installRuntimeConsoleBridge();
  startStatsLogger();

  installSchedulerBridge({
    registerPoll(intervalMs, callback, dirtyMode) {
      return registerPoll(intervalMs, callback, dirtyMode);
    },
  });
  installRuntimeHooks({
    markRuntimeDirty() {
      if (statsEnabled) stats.markRuntimeDirty++;
      runtimeDirty = true;
    },
    markWindowDirty(windowId) {
      if (statsEnabled) stats.markWindowDirty++;
      dirtyWindowIds.add(windowId);
    },
    markLayerDirty(layerId) {
      if (statsEnabled) stats.markLayerDirty++;
      dirtyLayerIds.add(layerId);
    },
  });

  const moduleUrl = pathToFileURL(resolve(configPath)).href;
  installAssetResolverBridge(findConfigRoot(configPath));
  installProcessResolverBridge(resolve(configPath));
  beginKeyBindingRegistration();
  beginPointerConfigRegistration();
  beginProcessConfigRegistration();
  const loaded = await import(moduleUrl).finally(() => {
    commitKeyBindingRegistration();
    commitPointerConfigRegistration();
    commitProcessConfigRegistration();
  });
  const composition = resolveComposition(loaded);
  const events = resolveEvents(loaded);
  const effectConfig = resolveEffectConfig(loaded);

  const socket = socketPath ? await connectSocket(socketPath) : null;
  const input = socket ?? process.stdin;
  const output = socket ?? process.stdout;

  for await (const payload of readFramedMessages(input)) {
    let request: RuntimeRequest;
    try {
      request = JSON.parse(payload.toString("utf8")) as RuntimeRequest;
    } catch (error) {
        await writeResponse(output, {
            requestId: -1,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
        continue;
    }

    try {
      updateOutputState(request.displayState);
      if (hasRuntimeTimestamp(request)) {
        beginRuntimeTurn(request.nowMs);
      }
      if (statsEnabled) {
        switch (request.kind) {
          case "evaluate":
          case "evaluatePreview":
            stats.evaluate++;
            break;
          case "schedulerTick":
            stats.schedulerTick++;
            break;
          case "invokeHandler":
            stats.invokeHandler++;
            break;
          case "invokeKeyBinding":
            stats.invokeKeyBinding++;
            break;
          case "windowResize":
            stats.windowResize++;
            break;
          case "windowMove":
            stats.windowMove++;
            break;
          case "windowMaximizeRequest":
            stats.windowMaximizeRequest++;
            break;
          case "windowMinimizeRequest":
            stats.windowMinimizeRequest++;
            break;
          case "windowActivateRequest":
            stats.windowActivateRequest++;
            break;
          case "pointerMoveAsync":
            stats.pointerMoveAsync++;
            break;
          case "getEffectConfig":
            stats.getEffectConfig++;
            break;
          case "evaluateLayerEffects":
            stats.evaluateLayerEffects++;
            if (hasActiveAnimations()) stats.evaluateLayerEffectsAnim++;
            break;
        }
      }
      if (request.kind === "evaluate" || request.kind === "evaluatePreview") {
        const result = request.kind === "evaluate"
          ? evaluateSnapshot(composition, events, effectConfig, request.snapshot, request.nowMs)
          : evaluatePreconfigure(composition, events, effectConfig, request.snapshot);
        const keyBindingConfig = pendingKeyBindingConfigPayload();
        const pointerConfig = pendingPointerConfigPayload();
        const eventConfig = pendingEventConfigPayload(events);
        const processConfig = pendingProcessConfigPayload();
        const processActions = pendingProcessActionsPayload();
        const cached = request.kind === "evaluate"
          ? cacheByWindowId.get(request.snapshot.id)?.cache
          : undefined;
        await writeResponse(output, {
          requestId: request.requestId,
          ok: true,
          kind: request.kind,
          serialized: result.serialized,
          transform: cached?.lastTransform ?? result.transform ?? identityTransform(),
          managedWindow: cached?.lastManagedWindow ?? result.managedWindow ?? identityManagedWindow(),
          windowEffects: result.windowEffects,
          dirtyNodeIds: request.kind === "evaluate"
            ? takeDirtyWindowNodeIds(request.snapshot.id)
            : [],
          nextPollInMs: request.kind === "evaluate"
            ? hasActiveAnimations() ? 0 : peekNextPollDelay()
            : undefined,
          displayConfig: pendingDisplayConfigPayload(),
          keyBindingConfig,
          pointerConfig,
          eventConfig,
          processConfig,
          processActions,
        });
      } else {
        if (request.kind === "schedulerTick") {
          const tick = processSchedulerTick(request.nowMs);
          if (statsEnabled && tick.dirty) stats.schedulerTickDirty++;
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const eventConfig = pendingEventConfigPayload(events);
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "schedulerTick",
            dirty: tick.dirty,
            dirtyWindowIds: tick.dirtyWindowIds,
            dirtyWindowNodeIds: tick.dirtyWindowNodeIds,
            dirtyLayerNodeIds: tick.dirtyLayerNodeIds,
            actions: tick.actions,
            nextPollInMs: hasActiveAnimations() ? 0 : tick.nextPollInMs,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            eventConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "windowClosed") {
          closeWindow(events, request.windowId);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "windowClosed",
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "startClose") {
          const result = startClose(events, effectConfig, request.windowId);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "startClose",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "evaluateCached") {
          const result = evaluateCached(effectConfig, request.windowId);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "evaluateCached",
            serialized: result.serialized,
            transform: result.transform,
            managedWindow: result.managedWindow,
            windowEffects: result.windowEffects,
            dirtyNodeIds: result.dirtyNodeIds,
            nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "getEffectConfig") {
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "getEffectConfig",
            backgroundEffect: effectConfig.background_effect,
            displayConfig: pendingDisplayConfigPayload(),
          });
        } else if (request.kind === "evaluateLayerEffects") {
          const result = evaluateLayerEffects(events, request.outputName, request.layers);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "evaluateLayerEffects",
            effects: result.effects,
            nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "invokeKeyBinding") {
          const result = invokeGlobalKeyBinding(request.bindingId);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "invokeKeyBinding",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "windowResize") {
          const result = invokeWindowResize(events, request.windowId, request.event);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "windowResize",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "windowMove") {
          const result = invokeWindowMove(events, request.windowId, request.event);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const eventConfig = pendingEventConfigPayload(events);
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "windowMove",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            eventConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "windowMaximizeRequest") {
          const result = invokeWindowMaximizeRequest(
            composition,
            events,
            request.windowId,
            request.snapshot,
            request.event,
          );
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const eventConfig = pendingEventConfigPayload(events);
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "windowMaximizeRequest",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            eventConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "windowMinimizeRequest") {
          const result = invokeWindowMinimizeRequest(
            composition,
            events,
            request.windowId,
            request.snapshot,
            request.event,
          );
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const eventConfig = pendingEventConfigPayload(events);
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "windowMinimizeRequest",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            eventConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "windowActivateRequest") {
          const result = invokeWindowActivateRequest(
            composition,
            events,
            request.windowId,
            request.snapshot,
            request.event,
          );
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const eventConfig = pendingEventConfigPayload(events);
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "windowActivateRequest",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            eventConfig,
            processConfig,
            processActions,
          });
        } else if (request.kind === "pointerMoveAsync") {
          const result = await invokePointerMoveAsync(events, request.event);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const eventConfig = pendingEventConfigPayload(events);
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "pointerMoveAsync",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            eventConfig,
            processConfig,
            processActions,
          });
        } else {
          const result = invokeHandler(effectConfig, request.windowId, request.handlerId);
          const keyBindingConfig = pendingKeyBindingConfigPayload();
          const pointerConfig = pendingPointerConfigPayload();
          const processConfig = pendingProcessConfigPayload();
          const processActions = pendingProcessActionsPayload();
          await writeResponse(output, {
            requestId: request.requestId,
            ok: true,
            kind: "invokeHandler",
            ...result,
            displayConfig: pendingDisplayConfigPayload(),
            keyBindingConfig,
            pointerConfig,
            processConfig,
            processActions,
          });
        }
      }
    } catch (error) {
      await writeResponse(output, {
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        displayConfig: pendingDisplayConfigPayload(),
      });
    }
  }
}

function evaluateCached(
  effectConfig: RuntimeEffectConfig,
  windowId: string,
): {
  serialized: unknown;
  transform: WindowTransform;
  managedWindow: ManagedWindowState;
  windowEffects: WindowEffectAssignment | null;
  dirtyNodeIds?: string[];
  nextPollInMs?: number;
} {
  const entry = cacheByWindowId.get(windowId);
  if (!entry) {
    throw new Error(`missing cache entry for closing window ${windowId}`);
  }

  const dirtyNodeIds = takeDirtyWindowNodeIds(windowId);
  const reevaluated = entry.cache.reevaluate(dirtyNodeIds);
  return {
    serialized: reevaluated.serialized,
    transform: entry.cache.lastTransform,
    managedWindow: entry.cache.lastManagedWindow,
    windowEffects: evaluateWindowEffects(effectConfig, windowId, entry),
    dirtyNodeIds,
    nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
  };
}

function evaluateSnapshot(
  composition: WindowCompositionFunction,
  events: WindowManagerEventController,
  effectConfig: RuntimeEffectConfig,
  snapshot: WaylandWindowSnapshot,
  nowMs: number,
): {
  serialized: unknown;
  transform?: WindowTransform;
  managedWindow?: ManagedWindowState;
  windowEffects: WindowEffectAssignment | null;
} {
  const existing = cacheByWindowId.get(snapshot.id);
  if (!existing) {
    const entry = createRuntimeCacheEntry(snapshot, composition, RENDER_COMPOSITION_CONTEXT);
    cacheByWindowId.set(snapshot.id, entry);
    if (!openedWindowIds.has(snapshot.id)) {
      openedWindowIds.add(snapshot.id);
      events.emitOpen(entry.cache.window);
    }
    events.emitFocus(entry.cache.window, snapshot.isFocused);
    if (!firstCommittedWindowIds.has(snapshot.id)) {
      firstCommittedWindowIds.add(snapshot.id);
      events.emitFirstCommit(entry.cache.window);
    }
    dirtyWindowIds.delete(snapshot.id);
    return {
      serialized: entry.cache.reevaluate(takeDirtyWindowNodeIds(snapshot.id)).serialized,
      windowEffects: evaluateWindowEffects(effectConfig, snapshot.id, entry),
    };
  }

  const wasPreconfigured = existing.preconfigured;
  if (wasPreconfigured) {
    existing.preconfigured = false;
    reanchorAnimationEntries(existing.animationEntries, nowMs);
    dirtyWindowIds.add(snapshot.id);
  }
  existing.cache.setContext(RENDER_COMPOSITION_CONTEXT);

  const focusChanged = existing.latestSnapshot.isFocused !== snapshot.isFocused;
  existing.latestSnapshot = snapshot;
  const updated = existing.cache.update(snapshot);
  if (focusChanged) {
    events.emitFocus(existing.cache.window, snapshot.isFocused);
  }
  if (!firstCommittedWindowIds.has(snapshot.id)) {
    firstCommittedWindowIds.add(snapshot.id);
    events.emitFirstCommit(existing.cache.window);
    dirtyWindowIds.add(snapshot.id);
  }

  const wasDirty = dirtyWindowIds.delete(snapshot.id);
  if (wasDirty) {
    const dirtyNodeIds = takeDirtyWindowNodeIds(snapshot.id);
    return {
      serialized: existing.cache.reevaluate(dirtyNodeIds).serialized,
      windowEffects: evaluateWindowEffects(effectConfig, snapshot.id, existing),
    };
  }

  return {
    serialized: updated?.serialized ?? existing.cache.lastSerialized,
    windowEffects: evaluateWindowEffects(effectConfig, snapshot.id, existing),
  };
}

function evaluatePreconfigure(
  composition: WindowCompositionFunction,
  events: WindowManagerEventController,
  effectConfig: RuntimeEffectConfig,
  snapshot: WaylandWindowSnapshot,
): {
  serialized: unknown;
  transform: WindowTransform;
  managedWindow: ManagedWindowState;
  windowEffects: WindowEffectAssignment | null;
} {
  // Preconfigure evaluation is used before the client has committed its first real frame so
  // Rust can send an initial configure matching <ManagedWindow rect>. It intentionally goes
  // through the normal cache/onOpen path so user window state initialized in onOpen is visible
  // to the layout. The first real evaluate reanchors any animations started here to its own
  // compositor timestamp, preventing open animations from appearing halfway through.
  let entry = cacheByWindowId.get(snapshot.id);
  if (!entry) {
    entry = createRuntimeCacheEntry(snapshot, composition, PRECONFIGURE_COMPOSITION_CONTEXT);
    cacheByWindowId.set(snapshot.id, entry);
    if (!openedWindowIds.has(snapshot.id)) {
      openedWindowIds.add(snapshot.id);
      events.emitOpen(entry.cache.window);
    }
    if (!initialConfiguredWindowIds.has(snapshot.id)) {
      initialConfiguredWindowIds.add(snapshot.id);
      events.emitInitialConfigure(entry.cache.window);
    }
    events.emitFocus(entry.cache.window, snapshot.isFocused);
    entry.cache.reevaluate(takeDirtyWindowNodeIds(snapshot.id));
  } else {
    entry.cache.setContext(PRECONFIGURE_COMPOSITION_CONTEXT);
    const focusChanged = entry.latestSnapshot.isFocused !== snapshot.isFocused;
    entry.latestSnapshot = snapshot;
    entry.cache.update(snapshot);
    if (focusChanged) {
      events.emitFocus(entry.cache.window, snapshot.isFocused);
    }
    if (!initialConfiguredWindowIds.has(snapshot.id)) {
      initialConfiguredWindowIds.add(snapshot.id);
      events.emitInitialConfigure(entry.cache.window);
    }
    entry.cache.reevaluate(takeDirtyWindowNodeIds(snapshot.id));
  }

  entry.preconfigured = true;
  return {
    serialized: entry.cache.lastSerialized,
    transform: entry.cache.lastTransform,
    managedWindow: entry.cache.lastManagedWindow,
    windowEffects: evaluateWindowEffects(effectConfig, snapshot.id, entry),
  };
}

function evaluateWindowEffects(
  effectConfig: RuntimeEffectConfig,
  windowId: string,
  entry: RuntimeCacheEntry,
): WindowEffectAssignment | null {
  const evaluate = effectConfig.window;
  if (!evaluate) {
    return null;
  }

  enterWindowDependencyScope(windowId);
  try {
    return resolveSignals(evaluate(entry.cache.window)) as WindowEffectAssignment | null;
  } finally {
    leaveWindowDependencyScope();
  }
}

function reanchorAnimationEntries(entries: Map<symbol, unknown>, nowMs: number): void {
  for (const rawEntry of entries.values()) {
    const entry = rawEntry as {
      progress?: { value: number };
      timeline?: { startedAtMs: number; from: number };
    };
    if (!entry.timeline || !entry.progress) {
      continue;
    }
    entry.timeline.startedAtMs = nowMs;
    entry.progress.value = entry.timeline.from;
  }
}

function createRuntimeCacheEntry(
  snapshot: WaylandWindowSnapshot,
  composition: WindowCompositionFunction,
  context: WindowCompositionContext = RENDER_COMPOSITION_CONTEXT,
): RuntimeCacheEntry {
  let latestSnapshot = snapshot;
  const actions: WaylandWindowActions = {
    close() {
      entry.pendingActions.push({ windowId: latestSnapshot.id, action: "close" });
    },
    maximize() {
      entry.pendingActions.push({ windowId: latestSnapshot.id, action: "maximize" });
    },
    unmaximize() {
      entry.pendingActions.push({ windowId: latestSnapshot.id, action: "unmaximize" });
    },
    minimize() {
      entry.pendingActions.push({ windowId: latestSnapshot.id, action: "minimize" });
    },
    focus() {
      entry.pendingActions.push({ windowId: latestSnapshot.id, action: "focus" });
    },
    setCloseAnimationDuration(durationMs) {
      entry.closeAnimationDurationMs = Math.max(0, Math.floor(durationMs));
    },
    isXWayland() {
      return latestSnapshot.isXwayland;
    },
  };

  const animationEntries =
    animationEntriesByWindowId.get(snapshot.id) ?? new Map();
  animationEntriesByWindowId.set(snapshot.id, animationEntries);
  const animation = createWindowAnimationControllerWithStore(
    snapshot.id,
    animationEntries as Map<symbol, never>,
  );
  const cache = createCompositionEvaluationCache(snapshot, actions, composition, animation, context);
  const entry: RuntimeCacheEntry = {
    latestSnapshot,
    cache,
    animationEntries,
    pendingActions: [],
    closeAnimationDurationMs: 0,
    closeStarted: false,
    preconfigured: false,
  };
  return entry;
}

function ensureRuntimeCacheEntry(
  composition: WindowCompositionFunction,
  events: WindowManagerEventController,
  snapshot: WaylandWindowSnapshot,
): RuntimeCacheEntry {
  let entry = cacheByWindowId.get(snapshot.id);
  if (!entry) {
    entry = createRuntimeCacheEntry(snapshot, composition, RENDER_COMPOSITION_CONTEXT);
    cacheByWindowId.set(snapshot.id, entry);
    if (!openedWindowIds.has(snapshot.id)) {
      openedWindowIds.add(snapshot.id);
      events.emitOpen(entry.cache.window);
    }
    events.emitFocus(entry.cache.window, snapshot.isFocused);
    dirtyWindowIds.delete(snapshot.id);
    return entry;
  }

  // Window state requests can arrive before the first real client commit. For example Discord
  // sends unmaximize / activation requests while restoring from the tray. These requests must not
  // consume the first-commit lifecycle or switch a preconfigure cache into render mode; otherwise
  // config code that initializes rects in onFirstCommit observes the tiny pre-commit geometry and
  // never gets a chance to replace it with the natural first-buffer size.
  const focusChanged = entry.latestSnapshot.isFocused !== snapshot.isFocused;
  entry.latestSnapshot = snapshot;
  entry.cache.update(snapshot);
  if (focusChanged) {
    events.emitFocus(entry.cache.window, snapshot.isFocused);
  }
  return entry;
}

function createRuntimeLayerEntry(
  snapshot: WaylandLayerSnapshot,
): RuntimeLayerEntry {
  const animationEntries =
    animationEntriesByLayerId.get(snapshot.id) ?? new Map();
  animationEntriesByLayerId.set(snapshot.id, animationEntries);
  const handle = createReactiveLayer(
    snapshot,
    createWindowAnimationControllerWithStore(
      snapshot.id,
      animationEntries as Map<symbol, never>,
    ),
  );
  return {
    latestSnapshot: snapshot,
    layer: handle.layer,
    update(nextSnapshot) {
      this.latestSnapshot = nextSnapshot;
      handle.update(nextSnapshot);
    },
  };
}

function evaluateLayerEffects(
  events: WindowManagerEventController,
  outputName: string,
  snapshots: WaylandLayerSnapshot[],
): {
  effects: RuntimeLayerEffectAssignment[];
  nextPollInMs?: number;
} {
  syncLayerSnapshots(events, snapshots);

  const effects: RuntimeLayerEffectAssignment[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.outputName !== outputName) {
      continue;
    }
    const entry = cacheByLayerId.get(snapshot.id);
    if (!entry) {
      continue;
    }
    effects.push({
      layerId: snapshot.id,
      effect: snapshotLayerEffect(entry.layer),
    });
  }

  return {
    effects,
    nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
  };
}

function syncLayerSnapshots(
  events: WindowManagerEventController,
  snapshots: WaylandLayerSnapshot[],
): void {
  updateLayerSnapshots(snapshots);
  const nextIds = new Set(snapshots.map((snapshot) => snapshot.id));

  for (const snapshot of snapshots) {
    const existing = cacheByLayerId.get(snapshot.id);
    if (!existing) {
      const entry = createRuntimeLayerEntry(snapshot);
      cacheByLayerId.set(snapshot.id, entry);
      if (!openedLayerIds.has(snapshot.id)) {
        openedLayerIds.add(snapshot.id);
        events.emitCreateLayer(entry.layer);
      }
      continue;
    }
    existing.update(snapshot);
  }

  for (const [layerId, existing] of cacheByLayerId) {
    if (nextIds.has(layerId)) {
      continue;
    }
    events.emitDestroyLayer(existing.layer);
    cacheByLayerId.delete(layerId);
    openedLayerIds.delete(layerId);
    animationEntriesByLayerId.delete(layerId);
    dirtyLayerIds.delete(layerId);
    dropLayerDependencies(layerId);
  }
}

function snapshotLayerEffect(layer: WaylandLayer): CompiledEffectHandle | null {
  enterLayerDependencyScope(layer.id);
  try {
    if (layer.effect == null) {
      return null;
    }
    return resolveSignals(layer.effect) as CompiledEffectHandle;
  } finally {
    leaveLayerDependencyScope();
  }
}

function resolveSignals<T>(value: T): T {
  if (isSignal(value)) {
    return read(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSignals(item)) as T;
  }
  if (value && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveSignals(entry);
    }
    return resolved as T;
  }
  return value;
}

function identityTransform(): WindowTransform {
  return {
    origin: { x: 0.5, y: 0.5 },
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
  };
}

function identityManagedWindow(): ManagedWindowState {
  return {
    managed: false,
    visible: true,
    idle: false,
    interactive: true,
    forceRectSize: false,
    zIndex: 0,
    transform: identityTransform(),
  };
}

function registerPoll(
  intervalMs: number,
  callback: PollCallback,
  dirtyMode: PollDirtyMode,
): PollHandle {
  const pollId = nextPollId++;
  const normalizedIntervalMs = Math.max(1, Math.floor(intervalMs));
  let cancelled = false;

  const handle: PollHandle = {
    cancel() {
      cancelled = true;
      polls.delete(pollId);
    },
    get cancelled() {
      return cancelled;
    },
    get nowMs() {
      return currentSchedulerTimeMs;
    },
  };

  polls.set(pollId, {
    intervalMs: normalizedIntervalMs,
    nextRunAtMs: currentSchedulerTimeMs + normalizedIntervalMs,
    callback,
    handle,
    nowMs: currentSchedulerTimeMs,
    dirtyMode,
  });

  return handle;
}

function processSchedulerTick(nowMs: number): {
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
} {
  for (const [pollId, poll] of polls) {
    if (poll.handle.cancelled) {
      polls.delete(pollId);
      continue;
    }

    if (poll.nextRunAtMs > nowMs) {
      continue;
    }

    poll.nowMs = nowMs;
    poll.nextRunAtMs = nowMs + poll.intervalMs;
    poll.callback(poll.handle);
    if (poll.dirtyMode === "runtime") {
      runtimeDirty = true;
    }

    if (poll.handle.cancelled) {
      polls.delete(pollId);
    }
  }

  return collectRuntimeMutationState();
}

function collectRuntimeMutationState(): {
  dirty: boolean;
  dirtyWindowIds: string[];
  dirtyWindowNodeIds?: Record<string, string[]>;
  dirtyLayerNodeIds?: Record<string, string[]>;
  actions: RuntimeWindowAction[];
  nextPollInMs?: number;
} {
  let nextPollInMs: number | undefined;
  for (const poll of polls.values()) {
    if (poll.handle.cancelled) {
      continue;
    }
    const delay = Math.max(1, poll.nextRunAtMs - currentSchedulerTimeMs);
    nextPollInMs =
      nextPollInMs === undefined ? delay : Math.min(nextPollInMs, delay);
  }

  const nextDirtyWindowIds = Array.from(dirtyWindowIds);
  dirtyWindowIds.clear();
  const nextDirtyLayerIds = Array.from(dirtyLayerIds);
  dirtyLayerIds.clear();
  const dirtyWindowNodeIds = Object.fromEntries(
    nextDirtyWindowIds
      .map((windowId) => [windowId, takeDirtyWindowNodeIds(windowId)] as const)
      .filter(([, nodeIds]) => nodeIds.length > 0),
  );
  const dirtyLayerNodeIds = Object.fromEntries(
    nextDirtyLayerIds
      .map((layerId) => [layerId, takeDirtyLayerNodeIds(layerId)] as const)
      .filter(([, nodeIds]) => nodeIds.length > 0),
  );
  const actions = drainPendingActions();
  const dirty = runtimeDirty || nextDirtyWindowIds.length > 0 || nextDirtyLayerIds.length > 0;
  runtimeDirty = false;

  return {
    dirty,
    dirtyWindowIds: nextDirtyWindowIds,
    dirtyWindowNodeIds:
      Object.keys(dirtyWindowNodeIds).length > 0 ? dirtyWindowNodeIds : undefined,
    dirtyLayerNodeIds:
      Object.keys(dirtyLayerNodeIds).length > 0 ? dirtyLayerNodeIds : undefined,
    actions,
    nextPollInMs,
  };
}

function invokeGlobalKeyBinding(
  bindingId: string,
): Omit<InvokeKeyBindingSuccess, "requestId" | "ok" | "kind"> {
  const invoked = invokeKeyBinding(bindingId);
  if (!invoked) {
    return {
      invoked: false,
      dirty: false,
      dirtyWindowIds: [],
      actions: [],
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const result = collectRuntimeMutationState();
  return {
    invoked: true,
    dirty: result.dirty,
    dirtyWindowIds: result.dirtyWindowIds,
    dirtyWindowNodeIds: result.dirtyWindowNodeIds,
    dirtyLayerNodeIds: result.dirtyLayerNodeIds,
    actions: result.actions,
    nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
  };
}

function invokeWindowResize(
  events: WindowManagerEventController,
  windowId: string,
  event: RuntimeWindowResizeEvent,
): Omit<WindowResizeSuccess, "requestId" | "ok" | "kind"> {
  const entry = cacheByWindowId.get(windowId);
  if (!entry) {
    return {
      invoked: false,
      dirty: false,
      dirtyWindowIds: [],
      actions: [],
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const invoked = events.emitWindowResize(entry.cache.window, event);
  if (!invoked) {
    return {
      invoked: false,
      dirty: false,
      dirtyWindowIds: [],
      actions: [],
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const result = collectRuntimeMutationState();
  return {
    invoked: true,
    dirty: result.dirty,
    dirtyWindowIds: result.dirtyWindowIds,
    dirtyWindowNodeIds: result.dirtyWindowNodeIds,
    dirtyLayerNodeIds: result.dirtyLayerNodeIds,
    actions: result.actions,
    nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
  };
}

function invokeWindowMove(
  events: WindowManagerEventController,
  windowId: string,
  event: RuntimeWindowMoveEvent,
): Omit<WindowMoveSuccess, "requestId" | "ok" | "kind"> {
  const entry = cacheByWindowId.get(windowId);
  if (!entry) {
    return {
      invoked: false,
      dirty: false,
      dirtyWindowIds: [],
      actions: [],
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const invoked = events.emitWindowMove(entry.cache.window, event);
  if (!invoked) {
    return {
      invoked: false,
      dirty: false,
      dirtyWindowIds: [],
      actions: [],
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const result = collectRuntimeMutationState();
  return {
    invoked: true,
    dirty: result.dirty,
    dirtyWindowIds: result.dirtyWindowIds,
    dirtyWindowNodeIds: result.dirtyWindowNodeIds,
    dirtyLayerNodeIds: result.dirtyLayerNodeIds,
    actions: result.actions,
    nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
  };
}

function invokeWindowMaximizeRequest(
  composition: WindowCompositionFunction,
  events: WindowManagerEventController,
  windowId: string,
  snapshot: WaylandWindowSnapshot,
  event: RuntimeWindowMaximizeRequestEvent,
): Omit<WindowStateRequestSuccess, "requestId" | "ok" | "kind"> {
  if (snapshot.id !== windowId) {
    return emptyWindowStateRequestResult();
  }
  const entry = ensureRuntimeCacheEntry(composition, events, snapshot);

  const invoked = events.emitWindowMaximizeRequest(entry.cache.window, event);
  if (!invoked) {
    return emptyWindowStateRequestResult();
  }

  const result = collectRuntimeMutationState();
  return {
    invoked: true,
    dirty: result.dirty,
    dirtyWindowIds: result.dirtyWindowIds,
    dirtyWindowNodeIds: result.dirtyWindowNodeIds,
    dirtyLayerNodeIds: result.dirtyLayerNodeIds,
    actions: result.actions,
    nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
  };
}

function invokeWindowMinimizeRequest(
  composition: WindowCompositionFunction,
  events: WindowManagerEventController,
  windowId: string,
  snapshot: WaylandWindowSnapshot,
  event: RuntimeWindowMinimizeRequestEvent,
): Omit<WindowStateRequestSuccess, "requestId" | "ok" | "kind"> {
  if (snapshot.id !== windowId) {
    return emptyWindowStateRequestResult();
  }
  const entry = ensureRuntimeCacheEntry(composition, events, snapshot);

  const invoked = events.emitWindowMinimizeRequest(entry.cache.window, event);
  if (!invoked) {
    return emptyWindowStateRequestResult();
  }

  const result = collectRuntimeMutationState();
  return {
    invoked: true,
    dirty: result.dirty,
    dirtyWindowIds: result.dirtyWindowIds,
    dirtyWindowNodeIds: result.dirtyWindowNodeIds,
    dirtyLayerNodeIds: result.dirtyLayerNodeIds,
    actions: result.actions,
    nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
  };
}

function invokeWindowActivateRequest(
  composition: WindowCompositionFunction,
  events: WindowManagerEventController,
  windowId: string,
  snapshot: WaylandWindowSnapshot,
  event: RuntimeWindowActivateRequestEvent,
): Omit<WindowStateRequestSuccess, "requestId" | "ok" | "kind"> {
  if (snapshot.id !== windowId) {
    return emptyWindowStateRequestResult();
  }
  const entry = ensureRuntimeCacheEntry(composition, events, snapshot);

  const invoked = events.emitWindowActivateRequest(entry.cache.window, event);
  if (!invoked) {
    return emptyWindowStateRequestResult();
  }

  const result = collectRuntimeMutationState();
  return {
    invoked: true,
    dirty: result.dirty,
    dirtyWindowIds: result.dirtyWindowIds,
    dirtyWindowNodeIds: result.dirtyWindowNodeIds,
    dirtyLayerNodeIds: result.dirtyLayerNodeIds,
    actions: result.actions,
    nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
  };
}

function emptyWindowStateRequestResult():
  Omit<WindowStateRequestSuccess, "requestId" | "ok" | "kind"> {
  return {
    invoked: false,
    dirty: false,
    dirtyWindowIds: [],
    actions: [],
    nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
  };
}

async function invokePointerMoveAsync(
  events: WindowManagerEventController,
  event: PointerMoveEvent,
): Promise<Omit<PointerMoveAsyncSuccess, "requestId" | "ok" | "kind">> {
  const invoked = await events.emitPointerMoveAsync(event);
  if (!invoked) {
    return {
      invoked: false,
      dirty: false,
      dirtyWindowIds: [],
      actions: [],
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const result = collectRuntimeMutationState();
  return {
    invoked: true,
    dirty: result.dirty,
    dirtyWindowIds: result.dirtyWindowIds,
    dirtyWindowNodeIds: result.dirtyWindowNodeIds,
    dirtyLayerNodeIds: result.dirtyLayerNodeIds,
    actions: result.actions,
    nextPollInMs: hasActiveAnimations() ? 0 : result.nextPollInMs,
  };
}

function closeWindow(events: WindowManagerEventController, windowId: string): void {
  const existing = cacheByWindowId.get(windowId);
  if (!existing) {
    return;
  }

  existing.closePoll?.cancel();
  events.emitClose(existing.cache.window);
  cacheByWindowId.delete(windowId);
  openedWindowIds.delete(windowId);
  initialConfiguredWindowIds.delete(windowId);
  firstCommittedWindowIds.delete(windowId);
  animationEntriesByWindowId.delete(windowId);
  dirtyWindowIds.delete(windowId);
  dropWindowDependencies(windowId);
  dropWindowState(windowId);
}

function startClose(
  events: WindowManagerEventController,
  effectConfig: RuntimeEffectConfig,
  windowId: string,
): Omit<StartCloseSuccess, "requestId" | "ok" | "kind"> {
  const entry = cacheByWindowId.get(windowId);
  if (!entry) {
    return {
      invoked: false,
      dirtyWindowIds: [],
      actions: [],
      windowEffects: null,
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  if (!entry.closeStarted) {
    entry.closeStarted = true;
    events.emitStartClose(entry.cache.window);

    const durationMs = entry.closeAnimationDurationMs;
    if (durationMs <= 0) {
      entry.pendingActions.push({ windowId, action: "finalizeClose" });
    } else {
      entry.closePoll?.cancel();
      entry.closePoll = createManagedPoll(
        durationMs,
        (handle) => {
          const current = cacheByWindowId.get(windowId);
          if (!current || !current.closeStarted) {
            handle.cancel();
            return;
          }
          current.pendingActions.push({ windowId, action: "finalizeClose" });
          dirtyWindowIds.add(windowId);
          handle.cancel();
          current.closePoll = undefined;
        },
        "none",
      );
    }
  }

  const dirtyNodeIds = takeDirtyWindowNodeIds(windowId);
  const reevaluated = entry.cache.reevaluate(dirtyNodeIds);
  const actions = entry.pendingActions.splice(0, entry.pendingActions.length);
  return {
    invoked: true,
    serialized: reevaluated.serialized,
    transform: entry.cache.lastTransform,
    managedWindow: entry.cache.lastManagedWindow,
    windowEffects: evaluateWindowEffects(effectConfig, windowId, entry),
    dirtyWindowIds: [windowId],
    dirtyWindowNodeIds: { [windowId]: dirtyNodeIds },
    actions,
    nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
  };
}

function invokeHandler(
  effectConfig: RuntimeEffectConfig,
  windowId: string,
  handlerId: string,
): Omit<InvokeHandlerSuccess, "requestId" | "ok" | "kind"> {
  const entry = cacheByWindowId.get(windowId);
  if (!entry) {
    return {
      invoked: false,
      dirtyWindowIds: [],
      actions: [],
      windowEffects: null,
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const invoked = entry.cache.invokeHandler(handlerId);
  if (!invoked) {
    return {
      invoked: false,
      dirtyWindowIds: [],
      actions: [],
      windowEffects: evaluateWindowEffects(effectConfig, windowId, entry),
      nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
    };
  }

  const dirtyNodeIds = takeDirtyWindowNodeIds(windowId);
  const reevaluated = entry.cache.reevaluate(dirtyNodeIds);
  const actions = entry.pendingActions.splice(0, entry.pendingActions.length);
  if (process.env.SHOJI_SSD_HANDLER_DEBUG) {
    console.debug(
      "runtime handler composition result",
      JSON.stringify({
        windowId,
        handlerId,
        dirtyNodeIds,
        nodeCount: countSerializedNodes(reevaluated.serialized),
        topLevel: summarizeSerializedChildren(reevaluated.serialized),
      }),
    );
  }

  return {
    invoked: true,
    serialized: reevaluated.serialized,
    transform: entry.cache.lastTransform,
    managedWindow: entry.cache.lastManagedWindow,
    windowEffects: evaluateWindowEffects(effectConfig, windowId, entry),
    dirtyWindowIds: [windowId],
    dirtyWindowNodeIds: { [windowId]: dirtyNodeIds },
    actions,
    nextPollInMs: hasActiveAnimations() ? 0 : peekNextPollDelay(),
  };
}

function countSerializedNodes(node: unknown): number {
  if (!node || typeof node !== "object") {
    return 0;
  }
  const record = node as { children?: unknown[] };
  return 1 + (record.children ?? []).reduce((sum, child) => sum + countSerializedNodes(child), 0);
}

function summarizeSerializedChildren(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return null;
  }
  const record = node as { kind?: string; nodeId?: string; children?: unknown[] };
  return {
    kind: record.kind,
    nodeId: record.nodeId,
    childCount: record.children?.length ?? 0,
    children: (record.children ?? []).map((child) => {
      if (!child || typeof child !== "object") {
        return { primitive: typeof child };
      }
      const childRecord = child as { kind?: string; nodeId?: string; children?: unknown[] };
      return {
        kind: childRecord.kind,
        nodeId: childRecord.nodeId,
        childCount: childRecord.children?.length ?? 0,
      };
    }),
  };
}

function peekNextPollDelay(): number | undefined {
  let nextPollInMs: number | undefined;
  for (const poll of polls.values()) {
    if (poll.handle.cancelled) {
      continue;
    }
    const delay = Math.max(1, poll.nextRunAtMs - currentSchedulerTimeMs);
    nextPollInMs =
      nextPollInMs === undefined ? delay : Math.min(nextPollInMs, delay);
  }
  return nextPollInMs;
}

function drainPendingActions(): RuntimeWindowAction[] {
  const actions: RuntimeWindowAction[] = [];
  for (const entry of cacheByWindowId.values()) {
    if (entry.pendingActions.length === 0) {
      continue;
    }
    actions.push(...entry.pendingActions.splice(0, entry.pendingActions.length));
  }
  return actions;
}

function resolveComposition(
  loaded: Record<string, unknown>,
): WindowCompositionFunction {
  type WindowSlot = { composition?: WindowCompositionFunction | null };
  type WmSlot = { window?: WindowSlot };
  const maybeComposition =
    WINDOW_MANAGER.window.composition ??
    (loaded.default as WmSlot | undefined)?.window?.composition ??
    (loaded.composition as WindowCompositionFunction | undefined);

  if (!maybeComposition) {
    throw new Error(
      "config did not assign WINDOW_MANAGER.window.composition",
    );
  }

  return maybeComposition;
}

function resolveEvents(
  loaded: Record<string, unknown>,
): WindowManagerEventController {
  const maybeEvents =
    WINDOW_MANAGER.event ??
    (loaded.default as { event?: WindowManagerEventController } | undefined)?.event;

  if (!maybeEvents) {
    throw new Error(
      "config did not initialize WINDOW_MANAGER.event",
    );
  }

  return maybeEvents;
}

function resolveEffectConfig(loaded: Record<string, unknown>): RuntimeEffectConfig {
  const maybeEffect =
    WINDOW_MANAGER.effect ??
    (loaded.default as { effect?: {
      background_effect?: CompiledEffectHandle | null;
      window?: RuntimeEffectConfig["window"];
    } } | undefined)?.effect;

  return {
    background_effect: maybeEffect?.background_effect ?? null,
    window: maybeEffect?.window,
  };
}

async function connectSocket(socketPath: string): Promise<Socket> {
  return await new Promise((resolveSocket, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolveSocket(socket));
    socket.once("error", reject);
  });
}

function writeResponse(
  output: NodeJS.WritableStream,
  response:
    | EvaluateSuccess
    | SchedulerTickSuccess
    | WindowClosedSuccess
    | StartCloseSuccess
    | InvokeHandlerSuccess
    | InvokeKeyBindingSuccess
    | WindowResizeSuccess
    | WindowMoveSuccess
    | WindowStateRequestSuccess
    | PointerMoveAsyncSuccess
    | GetEffectConfigSuccess
    | EvaluateLayerEffectsSuccess
    | RuntimeFailure,
) : Promise<void> {
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  if (payload.length > 0xffff_ffff) {
    throw new Error("runtime response too large");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);

  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (error: Error) => {
      cleanup();
      rejectWrite(error);
    };
    const cleanup = () => {
      output.off("error", onError);
    };

    output.on("error", onError);
    output.write(header);
    output.write(payload, (error) => {
      cleanup();
      if (error) {
        rejectWrite(error);
      } else {
        resolveWrite();
      }
    });
  });
}

async function* readFramedMessages(
  input: NodeJS.ReadableStream,
): AsyncGenerator<Buffer> {
  let buffered = Buffer.alloc(0);

  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffered = Buffer.concat([buffered, bytes]);

    while (buffered.length >= 4) {
      const frameLength = buffered.readUInt32LE(0);
      if (buffered.length < 4 + frameLength) {
        break;
      }

      yield buffered.subarray(4, 4 + frameLength);
      buffered = buffered.subarray(4 + frameLength);
    }
  }

  if (buffered.length !== 0) {
    throw new Error("incomplete framed runtime message at EOF");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
