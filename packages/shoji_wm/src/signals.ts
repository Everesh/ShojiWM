import { registerOwnedComputed, trackSignalRead, trackSignalWrite } from "./runtime-hooks";

export type SignalSetter<T> = (next: T | ((current: T) => T)) => void;

/**
 * A reactive read-only value. Reading `.value` inside a composition function
 * registers a dependency; the compositor re-runs the function whenever the
 * signal changes.
 * リアクティブな読み取り専用値。合成関数内で `.value` を読むと依存関係が登録され、
 * シグナルが変化するたびにコンポジターが関数を再実行します。
 *
 * Calling the signal as a function is an alias for reading `.value`.
 * Calling it with a mapper `signal(x => ...)` returns a derived `ReadonlySignal<U>`.
 * 関数として呼ぶことは `.value` を読むことと同等です。
 * マッパーを渡して `signal(x => ...)` と呼ぶと派生シグナル `ReadonlySignal<U>` を返します。
 *
 * @example
 * ```ts
 * // Read in composition (tracks dependency)
 * const focused = window.isFocused.value;
 *
 * // Derive a mapped signal
 * const scale = window.animation.variable(openVar)((x) => 0.8 + x * 0.2);
 * window.transform.scaleX = scale;
 *
 * // Subscribe outside composition
 * const unsub = window.title.subscribe(() => console.log(window.title.value));
 * ```
 */
export interface ReadonlySignal<T> {
  /** Read the current value (tracks dependency if inside a reactive context). / 現在の値を読みます（リアクティブなコンテキスト内では依存関係を追跡します）。 */
  (): T;
  /** Create a derived signal by mapping this signal's value. / この値をマップした派生シグナルを作成します。 */
  <U>(map: (value: T) => U): ReadonlySignal<U>;
  /** The current value. Reading this inside composition registers a dependency. / 現在の値。合成内で読むと依存関係が登録されます。 */
  readonly value: T;
  /**
   * Subscribe to changes. The listener fires after each write that changes the
   * value. Returns an unsubscribe function.
   * 変更を購読します。値が変わるたびにリスナーが呼ばれます。解除関数を返します。
   */
  subscribe(listener: () => void): () => void;
  /** Read the current value WITHOUT registering a dependency. / 依存関係を登録せずに現在の値を読みます。 */
  peek(): T;
}

/**
 * A reactive read-write value. Extends `ReadonlySignal<T>` with mutation
 * methods. Use `useState` / `createWindowState` inside composition; use
 * `signal()` at module scope.
 * リアクティブな読み書き可能な値。`ReadonlySignal<T>` を拡張して変更メソッドを追加します。
 * 合成内では `useState` / `createWindowState` を使い、モジュールスコープでは
 * `signal()` を使います。
 */
export interface Signal<T>
  extends ReadonlySignal<T> {
  /** Set a new value (triggers dependents). / 新しい値を設定します（依存関係をトリガーします）。 */
  value: T;
  /** Functional setter; pass a new value or an updater `(current) => next`. / 新しい値またはアップデーター `(current) => next` を渡す関数型セッター。 */
  set: SignalSetter<T>;
  /** Update via a mapping function. Equivalent to `signal.set(x => f(x))`. / マッピング関数で更新します。`signal.set(x => f(x))` と同等です。 */
  update(map: (current: T) => T): void;
}

/** A `Signal<T>` that also destructures as `[signal, setter]`. / `[signal, setter]` として分解代入もできる `Signal<T>`。 */
export type SignalTuple<T> = Signal<T> & readonly [Signal<T>, SignalSetter<T>];

interface ReactiveComputation {
  markDirty(): void;
  registerDependency(signal: BaseSignal<unknown>): void;
  /**
   * Stamped during BaseSignal.notify() iteration. A dependent's markDirty()
   * may synchronously unsubscribe + re-subscribe itself (effects clear and
   * re-register their deps inside run()), which moves the entry to the
   * Set's tail and would cause for-of to re-visit it indefinitely. Comparing
   * the stamp against the current notify epoch deduplicates without
   * allocating a snapshot array.
   */
  lastNotifyEpoch: number;
}

let activeComputation: ReactiveComputation | null = null;
let notifyEpoch = 0;

abstract class BaseSignal<T> {
  protected listeners = new Set<() => void>();
  protected dependents = new Set<ReactiveComputation>();

  abstract get value(): T;
  abstract peek(): T;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected trackDependency(): void {
    trackSignalRead(this);
    if (activeComputation) {
      this.dependents.add(activeComputation);
      activeComputation.registerDependency(this);
    }
  }

