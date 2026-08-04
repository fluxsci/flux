// Figure families — the pure core of the structured figure-identity system.
// A figure's identity is (family, number): the family carries the display
// formats ("Fig. S{num}{panel}", "Figure S{num} | ") and the number is the
// figure's POSITION within its family — always contiguous 1..N, healed by
// computeFamilyNumbers on load and re-normalized by every mutation, so gaps
// and duplicates are impossible by construction. In-text refs stay anchored
// to stable `@fig-…` labels; display text is recomputed from (family, number)
// wherever it renders, so renumbering never breaks a reference.
//
// Twin-Engine shared core (flux-core → src/lib): no imports, no DOM, no Node —
// unit-gated by scripts/verify-figfamily.ts.

export interface FigureFamilyDef {
  id: string; // slug: /^[a-z][a-z0-9-]*$/
  displayName: string; // "Supplementary Figure"
  refTemplate: string; // in-text reference: "Fig. S{num}{panel}"
  captionTemplate: string; // caption lead: "Figure S{num} | "
}

export const BUILTIN_FAMILIES: readonly FigureFamilyDef[] = [
  {
    id: "figure",
    displayName: "Figure",
    refTemplate: "Fig. {num}{panel}",
    captionTemplate: "Figure {num} | ",
  },
  {
    id: "supplementary",
    displayName: "Supplementary Figure",
    refTemplate: "Fig. S{num}{panel}",
    captionTemplate: "Figure S{num} | ",
  },
  {
    id: "extended-data",
    displayName: "Extended Data Figure",
    refTemplate: "Extended Data Fig. {num}{panel}",
    captionTemplate: "Extended Data Figure {num} | ",
  },
];

export const DEFAULT_FAMILY = "figure";

export const FAMILY_ID_RE = /^[a-z][a-z0-9-]*$/;

/** Builtins first (declared order), then customs in definition order. Custom
 *  ids colliding with a builtin (or an earlier custom) are ignored, so builtin
 *  semantics can never be shadowed by project data. */
export function familyMap(
  custom?: readonly FigureFamilyDef[] | null,
): Map<string, FigureFamilyDef> {
  const m = new Map<string, FigureFamilyDef>();
  for (const f of BUILTIN_FAMILIES) m.set(f.id, f);
  for (const f of custom ?? []) if (f?.id && !m.has(f.id)) m.set(f.id, f);
  return m;
}

