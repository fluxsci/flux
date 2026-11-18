// The Docs button opens the published guide (fluxsci.org/docs) at the page for where you are.
// The site is built from another repository, so nothing in this one can notice a page being
// renamed: this gate pins the table instead, and a change to it is a deliberate edit made
// together with the site. Run via run-verifies.
import { harness } from "./lib/harness.mjs";
import { DOCS_BASE, docsTarget } from "../src/shell/docsLink";
import { MODE_ORDER, MODE_LABEL } from "../src/shell/modeOrder";

const h = harness("verify-docs-link");

h.section("pages");
h.eq(DOCS_BASE, "https://fluxsci.org/docs/", "the guide's address");
h.eq(docsTarget({ view: "home", mode: "paper" }), { url: DOCS_BASE, label: "Flux" }, "Home opens the guide's start, whatever mode was last focused");
h.eq(docsTarget(), { url: DOCS_BASE, label: "Flux" }, "no context opens the guide's start");
h.eq(docsTarget({ view: "workspace", mode: "nowhere" }).url, DOCS_BASE, "an unknown mode opens the guide's start, never a made-up page");
const pages = Object.fromEntries(MODE_ORDER.map((mode) => [mode, docsTarget({ view: "workspace", mode }).url.slice(DOCS_BASE.length)]));
h.eq(pages, { figure: "figure.html", slide: "slides.html", paper: "paper.html", library: "library.html", reader: "reader.html" }, "each mode opens its own page (Slide's is slides.html)");
h.ok(MODE_ORDER.every((mode) => docsTarget({ view: "workspace", mode }).label === MODE_LABEL[mode]), "and the button names the mode");

h.section("surfaces");
h.eq(["general", "figure", "paper", "corrections"].map((tab) => docsTarget({ surface: "settings", tab }).url.slice(DOCS_BASE.length)),
  ["settings.html#general", "settings.html#figure", "settings.html#paper", "settings.html#corrections"], "Settings links to its page at the open tab");
h.eq(docsTarget({ surface: "settings", tab: "x" }).url, `${DOCS_BASE}settings.html`, "an unknown tab links to the page's top");
h.eq(docsTarget({ surface: "settings", mode: "figure", view: "workspace" }).label, "Settings", "a surface wins over the mode under it");
h.eq(["global", "figure", "slide", "paper", "library", "reader"].map((tab) => docsTarget({ surface: "shortcuts", tab }).url.slice(DOCS_BASE.length)),
  ["shortcuts.html#everywhere-in-a-project", "shortcuts.html#figure", "shortcuts.html#slide", "shortcuts.html#paper", "shortcuts.html#library", "shortcuts.html#reader"],
  "the keyboard reference links to the shortcuts page at the open section");

h.section("shape");
const all = [docsTarget(), ...MODE_ORDER.map((mode) => docsTarget({ view: "workspace", mode })), docsTarget({ surface: "settings", tab: "paper" }), docsTarget({ surface: "shortcuts", tab: "global" })];
h.ok(all.every((t) => t.url.startsWith(DOCS_BASE) && /^https:\/\/fluxsci\.org\/docs\/(?:[a-z0-9-]+\.html(?:#[a-z0-9-]+)?)?$/.test(t.url)), "every link is an https page of the guide: flat, lower-case, one optional anchor");

await h.done();
