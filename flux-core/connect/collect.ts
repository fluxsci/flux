// Gathers the facts a flux-connect pack is built from. Read-only: it never
// writes to the project, FluxConfig or FluxLib (the pack cache is cache.ts's
// business). Every file it reads is recorded as a source (path, sha256, size,
// mtime) so a later refresh can say exactly what changed, and so `--part`
// can refuse to mix versions.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fluxPaths from "../../electron/fluxPaths.cjs";
import { resolveSpawn } from "../../electron/execResolve.cjs";
import { listKnownProjects } from "../../electron/projectsRegistry.cjs";
import { configInfo } from "../references";
import { loadManifest, readFigIndex, readCanvasFiles } from "../model";
import { listDocuments } from "../manuscript";
import { listProjectComments } from "../comments";
import { captionFor, syncFigureAssets } from "../figures";
import { listDecks } from "../slides";
import { bridgeAvailable, getAppContext } from "../liveClient";
import { CONTEXT_PATHS, CONTEXT_DOC_RELS, parseLog, projectContextTemplate } from "../../src/lib/project/contextTemplates";
import { sortedCanvasMeta } from "../../src/lib/project/figfiles";
import { ANNOTATIONS_REL, foldAnnotations, parseLedger } from "../../src/lib/project/annotations";
import { buildInbox, filterInbox, sortForInbox } from "../../src/lib/project/inbox";
import { PRESENCE_DIR_REL, liveSessions, parsePresence } from "../../src/lib/project/presence";
import type { AgentIdentity } from "../agentIdentity";
import type { PackState } from "./cache";
import type { Deck } from "../../src/lib/slide/types";
import type { SemanticPlotElement } from "../../src/lib/types";
import { extractLinkRefs, linkKind } from "./links";
import {
  tokensOf,
  type ConnectDepth,
  type ConnectFacts,
  type DeckFact,
  type DocFact,
  type FigureFact,
  type JournalGroup,
  type LinkedFile,
  type LiveFacts,
  type MachineFacts,
  type OutlineEntry,
  type ProjectFacts,
  type ReviewItemFact,
  type UserFacts,
} from "./facts";

/** One file the pack was built from. */
export interface SourceRecord {
  /** Absolute path. */
  path: string;
  sha: string;
  size: number;
  mtimeMs: number;
}

export interface CollectOptions {
  /** Realpath of the project root, or null for global mode. */
  root: string | null;
  depth: ConnectDepth;
  packId: string;
  createdAt: string;
  identity: AgentIdentity;
  sessionName: string | null;
  /** Ask the running app (bridge) for its surface and selection. */
  live: boolean;
  /** The previous pack for this root (for "changed since last pack"). */
  previous?: { createdAt: string; sources: SourceRecord[] } | null;
  /** Progress lines, to stderr on the CLI. */
  progress?: (line: string) => void;
}

export interface CollectResult {
  facts: ConnectFacts;
  sources: SourceRecord[];
  /** What a later delta compares against (project mode). */
  state: PackState;
  /** The paths the no-change check stats (files and directories). */
  watch: string[];
  /** Document and Context texts by sha, kept with the pack for line counts. */
  texts: Map<string, string>;
}

/** Text files larger than this are listed, never loaded. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** How deep `--depth full` follows links from ProjectContext (core: 1). */
export const FULL_LINK_DEPTH = 3;
const JOURNAL_TAIL_BYTES = 256 * 1024;
const JOURNAL_ACTIONS = 30;

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240);

class Sources {
  readonly list: SourceRecord[] = [];
  readonly texts = new Map<string, string>();
  private seen = new Set<string>();
  /** Keep a text for the pack (documents and Context files: later line counts). */
  keep(sha: string, text: string) {
    this.texts.set(sha, text);
  }
  /** Read a UTF-8 file and record it; null when missing or unreadable. */
  async text(abs: string, max = MAX_TEXT_BYTES): Promise<{ text: string; sha: string } | null> {
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > max) return null;
      const buf = await fs.readFile(abs);
      const sha = sha256(buf);
      if (!this.seen.has(abs)) {
        this.seen.add(abs);
        this.list.push({ path: abs, sha, size: st.size, mtimeMs: st.mtimeMs });
      }
      return { text: buf.toString("utf8"), sha };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

export function outlineOf(text: string, maxLevel = 3): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let fence: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && h[1].length <= maxLevel) out.push({ level: h[1].length, text: h[2], line: i + 1 });
  }
  return out;
}

