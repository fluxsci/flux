import type { LocalLintRecord } from "./localCorrectionCore";

export type LocalCorrectionEngineStatus = "loading" | "ready" | "error";

/**
 * Annotation-only work runs on its OWN linter. One `linter.lint()` call is a
 * single indivisible WASM operation: a window of unfamiliar scientific words
 * costs SECONDS (17 of them measured at 1.6s of pure WASM time), and nothing
 * — not the worker's queue priority, not a cancel — can preempt it once it has
 * started. Queue order alone therefore cannot keep the live lanes responsive
 * behind a backlog scan; only a second thread can. The live lane is the one
 * the editor waits on, so it must never queue behind annotation work.
 * `verify-v020-paper-workers` pins the resulting budget.
 */
export type CorrectionLane = "live" | "background";

type WorkerReply =
  | { type: "ready" }
  | { type: "lints"; id: number; lints: LocalLintRecord[]; elapsedMs: number }
  | { type: "error"; id?: number; message: string };

interface Pending {
  scope?: string;
  lane: CorrectionLane;
  resolve: (value: LocalLintRecord[]) => void;
  reject: (error: Error) => void;
}

interface LaneState {
  worker: Worker;
  status: LocalCorrectionEngineStatus;
}

class LocalCorrectionService {
  private lanes = new Map<CorrectionLane, LaneState>();
  private status: LocalCorrectionEngineStatus = "loading";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(status: LocalCorrectionEngineStatus) => void>();
  private vocabulary = new Set<string>();
  private projectKey = "";
  private dialect: "american" | "british" | "canadian" | "australian" = "american";

  subscribe(listener: (status: LocalCorrectionEngineStatus) => void): () => void {
    this.listeners.add(listener);
    // The published status is the LIVE lane's: it is the one the editor waits
    // on. A background lane that dies takes its own annotations down with it.
    listener(this.lanes.has("live") ? this.status : "loading");
    return () => this.listeners.delete(listener);
  }

  warm(projectKey: string, words: readonly string[] = []): void {
    const projectChanged = this.selectProject(projectKey);
    this.mergeVocabulary(words, false);
    if (this.lanes.has("live")) {
      if (projectChanged) this.broadcast({ type: "words", words: [...this.vocabulary] });
      // Re-publish readiness when a preference is toggled back on. The worker
      // stays warm while disabled, so there may be no natural status event.
      this.setStatus(this.status);
      return;
    }
    // Warming never starts the background lane: it stays lazy until a caller
    // actually asks for annotation-only work.
    this.ensureLane("live");
  }

  updateVocabulary(projectKey: string, words: readonly string[]): void {
    const projectChanged = this.selectProject(projectKey);
    const vocabularyChanged = this.mergeVocabulary(words, true);
    if ((!projectChanged && !vocabularyChanged) || !this.lanes.size) return;
    this.broadcast({ type: "words", words: [...this.vocabulary] });
  }

  replaceVocabulary(projectKey: string, words: readonly string[]): void {
    this.selectProject(projectKey);
    this.vocabulary.clear();
    this.mergeVocabulary(words, false);
    this.broadcast({ type: "words", words: [...this.vocabulary] });
  }

  setDialect(
    projectKey: string,
    dialect: "american" | "british" | "canadian" | "australian",
    words: readonly string[],
  ): void {
    this.selectProject(projectKey);
    if (dialect === this.dialect) return;
    this.dialect = dialect;
    this.vocabulary = new Set(words.map((word) => word.trim()).filter(Boolean));
    this.broadcast({ type: "dialect", dialect, words: [...this.vocabulary] });
  }

