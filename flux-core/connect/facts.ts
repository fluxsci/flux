// The facts a flux-connect pack is built from. collect.ts gathers them from
// disk (and the live app); the pure renderers (budget, bundle, brief) turn them
// into the pack. Keeping the two apart means every rendering rule is testable
// on hand-made facts, with no filesystem.

export type ConnectDepth = "core" | "full" | "ask" | "task";
export type ConnectMode = "project" | "global";

export interface StockDoc {
  name: string;
  path: string;
  tokens: number;
}

export interface MachineFacts {
  fluxVersion: string;
  commit: string;
  installKind: "source" | "packaged";
  installPath: string;
  /** The launcher every skill and MCP registration points at. */
  launcher: string;
  mcpRegistered: { claude: boolean; codex: boolean };
  fluxConfig: string;
  fluxContextDir: string;
  stockDocs: StockDoc[];
  /** pdfs is null when FluxLib has no items index yet (connect never builds one). */
  fluxLib: { path: string; entries: number; pdfs: number | null };
  plotLibrary: { path: string; count: number } | null;
  fluxplot: { path: string; version: string | null } | null;
  quarto: string | null;
  uv: string | null;
  /** False when this install cannot render PNGs (the brief then says so). */
  canRender: boolean;
}

export interface UserFile {
  rel: string;
  text: string;
  sha: string;
}

export interface UserFacts {
  dir: string;
  files: UserFile[];
  images: { rel: string; abs: string }[];
  skills: { name: string; description: string; path: string }[];
}

export interface OutlineEntry {
  level: number;
  text: string;
  line: number;
}

export interface DocFact {
  path: string;
  title: string;
  words: number;
  lines: number;
  hasComments: boolean;
  outline: OutlineEntry[];
  sha: string;
  /** Loaded only when the plan may include it. */
  text?: string;
}

export interface FigureFact {
  id: string;
  displayName: string;
  canvasId: string;
  captionLead: string;
  caption: string;
  panels: { label?: string; source?: string; recipe?: string }[];
  stale: boolean;
  /** No elements at all (still numbered: it shifts every later figure's number). */
  empty?: boolean;
}

export interface DeckFact {
  id: string;
  title: string;
  /** Project-relative deck file (slides/<id>/deck.json). */
  path?: string;
  slides: { id: string; name: string; beats: number; notes?: string }[];
}

export interface LinkedFile {
  /** The link as written in ProjectContext. */
  link: string;
  /** Absolute path it resolved to. */
  abs: string;
  /** Display path: project-relative when inside the project, else absolute. */
  display: string;
  kind: "text" | "image" | "other" | "missing";
  text?: string;
  sha?: string;
  outline?: OutlineEntry[];
  /** Depth at which it was reached (1 = linked directly from ProjectContext). */
  depth: number;
}

export interface LogEntryFact {
  stamp: string;
  title: string;
  byline: string | null;
  body: string;
  isCheckpoint: boolean;
}

export interface ReviewItemFact {
  id: string;
  kind: "annotation" | "comment";
  where: string;
  text: string;
  status: string;
  chip: string;
  route: string;
  tags: string[];
  surface: string;
  doc?: string;
}

export interface JournalGroup {
  client: string;
  action: string;
  target: string;
  count: number;
  first: string;
  last: string;
}

export interface ProjectFacts {
  root: string;
  title: string;
  authors: string[];
  defaultDoc: string | null;
  docs: DocFact[];
  figures: FigureFact[];
  canvases: { id: string; name: string; figureIds: string[] }[];
  decks: DeckFact[];
  plots: { count: number; dissections: number; lighttable: string[] };
  referencesCount: number;
  workspace: { dir: string; markers: string[]; entries: string[] } | null;
  git: { branch: string; dirty: number } | null;
  /** `missing`: Context/ProjectContext.qmd does not exist (the brief says how to create it). */
  projectContext: { path: string; text: string; sha: string; isTemplate: boolean; missing: boolean; links: LinkedFile[] };
  rules: { path: string; text: string; sha: string };
  notebook: { path: string; sha: string; entries: LogEntryFact[]; legacySections: string | null };
  review: { items: ReviewItemFact[] };
  activity: { journal: JournalGroup[]; changedSinceLastPack: string[]; lastPackAt: string | null };
  /** Parts of the project that could not be read (connect reports them and carries on). */
  problems: string[];
}

export interface LiveFacts {
  appOpen: boolean;
  surface?: string;
  selection?: string;
}

export interface IdentityFacts {
  product: string | null;
  surface: string | null;
  /** The presence handle (MCP-connected sessions only). */
  sessionName: string | null;
}

export interface KnownProject {
  root: string;
  title: string;
  lastOpened: string | null;
}

export interface ConnectFacts {
  mode: ConnectMode;
  packId: string;
  createdAt: string;
  machine: MachineFacts;
  user: UserFacts;
  project: ProjectFacts | null;
  live: LiveFacts | null;
  identity: IdentityFacts;
  knownProjects: KnownProject[];
}

/** The rough token count the budget and the brief speak in. */
export function tokensOf(text: string): number {
  return Math.ceil(text.length / 3.6);
}
