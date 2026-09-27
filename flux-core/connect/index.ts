// flux-connect: hydrate an agent with a project (or the machine) in one step.
// Resolve the target → collect facts → plan what to include → render images,
// the bundle and the brief → write the pack → hand back the brief. Progress to
// stderr; the brief is the result (stdout on the CLI, text over MCP).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { findProjectRoot, loadManifest } from "../model";
import { recordProjectConnected, listKnownProjects } from "../../electron/projectsRegistry.cjs";
import type { AgentIdentity } from "../agentIdentity";
import { collectFacts, currentDocShas, currentItems, figureDigests, type SourceRecord } from "./collect";
import { planInclusion } from "./budget";
import { renderBundle, type BundleSection } from "./bundle";
import { renderBrief, type BriefImage, type BriefPaths } from "./brief";
import { renderPackImages } from "./images";
import { checkReceipt, type ReceiptCheck } from "./codes";
import {
  allocatePack,
  findPack,
  latestPack,
  newPackId,
  prunePacks,
  readCursor,
  writeCursor,
  writePackFile,
  type PackManifest,
  type PackState,
} from "./cache";
import { computeDelta, renderDeltaDetails, takeSnapshot, changedPaths, type Delta, type DeltaCursor, type StatSnapshot } from "./refresh";
import type { ConnectDepth, ConnectFacts } from "./facts";

export const PART_MAX_CHARS = 20_000;
export const RESERVED_TARGETS = ["setup", "doctor", "remove"] as const;

export interface ConnectOptions {
  target?: string;
  /** Base for a relative target and for the omitted-target walk (default: process.cwd()). */
  cwd?: string;
  depth?: ConnectDepth;
  live?: boolean;
  refresh?: boolean;
  budget?: number;
  noRender?: boolean;
  identity: AgentIdentity;
  /** The presence name of an MCP session (shown in the brief and receipt). */
  sessionName?: string | null;
  /** CLI sessions: the vendor session id; keys the hook cursor (§8.8 Delivery 2). */
  sessionKey?: string | null;
  progress?: (line: string) => void;
  /** Test seam: a fixed pack id / clock. */
  packId?: string;
  now?: Date;
}

