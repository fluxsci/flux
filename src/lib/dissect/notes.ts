import { writable } from "svelte/store";
import { fileBridge, joinPath } from "../project/types";
import { dissectionNoteRel, DISSECT_NOTE_MAX_BYTES, plotKeyFor } from "./rules";
import { listDissections } from "./loader";
import { notifyPlotsWritten } from "../plotsRail/plotIndex";

export interface PlotNote { root: string; key: string; group: string; name: string; path: string }
export interface IndexedPlotNote extends PlotNote { plot: string; text: string }
export const notesRevision = writable(0);
export function plotNote(root: string, key: string, group: string, name: string): PlotNote {
  return { root, key, group, name, path: joinPath(root, dissectionNoteRel(key, group, name)) };
}
export async function readPlotNote(note: PlotNote): Promise<string> {
  const fb = fileBridge();
  if (!fb?.readTextBounded) throw new Error("Notes need the desktop app's bounded text reader");
  const read = await fb.readTextBounded(note.path, DISSECT_NOTE_MAX_BYTES);
  if (read.truncated) throw new Error("This note exceeds the 1 MiB editing limit; open it in your text editor");
  return read.text;
}
export async function savePlotNote(note: PlotNote, text: string, expected: string | null): Promise<void> {
  const fb = fileBridge();
  if (!fb?.saveDissectionNote) throw new Error("Saving plot notes needs the desktop app");
  await fb.saveDissectionNote({ ...note, text, expected });
  notesRevision.update(n => n + 1);
  notifyPlotsWritten([note.path]);
}
export async function listPlotNotes(root: string, key: string): Promise<PlotNote[]> {
  const listing = await listDissections(root, key, { ownEpoch: true });
  return (listing.groups ?? []).flatMap(group => group.files.filter(f => /\.txt$/i.test(f.name)).map(f => plotNote(root, key, group.name, f.name)));
}
/** Bounded IO, no query-driven filesystem scans. The caller owns cancellation and invalidation. */
export async function indexPlotNotes(root: string, plots: { abs: string }[], signal: AbortSignal): Promise<{ notes: IndexedPlotNote[]; incomplete: boolean; errors: number }> {
  const owners = [...new Map(plots.map(p => [plotKeyFor(p.abs, root), p.abs])).entries()].filter(([key]) => key);
  const notes: IndexedPlotNote[] = [];
  let cursor = 0, bytes = 0, incomplete = false, errors = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!signal.aborted && cursor < owners.length && !incomplete) {
      const [key, plot] = owners[cursor++];
      try {
        for (const note of await listPlotNotes(root, key)) {
          if (signal.aborted) return;
          if (notes.length >= 10000 || bytes >= 32 * 1024 * 1024) { incomplete = true; return; }
          try { const text = await readPlotNote(note); bytes += text.length * 2; notes.push({ ...note, plot, text }); }
          catch { errors++; }
        }
      } catch { errors++; }
    }
  }));
  return { notes, incomplete, errors };
}
export function matchPlotNotes(notes: IndexedPlotNote[], query: string): (IndexedPlotNote & { snippet: string; line: number })[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  return notes.flatMap(note => {
    const i = note.text.toLocaleLowerCase().indexOf(q);
    if (i < 0) return [];
    const start = note.text.lastIndexOf("\n", i) + 1;
    const end = note.text.indexOf("\n", i);
    return [{ ...note, line: note.text.slice(0, start).split("\n").length, snippet: note.text.slice(start, end < 0 ? undefined : end).slice(0, 240) }];
  });
}
