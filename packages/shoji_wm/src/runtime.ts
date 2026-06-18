import type {
  ComponentProps,
  CompositionChild,
  CompositionRenderable,
  CompositionElementNode,
  CompositionNodeType,
} from "./types";
import { computed, signal, type ReadonlySignal, type SignalTuple } from "./signals";
import { withoutCompositionOwnership } from "./runtime-hooks";

interface ComponentStateStore {
  instances: Map<string, ComponentInstanceState>;
}

interface ComponentInstanceState {
  hooks: unknown[];
}

interface RenderRootContext {
  rootId: string;
  store: ComponentStateStore;
  seenInstances: Set<string>;
  pendingLayoutEffects: Array<() => void>;
  pendingEffects: Array<() => void>;
}

interface ComponentRenderFrame {
  instanceId: string;
  childCursor: number;
  hookCursor: number;
}

let activeRenderRoot: RenderRootContext | null = null;
const renderFrames: ComponentRenderFrame[] = [];

interface ComputedHookSlot<T> {
  kind: "computed";
  signal: ReadonlySignal<T>;
  computeRef: { current: () => T };
}

interface EffectHookSlot {
  kind: "effect";
  deps: readonly unknown[] | undefined;
  cleanup?: (() => void) | undefined;
}

interface MemoHookSlot<T> {
  kind: "memo";
  deps: readonly unknown[] | undefined;
  value: T;
}

interface RefHookSlot<T> {
  kind: "ref";
  ref: { current: T };
}

export function createElementNode(
  type: CompositionNodeType,
  props: ComponentProps = {},
  key?: string | number | null,
): CompositionElementNode {
  const { children, ...rest } = props;

  return {
    kind: "element",
    type,
    key: key ?? null,
    props: rest,
    children: normalizeChildren(children),
  };
}

export function normalizeChildren(children: unknown): CompositionChild[] {
  if (children == null || children === false || children === true) {
    return [];
  }

  if (Array.isArray(children)) {
    return children.flatMap(normalizeChildren);
  }

  return [children as CompositionChild];
}

export function createComponentStateStore(): ComponentStateStore {
  return {
    instances: new Map(),
  };
}

export function withComponentRenderRoot<T>(
  rootId: string,
  store: ComponentStateStore,
  render: () => T,
): T {
  const previousRoot = activeRenderRoot;
  const previousDepth = renderFrames.length;
  const rootInstanceId = `${rootId}/__root__`;
  activeRenderRoot = {
    rootId,
    store,
    seenInstances: new Set([rootInstanceId]),
    pendingLayoutEffects: [],
    pendingEffects: [],
  };
  renderFrames.push({
    instanceId: rootInstanceId,
    childCursor: 0,
    hookCursor: 0,
  });

  try {
    return render();
  } finally {
    const currentRoot = activeRenderRoot;
    if (currentRoot) {
      const prefix = `${rootId}/`;
      for (const [instanceId, instance] of Array.from(store.instances.entries())) {
        if (instanceId.startsWith(prefix) && !currentRoot.seenInstances.has(instanceId)) {
          cleanupInstance(instance);
          store.instances.delete(instanceId);
        }
      }
    }
    const pendingLayoutEffects = currentRoot?.pendingLayoutEffects ?? [];
    const pendingEffects = currentRoot?.pendingEffects ?? [];
    renderFrames.length = previousDepth;
    activeRenderRoot = previousRoot;
    for (const effect of pendingLayoutEffects) {
      effect();
    }
    for (const effect of pendingEffects) {
      effect();
    }
  }
}

export function renderComponent<TProps extends ComponentProps>(
  type: (props: TProps) => CompositionRenderable,
  props: TProps,
  key?: string | number | null,
): CompositionRenderable {
  const parentFrame = renderFrames[renderFrames.length - 1];
  const root = activeRenderRoot;
  if (!root) {
    return type(props);
  }

  const ordinal = parentFrame ? parentFrame.childCursor++ : 0;
  const typeName = type.name || "Anonymous";
  const instanceId = parentFrame
    ? buildInstanceId(parentFrame.instanceId, typeName, ordinal, key)
    : buildInstanceId(root.rootId, typeName, ordinal, key);

  root.seenInstances.add(instanceId);
  renderFrames.push({
    instanceId,
    childCursor: 0,
    hookCursor: 0,
  });
  try {
    return type(props);
  } finally {
    renderFrames.pop();
  }
}

/**
 * Create a reactive `Signal<T>` scoped to the current function component
 * render. The signal persists across re-renders (hook identity is stable per
 * component instance). Equivalent to `useState` — prefer that alias in TSX
 * files for familiarity.
 * 現在の関数コンポーネントレンダリングにスコープされたリアクティブな `Signal<T>` を
 * 作成します。シグナルは再レンダリングをまたいで保持されます（コンポーネントインスタンス
 * ごとにフックのアイデンティティが安定しています）。`useState` の別名です。
 *
 * @example
 * ```tsx
 * function MyButton({ window }: { window: WaylandWindow }) {
 *   const [hovered, setHovered] = createState(false);
 *   return <Button onClick={() => setHovered(true)} />;
 * }
 * ```
 */
