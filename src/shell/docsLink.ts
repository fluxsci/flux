// Where the Docs button goes. The user guide is published at fluxsci.org/docs (flat pages, one
// per topic); the button opens the page for where you are: the mode you are in, or the
// surface that offers the link (Settings on its tab, the keyboard reference on its section).
// Pure: verify-docs-link.ts pins the table, because the site lives in another repository and
// nothing here can notice a page being renamed.
//
// A copy of the guide also ships inside the app. `openDocs` uses it when there is no network.
import { fileBridge } from "../lib/project/types";
import { pushToast } from "../lib/toast";

export const DOCS_BASE = "https://fluxsci.org/docs/";

/** One page per mode. Slide's page is `slides`. */
const MODE_PAGE: Record<string, { page: string; label: string }> = {
  figure: { page: "figure.html", label: "Figure" },
  slide: { page: "slides.html", label: "Slide" },
  paper: { page: "paper.html", label: "Paper" },
  library: { page: "library.html", label: "Library" },
  reader: { page: "reader.html", label: "Reader" },
};
const SETTINGS_TABS = new Set(["general", "figure", "paper", "corrections"]);
/** The keyboard reference's sections → the headings of the guide's shortcuts page. */
const SHORTCUT_ANCHOR: Record<string, string> = {
  global: "everywhere-in-a-project",
  figure: "figure",
  slide: "slide",
  paper: "paper",
  library: "library",
  reader: "reader",
};

export interface DocsContext {
  /** "home" before a project is open. */
  view?: string;
  /** The focused mode. */
  mode?: string | null;
  /** A surface that links to its own page; wins over the mode. */
  surface?: "settings" | "shortcuts";
  /** The surface's tab or section. */
  tab?: string;
}
export interface DocsTarget {
  url: string;
  /** What the page is about, for the button's tooltip: "Figure", "Settings". Empty for the guide's start. */
  label: string;
}

export function docsTarget(context: DocsContext = {}): DocsTarget {
  if (context.surface === "settings") {
    const anchor = context.tab && SETTINGS_TABS.has(context.tab) ? `#${context.tab}` : "";
    return { url: `${DOCS_BASE}settings.html${anchor}`, label: "Settings" };
  }
  if (context.surface === "shortcuts") {
    const anchor = context.tab && SHORTCUT_ANCHOR[context.tab] ? `#${SHORTCUT_ANCHOR[context.tab]}` : "";
    return { url: `${DOCS_BASE}shortcuts.html${anchor}`, label: "Keyboard shortcuts" };
  }
  const mode = context.view === "home" ? undefined : MODE_PAGE[context.mode ?? ""];
  return mode ? { url: `${DOCS_BASE}${mode.page}`, label: mode.label } : { url: DOCS_BASE, label: "" };
}

/**
 * Open the guide at the page for `context`. Online: the published page, in the browser.
 * Offline (or where nothing can open a link): the copy that ships with the app, at its start.
 */
export async function openDocs(context: DocsContext = {}): Promise<void> {
  const bridge = fileBridge();
  const target = docsTarget(context);
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  if (online && bridge?.openExternal) {
    await bridge.openExternal(target.url);
    return;
  }
  if (bridge?.openDocs) {
    const result = await bridge.openDocs();
    if (result && !result.ok) pushToast("error", "Could not open the docs", { detail: result.error });
    else if (!online) pushToast("info", "Opened the guide that ships with Flux", { detail: "You are offline, so this is the copy inside the app." });
    return;
  }
  if (typeof window !== "undefined") window.open(target.url, "_blank", "noopener");
}
