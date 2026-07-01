// The paper currently open in FluxReader. Set via openInReader() from the Library
// (a "Read" row action) or a capture; the ReaderMode subscribes and loads its PDF.
import { writable } from "svelte/store";
import { setFocusedMode } from "../../paneStore";

/** Citekey of the paper open in the reader (null = nothing open). */
export const readerKey = writable<string | null>(null);

/** Open a paper in FluxReader and focus the reader mode. */
export function openInReader(citekey: string): void {
  readerKey.set(citekey);
  setFocusedMode("reader");
}

// Dev-only: let the headless harness drive the reader (mirrors __fluxEmitCapture).
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __fluxOpenReader?: (k: string) => void }).__fluxOpenReader = openInReader;
}
