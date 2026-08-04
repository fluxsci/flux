// Types mirroring the on-disk project format (SciForge_Project_Format.md).
// App-name-agnostic: the manifest is project.json, state lives in .meta/.

import type { FigureFamilyDef } from "../figfamily";

export const PROJECT_SCHEMA_VERSION = "0.1.0";
// WS-5.2: named per-file format versions (the write sites used bare literals)
// + THE forward-version comparator every load path shares. While formats are
// 0.x, the MINOR is the breaking slot (load.ts documents this); PATCH bumps
// load fine.
export const FIG_INDEX_SCHEMA_VERSION = "0.1.0";
export const CANVAS_SCHEMA_VERSION = "0.1.0";
export const PROJECT_MODEL_VERSION = 2; // standalone Project.version (migrate.ts stamps it)

/** True when fileV names a NEWER breaking format than appV (0.x: minor is the
 *  breaking slot). Missing/garbled file versions are NOT newer (legacy). */
export function isNewerSchema(fileV: unknown, appV: string): boolean {
  const parse = (v: unknown) => String(v ?? "0").split(".").map((n) => parseInt(n, 10) || 0);
  const [fileMajor, fileMinor] = parse(fileV);
  const [appMajor, appMinor] = parse(appV);
  return fileMajor > appMajor || (fileMajor === appMajor && fileMinor > appMinor);
}

/** The refuse copy every guard shows (single source — verify-fwdguard greps it). */
export function newerSchemaMessage(what: string, fileV: unknown, appV: string): string {
  return (
    `${what} uses format ${String(fileV)}, written by a newer Flux (this app reads ${appV}). ` +
    `Update Flux to open it — opening here could rewrite its files lossily.`
  );
}

export interface ProjectAuthor {
  name: string;
  orcid: string | null;
  email: string | null;
}

export interface ManuscriptRef {
  path: string;
  config: string;
  format: string;
}

export interface ReferencesRef {
  library: string;
  csljson?: string;
  defaultStyle?: string | null;
  zoteroSync?: string | null;
  // Diagnostic pointer to the machine-global FluxLib this project's subset was
  // materialized from. Advisory only — the project's library.bib stays canonical
  // within the project (self-contained); never a runtime dependency.
  fluxLib?: string | null;
}

export interface FigureEntry {
  id: string;
  name: string; // derived: `${family displayName} ${number}` (figfamily.ts)
  label: string;
  order: number;
  kind: "main" | "supplementary"; // derived from family; kept for older tooling
  // Structured identity — optional: manifests written before figure families
  // lack them (reindex rolls them up from fig/index.json).
  family?: string;
  number?: number;
  nickname?: string;
  canvas: string;
  caption: string;
}

// A deck registered in project.json.slides[]. Extended leniently beyond the
// original {id,path} with optional title/order (Flux Slide — the file is the
// API; unknown future fields round-trip untouched).
export interface SlideEntry {
  id: string;
  path: string;
  title?: string;
  order?: number;
}

export interface ProjectManifest {
  schemaVersion: string;
  id: string;
  slug: string;
  title: string;
  created: string;
  modified: string;
  authors: ProjectAuthor[];
  manuscript: ManuscriptRef;
  supplementary: { path: string }[];
  references: ReferencesRef;
  figures: FigureEntry[];
  // Custom figure families (rollup of fig/index.json `families`; built-ins
  // never persisted). Optional: pre-family manifests lack it.
  figureFamilies?: FigureFamilyDef[];
  slides: SlideEntry[];
  capabilities: Record<string, string>;
}

/** A loaded project: its root directory + parsed manifest. */
export interface LoadedProject {
  root: string;
  manifest: ProjectManifest;
}

// --- the preload sub-bridges (window.fig.{win,term,bridge}) ------------------
// SHL-16: these were duplicated as component-local interfaces + reached via
// `(window as unknown as {fig?:{…}}).fig` casts. They live here now so FileBridge
// is the ONE typed contract for everything the Electron preload exposes.

/** Custom-titlebar window controls (Electron only). */
export interface WinBridge {
  minimize: () => void;
  maximizeToggle: () => Promise<boolean> | void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (cb: (v: boolean) => void) => () => void;
  setDocumentEdited?: (edited: boolean) => void;
}

/** Integrated-terminal (PTY) bridge (Electron only). */
export interface TermBridge {
  create(opts?: {
    cols?: number;
    rows?: number;
    cwd?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }): Promise<{ ok: true; id: string; shell: string; cwd: string; pid: number } | { ok: false; error: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): Promise<boolean>;
  onData(cb: (m: { id: string; data: string }) => void): () => void;
  onExit(cb: (m: { id: string; exitCode: number; signal?: number }) => void): () => void;
}

