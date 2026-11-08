// Pack "references": broken cross-references and citations, before export.
//
//   ref.undefined-crossref   error  @fig-/@tbl-/@eq-/@sec- label with no target
//   ref.missing-panel        error  @fig-x-e where Fig. x has no panel e
//   ref.unknown-embed        warn   an embed whose figure is not in the project
//   ref.duplicate-label      warn   the same {#label} defined twice
//   ref.unreferenced-equation info a labeled equation never @eq-referenced
//   cite.missing-key         error  a citekey not in the project bibliography
//   cite.duplicate-reference warn   two cited keys for one work (DOI / title+year)
//   cite.incomplete-entry    warn   a cited entry missing a field the reference list prints
//
// A cross-reference resolves exactly as the editor chip resolves it: figures
// through figureReferences' resolver over the Figure model, tables and
// equations through the shared appearance-order numbering, sections through
// `{#sec-…}` heading attributes. A Quarto-native `{#fig-…}` defined in the
// document (a div figure) counts as a target too: Quarto resolves it.

import type { CheckContext } from "./context";
import type { CheckBibEntry, CheckFinding, CheckFix } from "./types";

type Add = (f: Omit<CheckFinding, "pack" | "doc" | "line" | "col">) => void;

/** Levenshtein distance, bounded (returns max+1 once exceeded). */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The one label within edit distance 2 of `label`, when exactly one exists —
 *  only then is "did you mean" a safe one-click fix. */
function nearestLabel(label: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = 3;
  let tie = false;
  for (const c of candidates) {
    if (c === label) continue;
    const d = distance(label, c, 2);
    if (d < bestD) {
      best = c;
      bestD = d;
      tie = false;
    } else if (d === bestD) tie = true;
  }
  return best && !tie ? best : null;
}

const normTitle = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
const normDoi = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/, "");

