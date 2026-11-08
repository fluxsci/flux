// Small shell-facing state. Runner IO and the approval UI load separately.
import { writable } from "svelte/store";
import type { RunnerDriver, RunnerEvent, RunnerPayload } from "../../lib/project/types";
import type { Transcript } from "../../lib/agent/transcript";
// One availability store: the recipient lists (F2) read it, background runs set it.
export { backgroundAvailable } from "../agent/backgroundAvailability";
export const backgroundDrivers = writable<RunnerDriver[]>([]);
export interface BackgroundRun {
  runId: string; itemId: string; root: string; driver: RunnerDriver; sessionId?: string;
  name?: string; display?: string; state: string; reason?: string; error?: string;
  tools: Extract<RunnerPayload, { type: "tool" }>[];
  message: string; usage?: Extract<RunnerPayload, { type: "usage" }>;
  /** Everything the run said and did, folded by the shared reducer (what the Inbox renders). */
  transcript: Transcript;
  /** When the current turn started (the elapsed counter). */
  startedAt: number;
}
export const backgroundRuns = writable<ReadonlyMap<string, BackgroundRun>>(new Map());
export const backgroundPermissions = writable<(Extract<RunnerEvent, { type: "permission" }>)[]>([]);
