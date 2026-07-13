import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

import {
  createCompositionEvaluationCache,
  installAssetResolverBridge,
  COMPOSITOR,
  type WindowCompositionFunction,
  type WaylandWindowActions,
  type WaylandWindowSnapshot,
} from "shoji_wm";

const DEFAULT_SNAPSHOT: WaylandWindowSnapshot = {
  id: "demo-window-1",
  title: "Kitty",
  appId: "kitty",
  position: {
    x: 100,
    y: 80,
    width: 900,
    height: 600,
  },
  rect: {
    x: 100,
    y: 80,
    width: 900,
    height: 600,
  },
  isFocused: true,
  isFloating: true,
  isMaximized: false,
  isFullscreen: false,
  isXwayland: false,
  decoration: {
    protocol: "none",
    clientPreference: null,
    configuredMode: "server",
    mode: "server",
  },
  sizeConstraints: {},
  isResizable: true,
  isTransient: false,
  parentId: undefined,
  icon: undefined,
  interaction: {
    hoveredIds: [],
    activeIds: [],
  },
};

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("usage: npm run ssd:eval -- <config-path> [snapshot-json]");
  }

  const snapshot = process.argv[3]
    ? (JSON.parse(process.argv[3]) as WaylandWindowSnapshot)
    : DEFAULT_SNAPSHOT;

  const moduleUrl = pathToFileURL(resolve(configPath)).href;
  installAssetResolverBridge(findConfigRoot(configPath));
  const loaded = await import(moduleUrl);
  const composition = resolveComposition(loaded);

  const actions: WaylandWindowActions = {
    close() {
      console.log("[runtime] close() requested");
    },
    maximize() {
      console.log("[runtime] maximize() requested");
    },
    unmaximize() {
      console.log("[runtime] unmaximize() requested");
    },
    minimize() {
      console.log("[runtime] minimize() requested");
    },
    focus() {
      console.log("[runtime] focus() requested");
    },
    setCloseAnimationDuration(durationMs) {
      console.log(`[runtime] setCloseAnimationDuration(${durationMs}) requested`);
    },
    isXWayland() {
      return snapshot.isXwayland;
    },
  };

  const cache = createCompositionEvaluationCache(snapshot, actions, composition);
  try {
    const serialized = cache.reevaluate().serialized;
    console.log(JSON.stringify(serialized, null, 2));
  } finally {
    COMPOSITOR.event.emitDisable("shutdown");
  }
}

function resolveComposition(
  loaded: Record<string, unknown>,
): WindowCompositionFunction {
  type WindowSlot = { composition?: WindowCompositionFunction | null };
  type WmSlot = { window?: WindowSlot };
  const maybeComposition =
    COMPOSITOR.window.composition ??
    (loaded.default as WmSlot | undefined)?.window?.composition ??
    (loaded.composition as WindowCompositionFunction | undefined);

  if (!maybeComposition) {
    throw new Error("config did not assign COMPOSITOR.window.composition");
  }

  return maybeComposition;
}

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
