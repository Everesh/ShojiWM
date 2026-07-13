import type {
  CompositorWindowDecorationController,
  WaylandWindow,
  WindowDecorationContext,
  WindowDecorationDecision,
  WindowDecorationResolver,
} from "./types";

const DEFAULT_DECISION: WindowDecorationDecision = { mode: "server" };

let resolver: WindowDecorationResolver | null = null;

function validateDecision(
  value: WindowDecorationDecision,
): WindowDecorationDecision {
  if (value === null || typeof value !== "object") {
    throw new TypeError("window decoration policy must return an object");
  }
  if (value.mode !== "client" && value.mode !== "server") {
    throw new TypeError(
      'window decoration policy mode must be either "client" or "server"',
    );
  }
  return { mode: value.mode };
}

export const WINDOW_DECORATION_CONTROLLER: CompositorWindowDecorationController =
  {
    configure(nextResolver) {
      if (typeof nextResolver !== "function") {
        throw new TypeError("window decoration resolver must be a function");
      }
      resolver = nextResolver;
    },
  };

export function resolveWindowDecorationDecision(
  window: WaylandWindow,
  context: WindowDecorationContext,
): WindowDecorationDecision {
  return validateDecision(resolver?.(window, context) ?? DEFAULT_DECISION);
}