const wordsOf = (text: string) => (text.match(/\S+/g) ?? []).length;

function frontmatterTitle(text: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const t = m && /^title:\s*(.+)$/m.exec(m[1]);
  return t ? t[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** `name` and `description` from a SKILL.md frontmatter (Agent Skills format). */
export function skillFrontmatter(text: string): { name: string; description: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const field = (k: string) => {
    const r = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]);
    return r ? r[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const name = field("name");
  return name ? { name, description: field("description") } : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Walk a tree (depth-limited, dot entries skipped), yielding file paths. */
async function walk(dir: string, opts: { maxDepth: number; skipDir?: (rel: string) => boolean; limit?: number }, rel = "", depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > opts.maxDepth || (opts.limit && out.length >= opts.limit)) return out;
  for (const e of (await listDir(path.join(dir, rel))).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!opts.skipDir?.(r)) await walk(dir, opts, r, depth + 1, out);
    } else if (e.isFile()) out.push(r);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/** Run a short command for its version line; null when missing or slow. */
function versionOf(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const r = resolveSpawn(cmd, args);
      const child = spawn(r.command, r.args, { stdio: ["ignore", "pipe", "ignore"], windowsVerbatimArguments: r.windowsVerbatimArguments, windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const v = /\d+\.\d+(\.\d+)?/.exec(out)?.[0] ?? null;
        finish(code === 0 ? v : null);
      });
    } catch {
      finish(null);
    }
  });
}

function gitSummary(dir: string): Promise<{ branch: string; dirty: number } | null> {
  const run = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      let out = "";
      try {
        const child = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        const timer = setTimeout(() => child.kill(), 3000);
        child.stdout.on("data", (d) => (out += d));
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? out : null);
        });
      } catch {
        resolve(null);
      }
    });
  return Promise.all([run(["rev-parse", "--abbrev-ref", "HEAD"]), run(["status", "--porcelain"])]).then(([b, s]) =>
    b === null || s === null ? null : { branch: b.trim(), dirty: s.split("\n").filter(Boolean).length },
  );
}

// ---------------------------------------------------------------------------
// Machine and user
// ---------------------------------------------------------------------------

async function mcpRegistrations(): Promise<{ claude: boolean; codex: boolean }> {
  const home = os.homedir();
  const claude = await fs
    .readFile(path.join(home, ".claude.json"), "utf8")
    .then((t) => !!(JSON.parse(t) as { mcpServers?: Record<string, unknown> }).mcpServers?.flux)
    .catch(() => false);
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codex = await fs
    .readFile(path.join(codexHome, "config.toml"), "utf8")
    .then((t) => /^\s*\[mcp_servers\.flux\]\s*$/m.test(t))
    .catch(() => false);
  return { claude, codex };
}

