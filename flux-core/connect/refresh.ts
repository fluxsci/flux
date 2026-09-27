// Staying current (plan §8.8): a connected agent is told what changed without
// asking. The no-change check is stat-only (a few dozen stats, well under the
// 30 ms budget); only when something moved are the changed files read and a
// summary computed against the session's cursor state (what it last saw).
//
// Pure parts (the snapshot comparison, line counts, rendering) take data in
// and return strings out; readDelta does the IO.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { CONTEXT_PATHS, parseLog } from "../../src/lib/project/contextTemplates";
import type { PackState } from "./cache";

// ---------------------------------------------------------------------------
// Stat snapshots
// ---------------------------------------------------------------------------

export interface StatSnapshot {
  /** Absolute paths watched (files and directories). */
  paths: string[];
  /** [size, mtimeMs] per path, or null when it did not exist. */
  stats: ([number, number] | null)[];
}

export async function takeSnapshot(paths: readonly string[]): Promise<StatSnapshot> {
  const stats = await Promise.all(
    paths.map((p) =>
      fs.stat(p).then(
        (s) => [s.isDirectory() ? 0 : s.size, Math.round(s.mtimeMs)] as [number, number],
        () => null,
      ),
    ),
  );
  return { paths: [...paths], stats };
}

/** Paths whose stat differs between two snapshots of the same path list. */
export function changedPaths(a: StatSnapshot, b: StatSnapshot): string[] {
  const before = new Map(a.paths.map((p, i) => [p, a.stats[i]]));
  const out: string[] = [];
  for (const [i, p] of b.paths.entries()) {
    const x = before.get(p), y = b.stats[i];
    if (x === undefined) out.push(p);
    else if ((x === null) !== (y === null) || (x && y && (x[0] !== y[0] || x[1] !== y[1]))) out.push(p);
  }
  return out;
}

export function sameSnapshot(a: StatSnapshot, b: StatSnapshot): boolean {
  return changedPaths(a, b).length === 0;
}

// ---------------------------------------------------------------------------
// Line counts and small diffs (pure)
// ---------------------------------------------------------------------------

