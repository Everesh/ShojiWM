// Generic bidirectional IPC transport for ShojiWM.
//
// The TS configuration runtime is a long-lived Node.js process, so it can host
// a Unix-domain socket that external clients (a bar, a launcher, ...) connect
// to. The wire format is newline-delimited JSON:
//
//   client -> server   { "id"?: number, "method": string, "params"?: unknown }
//   server -> client   { "id": number, "result": unknown }          (response)
//                      { "id": number, "error": string }            (error)
//                      { "event": string, "payload": unknown }      (broadcast)
//
// A request with an `id` receives exactly one matching response; requests
// without an `id` are fire-and-forget commands. `broadcast` pushes an event to
// every connected client and is how reactive state (e.g. the active workspace)
// is propagated.
//
// This module is intentionally feature-agnostic: workspace/window specifics are
// wired up by the configuration package on top of this transport.
//
// The reference below pulls the minimal node:net/node:fs ambient declarations
// (the monorepo has no @types/node) into every program that imports this file.
/// <reference path="./node-compat.d.ts" />

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

export interface IpcClient {
  /** Send an unsolicited event to this single client. */
  send(event: string, payload: unknown): void;
}

export type IpcHandler = (
  params: unknown,
  client: IpcClient,
) => unknown | Promise<unknown>;

export interface IpcRequestMessage {
  id?: number;
  method: string;
  params?: unknown;
}

export interface IpcServer {
  /** Register a handler for a request/command method. */
  handle(method: string, handler: IpcHandler): void;
  /** Push an event to every connected client. */
  broadcast(event: string, payload: unknown): void;
  /** Number of currently connected clients. */
  clientCount(): number;
  /** Stop listening and drop all clients (call on config reload/disable). */
  close(): void;
}

/**
 * Default socket path, namespaced by the Wayland display so multiple ShojiWM
 * instances do not collide. External clients should derive the same path.
 */
export function defaultSocketPath(): string {
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {};
  const runtimeDir = env.XDG_RUNTIME_DIR ?? "/tmp";
  const display = env.WAYLAND_DISPLAY ?? "wayland-0";
  return `${runtimeDir}/shojiwm-${display}.sock`;
}

export function createIpcServer(
  socketPath: string = defaultSocketPath(),
): IpcServer {
  // Clear a stale socket left behind by a previous run so `listen` succeeds.
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // best effort
    }
  }

  const handlers = new Map<string, IpcHandler>();
  const sockets = new Set<Socket>();

  const writeFrame = (socket: Socket, message: unknown): void => {
    try {
      socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      sockets.delete(socket);
    }
  };

  const dispatch = async (socket: Socket, line: string): Promise<void> => {
    let request: IpcRequestMessage;
    try {
      request = JSON.parse(line) as IpcRequestMessage;
    } catch {
      return;
    }

    const handler = handlers.get(request.method);
    const client: IpcClient = {
      send: (event, payload) => writeFrame(socket, { event, payload }),
    };

    if (!handler) {
      if (request.id != null) {
        writeFrame(socket, {
          id: request.id,
          error: `unknown method: ${request.method}`,
        });
      }
      return;
    }

    try {
      const result = await handler(request.params, client);
      if (request.id != null) {
        writeFrame(socket, { id: request.id, result });
      }
    } catch (error) {
      if (request.id != null) {
        writeFrame(socket, { id: request.id, error: String(error) });
      }
    }
  };

  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    sockets.add(socket);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line.length > 0) {
          void dispatch(socket, line);
        }
      }
    });
    socket.on("error", () => sockets.delete(socket));
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("error", (error) => {
    console.error("[shoji-ipc] server error:", String(error));
  });
  server.listen(socketPath);

  return {
    handle(method, handler) {
      handlers.set(method, handler);
    },
    broadcast(event, payload) {
      const frame = `${JSON.stringify({ event, payload })}\n`;
      for (const socket of [...sockets]) {
        try {
          socket.write(frame);
        } catch {
          sockets.delete(socket);
        }
      }
    },
    clientCount() {
      return sockets.size;
    },
    close() {
      for (const socket of [...sockets]) {
        try {
          socket.destroy();
        } catch {
          // best effort
        }
      }
      sockets.clear();
      server.close();
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // best effort
        }
      }
    },
  };
}
