// The paper currently open in FluxReader. Set via openInReader() from the Library
// (a "Read" row action) or a capture; the ReaderMode subscribes and loads its PDF.
import { writable } from "svelte/store";
import { setFocusedMode } from "../../paneStore";

/** Citekey of the paper open in the reader (null = nothing open). */
export const readerKey = writable<string | null>(null);

// 2.3: a pending find-in-document intent carried alongside the open. Bumped on every
// openInReader so the ReaderDoc's effect always re-runs (even when re-opening the
// already-open paper to jump to a new full-text match). `term:""` means "no find —
// close any transient search bar". nonce disambiguates repeat opens with the same term.
// `key` addresses the intent to one paper: a freshly-mounted ReaderDoc must not adopt
// a stale find left over from an earlier open of a different paper.
export interface ReaderFind {
  key: string;
  term: string;
  nonce: number;
}
export const readerFind = writable<ReaderFind>({ key: "", term: "", nonce: 0 });
let findNonce = 0;

/** Open a paper in FluxReader and focus the reader mode; optionally jump to a find term. */
export function openInReader(citekey: string, opts?: { find?: string }): void {
  readerKey.set(citekey);
  readerFind.set({ key: citekey, term: opts?.find?.trim() ?? "", nonce: ++findNonce });
  setFocusedMode("reader");
}

// Dev-only: let the headless harness drive the reader (mirrors __fluxEmitCapture) and
// observe the live store values. A dynamic import of this module in a page.evaluate()
// yields a SECOND module instance in dev, so tests can't read the stores directly — we
// mirror them onto window from the app's own instance instead.
if (import.meta.env?.DEV && typeof window !== "undefined") {
  const w = window as unknown as {
    __fluxOpenReader?: (k: string, opts?: { find?: string }) => void;
    __fluxReaderKey?: string | null;
    __fluxReaderFind?: ReaderFind;
  };
  w.__fluxOpenReader = openInReader;
  readerKey.subscribe((k) => (w.__fluxReaderKey = k));
  readerFind.subscribe((f) => (w.__fluxReaderFind = f));
}