  protected notify(): void {
    trackSignalWrite(this);

    // Listeners path is rare in this codebase — keep the simple snapshot.
    // A re-entrant subscribe()/unsubscribe() would otherwise corrupt iteration
    // order, and listeners are plain functions with no field to stamp.
    if (this.listeners.size > 0) {
      for (const listener of [...this.listeners]) {
        listener();
      }
    }

    // Hot path: epoch-stamped dedup so an effect that re-registers itself
    // inside markDirty() does not get re-visited. Avoids per-call array
    // allocation, which previously dominated `set value` cost (perf shows
    // 8.5%+ of total CPU under load with many windows).
    const epoch = ++notifyEpoch;
    for (const dependent of this.dependents) {
      if (dependent.lastNotifyEpoch === epoch) {
        continue;
      }
      dependent.lastNotifyEpoch = epoch;
      dependent.markDirty();
    }
  }

  removeDependent(computation: ReactiveComputation): void {
    this.dependents.delete(computation);
  }
}

class WritableSignal<T> extends BaseSignal<T> {
  #value: T;

  constructor(initialValue: T) {
    super();
    this.#value = initialValue;
  }

  get value(): T {
    this.trackDependency();
    return this.#value;
  }

  peek(): T {
    return this.#value;
  }

  set value(nextValue: T) {
    if (Object.is(this.#value, nextValue)) {
      return;
    }
    this.#value = nextValue;
    this.notify();
  }
}

class ComputedSignal<T> extends BaseSignal<T> implements ReactiveComputation {
  #compute: () => T;
  #cached!: T;
  #initialized = false;
  #dirty = true;
  #disposed = false;
  #dependencies = new Set<BaseSignal<unknown>>();
  lastNotifyEpoch = 0;

  constructor(compute: () => T) {
    super();
    this.#compute = compute;
    // Register with the current composition owner so the runtime can detach
    // us from our sources on the next composition pass. Without this, every
    // composition leaves behind a fresh ComputedSignal as a permanent
    // dependent of every BaseSignal it touched, and every signal write fans
    // out to the ever-growing graveyard.
    registerOwnedComputed(this);
  }

  get value(): T {
    this.trackDependency();
    this.recomputeIfNeeded();
    return this.#cached;
  }

  peek(): T {
    this.recomputeIfNeeded();
    return this.#cached;
  }

  markDirty(): void {
    if (this.#disposed) {
      return;
    }
    if (!this.#dirty) {
      this.#dirty = true;
      this.notify();
    }
  }

  registerDependency(signal: BaseSignal<unknown>): void {
    this.#dependencies.add(signal);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();
  }

  private recomputeIfNeeded(): void {
    if (this.#disposed) {
      return;
    }
    if (!this.#dirty && this.#initialized) {
      return;
    }

    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();

    const previous = activeComputation;
    activeComputation = this;
    try {
      const nextValue = this.#compute();
      const changed = !this.#initialized || !Object.is(this.#cached, nextValue);
      this.#cached = nextValue;
      this.#initialized = true;
      this.#dirty = false;
      if (changed) {
        const listeners = Array.from(this.listeners);
        for (const listener of listeners) {
          listener();
        }
      }
    } finally {
      activeComputation = previous;
    }
  }
}

class EffectHandle implements ReactiveComputation {
  #effect: () => void;
  #dependencies = new Set<BaseSignal<unknown>>();
  #disposed = false;
  lastNotifyEpoch = 0;

  constructor(effect: () => void) {
    this.#effect = effect;
    this.run();
  }

  markDirty(): void {
    if (!this.#disposed) {
      this.run();
    }
  }

  registerDependency(signal: BaseSignal<unknown>): void {
    this.#dependencies.add(signal);
  }

  dispose(): void {
    this.#disposed = true;
    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();
  }

  private run(): void {
    for (const dependency of this.#dependencies) {
      dependency.removeDependent(this);
    }
    this.#dependencies.clear();

    const previous = activeComputation;
    activeComputation = this;
    try {
      this.#effect();
    } finally {
      activeComputation = previous;
    }
  }
}

/**
 * Create a writable signal at module (non-component) scope. For reactive state
 * inside a composition function, prefer `useState` instead.
 * モジュール（非コンポーネント）スコープで書き込み可能なシグナルを作成します。
 * 合成関数内のリアクティブな状態には `useState` を使ってください。
 *
 * @example
 * ```ts
 * const [count, setCount] = signal(0);
 * setCount(count.value + 1);
 * // or
 * count.update((n) => n + 1);
 * ```
 */
export function signal<T>(initialValue: T): SignalTuple<T> {
  return createWritableSignalFacade(new WritableSignal(initialValue));
}

/**
 * Create a read-only derived signal at module scope. The `compute` function
 * re-runs lazily whenever its signal dependencies change.
 * For reactive derived values inside a composition function, prefer `useComputed`.
 * モジュールスコープで読み取り専用の派生シグナルを作成します。`compute` 関数は
 * シグナルの依存関係が変わったときに遅延再実行されます。
 * 合成関数内の派生値には `useComputed` を使ってください。
 *
 * @example
 * ```ts
 * const fullTitle = computed(() => `${app.value} — ${title.value}`);
 * ```
 */
export function computed<T>(compute: () => T): ReadonlySignal<T> {
  return createReadonlySignalFacade(new ComputedSignal(compute));
}

/**
 * Run a side effect at module scope whenever its signal dependencies change.
 * Returns an unsubscribe/dispose function.
 * シグナルの依存関係が変わったときにモジュールスコープでサイドエフェクトを実行します。
 * 解除・破棄関数を返します。
 *
 * @example
 * ```ts
 * const dispose = effect(() => {
 *   document.title = title.value;
 * });
 * // later: dispose();
 * ```
 */
export function effect(run: () => void): () => void {
  const handle = new EffectHandle(run);
  return () => handle.dispose();
}

/**
 * Returns `true` if `value` is a `ReadonlySignal`. Useful to narrow a
 * `MaybeSignal<T>` at runtime.
 * `value` が `ReadonlySignal` かどうかを判定します。
 * `MaybeSignal<T>` を実行時に絞り込むのに便利です。
 */
export function isSignal<T>(value: unknown): value is ReadonlySignal<T> {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    "value" in value &&
    typeof (value as ReadonlySignal<T>).subscribe === "function"
  );
}

