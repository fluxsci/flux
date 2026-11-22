/**
 * The order in which a window's TIFFs are answered and converted (one batch per window at a time). Pure: the import
 * flow (`fluximg/tiffImport.ts`) adds files as they are probed, asks the batch what to do next and tells it what
 * happened; the gate drives the same object.
 *
 * Nothing a person dropped may vanish. Files that arrive while a question is open join the SAME batch: one of the
 * kind being asked about (same structural fingerprint) is answered by that answer, and the question counts it; one
 * of another kind waits its turn, after the current file converts or is cancelled. Leaving a question (Esc) leaves
 * out exactly the files of that kind, including any that arrive later in the batch, and names them.
 */

export interface BatchFile {
  id: string;
  label: string;
  fingerprint: string;
  /** Converts without a question (metadata or a remembered rule settle everything). */
  ready: boolean;
}

export type BatchStep<T extends BatchFile> =
  | { file: T; how: "family" }   // a file of a kind already answered in this batch: try that answer first
  | { file: T; how: "ready" }    // the file's own metadata (or a remembered rule) answers it
  | { file: T; how: "ask" };     // a person answers it

export class TiffBatch<T extends BatchFile = BatchFile> {
  readonly files: T[] = [];
  private readonly settled = new Set<string>();
  private readonly answered = new Set<string>();
  private readonly leftOut = new Set<string>();
  /** The file whose question is open (or which is converting). */
  current: T | null = null;

  /** A file joins the batch; returns the labels left out at once (its kind's question was already left). */
  add(file: T): string[] {
    this.files.push(file);
    if (this.leftOut.has(file.fingerprint)) { this.settled.add(file.id); return [file.label]; }
    return [];
  }
  /** The next file to handle, in arrival order, and how; null when every file is settled. */
  next(): BatchStep<T> | null {
    const file = this.files.find((f) => !this.settled.has(f.id));
    if (!file) { this.current = null; return null; }
    this.current = file;
    return { file, how: this.answered.has(file.fingerprint) ? "family" : file.ready ? "ready" : "ask" };
  }
  /** A person answered `fingerprint`: the batch's other files of that kind follow the answer. */
  answer(fingerprint: string): void { this.answered.add(fingerprint); }
  /** The file is done (converted, failed, or left out on its own). */
  settle(file: T): void { this.settled.add(file.id); if (this.current?.id === file.id) this.current = null; }
  /** The question of `fingerprint` was left: every unsettled file of that kind (and any that arrives later) is left
   *  out; returns their labels. */
  leave(fingerprint: string): string[] {
    this.leftOut.add(fingerprint);
    const out: string[] = [];
    for (const f of this.files) if (f.fingerprint === fingerprint && !this.settled.has(f.id)) { this.settled.add(f.id); out.push(f.label); }
    if (this.current?.fingerprint === fingerprint) this.current = null;
    return out;
  }
  /** Everything not yet settled (a Cancel of the whole batch names them). */
  unsettled(): T[] { return this.files.filter((f) => !this.settled.has(f.id)); }
  /** For the question about `file`: how many files of its kind it answers, and how many of other kinds wait. */
  counts(file: T): { kind: number; waiting: number } {
    const open = this.files.filter((f) => !this.settled.has(f.id));
    return { kind: open.filter((f) => f.fingerprint === file.fingerprint).length, waiting: open.filter((f) => f.fingerprint !== file.fingerprint).length };
  }
}
