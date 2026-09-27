// Plot gallery scopes: WHERE the gallery browses and WHAT a search reaches.
//
// Two browse scopes: the open project's plots/ folder, and the user's global plot
// library (<FluxConfig>/plot_library — any folder structure, shared by every
// project). The Project | Global switch picks which one the folders show.
//
// Search reach is a Settings → Figure preference (`plotSearchScope`), resolved here
// into the list of scan SOURCES the gallery must have cached, plus an optional
// folder filter. Pure: no Svelte, no IO — the gallery owns the walks and caches,
// this module owns the rules (gated by verify-gallery-scope.ts).
//
// The reserved-folder rule wins over the preference: once you have deliberately
// entered plots/_lighttable (or _dissections, …) a search stays inside that
// collection, whatever the setting says — a query can never mix sweep images
// with ordinary plots.

export type GalleryScope = "project" | "global";
export type PlotSearchScope = "current" | "project" | "global" | "folder" | "all";

export const GALLERY_SCOPES: readonly { id: GalleryScope; label: string; title: string }[] = [
  { id: "project", label: "Project", title: "This project's plots/ folder" },
  { id: "global", label: "Global", title: "Your global plot library (FluxConfig/plot_library), shared by every project" },
];

/** Settings options, in menu order. `current` is the default. */
export const PLOT_SEARCH_SCOPES: readonly { id: PlotSearchScope; label: string }[] = [
  { id: "current", label: "Everything in the selected scope (Project or Global)" },
  { id: "folder", label: "Only the current folder and its subfolders" },
  { id: "project", label: "Only project plots" },
  { id: "global", label: "Only global plots" },
  { id: "all", label: "Everything — project and global plots" },
];
export const PLOT_SEARCH_SCOPE_IDS = PLOT_SEARCH_SCOPES.map((s) => s.id);
export const DEFAULT_PLOT_SEARCH_SCOPE: PlotSearchScope = "current";

/** One cached walk: a scope's whole ordinary tree (`reserved: ""`, reserved
 *  folders pruned at every depth) or one reserved collection inside it. */
export interface SearchSource {
  scope: GalleryScope;
  reserved: string;
}
export interface SearchPlan {
  sources: SearchSource[];
  /** Absolute folder a result must sit under ("" = no folder filter). */
  folder: string;
  /** Results come from somewhere other than the browsed scope, so rows name
   *  their scope ("Global · figs") rather than leaving the reader to guess. */
  mixed: boolean;
  /** The search box placeholder: says what a query would actually reach. */
  placeholder: string;
}

export function sourceKey(s: SearchSource): string {
  return `${s.scope}:${s.reserved}`;
}

export function isPlotSearchScope(v: unknown): v is PlotSearchScope {
  return typeof v === "string" && (PLOT_SEARCH_SCOPE_IDS as string[]).includes(v);
}

/**
 * Resolve the preference into what a search reads.
 *   browse   — the scope the gallery is showing
 *   reserved — the reserved collection the current folder sits under ("" = none)
 *   cwd      — absolute current folder; `browseRoot` — absolute root of `browse`
 */
export function gallerySearchPlan(input: {
  mode: PlotSearchScope;
  browse: GalleryScope;
  reserved: string;
  cwd: string;
  browseRoot: string;
}): SearchPlan {
  const { browse, reserved, cwd, browseRoot } = input;
  const mode = isPlotSearchScope(input.mode) ? input.mode : DEFAULT_PLOT_SEARCH_SCOPE;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const here = norm(cwd), root = norm(browseRoot);
  const nested = !!here && here !== root && here.startsWith(root + "/");
  const relDir = nested ? here.slice(root.length + 1) : "";
  const inFolder = mode === "folder" && nested;
  if (reserved) {
    // Deep inside a collection, the folder preference narrows further still.
    const deeper = inFolder && relDir !== reserved;
    return {
      sources: [{ scope: browse, reserved }],
      folder: deeper ? here : "",
      mixed: false,
      placeholder: `Search inside ${deeper ? relDir : reserved}/…`,
    };
  }
  const own = browse === "global" ? "the global plot library" : "project plots";
  switch (mode) {
    case "folder":
      return {
        sources: [{ scope: browse, reserved: "" }],
        folder: inFolder ? here : "",
        mixed: false,
        placeholder: inFolder ? `Search inside ${relDir}/…` : `Search ${own} by name…  (or browse below)`,
      };
    case "project":
    case "global":
      return {
        sources: [{ scope: mode, reserved: "" }],
        folder: "",
        mixed: mode !== browse,
        placeholder: mode === browse
          ? `Search ${own} by name…  (or browse below)`
          : `Search ${mode === "global" ? "global" : "project"} plots only…`,
      };
    case "all":
      return {
        sources: [{ scope: "project", reserved: "" }, { scope: "global", reserved: "" }],
        folder: "",
        mixed: true,
        placeholder: "Search all plots — project and global…",
      };
    default:
      return {
        sources: [{ scope: browse, reserved: "" }],
        folder: "",
        mixed: false,
        placeholder: `Search ${own} by name…  (or browse below)`,
      };
  }
}

/** Does a result at `abs` pass the plan's folder filter? */
export function inPlanFolder(plan: SearchPlan, abs: string): boolean {
  if (!plan.folder) return true;
  const a = abs.replace(/\\/g, "/"), f = plan.folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return a.startsWith(f + "/");
}