export function referencesPack(ctx: CheckContext, add: Add): void {
  const { text } = ctx;

  // ---- label definitions in this document ----------------------------------
  const defsByLabel = new Map<string, { from: number; to: number }[]>();
  for (const d of ctx.labelDefs) {
    const list = defsByLabel.get(d.label) ?? [];
    list.push({ from: d.from, to: d.to });
    defsByLabel.set(d.label, list);
  }
  for (const [label, defs] of defsByLabel) {
    for (const d of defs.slice(1)) {
      add({
        ruleId: "ref.duplicate-label",
        severity: "warn",
        message: `The label ${label} is defined ${defs.length} times; references can only reach one of them.`,
        from: d.from,
        to: d.to,
        excerpt: text.slice(d.from, d.to) + "}",
      });
    }
  }
  const secLabels = new Set([...defsByLabel.keys()].filter((l) => l.startsWith("sec-")));
  // Quarto-native figure labels (div/image figures Flux does not model).
  const nativeFig = new Set([...defsByLabel.keys()].filter((l) => l.startsWith("fig-") && !ctx.figByLabel.has(l)));

  // ---- embeds of figures the project does not have -------------------------
  for (const e of ctx.embeds) {
    if (ctx.figByLabel.has(e.label)) continue;
    add({
      ruleId: "ref.unknown-embed",
      severity: "warn",
      message: `This embeds ${e.label}, which is not one of the project's figures; it will export as a plain image.`,
      from: e.from,
      to: e.to,
      excerpt: e.label,
    });
  }

  // ---- cross-references -----------------------------------------------------
  const referenced = new Set<string>();
  for (const r of ctx.crossrefs) {
    const excerpt = "@" + r.token;
    if (r.kind === "fig") {
      const hit = ctx.resolveFigure(r.token);
      if (hit) {
        referenced.add(hit.ref.label);
        continue;
      }
      // A label prefix that IS a figure: the panel part is what failed.
      const base = figureBase(ctx, r.token);
      if (base) {
        referenced.add(base.label);
        const spec = r.token.slice(base.label.length + 1);
        const has = base.panels.length
          ? `it has panels ${base.panels.length > 2 ? `${base.panels[0]}–${base.panels[base.panels.length - 1]}` : base.panels.join(" and ")}`
          : "it has no panels";
        add({
          ruleId: "ref.missing-panel",
          severity: "error",
          message: `${base.display} has no panel ${spec.replace(/-/g, "–")} (${has}).`,
          from: r.from,
          to: r.to,
          excerpt,
        });
        continue;
      }
      if (nativeFig.has(r.token)) continue;
    } else if (r.kind === "tbl") {
      if (ctx.tableNumbers.has(r.token)) {
        referenced.add(r.token);
        continue;
      }
    } else if (r.kind === "eq") {
      if (ctx.eqNumbers.has(r.token)) {
        referenced.add(r.token);
        continue;
      }
    } else if (secLabels.has(r.token)) continue;

    const pool =
      r.kind === "fig"
        ? [...ctx.figByLabel.keys(), ...nativeFig]
        : r.kind === "tbl"
          ? ctx.tableNumbers.keys()
          : r.kind === "eq"
            ? ctx.eqNumbers.keys()
            : secLabels;
    const near = nearestLabel(r.token, new Set(pool));
    const noun = { fig: "figure", tbl: "table", eq: "equation", sec: "section" }[r.kind];
    const fix: CheckFix | undefined = near
      ? { label: `Change to @${near}`, edits: [{ from: r.from, to: r.to, insert: "@" + near, expect: text.slice(r.from, r.to) }] }
      : undefined;
    add({
      ruleId: "ref.undefined-crossref",
      severity: "error",
      message: `${excerpt} points to no ${noun}${near ? `; did you mean @${near}?` : "."}`,
      from: r.from,
      to: r.to,
      excerpt,
      ...(fix ? { fix } : {}),
    });
  }

  // ---- equations labeled but never referenced -------------------------------
  for (const label of ctx.eqNumbers.keys()) {
    if (referenced.has(label)) continue;
    const def = defsByLabel.get(label)?.[0];
    add({
      ruleId: "ref.unreferenced-equation",
      severity: "info",
      message: `Equation ${ctx.eqNumbers.get(label)} (${label}) is labeled but never referenced.`,
      ...(def ? { from: def.from, to: def.to } : {}),
      excerpt: label,
    });
  }

  // ---- citations --------------------------------------------------------------
  if (!ctx.citations.length) return;
  const bib = new Map<string, CheckBibEntry>();
  for (const e of ctx.input.bib) if (e.key && !bib.has(e.key)) bib.set(e.key, e);
  const first = new Map<string, { from: number; to: number }>();
  for (const c of ctx.citations) if (!first.has(c.key)) first.set(c.key, c);
  const bibKeys = [...bib.keys()];
  for (const c of ctx.citations) {
    if (bib.has(c.key)) continue;
    const near = nearestLabel(c.key, bibKeys);
    // Only the token itself is replaced, never a bracket: the range starts at
    // `[@` or `@`, so locate the `@` inside it.
    const at = text.indexOf("@", c.from);
    const fix: CheckFix | undefined =
      near && at >= 0 && at < c.to
        ? { label: `Change to @${near}`, edits: [{ from: at, to: c.to, insert: "@" + near, expect: text.slice(at, c.to) }] }
        : undefined;
    add({
      ruleId: "cite.missing-key",
      severity: "error",
      message: `@${c.key} is not in the project bibliography${near ? `; did you mean @${near}?` : "."}`,
      from: at >= 0 && at < c.to ? at : c.from,
      to: c.to,
      excerpt: "@" + c.key,
      ...(fix ? { fix } : {}),
    });
  }

  // Duplicates among CITED entries (an uncited duplicate never prints).
  const cited = [...first.keys()].filter((k) => bib.has(k)).map((k) => bib.get(k)!);
  const byDoi = new Map<string, CheckBibEntry>();
  const byTitle = new Map<string, CheckBibEntry>();
  for (const e of cited) {
    const doi = e.doi ? normDoi(e.doi) : "";
    const title = normTitle(e.title);
    let twin: CheckBibEntry | undefined;
    let why = "";
    if (doi && byDoi.has(doi)) {
      twin = byDoi.get(doi);
      why = `the same DOI (${doi})`;
    } else if (title.length >= 20 && byTitle.has(title)) {
      const t = byTitle.get(title)!;
      if (!t.year || !e.year || t.year === e.year) {
        twin = t;
        why = "the same title" + (e.year ? ` and year (${e.year})` : "");
      }
    }
    if (twin) {
      const loc = first.get(e.key)!;
      const at = text.indexOf("@", loc.from);
      add({
        ruleId: "cite.duplicate-reference",
        severity: "warn",
        message: `@${e.key} and @${twin.key} have ${why}; the reference list will print this work twice.`,
        from: at >= 0 && at < loc.to ? at : loc.from,
        to: loc.to,
        excerpt: "@" + e.key,
      });
      continue;
    }
    if (doi) byDoi.set(doi, e);
    if (title.length >= 20) byTitle.set(title, e);
  }

  for (const e of cited) {
    const missing: string[] = [];
    if (!e.authors.length) missing.push("authors");
    if (!e.title.trim()) missing.push("title");
    if (!e.year.trim()) missing.push("year");
    if (e.type === "article" && !e.container?.trim()) missing.push("journal");
    if (!missing.length) continue;
    const loc = first.get(e.key)!;
    const at = text.indexOf("@", loc.from);
    add({
      ruleId: "cite.incomplete-entry",
      severity: "warn",
      message: `The reference @${e.key} has no ${missing.join(", ")}; the reference list will print a gap.`,
      from: at >= 0 && at < loc.to ? at : loc.from,
      to: loc.to,
      excerpt: "@" + e.key,
    });
  }
}

