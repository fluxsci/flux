// The Manuscript Check runner for the Paper pane (Alt+K): one lazily created
// module worker, latest-wins. A request made while another is in flight
// replaces any request still waiting, so a burst of idle ticks costs at most
// one queued run. If the worker cannot start (or dies), the run falls back to
// the same pure call on the main thread in a macrotask — results are never
// lost, only slower.
import { checkManuscript, type CheckInput, type CheckResult } from "../../../../lib/manuscript/checks/index";

export interface CheckRun {
  result: CheckResult;
  /** Time inside the check itself. */
  ms: number;
  mode: "worker" | "main";
}

type Job = { id: number; input: CheckInput; resolve: (run: CheckRun | null) => void };

let worker: Worker | null = null;
let ready = false;
let serial = 0;
let active: Job | null = null;
let waiting: Job | null = null;
let initTimer: ReturnType<typeof setTimeout> | undefined;

/** Dev/gate telemetry: how many runs, where, and how long the last took. */
export const checkTelemetry = { runs: 0, workerRuns: 0, mainRuns: 0, lastMs: 0, lastMode: "" as "" | "worker" | "main" };

function record(run: CheckRun): CheckRun {
  checkTelemetry.runs++;
  if (run.mode === "worker") checkTelemetry.workerRuns++;
  else checkTelemetry.mainRuns++;
  checkTelemetry.lastMs = run.ms;
  checkTelemetry.lastMode = run.mode;
  return run;
}

function runOnMain(job: Job): void {
  setTimeout(() => {
    const t0 = performance.now();
    let run: CheckRun | null = null;
    try {
      run = record({ result: checkManuscript(job.input), ms: performance.now() - t0, mode: "main" });
    } catch (error) {
      console.error("[flux] manuscript check failed", error);
    }
    job.resolve(run);
  }, 0);
}

function dropWorker(): void {
  clearTimeout(initTimer);
  worker?.terminate();
  worker = null;
  ready = false;
}

function finish(run: CheckRun | null): void {
  const job = active;
  active = null;
  job?.resolve(run);
  pump();
}

function pump(): void {
  if (active || !waiting) return;
  if (typeof Worker === "undefined") {
    const job = waiting;
    waiting = null;
    runOnMain(job);
    return;
  }
  if (!worker) {
    try {
      worker = new Worker(new URL("./manuscriptCheck.worker.ts", import.meta.url), { type: "module", name: "flux-manuscript-check" });
    } catch {
      worker = null;
      const job = waiting;
      waiting = null;
      runOnMain(job);
      return;
    }
    const owner = worker;
    worker.onmessage = (e: MessageEvent) => {
      if (worker !== owner) return;
      if (e.data?.ready) {
        clearTimeout(initTimer);
        ready = true;
        pump();
        return;
      }
      if (!active || e.data?.id !== active.id) return;
      if (e.data.error) {
        console.error("[flux] manuscript check failed", e.data.error);
        finish(null);
      } else finish(record({ result: e.data.result as CheckResult, ms: e.data.ms as number, mode: "worker" }));
    };
    worker.onerror = () => {
      if (worker !== owner) return;
      const job = active;
      active = null;
      dropWorker();
      if (job) runOnMain(job);
      pump();
    };
    initTimer = setTimeout(() => {
      if (worker !== owner || ready) return;
      dropWorker();
      const job = waiting;
      waiting = null;
      if (job) runOnMain(job);
    }, 5000);
  }
  if (!ready) return;
  active = waiting;
  waiting = null;
  worker.postMessage({ id: active.id, input: active.input });
}

/** Run the checks; resolves null when superseded by a newer request before it
 *  started (the caller simply keeps the newer result). */
export function runManuscriptCheck(input: CheckInput): Promise<CheckRun | null> {
  if (import.meta.env?.DEV && typeof window !== "undefined") {
    // Published per run: the dev handle is rebuilt wholesale at startup.
    const w = window as unknown as { __flux?: Record<string, unknown> };
    if (w.__flux) w.__flux.manuscriptCheck = checkTelemetry;
  }
  return new Promise((resolve) => {
    waiting?.resolve(null);
    waiting = { id: ++serial, input, resolve };
    pump();
  });
}

