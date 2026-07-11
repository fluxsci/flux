// 3.3 gate (pure) — the library-organization model (tags/status/collections, immutable
// mutation + prune + normalize) and the tag:/status:/collection: query grammar.
//   Run: npx tsx scripts/verify-organize.ts
import {
  emptyOrganize,
  setTags,
  addTag,
  removeTag,
  setStatus,
  setCollections,
  addToCollection,
  allTags,
  allCollections,
  organizeOf,
  mergeOrganize,
  normalizeOrganize,
} from "../src/lib/references/organize";
import { runQuery, parseQuery, isStructured, attachHaystacks, createQueryRunner } from "../src/lib/references/query";
import type { RefEntry } from "../src/lib/references/types";

let fails = 0;
const ok = (c: boolean, name: string, extra = "") => {
  console.log(`${c ? "✓" : "✗"} ${name}${c || !extra ? "" : ` — ${extra}`}`);
  if (!c) fails++;
};

// --- model: tags -------------------------------------------------------------------------
{
  let d = emptyOrganize();
  d = setTags(d, "a2020", ["CPG", "cpg", " STG ", "stg", "review"]);
  ok(JSON.stringify(organizeOf(d, "a2020").tags) === JSON.stringify(["CPG", "STG", "review"]), "setTags de-dupes case-insensitively + trims", JSON.stringify(organizeOf(d, "a2020").tags));
  d = addTag(d, "a2020", "review"); // dup → no change
  d = addTag(d, "a2020", "important");
  ok(organizeOf(d, "a2020").tags.length === 4, "addTag ignores dup, appends new");
  d = removeTag(d, "a2020", "CPG");
  ok(!organizeOf(d, "a2020").tags.includes("CPG"), "removeTag drops it");
}

// --- model: status prune -----------------------------------------------------------------
{
  let d = emptyOrganize();
  d = setStatus(d, "k", "reading");
  ok(organizeOf(d, "k").status === "reading", "setStatus sets");
  d = setStatus(d, "k", "unread"); // back to default → entry pruned
  ok(d.items["k"] === undefined, "status=unread with nothing else prunes the entry");
}

// --- model: collections + rollups --------------------------------------------------------
{
  let d = emptyOrganize();
  d = setCollections(d, "a", ["Thesis Ch. 2", "reading list"]);
  d = addToCollection(d, "b", "Thesis Ch. 2");
  d = setTags(d, "a", ["cpg"]);
  d = setTags(d, "b", ["vision", "cpg"]);
  ok(JSON.stringify(allTags(d)) === JSON.stringify(["cpg", "vision"]), "allTags sorted+unique", JSON.stringify(allTags(d)));
  ok(JSON.stringify(allCollections(d)) === JSON.stringify(["reading list", "Thesis Ch. 2"]), "allCollections sorted+unique", JSON.stringify(allCollections(d)));
}

// --- normalize (repair hand-edits) -------------------------------------------------------
{
  const repaired = normalizeOrganize({ items: { k: { tags: ["a", "a", ""], status: "bogus", collections: 5 }, e: { tags: [] } } });
  ok(JSON.stringify(repaired.items["k"]?.tags) === JSON.stringify(["a"]), "normalize de-dupes + drops blanks");
  ok(repaired.items["k"]?.status === undefined, "normalize rejects an invalid status");
  ok(repaired.items["e"] === undefined, "normalize prunes an all-empty entry");
}

// --- grammar -----------------------------------------------------------------------------
{
  ok(isStructured("tag:cpg") && isStructured("status:read") && isStructured("collection:thesis"), "isStructured recognizes the organize fields");
  const cs = parseQuery('tag:cpg status:reading coll:"thesis ch. 2"');
  ok(cs.length === 3 && cs[0].field === "tag" && cs[1].field === "status" && cs[2].field === "collection", "parseQuery maps tag/status/coll (+ aliases)", JSON.stringify(cs));
}

