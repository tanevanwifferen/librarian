// src/types/shims.d.ts
// What: Minimal ambient type shims to allow TypeScript to compile before dependencies are installed.
// How: Declares loose modules and globals for Node/third-party packages to suppress editor errors.
//      These are pragmatic placeholders; when you run `npm install`, the real types from @types/* and packages
//      will take precedence. Safe to keep; they only provide `any`-like coverage.

declare var process: any;
declare const Buffer: any;

// Node built-ins
declare module 'fs/promises' {
  const anyExport: any;
  export default anyExport;
}
declare module 'path' {
  const anyExport: any;
  export default anyExport;
}
declare module 'child_process' {
  export const spawn: any;
}
declare module 'crypto' {
  export function randomBytes(size: number): { toString: (enc: string) => string };
}

// Third-party libs
declare module 'express' {
  export type Request = any;
  export type Response = any;
  export type NextFunction = any;
  export function Router(...args: any[]): any;
  const e: any;
  export default e;
}
declare module 'pg' {
  export class Pool {
    constructor(opts?: any);
    connect(): Promise<any>;
    query: any;
    end: any;
  }
  export type QueryResult<T = any> = { rows: T[]; rowCount: number };
}
declare module 'openai' {
  export default class OpenAI {
    constructor(opts?: any);
    embeddings: { create: (opts: any) => Promise<any> };
    chat: { completions: { create: (opts: any) => Promise<any> } };
  }
}
declare module 'pino' {
  export type Logger = any;
  export type LoggerOptions = any;
  export default function pino(opts?: any): any;
}
declare module 'p-limit' {
  export default function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T>;
}
declare module 'uuid' {
  export function v4(): string;
}
declare module 'zod' {
  export const z: any;
  export default z;
}
declare module 'dotenv/config' {
  // side-effect import only
}