export function createState<T>(initialValue: T | (() => T)): SignalTuple<T> {
  const { hooks, hookIndex } = currentHookSlotContext("createState");
  const existing = hooks[hookIndex];
  if (existing) {
    return existing as SignalTuple<T>;
  }

  const resolvedInitial =
    typeof initialValue === "function"
      ? (initialValue as () => T)()
      : initialValue;
  const state = signal(resolvedInitial);
  hooks[hookIndex] = state;
  return state;
}

/**
 * Create a reactive signal inside a function component. Alias for `createState`.
 * 関数コンポーネント内でリアクティブなシグナルを作成します。`createState` の別名。
 *
 * @example
 * ```tsx
 * function Tooltip({ window }: { window: WaylandWindow }) {
 *   const [visible, setVisible] = useState(false);
 *   return <Box style={{ opacity: visible.value ? 1 : 0 }} />;
 * }
 * ```
 */
export const useState = createState;

/**
 * Create a reactive derived signal inside a function component. The signal
 * re-computes lazily whenever any signal read inside `compute` changes.
 * The computed value is memoized across re-renders (the hook slot is stable).
 * 関数コンポーネント内でリアクティブな派生シグナルを作成します。`compute` 内で
 * 読んだシグナルが変わると遅延再計算されます。再レンダリングをまたいでメモ化されます。
 *
 * @example
 * ```tsx
 * const scale = useComputed(() => 0.8 + window.animation.variable(openVar).value * 0.2);
 * window.transform.scaleX = scale;
 * ```
 */
export function useComputed<T>(compute: () => T): ReadonlySignal<T> {
  const { hooks, hookIndex } = currentHookSlotContext("useComputed");
  const existing = hooks[hookIndex] as ComputedHookSlot<T> | undefined;
  if (existing?.kind === "computed") {
    existing.computeRef.current = compute;
    return existing.signal;
  }

  const computeRef = { current: compute };
  // useComputed memoizes the ComputedSignal via the hook slot, so it must
  // outlive the composition pass that first created it. Without this guard,
  // the next pass would auto-dispose it and the hook slot would hand back a
  // detached signal.
  const signalValue = withoutCompositionOwnership(() =>
    computed(() => computeRef.current()),
  );
  hooks[hookIndex] = {
    kind: "computed",
    signal: signalValue,
    computeRef,
  } satisfies ComputedHookSlot<T>;
  return signalValue;
}

/** Alias for `useComputed`. / `useComputed` の別名。 */
export const createComputed = useComputed;

/**
 * Run a side effect after a component renders. The effect fires after each
 * render in which `deps` changed (or every render if `deps` is omitted). Return
 * a cleanup function to run before the next invocation or when the component
 * unmounts.
 * コンポーネントレンダリング後にサイドエフェクトを実行します。`deps` が変わった
 * レンダリング後に発火します（省略時は毎回）。次の呼び出し前またはアンマウント時に
 * 実行するクリーンアップ関数を返せます。
 *
 * @example
 * ```ts
 * useEffect(() => {
 *   const unsub = window.title.subscribe(() => updateTaskbar(window.title.value));
 *   return () => unsub();
 * }, [window.id]);
 * ```
 */
export function useEffect(
  run: () => void | (() => void),
  deps?: readonly unknown[],
): void {
  queueEffect("useEffect", run, deps, false);
}

/**
 * Like `useEffect`, but the cleanup and re-run happen synchronously during the
 * render pass (before the next effect). Use this when the side effect must be
 * visible before subsequent render hooks run.
 * `useEffect` と同様ですが、クリーンアップと再実行はレンダリングパス中に同期的に
 * 行われます（次のエフェクトの前）。後続のレンダリングフックの前にサイドエフェクトが
 * 反映されなければならない場合に使います。
 */
export function useLayoutEffect(
  run: () => void | (() => void),
  deps?: readonly unknown[],
): void {
  queueEffect("useLayoutEffect", run, deps, true);
}

/**
 * Memoize an expensive computation inside a component. `compute` only re-runs
 * when `deps` changes. Unlike `useComputed`, the result is a plain value — not
 * a signal — so it won't reactively update downstream composition.
 * コンポーネント内で高コストな計算をメモ化します。`deps` が変わったときのみ
 * `compute` が再実行されます。`useComputed` と異なり、結果はシグナルではなく
 * 通常の値なので、下流の合成をリアクティブに更新しません。
 *
 * @example
 * ```ts
 * const sortedIds = useMemo(
 *   () => [...window.state[taskList].value].sort(),
 *   [window.id],
 * );
 * ```
 */
