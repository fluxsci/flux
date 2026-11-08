// ---------------------------------------------------------------------------
// Document properties — the title, authors and affiliations as structured rows
// (2026-11-08). The rows are what the Properties sheet edits; `planDocument
// PropertiesWith` turns them back into the front matter through the minimal
// value patcher (frontmatterEdit.planFrontMatterValuesWith), so a Save touches
// only the fields that changed and keeps every other key, comment and quoting.
//
// The schema is Quarto's, exactly as the journal export reads it
// (journalManuscript.readAuthors): `author`/`authors` entries with `name`
// (a string or given/family/literal), `email`, `orcid`, `corresponding`,
// `equal-contributor`, `lead-contact` (also under `attributes:`), and
// `affiliations` as ids / `{ref}`; top-level `affiliations` with `id`,
// `department`, `name`, `city`, `country`. Anything the sheet cannot show
// (inline affiliation objects, unknown keys) is carried through untouched.
//
// Pure: no DOM, no Svelte. js-yaml is injected (twin-engine, guide §2).
// ---------------------------------------------------------------------------

import { frontMatterBounds } from "./frontmatter";
import { planFrontMatterValuesWith, FrontMatterEditError, type FmChange, type FmValueChange } from "./frontmatterEdit";

type YamlMod = typeof import("js-yaml");

export interface AuthorRow {
  /** The old entry this row continues (index into the author list), null = new. */
  src: number | null;
  name: string;
  email: string;
  orcid: string;
  corresponding: boolean;
  equal: boolean;
  lead: boolean;
  /** Affiliation ids; null when the entry's affiliations are not plain
   *  references (inline objects / free text) — shown read-only, kept as is. */
  affiliations: string[] | null;
  /** Read-only display of non-reference affiliations. */
  affiliationText: string;
}

export interface AffiliationRow {
  src: number | null;
  /** The id authors reference (explicit `id:`, else Quarto's 1-based index). */
  id: string;
  /** True when `id:` is written in the file (index ids cannot be removed safely). */
  explicitId: boolean;
  department: string;
  name: string;
  city: string;
  country: string;
  /** False for a bare-string affiliation (kept as written). */
  editable: boolean;
  text: string;
}

export interface DocumentProperties {
  title: string;
  authors: AuthorRow[];
  affiliations: AffiliationRow[];
}

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const truthy = (v: unknown) => v === true || v === "true" || v === "yes";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

function nameOf(n: unknown): string {
  if (typeof n === "string") return n.trim();
  if (typeof n === "number") return String(n);
  if (isObj(n)) return s(n.literal) || [s(n.given), s(n.family)].filter(Boolean).join(" ");
  return "";
}

function affText(a: Record<string, unknown>): string {
  return [s(a.department), s(a.name) || s(a.institution), s(a.city), s(a.country)].filter(Boolean).join(", ");
}

/** ORCID iD checksum (ISO 7064 MOD 11-2); accepts the bare id or an orcid.org URL. */
export function orcidValid(raw: string): boolean {
  const id = raw.trim().replace(/^https?:\/\/orcid\.org\//i, "");
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id)) return false;
  const digits = id.replace(/-/g, "");
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(digits[i])) * 2;
  const check = (12 - (total % 11)) % 11;
  return digits[15] === (check === 10 ? "X" : String(check));
}

function authorKey(meta: Record<string, unknown>): "author" | "authors" {
  return "author" in meta ? "author" : "authors" in meta ? "authors" : "author";
}