  /**
   * `focus` is the window's correctable sub-range. Lints outside it are context
   * the caller will discard, so the worker skips the expensive mechanical
   * rescue search for them — that search costs tens of milliseconds PER unknown
   * word, and a sentence-wide window would otherwise re-pay it for every term
   * in the sentence on every completed word.
   *
   * `lane` defaults from the mode: a repair belongs to a live editing lane,
   * while `lintOnly` is annotation-only work that must not delay one. A
   * latency-bound check that merely happens to be `lintOnly` passes `"live"`
   * explicitly rather than queueing behind a backlog window.
   */
  lint(
    text: string,
    focus?: { from: number; to: number },
    mode: "repair" | "lintOnly" = "repair",
    scope?: string,
    lane: CorrectionLane = mode === "lintOnly" ? "background" : "live",
  ): Promise<LocalLintRecord[]> {
    if (!this.lanes.has("live")) this.warm(this.projectKey || "default");
    const target = this.ensureLane(lane);
    if (!target || target.status === "error") {
      return Promise.reject(new Error("Local correction engine is unavailable"));
    }
    if (this.pending.size >= 128) return Promise.reject(new Error("Local correction queue is full; newer input will be checked next"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, scope, lane });
      target.worker.postMessage({ type: "lint", id, text, mode, ...(focus ? { focus } : {}) });
    });
  }

  cancelScope(scope: string): void {
    const byLane = new Map<CorrectionLane, number[]>();
    for (const [id, request] of this.pending) if (request.scope === scope) {
      this.pending.delete(id); request.resolve([]);
      const ids = byLane.get(request.lane);
      if (ids) ids.push(id); else byLane.set(request.lane, [id]);
    }
    for (const [lane, ids] of byLane) this.lanes.get(lane)?.worker.postMessage({ type: "cancel", ids });
  }

  private ensureLane(lane: CorrectionLane): LaneState | null {
    const existing = this.lanes.get(lane);
    if (existing) return existing;
    if (lane === "live") this.setStatus("loading");
    const worker = new Worker(new URL("./localCorrection.worker.ts", import.meta.url), {
      type: "module",
      name: lane === "live" ? "flux-local-corrections" : "flux-local-corrections-backlog",
    });
    const state: LaneState = { worker, status: "loading" };
    this.lanes.set(lane, state);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => { if (this.lanes.get(lane) === state) this.onMessage(lane, event.data); };
    worker.onerror = (event) => { if (this.lanes.get(lane) === state) this.fail(lane, new Error(event.message || "Local correction worker failed")); };
    worker.postMessage({ type: "init", words: [...this.vocabulary] });
    if (this.dialect !== "american") {
      worker.postMessage({ type: "dialect", dialect: this.dialect, words: [...this.vocabulary] });
    }
    return state;
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const lane of this.lanes.values()) lane.worker.postMessage(message);
  }

  private selectProject(projectKey: string): boolean {
    const normalized = projectKey.trim() || "default";
    if (normalized === this.projectKey) return false;
    this.projectKey = normalized;
    // Harper's imported dictionary is replaceable. Clearing it here keeps a
    // term learned in one Flux project from silently affecting another.
    this.vocabulary.clear();
    return true;
  }

  private mergeVocabulary(words: readonly string[], notify: boolean): boolean {
    let changed = false;
    for (const word of words) {
      const clean = word.trim();
      if (!clean || this.vocabulary.has(clean)) continue;
      this.vocabulary.add(clean);
      changed = true;
    }
    if (changed && notify && this.status === "error") this.setStatus("loading");
    return changed;
  }

  private onMessage(lane: CorrectionLane, reply: WorkerReply): void {
    if (reply.type === "ready") {
      this.setLaneStatus(lane, "ready");
      return;
    }
    if (reply.type === "error") {
      const error = new Error(reply.message);
      if (reply.id != null) {
        this.pending.get(reply.id)?.reject(error);
        this.pending.delete(reply.id);
      } else {
        this.fail(lane, error);
      }
      return;
    }
    const pending = this.pending.get(reply.id);
    this.pending.delete(reply.id);
    pending?.resolve(reply.lints);
  }

  private fail(lane: CorrectionLane, error: Error): void {
    this.setLaneStatus(lane, "error");
    for (const [id, pending] of this.pending) if (pending.lane === lane) {
      pending.reject(error);
      this.pending.delete(id);
    }
    // Drop the lane so the next request rebuilds it, exactly as a failed single
    // worker used to be re-warmed on the following lint.
    this.lanes.get(lane)?.worker.terminate();
    this.lanes.delete(lane);
  }

  private setLaneStatus(lane: CorrectionLane, status: LocalCorrectionEngineStatus): void {
    const state = this.lanes.get(lane);
    if (state) state.status = status;
    if (lane === "live") this.setStatus(status);
  }

  private setStatus(status: LocalCorrectionEngineStatus): void {
    this.status = status;
    const live = this.lanes.get("live");
    if (live) live.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

export const localCorrectionService = new LocalCorrectionService();