function titleCase(slug: string): string {
  return slug
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Resolve a family id. Unknown/deleted ids synthesize a sane definition from
 *  the id itself so stale files still render (never throws, never null). */
export function familyById(
  id: string | undefined | null,
  custom?: readonly FigureFamilyDef[] | null,
): FigureFamilyDef {
  const m = familyMap(custom);
  const hit = m.get(id || DEFAULT_FAMILY);
  if (hit) return hit;
  const displayName = titleCase(id!) || "Figure";
  return {
    id: id!,
    displayName,
    refTemplate: `${displayName} {num}{panel}`,
    captionTemplate: `${displayName} {num} | `,
  };
}

/** Sort rank for pickers/lists: builtin order, then custom definition order,
 *  unknown families last. */
export function familyRank(
  id: string,
  custom?: readonly FigureFamilyDef[] | null,
): number {
  const m = familyMap(custom);
  let i = 0;
  for (const k of m.keys()) {
    if (k === id) return i;
    i++;
  }
  return m.size;
}

/** Fill an in-text template. `panel` is the pre-formatted spec ("a", "a–c,e")
 *  or "". Defensive against user templates: a missing {num} is appended, a
 *  missing {panel} rides on the end so panel refs never silently drop. */
export function formatFamilyRef(def: FigureFamilyDef, num: number, panel = ""): string {
  let t = def.refTemplate;
  if (!t.includes("{num}")) t = `${t.trimEnd()} {num}`;
  if (!t.includes("{panel}")) t = `${t}{panel}`;
  return t.replaceAll("{num}", String(num)).replaceAll("{panel}", panel);
}

/** Fill a caption-lead template ("Figure S4 | "). */
export function formatCaptionLabel(def: FigureFamilyDef, num: number): string {
  let t = def.captionTemplate;
  if (!t.includes("{num}")) t = `${t.trimEnd()} {num}`;
  return t.replaceAll("{num}", String(num)).replaceAll("{panel}", "");
}

/** The derived figure NAME — what the sidebar, canvas label, export filenames
 *  and slide folding all see: "Supplementary Figure 4". */
export function derivedFigureName(def: FigureFamilyDef, num: number): string {
  return `${def.displayName} ${num}`;
}

/** Compact sidebar badge: "2" / "S2" / "ED3"; customs use displayName
 *  initials (≤2 chars): "Movie" → "M3". */
export function shortBadge(def: FigureFamilyDef, num: number): string {
  const prefix =
    def.id === "figure"
      ? ""
      : def.id === "supplementary"
        ? "S"
        : def.id === "extended-data"
          ? "ED"
          : def.displayName
              .split(/\s+/)
              .filter(Boolean)
              .map((w) => w[0])
              .join("")
              .slice(0, 2)
              .toUpperCase();
  return `${prefix}${num}`;
}

/** Legacy `kind` stays on disk for older tooling; it is now derived. */
export function kindForFamily(family: string | undefined): "main" | "supplementary" {
  return family === "supplementary" ? "supplementary" : "main";
}

/** Migration parser — the successor to designationFromName, but strict:
 *  full-string matches with a plain integer only, so free-text names can
 *  never leak into display numbers again ("Figure 2 Sup. Figure 1",
 *  "Figure RENAMED", "Growth curves" → null → the name survives as a
 *  nickname instead). */
export function parseLegacyName(
  name: string,
): { family: string; number: number } | null {
  const s = name.trim();
  let m = /^fig(?:ure)?\.?\s+(\d+)$/i.exec(s);
  if (m) return { family: "figure", number: parseInt(m[1], 10) };
  m = /^fig(?:ure)?\.?\s+S(\d+)$/i.exec(s);
  if (m) return { family: "supplementary", number: parseInt(m[1], 10) };
  m = /^sup(?:p|pl|plementary|plemental)?\.?\s+fig(?:ure)?\.?\s+(\d+)$/i.exec(s);
  if (m) return { family: "supplementary", number: parseInt(m[1], 10) };
  m = /^extended[\s-]?data\s+fig(?:ure)?\.?\s+(\d+)$/i.exec(s);
  if (m) return { family: "extended-data", number: parseInt(m[1], 10) };
  return null;
}

const validNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1;

interface FamilyCarrier {
  id: string;
  name: string;
  family?: string;
  number?: number;
}

/** THE contiguity invariant. Non-mutating: array order in → id → healed
 *  {family, number} out. Family: explicit field, else parsed from the legacy
 *  name, else DEFAULT_FAMILY. Claimed number: a valid explicit field, else the
 *  parsed number when the parse agrees on the family, else none. Per family,
 *  members stable-sort by claimed number (unclaimed last) — ties and
 *  duplicates resolve by array order — then take positions 1..N. Deterministic
 *  and idempotent: already-contiguous input maps to itself. */
export function computeFamilyNumbers(
  figures: readonly FamilyCarrier[],
): Map<string, { family: string; number: number }> {
  const claims = figures.map((f) => {
    const parsed = f.family ? null : parseLegacyName(f.name ?? "");
    const family = f.family || parsed?.family || DEFAULT_FAMILY;
    const claimed = validNumber(f.number)
      ? f.number
      : parsed && parsed.family === family
        ? parsed.number
        : null;
    return { id: f.id, family, claimed };
  });
  const byFamily = new Map<string, typeof claims>();
  for (const c of claims) {
    const list = byFamily.get(c.family);
    if (list) list.push(c);
    else byFamily.set(c.family, [c]);
  }
  const out = new Map<string, { family: string; number: number }>();
  for (const [family, members] of byFamily) {
    const sorted = [...members].sort(
      (a, b) => (a.claimed ?? Infinity) - (b.claimed ?? Infinity),
    );
    sorted.forEach((c, i) => out.set(c.id, { family, number: i + 1 }));
  }
  return out;
}

/** Apply computeFamilyNumbers in place: stamp family/number and re-derive the
 *  name on every figure whose identity changed. Returns the changed ids. */
export function applyFamilyNumbers(
  figures: FamilyCarrier[],
  custom?: readonly FigureFamilyDef[] | null,
): string[] {
  const healed = computeFamilyNumbers(figures);
  const changed: string[] = [];
  for (const f of figures) {
    const h = healed.get(f.id);
    if (!h) continue;
    const name = derivedFigureName(familyById(h.family, custom), h.number);
    if (f.family !== h.family || f.number !== h.number || f.name !== name) {
      f.family = h.family;
      f.number = h.number;
      f.name = name;
      changed.push(f.id);
    }
  }
  return changed;
}

/** The ONE reorder primitive (GUI ops and flux-core both route here). Move
 *  figId into `family` at position `number` — insert-and-shift: the target
 *  family opens a slot, the old family compacts. `number` omitted or beyond
 *  the end appends; otherwise clamped to [1, N]. Mutates the figure objects
 *  (family/number/name) and returns the ids whose identity changed. */
export function assignFamilyNumber(
  figures: FamilyCarrier[],
  figId: string,
  family: string,
  number?: number,
  custom?: readonly FigureFamilyDef[] | null,
): string[] {
  const target = figures.find((f) => f.id === figId);
  if (!target) return [];
  // Normalize first so the shift math runs on contiguous numbers.
  const changed = new Set(applyFamilyNumbers(figures, custom));

  const others = figures.filter((f) => f.family === family && f.id !== figId);
  const desired = Math.max(1, Math.min(number ?? others.length + 1, others.length + 1));

  const oldFamily = target.family!;
  const oldNumber = target.number!;
  for (const f of figures) {
    if (f.id === figId) continue;
    if (f.family === oldFamily && f.number! > oldNumber) f.number = f.number! - 1;
    if (f.family === family && f.number! >= desired) f.number = f.number! + 1;
  }
  target.family = family;
  target.number = desired;
  if (oldFamily !== family || oldNumber !== desired) changed.add(figId);
  // Re-derive names (and belt-and-braces re-normalize) via the shared healer —
  // after the shift the numbers are already contiguous, so this only stamps
  // the new derived names and reports what moved.
  for (const id of applyFamilyNumbers(figures, custom)) changed.add(id);
  return [...changed];
}
