export const RETIRED_KEYS: readonly string[];
export function withoutRetiredKeys<T>(map: T): T;
export type CleanupStatus = "absent" | "removed" | "clean" | "malformed" | "busy" | "not-a-file" | "failed" | "skipped";
export function cleanupRetiredLibraryProxy(opts: { fluxLibDir: string; client?: string }): Promise<{ credentials: CleanupStatus; keys: CleanupStatus }>;
export function removeRetiredSessionPartition(opts: { userDataDir: string; session?: unknown }): Promise<"absent" | "removed" | "cleared" | "failed" | "skipped">;
