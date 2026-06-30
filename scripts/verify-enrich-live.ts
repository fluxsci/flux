#!/usr/bin/env -S npx tsx
// LIVE integration test for flux-core/enrich.ts against the real OpenAlex API.
// Uses an ISOLATED temp FluxLib + temp XDG config so it never touches the user's
// real ~/FluxLib or ~/.config/Flux/preferences.json. Network required. Run:
//   npx tsx scripts/verify-enrich-live.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = path.join(os.tmpdir(), "flux-enrich-live-" + process.pid);
process.env.XDG_CONFIG_HOME = path.join(TMP, "config"); // isolate prefs (read at call time)
const LIB = path.join(TMP, "FluxLib");

import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const BIB = `% test FluxLib
@article{lecun2015deep, title={Deep learning}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, journal={Nature}, year={2015}, doi={10.1038/nature14539}}
@article{schultz1997neural, title={A neural substrate of prediction and reward}, author={Schultz, Wolfram and Dayan, Peter and Montague, P Read}, journal={Science}, year={1997}, doi={10.1126/science.275.5306.1593}}
`;

async function main() {
  await fs.mkdir(LIB, { recursive: true });
  await fs.writeFile(path.join(LIB, "library.bib"), BIB);
  const bibBefore = await fs.readFile(path.join(LIB, "library.bib"), "utf8");

  // --- hydrate ---
  const r = await core.hydrateLibrary({ libPath: LIB });
  console.log("  hydrate:", JSON.stringify(r));
  assert(r.total === 2, "2 entries in lib");
  assert(r.fetched >= 1, "fetched ≥1 work from OpenAlex");

  const enr = JSON.parse(await fs.readFile(path.join(LIB, ".fluxlib", "enrich.json"), "utf8"));
  const le = enr["lecun2015deep"];
  assert(le && /^W\d+$/.test(le.openalexId), "lecun2015deep got an openalexId");
  assert(typeof le.citedByCount === "number" && le.citedByCount > 1000, `lecun citedByCount populated (${le?.citedByCount})`);
  assert(Array.isArray(le.topics) && le.topics.length > 0, "lecun topics populated");
  assert(Array.isArray(le.referencedWorks) && le.referencedWorks.length > 0, "lecun referencedWorks (out-edges) populated");
  assert(le.fetchedAt && le.sources.includes("openalex"), "lecun fetchedAt + sources stamped");
  const sch = enr["schultz1997neural"];
  assert(sch && /^W\d+$/.test(sch.openalexId), "schultz1997neural hydrated");
  console.log(`  coverage: ${r.withAbstract}/${r.total} with abstracts (OpenAlex+CrossRef)`);

  // --- .bib must be byte-identical (truth untouched) ---
  assert((await fs.readFile(path.join(LIB, "library.bib"), "utf8")) === bibBefore, ".bib byte-identical after hydrate");

  // --- whole-world lookups ---
  const disc = await core.searchWorld("dopamine reward prediction error", { sort: "cited_by_count:desc", perPage: 5 });
  assert(disc.length > 0 && !!disc[0].title, "searchWorld returns ranked hits");
  assert(typeof disc[0].citedByCount === "number", "discovery hit carries citedByCount");

  const citing = await core.citingWorks("schultz1997neural", { libPath: LIB, perPage: 5 });
  assert(citing.length > 0, `citingWorks(schultz) returns citers (${citing.length})`);

  const auth = await core.authorWorks("schultz1997neural", { libPath: LIB, perPage: 5 });
  assert(auth.length > 0, `authorWorks(schultz first author) returns works (${auth.length})`);

  const rel = await core.relatedWorks("lecun2015deep", { libPath: LIB });
  assert(rel.length > 0, `relatedWorks(lecun) returns related (${rel.length}) — validates openalex_id OR-filter`);

  console.log("\nALL ENRICH LIVE TESTS PASSED");
}

main()
  .catch((e) => {
    console.error("\n" + (e?.stack || e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  });
