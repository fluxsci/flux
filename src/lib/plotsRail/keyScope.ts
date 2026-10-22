// Keyboard ownership for the Plots rail. The rail is a `data-command-scope="plots-rail"` region:
// while focus is inside it, its keys are its own — tool letters type into search, arrows move
// between tiles, held Space / Alt do not arm the canvas's pan or caliper.
//
// Deliberately NARROWER than the animator's blanket yield (`.animator`, which swallows undo):
// modified chords pass through to the editor's keymap, so Ctrl+Z undoes an insert made from the
// rail without leaving it, Ctrl+S saves, Ctrl+B / Ctrl+Shift+B toggle the rails.

export const PLOTS_RAIL_SCOPE = "plots-rail";

/** Whether an event's target sits inside the Plots rail. */
export function inPlotsRailScope(e: Event): boolean {
  const t = e.target;
  return t instanceof Element && !!t.closest(`[data-command-scope="${PLOTS_RAIL_SCOPE}"]`);
}

/** The editor keymap yields this key to the rail: inside the rail and not a modified chord. */
export function plotsRailOwnsKey(e: KeyboardEvent): boolean {
  return inPlotsRailScope(e) && !e.ctrlKey && !e.metaKey && !e.altKey;
}