/** The figure a token names when its PANEL part is what fails to resolve
 *  ("fig-growth-e" on a figure with panels a–d): the longest label prefix. */
export function figureBase(ctx: CheckContext, token: string) {
  let best: import("./types").CheckFigure | undefined;
  for (const f of ctx.figByLabel.values()) {
    if ((token.startsWith(f.label + "-") || token.startsWith(f.label + ",")) && (!best || f.label.length > best.label.length)) best = f;
  }
  return best;
}

/** Referenced fig/tbl labels in document order of FIRST mention, with the
 *  panel letters each mention names — the display pack's input. */
export function displayMentions(ctx: CheckContext): {
  figures: Map<string, { from: number; to: number; panels: Set<string>; whole: boolean }>;
  tables: Map<string, { from: number; to: number }>;
} {
  const figures = new Map<string, { from: number; to: number; panels: Set<string>; whole: boolean }>();
  const tables = new Map<string, { from: number; to: number }>();
  for (const r of ctx.crossrefs) {
    if (r.kind === "fig") {
      // A reference to a missing panel still cites its figure (the panel
      // error is reported once, by ref.missing-panel).
      const hit = ctx.resolveFigure(r.token) ?? (() => {
        const base = figureBase(ctx, r.token);
        return base ? { ref: base, panelSpec: undefined } : null;
      })();
      if (!hit) continue;
      const entry = figures.get(hit.ref.label) ?? { from: r.from, to: r.to, panels: new Set<string>(), whole: false };
      if (!hit.panelSpec) entry.whole = true;
      else for (const p of expandPanels(hit.panelSpec, hit.ref.panels)) entry.panels.add(p);
      figures.set(hit.ref.label, entry);
    } else if (r.kind === "tbl" && ctx.tableNumbers.has(r.token) && !tables.has(r.token)) {
      tables.set(r.token, { from: r.from, to: r.to });
    }
  }
  return { figures, tables };
}

/** "a-c,e" over the figure's ordered panels → ["a","b","c","e"]. */
export function expandPanels(spec: string, panels: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-");
    if (b === undefined) {
      out.push(a);
      continue;
    }
    const i = panels.indexOf(a), j = panels.indexOf(b);
    if (i < 0 || j < 0) continue;
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) out.push(panels[k]);
  }
  return out;
}