/** The rows the sheet shows, read exactly the way the journal export reads. */
export function readDocumentProperties(meta: Record<string, unknown>): DocumentProperties {
  const affiliations: AffiliationRow[] = asList(meta.affiliations).map((a, i) => {
    if (isObj(a)) {
      return {
        src: i,
        id: s(a.id) || String(i + 1),
        explicitId: !!s(a.id),
        department: s(a.department),
        name: s(a.name) || s(a.institution),
        city: s(a.city),
        country: s(a.country),
        editable: true,
        text: affText(a),
      };
    }
    return { src: i, id: String(i + 1), explicitId: false, department: "", name: s(a), city: "", country: "", editable: false, text: s(a) };
  });
  const ids = new Set(affiliations.map((a) => a.id));
  const authors: AuthorRow[] = [];
  asList(meta[authorKey(meta)]).forEach((r, i) => {
    if (typeof r === "string" || typeof r === "number") {
      authors.push({ src: i, name: String(r).trim(), email: "", orcid: "", corresponding: false, equal: false, lead: false, affiliations: [], affiliationText: "" });
      return;
    }
    if (!isObj(r)) return;
    const name = nameOf(r.name);
    if (!name) return; // the export skips it too; the patcher keeps it in place
    const attrs = isObj(r.attributes) ? r.attributes : {};
    const raw = asList(r.affiliations ?? r.affiliation);
    const refs = raw.map((a) => (typeof a === "string" || typeof a === "number" ? String(a) : isObj(a) && a.ref != null && Object.keys(a).length === 1 ? String(a.ref) : null));
    const plain = refs.every((x) => x !== null && ids.has(x));
    authors.push({
      src: i,
      name,
      email: s(r.email),
      orcid: s(r.orcid),
      corresponding: truthy(r.corresponding) || truthy(attrs.corresponding),
      equal: truthy(r["equal-contributor"]) || truthy(attrs["equal-contributor"]),
      lead: truthy(r["lead-contact"]) || truthy(attrs["lead-contact"]),
      affiliations: plain ? (refs as string[]) : null,
      affiliationText: plain ? "" : raw.map((a) => (isObj(a) ? affText(a) : s(a))).filter(Boolean).join("; "),
    });
  });
  const t = meta.title;
  return { title: t == null ? "" : String(t), authors, affiliations };
}

function splitName(oldGiven: string, oldFamily: string, next: string): { given: string; family: string } {
  if (oldFamily && next.endsWith(` ${oldFamily}`)) return { given: next.slice(0, -oldFamily.length - 1).trim(), family: oldFamily };
  if (oldGiven && next.startsWith(`${oldGiven} `)) return { given: oldGiven, family: next.slice(oldGiven.length + 1).trim() };
  const sp = next.lastIndexOf(" ");
  return sp < 0 ? { given: "", family: next } : { given: next.slice(0, sp).trim(), family: next.slice(sp + 1).trim() };
}

const FLAG_KEYS = { corresponding: "corresponding", equal: "equal-contributor", lead: "lead-contact" } as const;

/** One author entry with the row applied to it (unknown fields carried). */
function authorEntry(base: unknown, row: AuthorRow, old: AuthorRow | undefined): unknown {
  const name = row.name.trim();
  const bare = !row.email.trim() && !row.orcid.trim() && !row.corresponding && !row.equal && !row.lead && !(row.affiliations?.length);
  if (typeof base === "string" || typeof base === "number" || base === undefined) {
    if (bare && base !== undefined) return name;
    if (bare) return { name };
  }
  const o: Record<string, unknown> = isObj(base) ? structuredClone(base) : { name };
  // name
  if (!old || name !== old.name) {
    const n = o.name;
    if (isObj(n)) {
      if (s(n.literal)) n.literal = name;
      else if (s(n.given) || s(n.family)) {
        const parts = splitName(s(n.given), s(n.family), name);
        if (parts.given) Object.assign(n, parts);
        else o.name = name;
      } else o.name = name;
    } else o.name = name;
  }
  const setText = (key: string, v: string, was: string | undefined) => {
    if (was !== undefined && v.trim() === was) return;
    if (v.trim()) o[key] = v.trim();
    else delete o[key];
  };
  setText("email", row.email, old?.email);
  setText("orcid", row.orcid, old?.orcid);
  for (const f of ["corresponding", "equal", "lead"] as const) {
    const key = FLAG_KEYS[f];
    if (old && old[f] === row[f]) continue;
    const attrs = isObj(o.attributes) ? o.attributes : null;
    if (row[f]) {
      if (attrs && key in attrs) attrs[key] = true;
      else o[key] = true;
    } else {
      delete o[key];
      if (attrs) {
        delete attrs[key];
        if (!Object.keys(attrs).length) delete o.attributes;
      }
    }
  }
  if (row.affiliations && (!old || JSON.stringify(old.affiliations) !== JSON.stringify(row.affiliations))) {
    const key = "affiliations" in o ? "affiliations" : "affiliation" in o ? "affiliation" : "affiliations";
    const prior = asList(o[key]);
    const asRef = prior.some((a) => isObj(a));
    const list = row.affiliations.map((id) => (asRef ? { ref: id } : id));
    if (!list.length) delete o[key];
    else if (!Array.isArray(o[key]) && o[key] !== undefined && list.length === 1) o[key] = list[0];
    else o[key] = list;
  }
  return o;
}