/**
 * Unwrap a `MaybeSignal<T>`: if `value` is a signal, return its current value;
 * otherwise return the value as-is.
 * `MaybeSignal<T>` を展開します。シグナルならその現在値を、そうでなければ値をそのまま返します。
 *
 * @example
 * ```ts
 * function getTitle(title: MaybeSignal<string>): string {
 *   return read(title); // works for both "Hello" and a signal
 * }
 * ```
 */
export function read<T>(value: T | ReadonlySignal<T>): T {
  return isSignal<T>(value) ? value.value : value;
}

function createMappedSignalProxy<T, U>(
  source: BaseSignal<T>,
  mapFn: (value: T) => U,
): ReadonlySignal<U> {
  // Thin proxy that re-applies `mapFn` on every read. Does NOT create an
  // intermediate ComputedSignal: such a wrapper would register itself as a
  // permanent dependent of `source` on first read, and `source.dependents` is
  // never trimmed for unread computeds. Across composition passes the user's
  // arrow-callback form (`signal(x => ...)`) produced a fresh ComputedSignal
  // each call, accumulating without bound and turning every signal write into
  // an O(leaked-dependents) cascade. Anchoring the dep edge at `source` via
  // the outer reader keeps the graph short-lived and GC-friendly.
  const mapped = ((nestedMap?: unknown) => {
    if (typeof nestedMap === "function") {
      return createMappedSignalProxy(source, (value: T) =>
        (nestedMap as (mapped: U) => unknown)(mapFn(value)),
      );
    }
    return mapFn(source.value);
  }) as ReadonlySignal<U>;

  Object.defineProperty(mapped, "value", {
    get() {
      return mapFn(source.value);
    },
    enumerable: true,
    configurable: true,
  });

  // subscribe forwards to source: listeners fire on any source change rather
  // than on changes in the mapped output. Downstream computeds memoize on
  // their own output so the cascade still short-circuits when mapFn yields the
  // same value.
  mapped.subscribe = source.subscribe.bind(source);
  mapped.peek = () => mapFn(source.peek());

  return mapped;
}

function createReadonlySignalFacade<T>(
  source: BaseSignal<T>,
): ReadonlySignal<T> {
  const facade = ((map?: unknown) => {
    if (typeof map === "function") {
      return createMappedSignalProxy(source, map as (value: T) => unknown);
    }
    return source.value;
  }) as ReadonlySignal<T>;

  Object.defineProperty(facade, "value", {
    get() {
      return source.value;
    },
    enumerable: true,
    configurable: true,
  });

  facade.subscribe = source.subscribe.bind(source);
  facade.peek = source.peek.bind(source);

  return facade;
}

function createWritableSignalFacade<T>(
  source: WritableSignal<T>,
): SignalTuple<T> {
  const facade = createReadonlySignalFacade(source) as SignalTuple<T>;

  Object.defineProperty(facade, "value", {
    get() {
      return source.value;
    },
    set(nextValue: T) {
      source.value = nextValue;
    },
    enumerable: true,
    configurable: true,
  });

  const set: SignalSetter<T> = (next) => {
    source.value =
      typeof next === "function"
        ? (next as (current: T) => T)(source.peek())
        : next;
  };

  facade.set = set;
  facade.update = (map) => {
    source.value = map(source.peek());
  };
  Object.defineProperty(facade, 0, {
    value: facade,
    enumerable: false,
  });
  Object.defineProperty(facade, 1, {
    value: set,
    enumerable: false,
  });
  Object.defineProperty(facade, "length", {
    value: 2,
    enumerable: false,
  });
  facade[Symbol.iterator] = function* iterator(): IterableIterator<Signal<T> | SignalSetter<T>> {
    yield facade;
    yield set;
  };

  return facade;
}
