// Small shell-facing state. Runner IO and the approval UI load separately.
import { writable } from "svelte/store";
import type { RunnerDriver, RunnerEvent, RunnerPayload } from "../../lib/project/types";
export const backgroundAvailable = writable(false);
export const backgroundDrivers = writable<RunnerDriver[]>([]);
export interface BackgroundRun {
  runId: string; itemId: string; root: string; driver: RunnerDriver; sessionId?: string;
  name?: string; display?: string; state: string; reason?: string; error?: string;
  tools: Extract<RunnerPayload, { type: "tool" }>[];
  message: string; usage?: Extract<RunnerPayload, { type: "usage" }>;
}
export const backgroundRuns = writable<ReadonlyMap<string, BackgroundRun>>(new Map());
export const backgroundPermissions = writable<(Extract<RunnerEvent, { type: "permission" }>)[]>([]);
