import { derived, get, writable } from "svelte/store";

// The things every modal and keyboard handler needs from Annotate and Ask, kept in
// a dependency-free module: importing annotateChord.ts would pull the context
// builder, the target resolvers and the Reader's PDF modules into every leaf
// component (and into bundles that have no business loading them).

/** Freezes editor input and defers external model reloads until Annotate closes. */
export const annotationOpen = writable(false);

/** Ask also owns shell input while its captured context is on screen. */
export const askOpen = writable(false);

/** Capture ownership also pauses playback and defers external editor changes. */
export const captureOpen = derived([annotationOpen, askOpen], ([annotation, ask]) => annotation || ask);

/** Ctrl/⌘+Shift+M: the Annotate chord, on every surface. */
export function isAnnotateChord(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyM";
}

/** Shell-level panels that own the keyboard while docked (the AI panel, the Inbox).
 *  Each panel's own state module reports itself here, so leaf handlers never import it. */
const dockedPanels = writable<ReadonlySet<string>>(new Set());
export function setShellPanel(name: string, open: boolean): void {
  dockedPanels.update((s) => {
    if (s.has(name) === open) return s;
    const next = new Set(s);
    if (open) next.add(name); else next.delete(name);
    return next;
  });
}

/** Window-level handlers yield without swallowing the composer's own events. */
export function yieldsToShellModal(_e: Event): boolean {
  return get(captureOpen) || get(dockedPanels).size > 0;
}
