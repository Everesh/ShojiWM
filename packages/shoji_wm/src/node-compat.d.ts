declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function resolve(...paths: string[]): string;
}

declare module "node:net" {
  export interface SocketOptions {
    fd?: number;
    readable?: boolean;
    writable?: boolean;
  }
  export class Socket {
    constructor(options?: SocketOptions);
    write(data: string | Uint8Array): boolean;
    setEncoding(encoding: string): this;
    destroy(): void;
    on(event: "data", listener: (chunk: string) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: unknown) => void): this;
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
  export function writeSync(fd: number, buffer: Uint8Array): number;
  export function write(
    fd: number,
    buffer: Uint8Array,
    callback: (err: Error | null, bytesWritten: number) => void,
  ): void;
}

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};

declare const Buffer: {
  from(data: ArrayLike<number>): Uint8Array;
};
