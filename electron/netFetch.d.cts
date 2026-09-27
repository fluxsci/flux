/// <reference types="node" />
export const NET_PARTITION: string;
export function publicHttpUrl(raw: unknown): string | null;
export function isPrivateAddress(address: unknown): boolean;
export function assertPublicResolved(hostname: string, lookup?: (hostname: string, options: {all: true; verbatim: true}) => Promise<Array<{address: string; family: number}>>): Promise<void>;
export function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer>;
export function createNetGet(options: {session: any; getKey?: (name: string) => string | undefined; allowPrivate?: boolean; partition?: string; timeouts?: {bytes?: number; meta?: number}; lookup?: typeof import("node:dns").promises.lookup}): (url: string, mode?: "json" | "text" | "bytes") => Promise<{error?: string; status?: number; json?: unknown; text?: string; bytesB64?: string; contentType?: string; finalUrl?: string}>;
