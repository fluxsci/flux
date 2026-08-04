// FigFamily — pure checks for the structured figure-identity core
// (src/lib/figfamily.ts) plus the panel-spec text helpers (scholar/figText.ts).
// A figure's display identity is (family, number): templates render it,
// computeFamilyNumbers keeps numbers contiguous per family, and
// assignFamilyNumber is the one insert-and-shift primitive.
//   Run: npx tsx scripts/verify-figfamily.ts
import {
  BUILTIN_FAMILIES,
  DEFAULT_FAMILY,
  applyFamilyNumbers,
  assignFamilyNumber,
  computeFamilyNumbers,
  derivedFigureName,
  familyById,
  familyMap,
  familyRank,
  formatCaptionLabel,
  formatFamilyRef,
  kindForFamily,
  parseLegacyName,
  shortBadge,
  type FigureFamilyDef,
} from "../src/lib/figfamily";
import { panelSpec, figRefText } from "../src/shell/modes/paper/scholar/figText";

let fail = 0;
function eq<T>(what: string, got: T, want: T) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    fail++;
  } else {
    console.log(`ok   ${what}`);
  }
}

const MOVIE: FigureFamilyDef = {
  id: "movie",
  displayName: "Movie",
  refTemplate: "Mov. {num}{panel}",
  captionTemplate: "Movie {num} | ",
};

// --- templates ---------------------------------------------------------------
const [FIG, SUP, ED] = BUILTIN_FAMILIES;
eq("ref figure", formatFamilyRef(FIG, 2), "Fig. 2");
eq("ref figure panel", formatFamilyRef(FIG, 2, "a"), "Fig. 2a");
eq("ref sup", formatFamilyRef(SUP, 4), "Fig. S4");
eq("ref sup range", formatFamilyRef(SUP, 4, "a–c,e"), "Fig. S4a–c,e");
eq("ref ed", formatFamilyRef(ED, 3, "b"), "Extended Data Fig. 3b");
eq("ref custom", formatFamilyRef(MOVIE, 3, "b"), "Mov. 3b");
eq("caption figure", formatCaptionLabel(FIG, 2), "Figure 2 | ");
eq("caption sup", formatCaptionLabel(SUP, 4), "Figure S4 | ");
eq("caption ed", formatCaptionLabel(ED, 3), "Extended Data Figure 3 | ");
eq("caption custom", formatCaptionLabel(MOVIE, 3), "Movie 3 | ");
eq("name figure", derivedFigureName(FIG, 2), "Figure 2");
eq("name sup", derivedFigureName(SUP, 4), "Supplementary Figure 4");
eq("badge figure", shortBadge(FIG, 2), "2");
eq("badge sup", shortBadge(SUP, 4), "S4");
eq("badge ed", shortBadge(ED, 3), "ED3");
eq("badge custom", shortBadge(MOVIE, 3), "M3");
// defensive templates: missing {num}/{panel} never drop information
eq(
  "ref no-num template",
  formatFamilyRef({ ...MOVIE, refTemplate: "Movie" }, 5, "a"),
  "Movie 5a",
);
eq(
  "caption no-num template",
  formatCaptionLabel({ ...MOVIE, captionTemplate: "Movie:" }, 5),
  "Movie: 5",
);

// --- family registry ---------------------------------------------------------
eq("map order", [...familyMap([MOVIE]).keys()], ["figure", "supplementary", "extended-data", "movie"]);
eq("builtin not shadowed", familyMap([{ ...MOVIE, id: "figure" }]).get("figure")!.displayName, "Figure");
eq("byId builtin", familyById("supplementary").id, "supplementary");
eq("byId default", familyById(undefined).id, DEFAULT_FAMILY);
eq("byId custom", familyById("movie", [MOVIE]).displayName, "Movie");
eq("byId unknown synthesizes", familyById("video-clip"), {
  id: "video-clip",
  displayName: "Video Clip",
  refTemplate: "Video Clip {num}{panel}",
  captionTemplate: "Video Clip {num} | ",
});
eq("rank", [familyRank("figure"), familyRank("extended-data"), familyRank("movie", [MOVIE]), familyRank("nope", [MOVIE])], [0, 2, 3, 4]);
eq("kind sup", kindForFamily("supplementary"), "supplementary");
eq("kind main", kindForFamily("figure"), "main");
eq("kind custom", kindForFamily("movie"), "main");