function affiliationEntry(base: unknown, row: AffiliationRow, old: AffiliationRow | undefined): unknown {
  if (!row.editable) return base;
  const o: Record<string, unknown> = isObj(base) ? structuredClone(base) : { id: row.id };
  if (!isObj(base) && !row.id) delete o.id;
  const field = (key: "department" | "name" | "city" | "country") => {
    const v = row[key].trim();
    if (old && v === old[key]) return;
    const target = key === "name" && !("name" in o) && "institution" in o ? "institution" : key;
    if (v) o[target] = v;
    else delete o[target];
  };
  field("department");
  field("name");
  field("city");
  field("country");
  return o;
}

/** A fresh affiliation id: the institution's initials, unique (`ucl`, `mit-2`). */
export function newAffiliationId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const words = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").split(/\s+/).filter((w) => w && !/^(of|the|and|for|de|la|und)$/.test(w));
  const base = (words.length > 1 ? words.map((w) => w[0]).join("") : words[0] ?? "aff").slice(0, 12) || "aff";
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Plan the Save of the Properties sheet: byte-minimal changes for the title,
 *  the author entries and the affiliations — only what differs from `before`. */
export function planDocumentPropertiesWith(yaml: YamlMod, src: string, next: DocumentProperties): FmChange[] {
  const b = frontMatterBounds(src);
  if (b.open && !b.has) throw new FrontMatterEditError("The front matter has no closing ---");
  let meta: Record<string, unknown> = {};
  if (b.has) {
    try {
      meta = (yaml.load(b.fmText) as Record<string, unknown>) ?? {};
    } catch (err) {
      throw new FrontMatterEditError(`The front matter is not valid YAML (${(err as Error).message.split("\n")[0]})`);
    }
  }
  const before = readDocumentProperties(meta);
  const changes: FmValueChange[] = [];

  if (next.title.trim() !== before.title && !(next.title.trim() === "" && meta.title === undefined)) {
    changes.push({ key: "title", value: next.title.trim() });
  }

  // affiliations first (authors reference them)
  const oldAffs = asList(meta.affiliations);
  const affValue = next.affiliations.map((row) => affiliationEntry(row.src === null ? undefined : oldAffs[row.src], row, row.src === null ? undefined : before.affiliations.find((a) => a.src === row.src)));
  const affSources = next.affiliations.map((r) => r.src);
  const affChanged = JSON.stringify(affValue) !== JSON.stringify(oldAffs) || affSources.some((x, i) => x !== i) || affSources.length !== oldAffs.length;

  const aKey = authorKey(meta);
  const oldAuthors = asList(meta[aKey]);
  // Entries the sheet never showed (no name) keep their slot.
  const shown = new Set(before.authors.map((r) => r.src));
  const queue = next.authors.filter((r) => r.name.trim());
  const sources: (number | null)[] = [];
  const authorValue: unknown[] = [];
  oldAuthors.forEach((entry, i) => {
    if (!shown.has(i)) {
      sources.push(i);
      authorValue.push(entry);
    } else if (queue.length) {
      const row = queue.shift()!;
      sources.push(row.src);
      authorValue.push(authorEntry(row.src === null ? undefined : oldAuthors[row.src], row, before.authors.find((r) => r.src === row.src)));
    }
  });
  for (const row of queue) {
    sources.push(row.src);
    authorValue.push(authorEntry(row.src === null ? undefined : oldAuthors[row.src], row, before.authors.find((r) => r.src === row.src)));
  }
  const authorsChanged = JSON.stringify(authorValue) !== JSON.stringify(oldAuthors) || sources.some((x, i) => x !== i);

  if (authorsChanged) {
    const single = !Array.isArray(meta[aKey]) && meta[aKey] !== undefined && authorValue.length === 1;
    changes.push({
      key: aKey,
      value: !authorValue.length ? undefined : single ? authorValue[0] : authorValue,
      itemSources: single || !Array.isArray(meta[aKey]) ? undefined : sources,
      after: "title",
    });
  }
  if (affChanged) {
    changes.push({
      key: "affiliations",
      value: affValue.length ? affValue : undefined,
      itemSources: Array.isArray(meta.affiliations) ? affSources : undefined,
      after: aKey,
    });
  }
  if (!changes.length) return [];
  return planFrontMatterValuesWith(yaml, src, changes);
}

/** Lazy-yaml wrappers for the GUI. */
export async function readDocumentPropertiesFrom(src: string): Promise<DocumentProperties> {
  const b = frontMatterBounds(src);
  if (!b.has) return { title: "", authors: [], affiliations: [] };
  const yaml = await import("js-yaml");
  try {
    return readDocumentProperties(((yaml.load(b.fmText) as Record<string, unknown>) ?? {}));
  } catch {
    return { title: "", authors: [], affiliations: [] };
  }
}
