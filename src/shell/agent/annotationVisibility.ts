import { get, writable } from "svelte/store";

// The two things every modal and keyboard handler needs from Annotate, kept in
// a dependency-free module: importing annotateChord.ts would pull the context
// builder, the target resolvers and the Reader's PDF modules into every leaf
// component (and into bundles that have no business loading them).

/** Freezes editor input and defers external model reloads until Annotate closes. */
export const annotationOpen = writable(false);

/** Ctrl/⌘+Shift+M: the Annotate chord, on every surface. */
export function isAnnotateChord(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyM";
}

/** A shell-level panel that owns the keyboard while open (the AI panel, when docked).
 *  Its own state module drives this, so leaf handlers never import it. */
export const shellPanelOpen = writable(false);

/** Window-level handlers yield without swallowing the composer's own events. */
export function yieldsToShellModal(_e: Event): boolean {
  return get(annotationOpen) || get(shellPanelOpen);
}