export function useMemo<T>(
  compute: () => T,
  deps?: readonly unknown[],
): T {
  const { hooks, hookIndex } = currentHookSlotContext("useMemo");
  const existing = hooks[hookIndex] as MemoHookSlot<T> | undefined;
  if (existing?.kind === "memo" && sameHookDeps(existing.deps, deps)) {
    return existing.value;
  }

  const value = compute();
  hooks[hookIndex] = {
    kind: "memo",
    deps: deps ? [...deps] : undefined,
    value,
  } satisfies MemoHookSlot<T>;
  return value;
}

/**
 * Create a mutable ref object whose `.current` property persists across
 * re-renders without causing reactive updates. Useful for holding DOM-like
 * handles or previous values.
 * 再レンダリングをまたいで保持されるミュータブルな ref オブジェクトを作成します。
 * `.current` の変更はリアクティブな更新を引き起こしません。ハンドルや前の値の
 * 保持に使います。
 *
 * @example
 * ```ts
 * const prevId = useRef<string | undefined>(undefined);
 * useEffect(() => { prevId.current = window.id; });
 * ```
 */
export function useRef<T>(initialValue: T): { current: T } {
  const { hooks, hookIndex } = currentHookSlotContext("useRef");
  const existing = hooks[hookIndex] as RefHookSlot<T> | undefined;
  if (existing?.kind === "ref") {
    return existing.ref;
  }

  const ref = { current: initialValue };
  hooks[hookIndex] = {
    kind: "ref",
    ref,
  } satisfies RefHookSlot<T>;
  return ref;
}

/**
 * Register a cleanup function that runs when the component instance unmounts
 * (i.e. when the window closes or the composition is torn down). Simpler
 * alternative to `useEffect(() => { return cleanup; })` when you only need
 * the teardown.
 * コンポーネントインスタンスがアンマウントされるとき（ウィンドウが閉じるか
 * 合成が破棄されるとき）に実行するクリーンアップ関数を登録します。
 * テアダウンのみが必要な場合の `useEffect(() => { return cleanup; })` の
 * 簡潔な代替です。
 *
 * @example
 * ```ts
 * const unsub = someExternalStore.subscribe(handler);
 * onCleanup(() => unsub());
 * ```
 */
export function onCleanup(cleanup: () => void): void {
  const { hooks, hookIndex, root } = currentHookSlotContext("onCleanup");
  const existing = hooks[hookIndex] as EffectHookSlot | undefined;
  const slot: EffectHookSlot =
    existing?.kind === "effect"
      ? existing
      : {
          kind: "effect",
          deps: undefined,
          cleanup: undefined,
        };
  hooks[hookIndex] = slot;
  root.pendingEffects.push(() => {
    slot.cleanup?.();
    slot.cleanup = cleanup;
  });
}

function queueEffect(
  apiName: "useEffect" | "useLayoutEffect",
  run: () => void | (() => void),
  deps: readonly unknown[] | undefined,
  layout: boolean,
): void {
  const { hooks, hookIndex, root } = currentHookSlotContext(apiName);
  const existing = hooks[hookIndex] as EffectHookSlot | undefined;
  const depsChanged = !existing || !sameHookDeps(existing.deps, deps);
  if (!depsChanged) {
    return;
  }

  const slot: EffectHookSlot =
    existing?.kind === "effect"
      ? existing
      : {
          kind: "effect",
          deps: undefined,
          cleanup: undefined,
        };
  hooks[hookIndex] = slot;
  (layout ? root.pendingLayoutEffects : root.pendingEffects).push(() => {
    slot.cleanup?.();
    const cleanup = run();
    slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    slot.deps = deps ? [...deps] : undefined;
  });
}

function buildInstanceId(
  parentId: string,
  typeName: string,
  ordinal: number,
  key?: string | number | null,
): string {
  if (key != null) {
    return `${parentId}/${typeName}#${String(key)}`;
  }

  return `${parentId}/${typeName}[${ordinal}]`;
}

function currentHookSlotContext(apiName: string): {
  hooks: unknown[];
  hookIndex: number;
  root: RenderRootContext;
} {
  const frame = renderFrames[renderFrames.length - 1];
  const root = activeRenderRoot;
  if (!frame || !root) {
    throw new Error(`${apiName}() can only be used inside a function component render`);
  }

  let instance = root.store.instances.get(frame.instanceId);
  if (!instance) {
    instance = { hooks: [] };
    root.store.instances.set(frame.instanceId, instance);
  }

  const hookIndex = frame.hookCursor++;
  return {
    hooks: instance.hooks,
    hookIndex,
    root,
  };
}

function sameHookDeps(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (previous === undefined || next === undefined) {
    return previous === next;
  }

  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((value, index) => Object.is(value, next[index]));
}

function cleanupInstance(instance: ComponentInstanceState): void {
  for (const hook of instance.hooks) {
    if (
      hook &&
      typeof hook === "object" &&
      "kind" in hook &&
      (hook as { kind?: string }).kind === "effect"
    ) {
      (hook as EffectHookSlot).cleanup?.();
    }
  }
}