async function fluxLibFacts(lib: string): Promise<MachineFacts["fluxLib"]> {
  const bib = await fs.readFile(path.join(lib, "library.bib"), "utf8").catch(() => "");
  const entries = (bib.match(/^\s*@(?!comment\b|string\b|preamble\b)\w+\s*\{/gim) ?? []).length;
  let pdfs: number | null = null;
  try {
    const idx = JSON.parse(await fs.readFile(path.join(lib, ".fluxlib", "items.json"), "utf8")) as Record<string, { hasPdf?: boolean }>;
    pdfs = Object.values(idx).filter((s) => s?.hasPdf).length;
  } catch {
    /* no items index yet: the count is unknown, and connect never builds one */
  }
  return { path: lib, entries, pdfs };
}

async function fluxplotFacts(workspace: string | null): Promise<MachineFacts["fluxplot"]> {
  const candidates = [process.env.FLUXPLOT_PATH, workspace ? path.join(workspace, "fluxplot") : null, path.join(os.homedir(), "fluxplot")].filter(
    (c): c is string => !!c,
  );
  for (const dir of candidates) {
    const py = await fs.readFile(path.join(dir, "pyproject.toml"), "utf8").catch(() => null);
    if (py && /^name\s*=\s*["']fluxplot["']/m.test(py)) return { path: dir, version: /^version\s*=\s*["']([^"']+)["']/m.exec(py)?.[1] ?? null };
  }
  return null;
}

async function machineFacts(workspace: string | null): Promise<{ machine: MachineFacts; userContextDir: string; userDataDir: string }> {
  const info = await configInfo();
  let installKind: MachineFacts["installKind"] = "source";
  let installPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  try {
    const rt = fluxPaths.resolveOwnCliCommandsSync();
    installKind = rt.electron ? "packaged" : "source";
    installPath = rt.target;
  } catch {
    /* translocated or unlocatable: keep the source-relative guess */
  }
  const launcher = path.join(fluxPaths.binDirSync(), process.platform === "win32" ? "flux.cmd" : "flux");
  const stockDocs = [];
  for (const e of await listDir(info.fluxContextPath)) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const t = await fs.readFile(path.join(info.fluxContextPath, e.name), "utf8").catch(() => "");
    stockDocs.push({ name: e.name, path: path.join(info.fluxContextPath, e.name), tokens: tokensOf(t) });
  }
  stockDocs.sort((a, b) => a.name.localeCompare(b.name));
  const plotFiles = await walk(info.plotLibraryPath, { maxDepth: 4, limit: 5000 });
  const [mcp, fluxLib, fluxplot, quarto, uv] = await Promise.all([
    mcpRegistrations(),
    fluxLibFacts(info.fluxLibPath),
    fluxplotFacts(workspace),
    versionOf("quarto", ["--version"]),
    versionOf("uv", ["--version"]),
  ]);
  return {
    machine: {
      fluxVersion: info.build.version,
      commit: info.build.commit,
      installKind,
      installPath,
      launcher,
      mcpRegistered: mcp,
      fluxConfig: info.fluxConfigPath,
      fluxContextDir: info.fluxContextPath,
      stockDocs,
      fluxLib,
      plotLibrary: (await exists(info.plotLibraryPath)) ? { path: info.plotLibraryPath, count: plotFiles.filter((f) => f.endsWith(".svg")).length } : null,
      fluxplot,
      quarto,
      uv,
      // Rendering is proven by rendering (images.ts reports failures); --no-render clears it.
      canRender: true,
    },
    userContextDir: info.userContextPath,
    userDataDir: info.userDataDir,
  };
}

const USER_TEXT = /\.(md|txt|qmd)$/i;
const USER_IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

async function userFacts(dir: string, src: Sources): Promise<UserFacts> {
  const files: UserFacts["files"] = [];
  const images: UserFacts["images"] = [];
  const skills: UserFacts["skills"] = [];
  // Skills are listed by name and description (bodies are read on demand), never bundled as text.
  const all = await walk(dir, { maxDepth: 6, skipDir: (rel) => rel === "Skills", limit: 2000 });
  for (const rel of all) {
    const abs = path.join(dir, rel);
    if (USER_TEXT.test(rel)) {
      const r = await src.text(abs);
      if (r) files.push({ rel, text: r.text, sha: r.sha });
    } else if (USER_IMAGE.test(rel)) images.push({ rel, abs });
  }
  for (const e of await listDir(path.join(dir, "Skills"))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const skillPath = path.join(dir, "Skills", e.name, "SKILL.md");
    const r = await src.text(skillPath, 256 * 1024);
    const fm = r && skillFrontmatter(r.text);
    if (fm && fm.name === e.name) skills.push({ name: fm.name, description: fm.description, path: skillPath });
  }
  return { dir, files, images, skills };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** Where a ProjectContext link points: absolute, `~`, or relative to the linking file. */
export function resolveLink(link: string, fromFile: string): string {
  let t = link;
  try {
    t = decodeURIComponent(link);
  } catch {
    /* keep it as written */
  }
  if (t.startsWith("~/") || t === "~") return path.join(os.homedir(), t.slice(1));
  if (path.isAbsolute(t)) return path.normalize(t);
  return path.resolve(path.dirname(fromFile), t);
}

async function linkedFiles(root: string, pcAbs: string, pcText: string, depth: ConnectDepth, src: Sources): Promise<LinkedFile[]> {
  const maxDepth = depth === "full" ? FULL_LINK_DEPTH : 1;
  const out: LinkedFile[] = [];
  const seen = new Set<string>([pcAbs]);
  const display = (abs: string) => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
  };
  let frontier: { abs: string; text: string }[] = [{ abs: pcAbs, text: pcText }];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: { abs: string; text: string }[] = [];
    for (const from of frontier) {
      for (const { target: link, via } of extractLinkRefs(from.text)) {
        const abs = resolveLink(link, from.abs);
        if (seen.has(abs)) continue;
        seen.add(abs);
        let st: import("node:fs").Stats | null = null;
        try {
          st = await fs.stat(abs);
        } catch {
          /* missing */
        }
        if (!st) {
          // A backticked name that does not exist is just code; a written link that does not resolve is reported.
          if (via !== "code") out.push({ link, abs, display: display(abs), kind: "missing", depth: d });
          continue;
        }
        if (st.isDirectory()) {
          out.push({ link, abs, display: display(abs), kind: "other", depth: d });
          continue;
        }
        const kind = linkKind(abs);
        if (kind === "text") {
          const r = await src.text(abs);
          if (r) {
            out.push({ link, abs, display: display(abs), kind: "text", text: r.text, sha: r.sha, outline: outlineOf(r.text), depth: d });
            if (/\.(qmd|md|markdown|txt)$/i.test(abs)) next.push({ abs, text: r.text });
          } else out.push({ link, abs, display: display(abs), kind: "other", depth: d });
        } else out.push({ link, abs, display: display(abs), kind, depth: d });
      }
    }
    frontier = next;
  }
  return out;
}

/** True when ProjectContext still reads as the unfilled template (only headings, comments and placeholders). */
export function isTemplateContext(text: string, title: string): boolean {
  if (text.trim() === projectContextTemplate(title).trim()) return true;
  const body = text
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^\*\(.*\)\*$/.test(l.trim()));
  return body.length === 0;
}

/** The notebook text above its `## Log` heading, when it holds more than the title and comments. */
export function legacyNotebookSections(text: string): string | null {
  const at = text.search(/^##[ \t]+Log[ \t]*$/m);
  const head = (at < 0 ? text : text.slice(0, at))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#\s+.*$/m, "")
    .replace(/^---\s*$/gm, "")
    .trim();
  const substantive = head.split("\n").filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^\*\(.*\)\*$/.test(l.trim()));
  return substantive.length ? head : null;
}

async function docFacts(root: string, src: Sources, withText: boolean): Promise<{ docs: DocFact[]; commented: Set<string> }> {
  const rows = await listDocuments(root);
  const threads = await listProjectComments(root).catch(() => []);
  const commented = new Set(threads.filter((t) => !t.resolved).map((t) => t.doc));
  const docs: DocFact[] = [];
  const skip = new Set(CONTEXT_DOC_RELS);
  for (const row of rows) {
    if (skip.has(row.path)) continue;
    const r = await src.text(path.join(root, row.path));
    const text = r?.text ?? "";
    if (r) src.keep(r.sha, text);
    docs.push({
      path: row.path,
      title: row.title || frontmatterTitle(text) || path.basename(row.path),
      words: wordsOf(text.replace(/^---\n[\s\S]*?\n---/, "")),
      lines: text ? text.split("\n").length : 0,
      hasComments: commented.has(row.path),
      outline: outlineOf(text),
      sha: r?.sha ?? "",
      ...(withText && r ? { text } : {}),
    });
  }
  return { docs, commented };
}

/** Figure id → display name + sha of its model JSON (what a delta compares). */
export async function figureDigests(root: string): Promise<Record<string, { name: string; sha: string }>> {
  const index = await readFigIndex(root).catch(() => null);
  if (!index) return {};
  const { byId } = await readCanvasFiles(root, index).catch(() => ({ byId: {} as Record<string, unknown> }));
  const out: Record<string, { name: string; sha: string }> = {};
  for (const f of index.figures) out[f.id] = { name: f.name, sha: sha256(JSON.stringify(byId[f.id] ?? null) + "\0" + f.caption) };
  return out;
}

async function figureFacts(root: string, src: Sources, problems: string[]): Promise<{ figures: FigureFact[]; canvases: ProjectFacts["canvases"] }> {
  let index: Awaited<ReturnType<typeof readFigIndex>>;
  try {
    index = await readFigIndex(root);
  } catch (e) {
    problems.push(`fig/index.json could not be read: ${firstLine(e)}`);
    return { figures: [], canvases: [] };
  }
  if (!index) return { figures: [], canvases: [] };
  await src.text(path.join(root, "fig", "index.json"));
  for (const c of index.canvases) await src.text(path.join(root, "fig", "canvases", `${c.id}.json`), 64 * 1024 * 1024);
  let byId: Record<string, import("../../src/lib/types").Figure> = {};
  try {
    byId = (await readCanvasFiles(root, index)).byId;
  } catch (e) {
    // A damaged figure model still lists from the index; the defect is reported, never fatal.
    problems.push(`the figure files are damaged (${firstLine(e)}); figures are listed from fig/index.json only — run \`flux validate\``);
  }
  let stale = new Set<string>();
  try {
    const dry = await syncFigureAssets(root, undefined, { dryRun: true });
    stale = new Set(dry.refreshed.map((r) => r.assetId));
  } catch {
    /* staleness is advisory */
  }
  const figures: FigureFact[] = [];
  for (const f of [...index.figures].sort((a, b) => a.order - b.order)) {
    const fig = byId[f.id];
    const caption = await captionFor(root, f.id).catch(() => "");
    const plain = caption.replace(/\s+/g, " ").trim();
    const plots = (fig?.elements ?? []).filter((e): e is SemanticPlotElement => e.type === "plot");
    figures.push({
      id: f.id,
      displayName: f.nickname ? `${f.name} (${f.nickname})` : f.name,
      canvasId: f.canvas,
      captionLead: plain.length > 120 ? plain.slice(0, 119) + "…" : plain,
      caption,
      panels: plots.map((p) => ({ ...(p.name ? { label: p.name } : {}), ...(p.source?.svgPath ? { source: p.source.svgPath } : {}), ...(p.source?.recipePath ? { recipe: p.source.recipePath } : {}) })),
      stale: plots.some((p) => stale.has(p.assetId)),
      ...(fig && !fig.elements.length ? { empty: true } : {}),
    });
  }
  const canvases = sortedCanvasMeta(index).map((c) => ({ id: c.id, name: c.name, figureIds: figures.filter((f) => f.canvasId === c.id).map((f) => f.id) }));
  return { figures, canvases };
}

async function deckFacts(root: string, src: Sources): Promise<DeckFact[]> {
  const out: DeckFact[] = [];
  for (const d of await listDecks(root).catch(() => [])) {
    const r = await src.text(path.join(root, d.path), 64 * 1024 * 1024);
    let deck: Deck | null = null;
    try {
      deck = r ? (JSON.parse(r.text) as Deck) : null;
    } catch {
      deck = null;
    }
    out.push({
      id: d.id,
      title: d.title,
      path: d.path,
      slides: (deck?.slides ?? []).map((s, i) => ({ id: s.id, name: s.name || `Slide ${i + 1}`, beats: Math.max(1, s.beats?.length ?? 0), ...(s.notes?.trim() ? { notes: s.notes } : {}) })),
    });
  }
  return out;
}

async function plotsFacts(root: string): Promise<ProjectFacts["plots"]> {
  const dir = path.join(root, "plots");
  const files = await walk(dir, { maxDepth: 5, skipDir: (rel) => rel.startsWith("_"), limit: 20000 });
  const dissections = (await listDir(path.join(dir, "_dissections"))).filter((e) => e.isDirectory()).length;
  const lighttable = (await listDir(path.join(dir, "_lighttable"))).filter((e) => e.isDirectory()).map((e) => e.name);
  return { count: files.filter((f) => f.endsWith(".svg")).length, dissections, lighttable };
}

const WORKSPACE_MARKERS = ["pyproject.toml", "uv.lock", ".git", "AGENTS.md", "CLAUDE.md", "requirements.txt", "environment.yml"];

async function workspaceFacts(root: string): Promise<ProjectFacts["workspace"]> {
  const dir = path.dirname(root);
  if (dir === root) return null;
  const markers: string[] = [];
  for (const m of WORKSPACE_MARKERS) if (await exists(path.join(dir, m))) markers.push(m);
  if (!markers.length) return null;
  const entries = (await listDir(dir))
    .filter((e) => !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .slice(0, 30);
  return { dir, markers, entries };
}

/** Review items for §G: the same inbox every surface shows, open items only. */
export async function reviewItemFacts(root: string, humanAuthors: string[]): Promise<ReviewItemFact[]> {
  const ledger = await fs.readFile(path.join(root, ANNOTATIONS_REL), "utf8").catch(() => "");
  const state = foldAnnotations(parseLedger(ledger));
  const comments = await listProjectComments(root).catch(() => []);
  const sessions = [];
  for (const e of await listDir(path.join(root, PRESENCE_DIR_REL))) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const s = parsePresence(await fs.readFile(path.join(root, PRESENCE_DIR_REL, e.name), "utf8").catch(() => ""));
    if (s) sessions.push(s);
  }
  const now = Date.now();
  const live = liveSessions(sessions, now, { host: os.hostname() });
  const items = buildInbox({ state, comments, liveness: { now, liveSessionIds: new Set(live.keys()) }, humanAuthors });
  return sortForInbox(filterInbox(items, {})).map((i) => ({
    id: i.id,
    kind: i.kind,
    where: i.where,
    text: i.text,
    status: i.status,
    chip: i.chip,
    route: typeof i.route === "string" ? i.route : i.route && "session" in i.route ? `@${i.route.session.name}` : i.route && "background" in i.route ? "@new" : "none",
    tags: i.tags,
    surface: i.surface,
    ...(i.doc ? { doc: i.doc } : {}),
  }));
}

/** The open inbox now, for a delta: status, a one-line description, and whether it is routed to this session. */
export async function currentItems(root: string, sessionId: string | null): Promise<import("./refresh").CurrentItems> {
  const manifest = await loadManifest(root).catch(() => null);
  const humanAuthors = (manifest?.authors ?? []).map((a) => a.name).filter(Boolean);
  const ledger = await fs.readFile(path.join(root, ANNOTATIONS_REL), "utf8").catch(() => "");
  const state = foldAnnotations(parseLedger(ledger));
  const comments = await listProjectComments(root).catch(() => []);
  const items = buildInbox({ state, comments, liveness: { now: Date.now() }, humanAuthors });
  const open = new Map<string, { status: string; line: string; forYou: boolean; kind: "annotation" | "comment" }>();
  for (const i of filterInbox(items, {})) {
    const routed = typeof i.route === "object" && i.route && "session" in i.route ? i.route.session.id : null;
    const forYou = !!sessionId && (routed === sessionId || i.assignedTo?.id === sessionId);
    open.set(i.id, { status: i.status, kind: i.kind, forYou, line: `${i.kind} · ${i.where} · "${i.text.slice(0, 80).replace(/\s+/g, " ")}" · ${i.chip}` });
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    open,
    closedHow: (id) => {
      const i = byId.get(id);
      if (!i) return "removed";
      if (i.status === "resolved") return "resolved";
      if (i.status === "withdrawn") return "withdrawn by the user";
      if (i.archived) return "archived";
      return null;
    },
  };
}

/** Document path → sha for every current document and Context file (a delta's document list). */
export async function currentDocShas(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const rows = await listDocuments(root).catch(() => []);
  for (const rel of new Set([...rows.map((r) => r.path), ...CONTEXT_DOC_RELS])) {
    try {
      out[rel] = sha256(await fs.readFile(path.join(root, rel)));
    } catch {
      /* missing */
    }
  }
  return out;
}

/** The tail of the journal, collapsed by (client, action, target), newest last. */
async function journalFacts(root: string, src: Sources): Promise<JournalGroup[]> {
  const file = path.join(root, ".meta", "journal.ndjson");
  let text = "";
  try {
    const st = await fs.stat(file);
    const fh = await fs.open(file, "r");
    try {
      const start = Math.max(0, st.size - JOURNAL_TAIL_BYTES);
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      await fh.close();
    }
    src.list.push({ path: file, sha: "", size: st.size, mtimeMs: st.mtimeMs });
  } catch {
    return [];
  }
  const events: { ts: string; client: string; action: string; target: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; at?: string; client?: string; action?: string; target?: string; detail?: string };
      if (!e.action) continue;
      events.push({ ts: e.ts ?? e.at ?? "", client: e.client ?? "?", action: e.action, target: e.target ?? "" });
    } catch {
      /* torn line */
    }
  }
  const groups: JournalGroup[] = [];
  for (const e of events.slice(-JOURNAL_ACTIONS * 4)) {
    const last = groups[groups.length - 1];
    if (last && last.client === e.client && last.action === e.action && last.target === e.target) {
      last.count++;
      last.last = e.ts;
    } else groups.push({ client: e.client, action: e.action, target: e.target, count: 1, first: e.ts, last: e.ts });
  }
  return groups.slice(-JOURNAL_ACTIONS);
}