/** Lines added and removed, as a multiset difference (moves count as neither). O(n). */
export function lineChanges(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const l of before.split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after.split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

/** The changed middle of a text (common prefix and suffix trimmed), as a short unified-style excerpt. */
export function changedExcerpt(before: string, after: string, maxLines = 40): string {
  const a = before.split("\n"), b = after.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const out = [`@@ line ${s + 1} @@`];
  const removed = a.slice(s, ea + 1).map((l) => `- ${l}`);
  const added = b.slice(s, eb + 1).map((l) => `+ ${l}`);
  const body = [...removed, ...added];
  out.push(...body.slice(0, maxLines));
  if (body.length > maxLines) out.push(`… ${body.length - maxLines} more changed lines`);
  return out.join("\n");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// The cursor and the delta
// ---------------------------------------------------------------------------

/** What a session last saw. MCP sessions keep it in memory; CLI sessions via their pack. */
export interface DeltaCursor {
  root: string;
  packId: string;
  /** When the session last looked (connect, or its last read_delta). */
  since: string;
  state: PackState;
  snapshot: StatSnapshot;
  /** Old document texts by sha (for line counts). */
  text: (sha: string) => Promise<string | null>;
}

export interface DeltaChange {
  kind: "context" | "rules" | "log" | "doc" | "figures" | "deck" | "inbox" | "project";
  /** One short phrase for the piggyback line. */
  summary: string;
  /** Markdown detail for read_delta. */
  detail: string;
  /** Routed to this session (the line flags these). */
  forYou?: boolean;
  /** Figures added or changed (read_delta re-renders their canvases). */
  figureIds?: string[];
}

export interface Delta {
  changes: DeltaChange[];
  /** The cursor state after these changes (what the session has now been told about). */
  state: PackState;
  /** Newly seen texts by sha (for the next delta's line counts). */
  texts: Map<string, string>;
}

export interface CurrentItems {
  /** Open items now: id → {status, one-line description, routed to this session?}. */
  open: Map<string, { status: string; line: string; forYou: boolean; kind: "annotation" | "comment" }>;
  /** Items that left the open set since the cursor, with how. */
  closedHow: (id: string) => string | null;
}

export interface DeltaInputs {
  root: string;
  cursor: DeltaCursor;
  changed: readonly string[];
  /** Current figures (id → name + sha), read only when fig/ changed. */
  figures: () => Promise<Record<string, { name: string; sha: string }>>;
  /** Current document list (path → sha), read only when a document or its folder changed. */
  docs: () => Promise<Record<string, string>>;
  items: () => Promise<CurrentItems>;
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join("/");

/** Read what changed and describe it against the cursor. Reads only changed things. */
export async function computeDelta(inp: DeltaInputs): Promise<Delta> {
  const { root, cursor } = inp;
  const changes: DeltaChange[] = [];
  const state: PackState = { logTitles: [...cursor.state.logTitles], figures: { ...cursor.state.figures }, items: { ...cursor.state.items }, docs: { ...cursor.state.docs } };
  const texts = new Map<string, string>();
  const changedRel = new Set(inp.changed.map((p) => rel(root, p)));
  const touched = (pred: (r: string) => boolean) => [...changedRel].some(pred);
  const read = (r: string) => fs.readFile(path.join(root, r), "utf8").catch(() => null);

  if (changedRel.has(CONTEXT_PATHS.projectContext)) {
    const t = await read(CONTEXT_PATHS.projectContext);
    const old = await cursor.text(cursor.state.docs[CONTEXT_PATHS.projectContext] ?? "");
    if (t !== null && sha256(t) !== cursor.state.docs[CONTEXT_PATHS.projectContext]) {
      state.docs[CONTEXT_PATHS.projectContext] = sha256(t);
      texts.set(sha256(t), t);
      changes.push({ kind: "context", summary: "ProjectContext edited", detail: `### ProjectContext edited\n\n\`\`\`diff\n${changedExcerpt(old ?? "", t)}\n\`\`\`` });
    }
  }
  if (changedRel.has(CONTEXT_PATHS.rules)) {
    const t = await read(CONTEXT_PATHS.rules);
    const old = await cursor.text(cursor.state.docs[CONTEXT_PATHS.rules] ?? "");
    if (t !== null && sha256(t) !== cursor.state.docs[CONTEXT_PATHS.rules]) {
      state.docs[CONTEXT_PATHS.rules] = sha256(t);
      texts.set(sha256(t), t);
      changes.push({ kind: "rules", summary: "Rules edited", detail: `### Rules edited\n\n\`\`\`diff\n${changedExcerpt(old ?? "", t)}\n\`\`\`` });
    }
  }
  if (changedRel.has(CONTEXT_PATHS.notebook)) {
    const t = await read(CONTEXT_PATHS.notebook);
    if (t !== null) {
      const entries = parseLog(t);
      const seen = cursor.state.logTitles;
      const fresh = entries.length >= seen.length && entries.slice(0, seen.length).every((e, i) => `${e.stamp} — ${e.title}` === seen[i]) ? entries.slice(seen.length) : entries.filter((e) => !seen.includes(`${e.stamp} — ${e.title}`));
      state.logTitles = entries.map((e) => `${e.stamp} — ${e.title}`);
      state.docs[CONTEXT_PATHS.notebook] = sha256(t);
      if (fresh.length) {
        changes.push({
          kind: "log",
          summary: `${fresh.length} new Log entr${fresh.length === 1 ? "y" : "ies"}`,
          detail: ["### New Log entries", "", ...fresh.map((e) => `#### ${e.stamp} — ${e.title}\n${e.byline ? `*${e.byline}*\n` : ""}\n${e.body}`)].join("\n"),
        });
      }
    }
  }
  const docDirs = new Set(Object.keys(cursor.state.docs).map((d) => path.posix.dirname(d)));
  if (touched((r) => r === "project.json" || docDirs.has(r) || cursor.state.docs[r] !== undefined)) {
    const now = await inp.docs();
    for (const [doc, sha] of Object.entries(now)) {
      if (doc === CONTEXT_PATHS.projectContext || doc === CONTEXT_PATHS.rules || doc === CONTEXT_PATHS.notebook) continue;
      const was = cursor.state.docs[doc];
      if (was === sha) continue;
      const t = (await read(doc)) ?? "";
      texts.set(sha, t);
      state.docs[doc] = sha;
      if (was === undefined) {
        changes.push({ kind: "doc", summary: `new document ${doc}`, detail: `### New document \`${doc}\` (${t.split("\n").length} lines)` });
      } else {
        const old = (await cursor.text(was)) ?? "";
        const { added, removed } = lineChanges(old, t);
        changes.push({ kind: "doc", summary: `${doc} +${added}/−${removed}`, detail: `### \`${doc}\` +${added}/−${removed}\n\n\`\`\`diff\n${changedExcerpt(old, t)}\n\`\`\`` });
      }
    }
    for (const doc of Object.keys(cursor.state.docs)) {
      if (doc in now || doc === CONTEXT_PATHS.projectContext || doc === CONTEXT_PATHS.rules || doc === CONTEXT_PATHS.notebook) continue;
      delete state.docs[doc];
      changes.push({ kind: "doc", summary: `${doc} removed`, detail: `### \`${doc}\` removed` });
    }
  }
  if (touched((r) => r === "fig" || r.startsWith("fig/"))) {
    const now = await inp.figures();
    const added = Object.keys(now).filter((id) => !(id in cursor.state.figures));
    const removed = Object.keys(cursor.state.figures).filter((id) => !(id in now));
    const edited = Object.keys(now).filter((id) => id in cursor.state.figures && now[id].sha !== cursor.state.figures[id].sha);
    state.figures = now;
    const parts = [
      added.length ? `${added.length} added (${added.map((id) => `${id} "${now[id].name}"`).join(", ")})` : "",
      edited.length ? `${edited.length} changed (${edited.map((id) => `${id} "${now[id].name}"`).join(", ")})` : "",
      removed.length ? `${removed.length} removed (${removed.map((id) => `${id} "${cursor.state.figures[id].name}"`).join(", ")})` : "",
    ].filter(Boolean);
    if (parts.length) {
      const n = added.length + edited.length + removed.length;
      changes.push({ kind: "figures", figureIds: [...added, ...edited], summary: `${n} figure${n === 1 ? "" : "s"} changed`, detail: `### Figures\n\n${parts.map((p) => `- ${p}`).join("\n")}\n\nLook at them: get_figure_image / get_canvas_image (or \`flux render-canvas --png\`).` });
    }
  }
  for (const r of changedRel) {
    const m = /^slides\/([^/]+)\/deck\.json$/.exec(r);
    if (m) changes.push({ kind: "deck", summary: `deck ${m[1]} edited`, detail: `### Deck \`${m[1]}\` edited` });
  }
  if (touched((r) => r === ".meta/feedback.ndjson" || r.endsWith("comments.json"))) {
    const now = await inp.items();
    const fresh = [...now.open].filter(([id]) => !(id in cursor.state.items));
    const closed = Object.keys(cursor.state.items).filter((id) => !now.open.has(id));
    state.items = Object.fromEntries([...now.open].map(([id, v]) => [id, v.status]));
    if (fresh.length) {
      const mine = fresh.filter(([, v]) => v.forYou);
      const ann = fresh.filter(([, v]) => v.kind === "annotation").length;
      const com = fresh.length - ann;
      const what = [ann ? `${ann} new annotation${ann === 1 ? "" : "s"}` : "", com ? `${com} new comment${com === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
      changes.push({
        kind: "inbox",
        summary: mine.length ? `${what} — ${mine.length} for you (${mine.map(([id]) => id).join(", ")})` : what,
        detail: ["### New review items", "", ...fresh.map(([id, v]) => `- \`${id}\` · ${v.line}${v.forYou ? " · **routed to you**" : ""}`)].join("\n"),
        forYou: mine.length > 0,
      });
    }
    if (closed.length) {
      const hows = closed.map((id) => `${id} ${now.closedHow(id) ?? "closed"}`);
      changes.push({ kind: "inbox", summary: `the user closed ${closed.length} item${closed.length === 1 ? "" : "s"}`, detail: ["### Closed since you looked", "", ...hows.map((h) => `- ${h}`)].join("\n") });
    }
  }
  return { changes, state, texts };
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

export function ageOf(since: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(since)) / 60000));
  if (min < 1) return "just now";
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** The one-line piggyback / hook notice. */
export function renderDeltaLine(delta: Delta, since: string, readHow = "read_delta", now = Date.now()): string {
  // What is routed to this session leads; the rest keeps its order.
  const parts = [...delta.changes.filter((c) => c.forYou), ...delta.changes.filter((c) => !c.forYou)].map((c) => c.summary);
  const shown = parts.slice(0, 6);
  return `↻ Since you last looked (${ageOf(since, now)}): ${shown.join(" · ")}${parts.length > shown.length ? ` · +${parts.length - shown.length} more` : ""} — details: ${readHow}`;
}

/** read_delta / --refresh: the details, in Markdown. */
export function renderDeltaDetails(delta: Delta, title: string, since: string, now = Date.now()): string {
  if (!delta.changes.length) return `Nothing changed in "${title}" since you last looked (${ageOf(since, now)}).`;
  return [`# Changes in "${title}" since you last looked (${ageOf(since, now)})`, "", ...delta.changes.map((c) => c.detail + "\n")].join("\n");
}
