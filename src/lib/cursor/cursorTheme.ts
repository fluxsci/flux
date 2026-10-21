// Writes the user's cursor family onto :root (2026-10-21). The DEFAULT family is
// static in styles/cursors.css (first paint, no JS); when Settings → Figure →
// Cursor differs from the defaults this module sets the same `--cursor-*`
// custom properties inline on <html>, and clears them again when the settings
// return to the defaults. It runs once per settings change — never per hover,
// never per frame — so the cursor FIREWALL (every `.el` wrapper carries a
// constant `cursor`; host flips are per gesture) is untouched: a settings
// change is one style recalc, which is the cost of changing the cursor at all.
import { settings, type Settings } from "../settings";
import { buildCursorFamily, cursorVar, CURSOR_STATES, isDefaultCursorParams, type CursorParams } from "./cursorFamily";

/** The builder's parameters from the persisted settings (the one mapping). */
export function cursorParamsFromSettings(s: Settings): Partial<CursorParams> {
  return {
    size: s.cursorSize,
    stroke: s.cursorStroke,
    halo: s.cursorHalo,
    gap: s.cursorGap,
    centre: s.cursorCentre,
    hoverDot: s.cursorHoverDot,
    pressContract: s.cursorPressContract,
    scheme: s.cursorScheme,
    resizeStyle: s.cursorResizeStyle,
  };
}

/** Apply (or clear) the family on `root`. Returns what it did, for the gates. */
export function applyCursorFamily(s: Settings, root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): "defaults" | "custom" {
  const params = cursorParamsFromSettings(s);
  if (!root) return isDefaultCursorParams(params) ? "defaults" : "custom";
  if (isDefaultCursorParams(params)) {
    for (const st of CURSOR_STATES) root.style.removeProperty(cursorVar(st));
    return "defaults";
  }
  const fam = buildCursorFamily(params);
  for (const st of CURSOR_STATES) root.style.setProperty(cursorVar(st), fam[st].css);
  return "custom";
}

let last = "";
/** Subscribe once (main.ts). Re-applies only when a cursor setting changed. */
export function startCursorTheme(): () => void {
  return settings.subscribe((s) => {
    const key = JSON.stringify(cursorParamsFromSettings(s));
    if (key === last) return;
    last = key;
    applyCursorFamily(s);
  });
}