// --- runQuery over merged entries --------------------------------------------------------
{
  const entries: RefEntry[] = [
    { key: "marder", title: "CPG dynamics", authors: ["Marder"], year: "1996" },
    { key: "buzsaki", title: "Oscillations", authors: ["Buzsaki"], year: "2004" },
    { key: "hubel", title: "Vision", authors: ["Hubel"], year: "1962" },
  ];
  let d = emptyOrganize();
  d = setTags(d, "marder", ["cpg", "review"]);
  d = setStatus(d, "marder", "read");
  d = setTags(d, "buzsaki", ["oscillations"]);
  d = setStatus(d, "buzsaki", "reading");
  d = setCollections(d, "marder", ["Thesis"]);
  d = setCollections(d, "hubel", ["Thesis"]);
  const merged = mergeOrganize(entries, d);

  ok(runQuery(merged, "tag:cpg").map((e) => e.key).join() === "marder", "tag: filters to the tagged paper");
  ok(runQuery(merged, "status:reading").map((e) => e.key).join() === "buzsaki", "status: filters by reading state");
  ok(runQuery(merged, "status:unread").map((e) => e.key).join() === "hubel", "status:unread matches papers with no status");
  ok(runQuery(merged, "collection:thesis").map((e) => e.key).sort().join() === "hubel,marder", "collection: filters to members");
  ok(runQuery(merged, "tag:cpg status:read").map((e) => e.key).join() === "marder", "combined tag: + status: (AND)");
  ok(runQuery(merged, "tag:cpg status:reading").length === 0, "combined clauses that share no paper → empty");
}

// ---- WS-8.1: haystack precompute + incremental refinement ---------------------
{
  const mk = (key: string, title: string, extra: Partial<RefEntry> = {}): RefEntry =>
    ({ key, title, authors: ["Doe, J."], year: "2020", container: "Nature", raw: "", ...extra }) as RefEntry;
  const pool = [
    mk("alpha", "Neural dynamics of decision"),
    mk("beta", "Decision boundaries in cortex"),
    mk("gamma", "Cortical maps"),
    mk("delta", "Unrelated paper on rivers"),
  ];
  // (1) attachHaystacks changes NO results — hay path ≡ per-call build.
  const plainRes = (q: string) => runQuery(pool.map((e) => ({ ...e })), q).map((e) => e.key).join();
  const hayPool = attachHaystacks(pool.map((e) => ({ ...e })));
  for (const q of ["decision", "cortex", "doe", "2020", "nature decision", "zzz"]) {
    ok(runQuery(hayPool, q).map((e) => e.key).join() === plainRes(q), `hay ≡ plain for "${q}"`);
  }
  ok(!JSON.stringify(hayPool[0]).includes("_hay"), "_hay is non-enumerable (never serializes)");

  // (2) the refining runner ≡ from-scratch runQuery across a typing sequence.
  const run = createQueryRunner<RefEntry>();
  const seq = ["d", "de", "dec", "deci", "decision", "decision c", "decision cortex"];
  for (const q of seq) {
    ok(run(hayPool, q).map((e) => e.key).join() === runQuery(hayPool, q).map((e) => e.key).join(),
      `refined ≡ fresh for "${q}" (order included)`);
  }
  // (3) non-extending edit, structured query, and new-array identity all fall back safely.
  ok(run(hayPool, "cortex").map((e) => e.key).join() === runQuery(hayPool, "cortex").map((e) => e.key).join(),
    "non-extending edit falls back to the full scan");
  ok(run(hayPool, "author:doe").map((e) => e.key).join() === runQuery(hayPool, "author:doe").map((e) => e.key).join(),
    "structured query bypasses refinement");
  const rebuilt = attachHaystacks(pool.map((e) => ({ ...e })));
  ok(run(rebuilt, "co").map((e) => e.key).join() === runQuery(rebuilt, "co").map((e) => e.key).join(),
    "new entries-array identity forces a full scan");
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