// --- parseLegacyName ---------------------------------------------------------
eq("p Figure 2", parseLegacyName("Figure 2"), { family: "figure", number: 2 });
eq("p fig 12", parseLegacyName("fig 12"), { family: "figure", number: 12 });
eq("p Fig. 4", parseLegacyName("Fig. 4"), { family: "figure", number: 4 });
eq("p padded", parseLegacyName("  Figure 7  "), { family: "figure", number: 7 });
eq("p Figure S4", parseLegacyName("Figure S4"), { family: "supplementary", number: 4 });
eq("p Fig S2", parseLegacyName("Fig S2"), { family: "supplementary", number: 2 });
eq("p Sup. Figure 1", parseLegacyName("Sup. Figure 1"), { family: "supplementary", number: 1 });
eq("p Supp Figure 3", parseLegacyName("Supp Figure 3"), { family: "supplementary", number: 3 });
eq("p Suppl. Fig. 3", parseLegacyName("Suppl. Fig. 3"), { family: "supplementary", number: 3 });
eq("p Supplementary Figure 4", parseLegacyName("Supplementary Figure 4"), { family: "supplementary", number: 4 });
eq("p Supplemental Fig 2", parseLegacyName("Supplemental Fig 2"), { family: "supplementary", number: 2 });
eq("p Extended Data Figure 5", parseLegacyName("Extended Data Figure 5"), { family: "extended-data", number: 5 });
eq("p Extended Data Fig. 3", parseLegacyName("Extended Data Fig. 3"), { family: "extended-data", number: 3 });
// negatives — including the greedy-capture victims that motivated this system
eq("p greedy victim", parseLegacyName("Figure 2 Sup. Figure 1"), null);
eq("p renamed", parseLegacyName("Figure RENAMED"), null);
eq("p descriptive", parseLegacyName("Growth curves"), null);
eq("p bare", parseLegacyName("Figure"), null);
eq("p plural", parseLegacyName("Figures 3"), null);
eq("p prefix-word", parseLegacyName("Figurine 3"), null);
eq("p empty", parseLegacyName(""), null);

// --- computeFamilyNumbers ----------------------------------------------------
type F = { id: string; name: string; family?: string; number?: number };
const heal = (figs: F[]) =>
  [...computeFamilyNumbers(figs)].map(([id, v]) => `${id}:${v.family}/${v.number}`).sort();

eq(
  "heal legacy names",
  heal([
    { id: "a", name: "Figure 2" },
    { id: "b", name: "Sup. Figure 1" },
    { id: "c", name: "Figure 1" },
    { id: "d", name: "Growth curves" },
  ]),
  ["a:figure/2", "b:supplementary/1", "c:figure/1", "d:figure/3"],
);
eq(
  "explicit fields win over names",
  heal([{ id: "a", name: "Figure 9", family: "supplementary", number: 2 }]),
  ["a:supplementary/1"],
);
eq(
  "duplicate claims resolve by array order",
  heal([
    { id: "a", name: "", family: "figure", number: 2 },
    { id: "b", name: "", family: "figure", number: 2 },
    { id: "c", name: "", family: "figure", number: 1 },
  ]),
  ["a:figure/2", "b:figure/3", "c:figure/1"],
);
eq(
  "gaps compact",
  heal([
    { id: "a", name: "", family: "figure", number: 5 },
    { id: "b", name: "", family: "figure", number: 9 },
  ]),
  ["a:figure/1", "b:figure/2"],
);
{
  const figs: F[] = [
    { id: "a", name: "Figure 1", family: "figure", number: 1 },
    { id: "b", name: "Supplementary Figure 1", family: "supplementary", number: 1 },
    { id: "c", name: "Figure 2", family: "figure", number: 2 },
  ];
  eq("contiguous input is a fixpoint", applyFamilyNumbers(figs), []);
}
{
  const figs: F[] = [
    { id: "a", name: "Figure 2 Sup. Figure 1" },
    { id: "b", name: "Supplementary Figure 4" },
  ];
  const changed1 = applyFamilyNumbers(figs);
  const changed2 = applyFamilyNumbers(figs);
  eq("apply changes once", changed1.sort(), ["a", "b"]);
  eq("apply is idempotent", changed2, []);
  eq("apply derives names", figs.map((f) => f.name), ["Figure 1", "Supplementary Figure 1"]);
}

