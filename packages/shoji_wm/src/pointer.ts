import type { PointerController } from "./types";

interface RuntimePointerConfig {
  windowMoveModifier?: string;
  windowResizeModifier?: string;
}

let desiredPointerConfig: RuntimePointerConfig = {};
let stagedPointerConfig: RuntimePointerConfig | null = null;
let pendingPointerConfig = false;

function registrationTarget(): RuntimePointerConfig {
  return stagedPointerConfig ?? desiredPointerConfig;
}

function normalizeModifier(modifier: string): string {
  const parts = modifier
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    throw new Error("window move modifier must not be empty");
  }

  return parts.join("+");
}

export const POINTER_CONTROLLER: PointerController = {
  bindWindowMoveModifier(modifier) {
    registrationTarget().windowMoveModifier = normalizeModifier(modifier);

    if (!stagedPointerConfig) {
      pendingPointerConfig = true;
    }
  },

  bindWindowResizeModifier(modifier) {
    registrationTarget().windowResizeModifier = normalizeModifier(modifier);

    if (!stagedPointerConfig) {
      pendingPointerConfig = true;
    }
  },
};

export function beginPointerConfigRegistration(): void {
  stagedPointerConfig = {};
}

export function commitPointerConfigRegistration(): void {
  if (!stagedPointerConfig) {
    return;
  }

  desiredPointerConfig = stagedPointerConfig;
  stagedPointerConfig = null;
  pendingPointerConfig = true;
}

export function takePendingPointerConfig(): RuntimePointerConfig | undefined {
  if (!pendingPointerConfig) {
    return undefined;
  }

  pendingPointerConfig = false;
  return { ...desiredPointerConfig };
}
