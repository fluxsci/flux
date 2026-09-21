export interface OperationLease { dir: string; name: string; client: string; token: string; pid: number; host: string; ts: string }
export type AcquireResult = { ok: true; lease: OperationLease } | { ok: false; heldBy: string; info: Partial<OperationLease> };
export function acquire(dir: string, name: string, client: string, options?: {ttlMs?: number}): Promise<AcquireResult>;
export function release(lease: OperationLease): Promise<boolean>;
export function renew(lease: OperationLease): Promise<boolean>;
export function inspect(dir: string, name: string): Promise<OperationLease | null>;
export function assertOwned(lease: OperationLease): Promise<void>;
export function queued<T>(dir: string, name: string, fn: (canonicalDir: string) => Promise<T>): Promise<T>;
export function stale(info: Partial<OperationLease> | null, ttl?: number): boolean;
export function canonicalDir(dir: string): Promise<string>;
