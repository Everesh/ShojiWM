declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function resolve(...paths: string[]): string;
}

declare module "node:net" {
  export interface Socket {
    write(data: string): boolean;
    setEncoding(encoding: string): this;
    destroy(): void;
    on(event: "data", listener: (chunk: string) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export interface Server {
    listen(path: string, listener?: () => void): this;
    close(callback?: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export function createServer(
    connectionListener: (socket: Socket) => void,
  ): Server;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function unlinkSync(path: string): void;
}

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};
