// Types mirroring the on-disk project format (SciForge_Project_Format.md).
// App-name-agnostic: the manifest is project.json, state lives in .meta/.

export const PROJECT_SCHEMA_VERSION = "0.1.0";

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
}

export interface FigureEntry {
  id: string;
  name: string;
  label: string;
  order: number;
  kind: "main" | "supplementary";
  canvas: string;
  caption: string;
}

export interface SlideEntry {
  id: string;
  path: string;
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
  slides: SlideEntry[];
  capabilities: Record<string, string>;
}

/** A loaded project: its root directory + parsed manifest. */
export interface LoadedProject {
  root: string;
  manifest: ProjectManifest;
}

// --- the file bridge (window.fig, from the Electron preload) -----------------
export interface FileBridge {
  mkdir(p: string): Promise<void>;
  writeText(p: string, text: string): Promise<void>;
  readText(p: string): Promise<string>;
  readFile(p: string): Promise<ArrayBuffer>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  exists(p: string): Promise<boolean>;
  // List a directory's entries (files + subdirs). Optional: older bridges / the
  // web demo may not provide it. Used by the Plot Importer to browse plots/.
  readdir?(p: string): Promise<{ name: string; dir: boolean }[]>;
  paths(): Promise<{ home: string; userData: string; documents: string }>;
  openDirectory(title?: string): Promise<string | null>;
  save(defaultPath: string, filters?: unknown[]): Promise<string | null>;
  // Added for the Paper module (Flux_Paper_Plan.md). Optional: older bridges /
  // the web demo may not provide them.
  printPdf?(
    html: string,
    outPath: string,
    opts?: { margins?: Record<string, number> },
  ): Promise<boolean>;
  fetchDoi?(doi: string): Promise<{ message?: unknown; error?: string }>;
  openExternal?(url: string): Promise<void>;
  quartoAvailable?(): Promise<{ installed: boolean; version?: string }>;
  quartoRender?(
    root: string,
    to: string,
  ): Promise<{ ok: boolean; code?: number; log: string }>;
  // F1 file-watch live reload. Optional: only the Electron bridge (and the dev
  // fixture) provide them.
  watchRoot?(root: string | null): Promise<boolean> | boolean;
  onFsChanged?(cb: (info: { subsystem: string; path: string }) => void): () => void;
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
