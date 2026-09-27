// ---------------------------------------------------------------------------
// Store tenancy (slide-migration §3.2.1) — the defense-in-depth backstop for
// the ONE app-global figure store being shared by two modes.
//
// The figure editor's stores (src/lib/store.ts `project`, selection, viewport,
// history) are an app-wide singleton. Slide mode LOADS THE DECK'S SLIDES INTO
// THAT STORE (projected as figures) so the whole figure editing suite operates
// on them; figure mode loads fig/ into the same store. The shell guarantees
// the two modes are never resident together (mutual eviction), but the
// persistence bridges must be structurally unable to write the wrong folder
// even if the shell logic regresses: a kept-alive FigureMode autosave firing
// against a deck-projected store would write the deck's slides into fig/ —
// the worst-case corruption.
//
// figbridge.saveFigFrom asserts tenant === "figure"; slideBridge.saveDeckFrom
// asserts tenant === "slide". A refusal throws — it surfaces through the
// autosave error path (sticky toast), never a wrong-folder write.
// ---------------------------------------------------------------------------

import { get, writable } from "svelte/store";
export type StoreTenant = "figure" | "slide";

// Read at save time, set in mode lifecycles; context observers also subscribe.
export const storeTenantState = writable<StoreTenant>("figure");

export function storeTenant(): StoreTenant {
  return get(storeTenantState);
}

/** Claim the shared figure store for a mode. Call BEFORE loading content into
 *  it (FigureMode / SlideMode onMount, after evicting the other mode). */
export function setStoreTenant(t: StoreTenant): void {
  storeTenantState.set(t);
}

/** Throw unless `expected` currently owns the shared store. `action` names the
 *  refused write for the error surface. */
export function assertStoreTenant(expected: StoreTenant, action: string): void {
  const tenant = storeTenant();
  if (tenant !== expected) {
    throw new Error(
      `${action} refused: the editing store is owned by ${tenant} mode (expected ${expected}). ` +
        `This is the tenancy guard that prevents cross-subsystem writes — nothing was written.`,
    );
  }
}
