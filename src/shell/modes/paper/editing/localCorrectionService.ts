import type { LocalLintRecord } from "./localCorrectionCore";

export type LocalCorrectionEngineStatus = "loading" | "ready" | "error";

type WorkerReply =
  | { type: "ready" }
  | { type: "lints"; id: number; lints: LocalLintRecord[]; elapsedMs: number }
  | { type: "error"; id?: number; message: string };

interface Pending {
  scope?: string;
  resolve: (value: LocalLintRecord[]) => void;
  reject: (error: Error) => void;
}

class LocalCorrectionService {
  private worker: Worker | null = null;
  private status: LocalCorrectionEngineStatus = "loading";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(status: LocalCorrectionEngineStatus) => void>();
  private vocabulary = new Set<string>();
  private projectKey = "";
  private dialect: "american" | "british" | "canadian" | "australian" = "american";

  subscribe(listener: (status: LocalCorrectionEngineStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.worker ? this.status : "loading");
    return () => this.listeners.delete(listener);
  }

  warm(projectKey: string, words: readonly string[] = []): void {
    const projectChanged = this.selectProject(projectKey);
    this.mergeVocabulary(words, false);
    if (this.worker) {
      if (projectChanged) {
        this.worker.postMessage({ type: "words", words: [...this.vocabulary] });
      }
      // Re-publish readiness when a preference is toggled back on. The worker
      // stays warm while disabled, so there may be no natural status event.
      this.setStatus(this.status);
      return;
    }
    this.setStatus("loading");
    const worker = new Worker(new URL("./localCorrection.worker.ts", import.meta.url), {
      type: "module",
      name: "flux-local-corrections",
    });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => { if (this.worker === worker) this.onMessage(event.data); };
    worker.onerror = (event) => { if (this.worker === worker) this.fail(new Error(event.message || "Local correction worker failed")); };
    worker.postMessage({ type: "init", words: [...this.vocabulary] });
    if (this.dialect !== "american") {
      worker.postMessage({ type: "dialect", dialect: this.dialect, words: [...this.vocabulary] });
    }
  }

  updateVocabulary(projectKey: string, words: readonly string[]): void {
    const projectChanged = this.selectProject(projectKey);
    const vocabularyChanged = this.mergeVocabulary(words, true);
    if ((!projectChanged && !vocabularyChanged) || !this.worker) return;
    this.worker.postMessage({ type: "words", words: [...this.vocabulary] });
  }

  replaceVocabulary(projectKey: string, words: readonly string[]): void {
    this.selectProject(projectKey);
    this.vocabulary.clear();
    this.mergeVocabulary(words, false);
    if (this.worker) this.worker.postMessage({ type: "words", words: [...this.vocabulary] });
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
    this.worker?.postMessage({ type: "dialect", dialect, words: [...this.vocabulary] });
  }

  /**
   * `focus` is the window's correctable sub-range. Lints outside it are context
   * the caller will discard, so the worker skips the expensive mechanical
   * rescue search for them — that search costs tens of milliseconds PER unknown
   * word, and a sentence-wide window would otherwise re-pay it for every term
   * in the sentence on every completed word.
   */
  lint(text: string, focus?: { from: number; to: number }, mode: "repair" | "lintOnly" = "repair", scope?: string): Promise<LocalLintRecord[]> {
    if (!this.worker) this.warm(this.projectKey || "default");
    if (!this.worker || this.status === "error") {
      return Promise.reject(new Error("Local correction engine is unavailable"));
    }
    if (this.pending.size >= 128) return Promise.reject(new Error("Local correction queue is full; newer input will be checked next"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, scope });
      this.worker!.postMessage({ type: "lint", id, text, mode, ...(focus ? { focus } : {}) });
    });
  }

  cancelScope(scope: string): void {
    const ids: number[] = [];
    for (const [id, request] of this.pending) if (request.scope === scope) {
      ids.push(id); this.pending.delete(id); request.resolve([]);
    }
    if (ids.length) this.worker?.postMessage({ type: "cancel", ids });
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

  private onMessage(reply: WorkerReply): void {
    if (reply.type === "ready") {
      this.setStatus("ready");
      return;
    }
    if (reply.type === "error") {
      const error = new Error(reply.message);
      if (reply.id != null) {
        this.pending.get(reply.id)?.reject(error);
        this.pending.delete(reply.id);
      } else {
        this.fail(error);
      }
      return;
    }
    const pending = this.pending.get(reply.id);
    this.pending.delete(reply.id);
    pending?.resolve(reply.lints);
  }

  private fail(error: Error): void {
    this.setStatus("error");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private setStatus(status: LocalCorrectionEngineStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

export const localCorrectionService = new LocalCorrectionService();