async function projectFacts(root: string, opts: CollectOptions, src: Sources): Promise<ProjectFacts> {
  const manifest = await loadManifest(root);
  const title = manifest.title || path.basename(root);
  await src.text(path.join(root, "project.json"));
  opts.progress?.("connect: reading documents…");
  const problems: string[] = [];
  const { docs } = await docFacts(root, src, opts.depth === "full").catch((e) => {
    problems.push(`the document list could not be read: ${firstLine(e)}`);
    return { docs: [] as DocFact[], commented: new Set<string>() };
  });
  const pcAbs = path.join(root, CONTEXT_PATHS.projectContext);
  const pc = await src.text(pcAbs);
  if (pc) src.keep(pc.sha, pc.text);
  const pcText = pc?.text ?? "";
  const links = pc ? await linkedFiles(root, pcAbs, pcText, opts.depth, src) : [];
  const rules = await src.text(path.join(root, CONTEXT_PATHS.rules));
  if (rules) src.keep(rules.sha, rules.text);
  const nb = await src.text(path.join(root, CONTEXT_PATHS.notebook));
  opts.progress?.("connect: reading figures and decks…");
  const [{ figures, canvases }, decks, plots, workspace, git] = await Promise.all([
    figureFacts(root, src, problems),
    deckFacts(root, src),
    plotsFacts(root),
    workspaceFacts(root),
    gitSummary(root),
  ]);
  const bibRel = manifest.references?.library ?? "references/library.bib";
  const bib = await fs.readFile(path.join(root, bibRel), "utf8").catch(() => "");
  const authors = (manifest.authors ?? []).map((a) => a.name).filter(Boolean);
  const review = await reviewItemFacts(root, authors).catch(() => []);
  const journal = await journalFacts(root, src);
  const prev = opts.previous;
  const changed: string[] = [];
  if (prev) {
    const before = new Map(prev.sources.map((s) => [s.path, s.sha]));
    for (const s of src.list) {
      if (!s.sha) continue;
      const was = before.get(s.path);
      if (was !== s.sha) changed.push(path.relative(root, s.path).split(path.sep).join("/") || s.path);
    }
  }
  return {
    root,
    title,
    authors,
    defaultDoc: manifest.manuscript?.path ?? null,
    docs,
    figures,
    canvases,
    decks,
    plots,
    referencesCount: (bib.match(/^\s*@(?!comment\b|string\b|preamble\b)\w+\s*\{/gim) ?? []).length,
    workspace,
    git,
    projectContext: {
      path: CONTEXT_PATHS.projectContext,
      text: pcText,
      sha: pc?.sha ?? "",
      isTemplate: !!pc && isTemplateContext(pcText, title),
      missing: !pc,
      links,
    },
    rules: { path: CONTEXT_PATHS.rules, text: rules?.text ?? "", sha: rules?.sha ?? "" },
    notebook: {
      path: CONTEXT_PATHS.notebook,
      sha: nb?.sha ?? "",
      entries: nb ? parseLog(nb.text) : [],
      legacySections: nb ? legacyNotebookSections(nb.text) : null,
    },
    review: { items: review },
    activity: { journal, changedSinceLastPack: changed, lastPackAt: prev?.createdAt ?? null },
    problems,
  };
}

async function liveFacts(root: string): Promise<LiveFacts> {
  if (!(await bridgeAvailable(root).catch(() => false))) return { appOpen: false };
  try {
    const ctx = (await getAppContext(root)) as { mode?: string; surface?: string; selection?: unknown; selectionSummary?: string };
    const surface = ctx.surface ?? ctx.mode;
    const selection =
      ctx.selectionSummary ??
      (Array.isArray(ctx.selection) ? `${ctx.selection.length} selected` : typeof ctx.selection === "string" ? ctx.selection : undefined);
    return { appOpen: true, ...(surface ? { surface } : {}), ...(selection ? { selection } : {}) };
  } catch {
    return { appOpen: true };
  }
}

export async function collectFacts(opts: CollectOptions): Promise<CollectResult> {
  const src = new Sources();
  const root = opts.root;
  opts.progress?.("connect: reading machine and user context…");
  const workspaceDir = root ? path.dirname(root) : null;
  const { machine, userContextDir } = await machineFacts(workspaceDir);
  const user = await userFacts(userContextDir, src);
  const project = root ? await projectFacts(root, opts, src) : null;
  const known = await listKnownProjects().catch(() => []);
  const facts: ConnectFacts = {
    mode: root ? "project" : "global",
    packId: opts.packId,
    createdAt: opts.createdAt,
    machine,
    user,
    project,
    live: root && opts.live ? await liveFacts(root) : null,
    identity: { product: opts.identity.product, surface: opts.identity.surface, sessionName: opts.sessionName },
    knownProjects: known
      .map((k) => ({ root: k.root, title: k.title, lastOpened: k.lastOpened ?? k.lastConnected ?? null }))
      .filter((k) => k.root !== root)
      .slice(0, 15),
  };
  const state: PackState = project
    ? {
        logTitles: project.notebook.entries.map((e) => `${e.stamp} — ${e.title}`),
        figures: await figureDigests(project.root),
        items: Object.fromEntries(project.review.items.map((i) => [i.id, i.status])),
        docs: Object.fromEntries([
          ...project.docs.map((d) => [d.path, d.sha] as const),
          ...(project.projectContext.sha ? [[project.projectContext.path, project.projectContext.sha] as const] : []),
          ...(project.rules.sha ? [[project.rules.path, project.rules.sha] as const] : []),
          ...(project.notebook.sha ? [[project.notebook.path, project.notebook.sha] as const] : []),
        ]),
      }
    : { logTitles: [], figures: {}, items: {}, docs: {} };
  const watch = project ? await watchPaths(project) : [];
  return { facts, sources: src.list, state, watch, texts: src.texts };
}

/** What the stat-only no-change check looks at: Context docs, documents and
 *  their folders (new files and comment sidecars show as folder mtimes), the
 *  figure files, decks, the annotation ledger and the manifest. */
export async function watchPaths(p: ProjectFacts): Promise<string[]> {
  const root = p.root;
  const rels = new Set<string>(["project.json", ".meta", ANNOTATIONS_REL, "fig", "fig/index.json", "fig/canvases", "fig/captions", "slides", ...CONTEXT_DOC_RELS, CONTEXT_PATHS.dir]);
  for (const d of p.docs) {
    rels.add(d.path);
    rels.add(path.posix.dirname(d.path));
  }
  for (const dir of [...rels].filter((r) => !/\.[a-z0-9]+$/i.test(r) || r === ".meta")) {
    for (const e of await listDir(path.join(root, dir))) {
      if (e.isFile() && (e.name.endsWith("comments.json") || (dir.startsWith("fig/") && e.name.endsWith(".json")) || (dir === "fig/captions" && e.name.endsWith(".md")))) rels.add(`${dir}/${e.name}`);
      if (dir === "slides" && e.isDirectory()) rels.add(`slides/${e.name}/deck.json`);
    }
  }
  return [...rels].sort().map((r) => path.join(root, r));
}
