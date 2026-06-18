import type {
  InputConfigDraft,
  InputConfigureContext,
  InputConfigureFactory,
  InputController,
  InputDeviceConfig,
  InputDeviceInfo,
} from "./types";
import type { InputDeviceChangeEvent } from "./events";

let currentInputState: Record<string, InputDeviceInfo> = {};
let desiredInputConfig: InputConfigDraft = { device: {} };
let pendingInputConfig = false;
let configureFactory: InputConfigureFactory | null = null;
let stagedConfigureFactory: InputConfigureFactory | null | undefined;
let inputDeviceChangeEmitter: ((event: InputDeviceChangeEvent) => void) | null =
  null;

function cloneDevice(device: InputDeviceInfo, key = device.key): InputDeviceInfo {
  return {
    key,
    name: device.name,
    sysname: device.sysname,
    vendor: device.vendor,
    product: device.product,
    kind: { ...device.kind },
  };
}

function cloneInputState(
  state: Record<string, InputDeviceInfo>,
): Record<string, InputDeviceInfo> {
  return Object.fromEntries(
    Object.entries(state).map(([key, device]) => [key, cloneDevice(device, key)]),
  );
}

function normalizeDeviceConfig(
  config: InputDeviceConfig | null | undefined,
): InputDeviceConfig | null {
  if (config == null) {
    return null;
  }
  return {
    keyboard: config.keyboard ? { ...config.keyboard } : undefined,
    pointer: config.pointer ? { ...config.pointer } : undefined,
    touchpad: config.touchpad ? { ...config.touchpad } : undefined,
  };
}

function cloneInputConfig(config: InputConfigDraft): InputConfigDraft {
  return {
    global: normalizeDeviceConfig(config.global) ?? undefined,
    device: Object.fromEntries(
      Object.entries(config.device).map(([key, value]) => [
        key,
        normalizeDeviceConfig(value),
      ]),
    ),
  };
}

function normalizeInputConfig(config: InputConfigDraft): InputConfigDraft {
  return cloneInputConfig({
    global: config.global,
    device: config.device ?? {},
  });
}

function inputConfigsEqual(a: InputConfigDraft, b: InputConfigDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function inputStatesEqual(
  a: Record<string, InputDeviceInfo>,
  b: Record<string, InputDeviceInfo>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function configureContext(): InputConfigureContext {
  const current = cloneInputState(currentInputState);
  return {
    devices: Object.values(current),
    current,
  };
}

function evaluateConfigureFactory(force = false): void {
  const factory = stagedConfigureFactory ?? configureFactory;
  if (!factory) {
    return;
  }
  const draft: InputConfigDraft = { device: {} };
  factory(draft, configureContext());
  const nextConfig = normalizeInputConfig(draft);
  if (!force && inputConfigsEqual(nextConfig, desiredInputConfig)) {
    return;
  }
  desiredInputConfig = nextConfig;
  pendingInputConfig = true;
}

function inputDeviceChangeEvent(
  previous: Record<string, InputDeviceInfo>,
  current: Record<string, InputDeviceInfo>,
): InputDeviceChangeEvent {
  const previousKeys = new Set(Object.keys(previous));
  const currentKeys = new Set(Object.keys(current));
  const added = Object.entries(current)
    .filter(([key]) => !previousKeys.has(key))
    .map(([, device]) => cloneDevice(device));
  const removed = Object.entries(previous)
    .filter(([key]) => !currentKeys.has(key))
    .map(([, device]) => cloneDevice(device));
  const changed = Object.entries(current)
    .filter(([key, device]) => {
      const before = previous[key];
      return before && JSON.stringify(before) !== JSON.stringify(device);
    })
    .map(([, device]) => cloneDevice(device));
  return {
    devices: Object.values(cloneInputState(current)),
    current: cloneInputState(current),
    added,
    removed,
    changed,
  };
}

export function updateInputState(
  nextState: Record<string, InputDeviceInfo> | undefined,
): void {
  const normalized = cloneInputState(nextState ?? {});
  if (inputStatesEqual(currentInputState, normalized)) {
    return;
  }
  const previous = currentInputState;
  currentInputState = normalized;
  evaluateConfigureFactory();
  inputDeviceChangeEmitter?.(
    inputDeviceChangeEvent(previous, currentInputState),
  );
}

export function installInputDeviceChangeEmitter(
  emitter: (event: InputDeviceChangeEvent) => void,
): void {
  inputDeviceChangeEmitter = emitter;
}

export function reconfigureInput(): void {
  evaluateConfigureFactory(true);
}

export function configureInput(factory: InputConfigureFactory): void {
  if (stagedConfigureFactory !== undefined) {
    stagedConfigureFactory = factory;
    return;
  }
  configureFactory = factory;
  evaluateConfigureFactory(true);
}

export function beginInputConfigurationRegistration(): void {
  stagedConfigureFactory = null;
}

export function commitInputConfigurationRegistration(): void {
  if (stagedConfigureFactory === undefined) {
    return;
  }
  configureFactory = stagedConfigureFactory;
  stagedConfigureFactory = undefined;
  evaluateConfigureFactory(true);
}

export function takePendingInputConfig(): InputConfigDraft | undefined {
  if (!pendingInputConfig) {
    return undefined;
  }
  pendingInputConfig = false;
  return cloneInputConfig(desiredInputConfig);
}

export const INPUT_CONTROLLER: InputController = {
  get devices() {
    return Object.values(cloneInputState(currentInputState));
  },
  get current() {
    return cloneInputState(currentInputState);
  },
  get(deviceKey) {
    const device = currentInputState[deviceKey];
    return device ? cloneDevice(device) : undefined;
  },
  find(predicate) {
    for (const device of Object.values(currentInputState)) {
      const cloned = cloneDevice(device);
      if (predicate(cloned)) {
        return cloned;
      }
    }
    return undefined;
  },
  configure(factory) {
    configureInput(factory);
  },
  reconfigure() {
    reconfigureInput();
  },
};