// --- assignFamilyNumber ------------------------------------------------------
const mk = (): F[] => [
  { id: "a", name: "Figure 1", family: "figure", number: 1 },
  { id: "b", name: "Figure 2", family: "figure", number: 2 },
  { id: "c", name: "Figure 3", family: "figure", number: 3 },
  { id: "d", name: "Figure 4", family: "figure", number: 4 },
];
const snap = (figs: F[]) =>
  figs.map((f) => `${f.id}:${f.family}/${f.number}:${f.name}`);

{
  const figs = mk();
  const changed = assignFamilyNumber(figs, "d", "figure", 2);
  eq("insert-and-shift", snap(figs), [
    "a:figure/1:Figure 1",
    "b:figure/3:Figure 3",
    "c:figure/4:Figure 4",
    "d:figure/2:Figure 2",
  ]);
  eq("insert changed set", changed.sort(), ["b", "c", "d"]);
}
{
  const figs = mk();
  assignFamilyNumber(figs, "b", "figure", 4);
  eq("move later", snap(figs), [
    "a:figure/1:Figure 1",
    "b:figure/4:Figure 4",
    "c:figure/2:Figure 2",
    "d:figure/3:Figure 3",
  ]);
}
{
  const figs = mk();
  eq("no-op move", assignFamilyNumber(figs, "b", "figure", 2), []);
  eq("no-op state", snap(figs), mk().map((f) => `${f.id}:${f.family}/${f.number}:${f.name}`));
}
{
  const figs = mk();
  assignFamilyNumber(figs, "c", "supplementary");
  eq("family switch appends + compacts", snap(figs), [
    "a:figure/1:Figure 1",
    "b:figure/2:Figure 2",
    "c:supplementary/1:Supplementary Figure 1",
    "d:figure/3:Figure 3",
  ]);
}
{
  const figs = mk();
  assignFamilyNumber(figs, "c", "movie", 99, [MOVIE]);
  eq("custom family + clamp", snap(figs), [
    "a:figure/1:Figure 1",
    "b:figure/2:Figure 2",
    "c:movie/1:Movie 1",
    "d:figure/3:Figure 3",
  ]);
}
{
  const figs = mk();
  assignFamilyNumber(figs, "a", "figure", 0);
  eq("clamp low", figs.find((f) => f.id === "a")!.number, 1);
  eq("unknown fig is a no-op", assignFamilyNumber(figs, "zz", "figure", 1), []);
}

// --- panelSpec / figRefText (carried over from verify-figname) ---------------
const P = { label: "fig-x", panels: ["a", "b", "c", "d", "e"] };
eq("none = whole", figRefText(P, []), "@fig-x");
eq("single", figRefText(P, ["b"]), "@fig-x-b");
eq("pair stays comma", figRefText(P, ["a", "b"]), "@fig-x-a,b");
eq("run of 3 collapses", figRefText(P, ["a", "b", "c"]), "@fig-x-a-c");
eq("run + extra", figRefText(P, ["a", "b", "c", "e"]), "@fig-x-a-c,e");
eq("order-independent", figRefText(P, ["e", "c", "a", "b"]), "@fig-x-a-c,e");
eq("all five", figRefText(P, ["a", "b", "c", "d", "e"]), "@fig-x-a-e");
eq("unknown letters ignored", figRefText(P, ["z"]), "@fig-x");
eq("panelSpec direct", panelSpec(P, ["a", "c", "d", "e"]), "a,c-e");

if (fail) {
  console.error(`\nFIGFAMILY VERIFY: FAIL (${fail})`);
  process.exit(1);
}
console.log("\nFIGFAMILY VERIFY: PASS");