export interface ConnectResult {
  packId: string;
  mode: "project" | "global";
  root: string | null;
  title: string;
  brief: string;
  briefPath: string | null;
  bundlePath: string | null;
  manifestPath: string | null;
  images: BriefImage[];
  /** Nothing could be written: the bundle is delivered in parts on stdout. */
  stdoutOnly: boolean;
  /** Part 1 of the bundle in stdout-only mode (printed after the brief). */
  firstPart: string | null;
  sections: BundleSection[];
  /** The session's starting point for deltas (project mode). */
  cursor: DeltaCursor | null;
  /** --refresh: what changed since the previous pack. */
  refresh: { since: string; fromPack: string; changes: number; details: string } | null;
  problems: string[];
  /** Render-cache use for this pack's images. */
  renderCache: { hits: number; misses: number };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export type ResolvedTarget = { mode: "global" } | { mode: "project"; root: string };

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** A path to (or inside) a project, `global`, or omitted (the project around cwd, else global). */
export async function resolveConnectTarget(target: string | undefined, cwd: string): Promise<ResolvedTarget> {
  const t = target?.trim();
  if (t === "global") return { mode: "global" };
  if (t && (RESERVED_TARGETS as readonly string[]).includes(t)) {
    throw new Error(`"${t}" is a flux-connect command, not a project: run \`flux connect ${t}\` from a shell, or pass ./${t} for a folder of that name`);
  }
  if (!t) {
    const root = await findProjectRoot(cwd);
    return root ? { mode: "project", root: await fs.realpath(root) } : { mode: "global" };
  }
  const abs = path.resolve(cwd, expandHome(t));
  try {
    await fs.stat(abs);
  } catch {
    throw new Error(`${abs} does not exist${await suggestions(abs)}`);
  }
  const root = await findProjectRoot(abs);
  if (!root) throw new Error(`${abs} is not inside a Flux project (no project.json in it or up to 8 folders above)${await suggestions(abs)}`);
  return { mode: "project", root: await fs.realpath(root) };
}

async function suggestions(abs: string): Promise<string> {
  const known = await listKnownProjects().catch(() => []);
  const base = path.basename(abs).toLowerCase();
  const hits = known.filter((k) => k.root.startsWith(abs + path.sep) || path.basename(k.root).toLowerCase().includes(base) || k.title.toLowerCase().includes(base)).slice(0, 5);
  return hits.length ? `. Known projects that may match: ${hits.map((k) => `"${k.title}" ${k.root}`).join("; ")}` : "";
}

// ---------------------------------------------------------------------------
// Parts (stdout-only mode)
// ---------------------------------------------------------------------------

/** Split a bundle at line boundaries into parts ≤ max chars, preferring section starts. */
export function splitParts(text: string, max = PART_MAX_CHARS): string[] {
  const lines = text.split("\n");
  const parts: string[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const line of lines) {
    const add = line.length + 1;
    const sectionStart = /^## §[A-Z] · /.test(line);
    if (cur.length && (size + add > max || (sectionStart && size > max * 0.6))) {
      parts.push(cur.join("\n"));
      cur = [];
      size = 0;
    }
    // A single enormous line (already wrapped at 400 in the bundle) cannot exceed max; guard anyway.
    if (add > max) {
      for (let i = 0; i < line.length; i += max - 1) parts.push(line.slice(i, i + max - 1));
      continue;
    }
    cur.push(line);
    size += add;
  }
  if (cur.length) parts.push(cur.join("\n"));
  return parts;
}

/** One digest over every source and watched path: a part refuses when anything changed since the pack. */
export function sourcesDigest(sources: readonly SourceRecord[], snapshot: StatSnapshot): string {
  const h = createHash("sha256");
  for (const s of [...sources].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${s.path}\0${s.sha || s.size}\n`);
  for (const [i, p] of snapshot.paths.entries()) h.update(`${p}\0${JSON.stringify(snapshot.stats[i])}\n`);
  return h.digest("hex").slice(0, 12);
}

function partHeader(packId: string, n: number, count: number, digest: string): string {
  return `# FLUX-CONNECT BUNDLE · pack ${packId} · part ${n} of ${count} · sources ${digest}\n`;
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

function manifestFor(
  facts: ConnectFacts,
  depth: ConnectDepth,
  identity: AgentIdentity,
  sources: SourceRecord[],
  bundle: { sections: BundleSection[]; tokens: number; lines: number },
  images: BriefImage[],
  state: PackState,
  snapshot: StatSnapshot,
): PackManifest {
  const p = facts.project;
  const ann = p?.review.items.filter((i) => i.kind === "annotation").length ?? 0;
  return {
    v: 1,
    packId: facts.packId,
    mode: facts.mode,
    root: p?.root ?? null,
    title: p?.title ?? "global",
    createdAt: facts.createdAt,
    depth,
    build: { version: facts.machine.fluxVersion, commit: facts.machine.commit },
    identity: { product: identity.product, surface: identity.surface, client: identity.client, sessionId: identity.sessionId },
    sessionName: facts.identity.sessionName,
    sources,
    bundle,
    images: images.map((i) => ({ path: i.path, label: i.label })),
    counts: {
      docs: p?.docs.length ?? 0,
      figures: p?.figures.length ?? 0,
      canvases: p?.canvases.length ?? 0,
      decks: p?.decks.length ?? 0,
      annotations: ann,
      comments: (p?.review.items.length ?? 0) - ann,
      logEntries: p?.notebook.entries.length ?? 0,
    },
    state,
    snapshot,
  };
}

/** Old texts of a pack, by sha (src/<sha>.txt). */
function packTexts(dir: string | null, extra?: Map<string, string>): (sha: string) => Promise<string | null> {
  return async (sha) => {
    if (!sha) return null;
    const hit = extra?.get(sha);
    if (hit !== undefined) return hit;
    if (!dir || !/^[0-9a-f]{64}$/.test(sha)) return null;
    return fs.readFile(path.join(dir, "src", `${sha}.txt`), "utf8").catch(() => null);
  };
}

/** Inputs for a delta against a cursor, reading the current project lazily. */
export function deltaInputs(root: string, cursor: DeltaCursor, changed: readonly string[], sessionId: string | null) {
  return { root, cursor, changed, figures: () => figureDigests(root), docs: () => currentDocShas(root), items: () => currentItems(root, sessionId) };
}

export async function connect(opts: ConnectOptions): Promise<ConnectResult> {
  const cwd = opts.cwd ?? process.cwd();
  const depth = opts.depth ?? "core";
  const target = await resolveConnectTarget(opts.target, cwd);
  const root = target.mode === "project" ? target.root : null;
  const now = opts.now ?? new Date();
  const packId = opts.packId ?? newPackId(now.getTime());
  const title = root ? ((await loadManifest(root)).title || path.basename(root)) : "global";
  const previous = await latestPack(target.mode, root, title);

  const { facts, sources, state, watch, texts } = await collectFacts({
    root,
    depth,
    packId,
    createdAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    identity: opts.identity,
    sessionName: opts.sessionName ?? null,
    live: !!opts.live,
    previous: previous ? { createdAt: previous.manifest.createdAt, sources: previous.manifest.sources } : null,
    progress: opts.progress,
  });
  const plan = planInclusion(facts, depth, { linkedBudget: opts.budget });
  const loc = await allocatePack(facts.mode, root, title, packId);
  const problems: string[] = [];
  if (loc.fallback && loc.dir) problems.push(`the Flux data folder is not writable here; the pack is in ${loc.dir}`);

  // Images need a pack dir; stdout-only mode and --no-render have none.
  let images: BriefImage[] = [];
  let renderCache = { hits: 0, misses: 0 };
  if (opts.noRender || !loc.dir) facts.machine.canRender = false;
  else if (root) {
    opts.progress?.(`connect: rendering ${plan.figureImages === "canvases" ? "canvas overviews" : "canvases and figures"}…`);
    const r = await renderPackImages(root, facts, plan, loc.dir);
    images = r.images;
    renderCache = r.cache;
    problems.push(...r.problems);
    const expected = facts.project?.canvases.filter((c) => c.figureIds.length).length ?? 0;
    if (expected && !images.length) facts.machine.canRender = false;
  }

  const bundle = renderBundle(facts, plan);
  const linkedImages = (facts.project?.projectContext.links ?? []).filter((l) => l.kind === "image").map((l) => l.abs);
  const snapshot = await takeSnapshot(watch);
  const digest = sourcesDigest(sources, snapshot);
  const parts = loc.dir ? null : splitParts(bundle.text);
  const targetArg = root ?? "global";
  const paths: BriefPaths = {
    briefPath: loc.dir ? path.join(loc.dir, "brief.md") : "(not written: this output is the brief)",
    bundlePath: loc.dir ? path.join(loc.dir, "bundle.md") : "(delivered in parts)",
    flux: path.join(facts.machine.fluxContextDir, "FLUX.md"),
    connect: path.join(facts.machine.fluxContextDir, "CONNECT.md"),
    ...(parts ? { parts: { count: parts.length, command: (n: number) => `flux connect ${JSON.stringify(targetArg)} --part ${n} --pack ${packId} --sources ${digest}` } } : {}),
  };
  const brief = renderBrief({ facts, plan, paths, bundle: { tokens: bundle.tokens, lines: bundle.lines, sections: bundle.sections }, images, linkedImages, live: !!opts.live });

  const manifest = manifestFor(facts, depth, opts.identity, sources, bundle, images, state, snapshot);

  // --refresh: what changed since this session last looked (its cursor), else since the previous pack.
  let refresh: ConnectResult["refresh"] = null;
  if (opts.refresh && root) {
    const session = opts.sessionKey ? await readCursor(opts.sessionKey) : null;
    const base: DeltaCursor | null =
      session && session.root === root
        ? { root, packId: session.packId, since: session.since, state: session.state, snapshot: session.snapshot, text: packTexts(session.packDir) }
        : previous
          ? { root, packId: previous.manifest.packId, since: previous.manifest.createdAt, state: previous.manifest.state, snapshot: previous.manifest.snapshot, text: packTexts(previous.dir) }
          : null;
    if (base) {
      const changed = changedPaths(base.snapshot, await takeSnapshot([...new Set([...base.snapshot.paths, ...watch])]));
      const delta: Delta = await computeDelta(deltaInputs(root, base, changed, opts.identity.sessionId));
      refresh = { since: base.since, fromPack: base.packId, changes: delta.changes.length, details: renderDeltaDetails(delta, title, base.since, now.getTime()) };
    }
  }

  let briefPath: string | null = null, bundlePath: string | null = null, manifestPath: string | null = null;
  if (loc.dir) {
    briefPath = await writePackFile(loc.dir, "brief.md", brief);
    bundlePath = await writePackFile(loc.dir, "bundle.md", bundle.text);
    for (const [sha, text] of texts) await writePackFile(loc.dir, `src/${sha}.txt`, text);
    manifestPath = await writePackFile(loc.dir, "pack.json", JSON.stringify(manifest, null, 1) + "\n");
    await prunePacks(loc.dir);
  }
  if (root) await recordProjectConnected(root, title).catch(() => {});
  if (root && loc.dir && opts.sessionKey) {
    await writeCursor({ v: 2, key: opts.sessionKey, root, title, packId, packDir: loc.dir, since: manifest.createdAt, state, snapshot, notified: snapshot }).catch(() => {});
  }

  return {
    packId,
    mode: facts.mode,
    root,
    title,
    brief,
    briefPath,
    bundlePath,
    manifestPath,
    images,
    stdoutOnly: !loc.dir,
    firstPart: parts ? partHeader(packId, 1, parts.length, digest) + parts[0] : null,
    sections: bundle.sections,
    cursor: root ? { root, packId, since: manifest.createdAt, state, snapshot, text: packTexts(loc.dir, texts) } : null,
    refresh,
    problems,
    renderCache,
  };
}

// ---------------------------------------------------------------------------
// Reading a pack back: --part, read_pack, get_pack_image, --check-receipt
// ---------------------------------------------------------------------------

/** Stdout-only mode: recompute part N of a pack, refusing if any source changed. */
export async function connectPart(opts: ConnectOptions & { part: number; pack: string; sources: string }): Promise<string> {
  const target = await resolveConnectTarget(opts.target, opts.cwd ?? process.cwd());
  const root = target.mode === "project" ? target.root : null;
  const depth = opts.depth ?? "core";
  const { facts, sources, watch } = await collectFacts({ root, depth, packId: opts.pack, createdAt: "", identity: opts.identity, sessionName: null, live: false });
  if (sourcesDigest(sources, await takeSnapshot(watch)) !== opts.sources) throw new Error(`pack ${opts.pack} is out of date — re-run flux-connect`);
  facts.machine.canRender = false;
  const parts = splitParts(renderBundle(facts, planInclusion(facts, depth, { linkedBudget: opts.budget })).text);
  if (opts.part < 1 || opts.part > parts.length) throw new Error(`pack ${opts.pack} has ${parts.length} part(s)`);
  return partHeader(opts.pack, opts.part, parts.length, opts.sources) + parts[opts.part - 1];
}

/** read_pack: the brief, one bundle section, or a sequential ≤20k-char part. */
export async function readPack(packId: string, opts: { section?: string; part?: number } = {}): Promise<{ text: string; parts: number }> {
  const found = await findPack(packId);
  if (!found) throw new Error(`No flux-connect pack "${packId}" on this machine (packs are kept 5 per project) — run flux-connect again`);
  if (opts.section === "brief") return { text: await fs.readFile(path.join(found.dir, "brief.md"), "utf8"), parts: 1 };
  const bundle = await fs.readFile(path.join(found.dir, "bundle.md"), "utf8");
  if (opts.section) {
    const id = opts.section.replace(/^§/, "").toUpperCase();
    const s = found.manifest.bundle.sections.find((x) => x.id === id);
    if (!s) throw new Error(`pack ${packId} has no section "${opts.section}" (sections: ${found.manifest.bundle.sections.map((x) => x.id).join(", ")}, or "brief")`);
    const lines = bundle.split("\n").slice(s.startLine - 1, s.endLine);
    const parts = splitParts(lines.join("\n"));
    const n = opts.part ?? 1;
    if (n < 1 || n > parts.length) throw new Error(`section ${id} has ${parts.length} part(s)`);
    return { text: (parts.length > 1 ? `(section ${id}, part ${n} of ${parts.length})\n` : "") + parts[n - 1], parts: parts.length };
  }
  const parts = splitParts(bundle);
  const n = opts.part ?? 1;
  if (n < 1 || n > parts.length) throw new Error(`pack ${packId} has ${parts.length} part(s)`);
  return { text: `(bundle part ${n} of ${parts.length})\n` + parts[n - 1], parts: parts.length };
}

/** get_pack_image: the PNG bytes of image `index` in a pack. */
export async function packImage(packId: string, index: number): Promise<{ png: Buffer; label: string; count: number }> {
  const found = await findPack(packId);
  if (!found) throw new Error(`No flux-connect pack "${packId}" on this machine — run flux-connect again`);
  const img = found.manifest.images[index];
  if (!img) throw new Error(`pack ${packId} has ${found.manifest.images.length} image(s) (index from 0)`);
  // The manifest's path must stay inside the pack's images/ folder.
  const abs = path.resolve(img.path);
  if (path.dirname(abs) !== path.join(found.dir, "images")) throw new Error(`pack ${packId}: image ${index} is outside the pack`);
  return { png: await fs.readFile(abs), label: img.label, count: found.manifest.images.length };
}

/** --check-receipt / connect_doctor {checkReceipt}: which section and image codes a proof line confirms. */
export async function checkPackReceipt(packId: string, proof: string): Promise<ReceiptCheck & { title: string }> {
  const found = await findPack(packId);
  if (!found) throw new Error(`No flux-connect pack "${packId}" on this machine`);
  return { ...checkReceipt(packId, proof, found.manifest.bundle.sections.map((s) => s.id), found.manifest.images.length), title: found.manifest.title };
}

export function describeReceiptCheck(r: ReceiptCheck & { title: string }): string {
  const secOk = r.sections.filter((s) => s.ok).map((s) => s.id);
  const secMiss = r.sections.filter((s) => !s.ok).map((s) => s.id);
  const imgOk = r.images.filter((i) => i.ok).length;
  return [
    `${r.complete ? "✓ complete" : "✗ incomplete"} receipt for "${r.title}"`,
    `  sections confirmed: ${secOk.join(", ") || "none"}${secMiss.length ? ` · missing: ${secMiss.join(", ")}` : ""}`,
    `  images confirmed: ${imgOk} of ${r.images.length}`,
  ].join("\n");
}

export { packTexts };
