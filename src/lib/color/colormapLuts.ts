// The full colormap tables, loaded on demand (colour-system plan A7.2).
//
// A live colour-scale edit may name a map ("magma"); painting it needs matplotlib's whole
// 256-entry table, which the eager bundle must not carry (verify-startup's budget; the offline
// deck runtime). The generated colormapLuts.gen.ts is imported lazily: `ensureColormapLuts()`
// loads it once, after which `colormapLut(name)` answers synchronously. Renderers that meet an
// unresolved name paint the generated colours and re-render when the table arrives; the GUI
// picker and the verbs resolve a name at write time and store the table on the element, so
// saved documents never depend on this module at all.
import type { ColormapTable } from "../plot/colorscale";

let table: Record<string, string> | null = null;
let loading: Promise<void> | null = null;
const parsed = new Map<string, ColormapTable | null>();

/** Load the tables (idempotent). */
export function ensureColormapLuts(): Promise<void> {
  if (table) return Promise.resolve();
  // the exported deck runtime leaves this chunk out (exportDeck.ts): a failed load simply keeps
  // names unresolved, and a later call may try again
  loading ??= import("./colormapLuts.gen").then((m) => { table = m.COLORMAP_LUTS; }, () => { loading = null; });
  return loading;
}
export const colormapLutsLoaded = (): boolean => table !== null;

/** Resolve a fluxplot map name — qualified (`crameri.batlow`), bare (`batlow`: the first
 *  collection that has it, in fluxplot's order matplotlib → Crameri → Tol → cmasher), the
 *  legacy `cmr.` prefix, `_r` reversed — to its full table, or null when unknown or not yet
 *  loaded. The `name` recorded is the name as given. */
export function colormapLut(name: string): ColormapTable | null {
  if (!table) return null;
  const trimmed = name.trim();
  if (parsed.has(trimmed)) return parsed.get(trimmed)!;
  const reversed = trimmed.endsWith("_r"), base = reversed ? trimmed.slice(0, -2) : trimmed;
  let key: string | undefined;
  if (base.includes(".")) {
    const [prefix, ...rest] = base.split(".");
    key = `${prefix === "cmr" ? "cmasher" : prefix}.${rest.join(".")}`;
    if (!(key in table)) key = undefined;
  } else {
    for (const id of ["mpl", "crameri", "tol", "cmasher"]) if (`${id}.${base}` in table) { key = `${id}.${base}`; break; }
  }
  const packed = key ? table[key] : undefined;
  if (!packed) { parsed.set(trimmed, null); return null; }
  const lut: string[] = [];
  for (let i = 0; i < packed.length; i += 6) lut.push("#" + packed.slice(i, i + 6));
  if (reversed) lut.reverse();
  const out: ColormapTable = { lut, name: trimmed };
  parsed.set(trimmed, out);
  return out;
}