/** Live agent bridge (WS4) — renderer half of the loopback control server (Electron
 *  only). `command` is untyped JSON off the wire; the consumer narrows it. */
export interface LiveBridge {
  pushContext: (ctx: unknown) => void;
  onDispatch: (cb: (msg: { id: number; command: unknown }) => void) => () => void;
  reply: (id: number, result?: unknown, error?: string) => void;
}

// --- the file bridge (window.fig, from the Electron preload) -----------------
export interface FileBridge {
  mkdir(p: string): Promise<void>;
  writeText(p: string, text: string): Promise<void>;
  readText(p: string): Promise<string>;
  readFile(p: string): Promise<ArrayBuffer>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  exists(p: string): Promise<boolean>;
  // File identity (mtime+size) for cache keying (the enrich parse cache); null when
  // absent. Optional: older bridges / the web demo may not provide it.
  stat?(p: string): Promise<{ mtimeMs: number; size: number } | null>;
  // List a directory's entries (files + subdirs). Optional: older bridges / the
  // web demo may not provide it. Used by the Plot Importer to browse plots/.
  readdir?(p: string): Promise<{ name: string; dir: boolean }[]>;
  // Delete a file (e.g. clear a paper's fetch-failure record on a later success). Optional:
  // older bridges may lack it; callers use `fb.remove?.(p)`.
  remove?(p: string): Promise<void>;
  // WS-5.3: fsync a DIRECTORY after a rename-into-place batch (crash-durability
  // of the rename itself). Optional; no-op on win32 / older bridges.
  fsyncDir?(p: string): Promise<void>;
  paths(): Promise<{ home: string; userData: string; documents: string }>;
  openDirectory(title?: string): Promise<string | null>;
  openFiles(filters?: unknown[]): Promise<string[] | null>;
  save(defaultPath: string, filters?: unknown[]): Promise<string | null>;
  // Figure PDF export (vector). Optional: web demo may not provide it.
  exportPdf?(svg: string, outPath: string, w: number, h: number): Promise<boolean>;
  // Added for the Paper module (Flux_Paper_Plan.md). Optional: older bridges /
  // the web demo may not provide them.
  printPdf?(
    html: string,
    outPath: string,
    opts?: { margins?: Record<string, number> },
  ): Promise<boolean>;
  fetchDoi?(doi: string): Promise<{ message?: unknown; error?: string }>;
  // DOI → raw BibTeX via doi.org content negotiation (registrar-agnostic; rescues
  // DataCite DOIs that Crossref 404s). { bibtex } or { error: "HTTP 404" | … }.
  fetchDoiBibtex?(doi: string): Promise<{ bibtex?: string; error?: string }>;
  // Resolve a paper URL (or DOI) to a DOI by fetching + scraping the page in main.
  resolveUrl?(url: string): Promise<{ doi?: string; error?: string }>;
  // Fetch an OpenAlex API URL (built by src/lib/references/openalex.ts) in main to
  // avoid CORS — returns parsed JSON, or { error }. Powers hydration + world lookups.
  fetchOpenAlex?(url: string): Promise<unknown>;
  // Fetch a Semantic Scholar API URL in main (x-api-key attached when configured).
  fetchS2?(url: string): Promise<unknown>;
  // PDF-acquisition fetch (FluxFinder): host-unrestricted http(s) GET in main, used by
  // the renderer's resolver waterfall (src/lib/references/pdfFinderBridge.ts).
  netGet?(
    url: string,
    mode: "json" | "text" | "bytes",
  ): Promise<{
    json?: unknown;
    text?: string;
    bytesB64?: string;
    contentType?: string;
    finalUrl?: string;
    error?: string;
    status?: number;
  }>;
  // Library proxy (EZProxy) — user-initiated paywalled PDF access (Electron only).
  proxyLogin?(): Promise<{ ok?: boolean; error?: string }>;
  proxyStatus?(): Promise<{ configured: boolean; signedIn: boolean }>;
  // `token` is an opaque per-call id so a background bulk run can cancel this exact fetch
  // (or all in-flight via proxyCancel("*")). `reason`/`diag` classify a failure for the
  // Part C failure log (e.g. reason "no-affordances" | "session-expired" | "cancelled").
  fetchViaProxy?(
    target: string,
    token?: string,
  ): Promise<{
    bytesB64?: string;
    contentType?: string;
    finalUrl?: string;
    via?: string;
    error?: string;
    reason?: string;
    diag?: { landedUrl?: string; host?: string; affordancesFound?: string[]; detail?: string };
  }>;
  proxyCancel?(token: string): Promise<{ ok?: boolean }>;
  // Proxy credentials, stored ENCRYPTED via the OS keychain (Electron safeStorage).
  proxySetCredentials?(username: string, password: string): Promise<{ ok?: boolean; error?: string }>;
  proxyHasCredentials?(): Promise<{ username: string; hasPassword: boolean; available: boolean }>;
  proxyClearCredentials?(): Promise<{ ok?: boolean }>;
  // Machine-global API-key store (<FluxLib>/keys.json), shared across all projects.
  keysGet?(): Promise<Record<string, unknown>>;
  keysSet?(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  openExternal?(url: string): Promise<void>;
  quartoAvailable?(): Promise<{ installed: boolean; version?: string }>;
  quartoRender?(
    root: string,
    to: string,
    docPath?: string,
  ): Promise<{ ok: boolean; code?: number; log: string; outPath?: string }>;
  // Reveal an exported file in the OS file manager (fsGuard'd in main).
  revealPath?(p: string): Promise<boolean>;
  /** Open a FluxConfig/project file in the OS default editor. */
  openPath?(p: string): Promise<boolean>;
  /** Launch the Lighttable sidecar app (its own process — nothing is shared). */
  launchLighttable?(): Promise<{ ok: boolean; error?: string }>;
  /** Open the rendered user docs (docs/_site) in the OS browser. */
  openDocs?(): Promise<{ ok: boolean; error?: string }>;
  /** Append one NDJSON line to the feedback ledger (O_APPEND — never rewrites). */
  feedbackAppend?(p: string, line: string): Promise<boolean>;
  // 2.3 Full-text search across every stored PDF's extracted text. Runs the streaming
  // scan in the bundled CLI (main process) so the renderer never blocks; returns the
  // FulltextResult, or { error }. Electron only. `opts.keys` restricts the scan scope.
  searchFulltext?(
    query: string,
    opts?: { limit?: number; keys?: string[] },
  ): Promise<{
    hits?: { key: string; count: number; snippets: { page: number; text: string }[] }[];
    scanned?: number;
    missingText?: string[];
    truncated?: boolean;
    elapsedMs?: number;
    error?: string;
  }>;
  // F1 file-watch live reload. Optional: only the Electron bridge (and the dev
  // fixture) provide them.
  watchRoot?(root: string | null): Promise<boolean> | boolean;
  onFsChanged?(cb: (info: { subsystem: string; path: string }) => void): () => void;
  // Web capture (flux://): main delivers a { doi?, url? } payload to add to FluxLib.
  // Electron only; returns an unsubscribe fn. Mirrors onFsChanged's shape.
  onCapture?(cb: (payload: { doi?: string; url?: string }) => void): () => void;
  // App-level notices from the main process (watcher death, spawn failures) —
  // surfaced as shell toasts (src/lib/toast.ts). Electron only.
  onAppError?(cb: (payload: { level?: string; msg: string; detail?: string }) => void): () => void;
  // W6: quit/close flush handshake. Main sends `app:flush` with a token before
  // destroying the window; the renderer flushes every dirty mode and acks with
  // flushDone(token). Main destroys on ack or after a 2.5s timeout. Electron only.
  onFlushRequest?(cb: (token: number) => void): () => void;
  flushDone?(token: number): void;
  // W3: advisory locks. lockSet holds/releases a heartbeat-restamped "human"
  // activity lock; lockAcquire/lockRelease bracket short renderer RMWs
  // (scope "project" = <root>/.meta/locks, "fluxlib" = <lib>/.fluxlib/locks).
  lockSet?(name: string, held: boolean, scope?: "project" | "fluxlib"): Promise<boolean>;
  lockAcquire?(scope: "project" | "fluxlib", name: string): Promise<{ ok: boolean; heldBy?: string; noop?: boolean }>;
  lockRelease?(scope: "project" | "fluxlib", name: string): Promise<boolean>;
  // Global preferences (the first file-based config the GUI + CLI/agents share:
  // <userData>/preferences.json — holds the FluxConfig pointer; the FluxLib and
  // FluxConfig paths come back RESOLVED as fluxLibResolved/fluxConfigResolved).
  // Optional: Electron only.
  prefsGet?(): Promise<Record<string, unknown>>;
  prefsSet?(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  // Move the whole FluxConfig folder to a new parent dir (always named exactly
  // "FluxConfig"; main-process rename/copy+verify). Optional: Electron only.
  configMove?(parentDir: string): Promise<{ ok: true; path: string } | { error: string }>;
  // Machine-global named TEXT-STYLE library (<userData>/textstyles.json; the
  // dev fixture uses localStorage). Reusable definitions shared across every
  // project; applying one copies it into the project (copy-on-apply). The
  // element type is src/lib/types.ts TextStyle — kept as unknown[] here so this
  // leaf module doesn't import the figure model.
  readGlobalTextStyles?(): Promise<unknown[]>;
  writeGlobalTextStyles?(styles: unknown[]): Promise<void>;
  // Machine-global DESIGN-PRESET library (<FluxConfig>/presets/designs/**.json;
  // the dev fixture uses localStorage). One preset per file, subfolders via
  // rel paths. Payloads stay unknown here (same leaf-module rule as above).
  readDesignPresets?(): Promise<unknown[]>;
  writeDesignPreset?(rel: string, preset: unknown): Promise<boolean>;
  deleteDesignPreset?(rel: string): Promise<boolean>;
  // Machine-global ANIMATION preset/template library (animation rework §7:
  // <FluxConfig>/presets/animations|anim-templates/**.json; the dev fixture
  // uses localStorage). kind = "preset" | "template"; payloads stay unknown
  // here (leaf-module rule).
  readAnimLibrary?(kind: string): Promise<unknown[]>;
  writeAnimLibrary?(kind: string, rel: string, payload: unknown): Promise<boolean>;
  deleteAnimLibrary?(kind: string, rel: string): Promise<boolean>;
  // Machine-global SLIDE-PRESET library (<FluxConfig>/presets/slides/**.json;
  // the dev fixture uses localStorage). Whole-slide snapshots with embedded
  // asset bytes; payloads stay unknown here (leaf-module rule).
  readSlideLibrary?(): Promise<unknown[]>;
  writeSlideLibrary?(rel: string, payload: unknown): Promise<boolean>;
  deleteSlideLibrary?(rel: string): Promise<boolean>;
  // WS-9.3: pre-register a project root about to be loaded (single pending
  // fsGuard slot; watchRoot promotes/clears it). Electron only.
  beginOpen?(root: string): Promise<boolean>;
  // 5.3 update check (packaged app only): resolves to a newer release's
  // { version, url } or null. Main owns the ≤1/day throttle + GitHub fetch.
  checkForUpdate?(): Promise<{ version: string; url: string } | null>;
  // F2: re-run a plot's recipe (regenerate). Electron only.
  runRecipe?(
    recipePath: string,
    params: Record<string, unknown>,
  ): Promise<{
    code: number;
    svgText: string | null;
    manifestText: string | null;
    recipeText: string;
    stdout?: string;
    stderr?: string;
  }>;
  // SHL-16: the preload's non-fs sub-bridges + host info, folded in so this interface is
  // the single contract. All optional (absent under the web/dev fallback).
  platform?: string; // process.platform ("darwin" | "linux" | "win32")
  win?: WinBridge;
  term?: TermBridge;
  bridge?: LiveBridge;
  /** Principal-agent scheme: the resolved launch spec for the user's configured
   *  principal (agents.json roster + boot prompt + MCP wiring + cwd rule).
   *  {probe:true} returns the picker info instead; a provided selection is
   *  persisted as last-used. */
  agentPrincipalSpec?(opts?: {
    probe?: boolean;
    selection?: {
      principal: { family: string; model: string; effort: string };
      worker: { family: string; model: string; effort: string };
    };
  }): Promise<{
    ok: boolean;
    error?: string;
    probe?: boolean;
    legacy?: boolean;
    families?: Record<string, { models: string[]; efforts: string[] }>;
    selection?: {
      principal: { family: string; model: string; effort: string };
      worker: { family: string; model: string; effort: string };
    };
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    /** The boot prompt, standalone (for copy-to-clipboard → the user's own terminal). */
    prompt?: string;
    warning?: string | null;
    agentsPath?: string;
  }>;
}

declare global {
  // The one typed handle on the preload surface (replaces the old partial electron.d.ts).
  // Non-optional to match how io.ts accesses it directly; guarded callers use fileBridge().
  interface Window {
    fig: FileBridge;
  }
}

export function fileBridge(): FileBridge | undefined {
  return (window as unknown as { fig?: FileBridge }).fig;
}

// --- path helpers (POSIX "/" — Node accepts forward slashes on Windows) ------
export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Absolute-path test for renderer code (no node:path here): POSIX `/…` plus
 *  the Windows forms — drive-letter `C:\…`/`C:/…` and UNC `\\server\…`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project"
  );
}
