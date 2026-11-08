#!/usr/bin/env -S npx tsx
// 2026-11-08 — the structured authors / affiliations editor (Document
// Properties). The sheet edits rows; the Save writes them through the minimal
// value patcher. Every case below is an EXACT expected document: one toggled
// flag adds one line, a new affiliation reference rewrites one list, a moved
// author moves verbatim, and nothing else changes. The journal exporter's own
// reader (readAuthors) sees the intended title page afterwards.
//   node scripts/run-verifies.mjs --tier pure --only document-properties

import * as yaml from "js-yaml";
import {
  readDocumentProperties,
  planDocumentPropertiesWith,
  orcidValid,
  newAffiliationId,
  type DocumentProperties,
} from "../src/shell/modes/paper/documentProperties";
import { applyFmChanges, planFrontMatterValuesWith, FrontMatterEditError } from "../src/shell/modes/paper/frontmatterEdit";
import { frontMatterBounds } from "../src/shell/modes/paper/frontmatter";
import { readAuthors } from "../src/lib/style/journalManuscript";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));
const metaOf = (src: string) => (yaml.load(frontMatterBounds(src).fmText) as Record<string, unknown>) ?? {};
const props = (src: string) => readDocumentProperties(metaOf(src));
const save = (src: string, p: DocumentProperties) => applyFmChanges(src, planDocumentPropertiesWith(yaml, src, p));
function expectDoc(name: string, src: string, edit: (p: DocumentProperties) => void, want: string) {
  const p = props(src);
  edit(p);
  let got: string;
  try {
    got = save(src, p);
  } catch (err) {
    fail(`${name}: threw ${(err as Error).message}`);
    return;
  }
  if (got === want) ok(name);
  else {
    fail(name);
    console.error("    --- want\n" + want.replace(/^/gm, "    | ") + "\n    --- got\n" + got.replace(/^/gm, "    | "));
  }
}

const DOC = `---
# Manuscript metadata: keep in sync with the cover letter
title: 'Sleep spindles gate CA1 replay'   # working title
author:
  - name: Ada Lovelace
    orcid: 0000-0002-1825-0097
    email: ada@example.org
    corresponding: true
    equal-contributor: true
    affiliations:
      - ref: ucl
  # second author joined in 2025
  - name: Alan Turing
    lead-contact: true
    affiliations: [ucl, mit]
affiliations:
  - id: ucl
    name: University College London
    city: London   # campus
  - id: mit
    name: MIT
keywords: [sleep, "CA1"]
---

Body.
`;

// ---- reading -------------------------------------------------------------------------------
{
  const p = props(DOC);
  assert(p.title === "Sleep spindles gate CA1 replay", "title read");
  const [ada, alan] = p.authors;
  assert(ada.name === "Ada Lovelace" && ada.orcid === "0000-0002-1825-0097" && ada.email === "ada@example.org" && ada.corresponding && ada.equal && !ada.lead && JSON.stringify(ada.affiliations) === '["ucl"]', "Ada: orcid, email, corresponding, equal, {ref} affiliation");
  assert(alan.lead && !alan.corresponding && JSON.stringify(alan.affiliations) === '["ucl","mit"]', "Alan: lead contact, flow-list affiliations");
  assert(p.affiliations.map((a) => `${a.id}:${a.name}:${a.city}`).join("|") === "ucl:University College London:London|mit:MIT:", "affiliation rows");
  assert(planDocumentPropertiesWith(yaml, DOC, props(DOC)).length === 0, "an untouched Save writes zero bytes");
}

// ---- field edits: one line each --------------------------------------------------------------
expectDoc("toggle corresponding on: one line appended to that author", DOC, (p) => { p.authors[1].corresponding = true; },
  DOC.replace("    affiliations: [ucl, mit]\n", "    affiliations: [ucl, mit]\n    corresponding: true\n"));
expectDoc("toggle equal-contributor off: that line goes", DOC, (p) => { p.authors[0].equal = false; },
  DOC.replace("    equal-contributor: true\n", ""));
expectDoc("edit an email: only the scalar", DOC, (p) => { p.authors[0].email = "ada@ucl.ac.uk"; },
  DOC.replace("ada@example.org", "ada@ucl.ac.uk"));
expectDoc("clear an ORCID: its line goes", DOC, (p) => { p.authors[0].orcid = ""; },
  DOC.replace("    orcid: 0000-0002-1825-0097\n", ""));
expectDoc("add an affiliation reference: the {ref} list keeps its style", DOC, (p) => { p.authors[0].affiliations = ["ucl", "mit"]; },
  DOC.replace("      - ref: ucl\n", "      - ref: ucl\n      - ref: mit\n"));
expectDoc("drop a reference from a flow list: stays flow", DOC, (p) => { p.authors[1].affiliations = ["mit"]; },
  DOC.replace("affiliations: [ucl, mit]", "affiliations: [mit]"));
expectDoc("rename keeps every field", DOC, (p) => { p.authors[1].name = "Alan M. Turing"; },
  DOC.replace("  - name: Alan Turing", "  - name: Alan M. Turing"));
expectDoc("affiliation city added after its last field", DOC, (p) => { p.affiliations[1].city = "Cambridge"; },
  DOC.replace("    name: MIT\n", "    name: MIT\n    city: Cambridge\n"));
expectDoc("affiliation renamed in place (comment on the next line kept)", DOC, (p) => { p.affiliations[0].name = "UCL"; },
  DOC.replace("    name: University College London\n", "    name: UCL\n"));
expectDoc("title edit keeps its quotes and comment", DOC, (p) => { p.title = "Spindles gate replay"; },
  DOC.replace("'Sleep spindles gate CA1 replay'", "'Spindles gate replay'"));

// ---- structure: add / remove / move ----------------------------------------------------------
expectDoc("new author with an affiliation: one entry appended", DOC, (p) => {
  p.authors.push({ src: null, name: "Grace Hopper", email: "", orcid: "", corresponding: false, equal: false, lead: false, affiliations: ["mit"], affiliationText: "" });
}, DOC.replace("    affiliations: [ucl, mit]\n", "    affiliations: [ucl, mit]\n  - name: Grace Hopper\n    affiliations:\n      - mit\n"));
expectDoc("new affiliation row: one entry appended with an id", DOC, (p) => {
  p.affiliations.push({ src: null, id: "ox", explicitId: true, department: "Department of Physiology", name: "University of Oxford", city: "Oxford", country: "UK", editable: true, text: "" });
}, DOC.replace("    name: MIT\n", "    name: MIT\n  - id: ox\n    department: Department of Physiology\n    name: University of Oxford\n    city: Oxford\n    country: UK\n"));
expectDoc("remove an affiliation and its references", DOC, (p) => {
  p.affiliations = p.affiliations.filter((a) => a.id !== "mit");
  p.authors[1].affiliations = ["ucl"];
}, DOC.replace("affiliations: [ucl, mit]", "affiliations: [ucl]").replace("  - id: mit\n    name: MIT\n", ""));
expectDoc("reorder authors: entries move verbatim, the comment travels with Alan", DOC, (p) => { p.authors.reverse(); },
  DOC.replace(
    /  - name: Ada Lovelace\n(?:    .*\n|      .*\n)+  # second author joined in 2025\n  - name: Alan Turing\n    lead-contact: true\n    affiliations: \[ucl, mit\]\n/,
    "  # second author joined in 2025\n  - name: Alan Turing\n    lead-contact: true\n    affiliations: [ucl, mit]\n" +
      "  - name: Ada Lovelace\n    orcid: 0000-0002-1825-0097\n    email: ada@example.org\n    corresponding: true\n    equal-contributor: true\n    affiliations:\n      - ref: ucl\n",
  ));

// ---- the title page the export prints --------------------------------------------------------
{
  const p = props(DOC);
  p.authors[1].corresponding = true;
  p.authors[1].email = "alan@example.org";
  p.affiliations[1].country = "USA";
  const out = save(DOC, p);
  const page = readAuthors(metaOf(out));
  const alan = page.authors[1];
  assert(alan.corresponding && alan.email === "alan@example.org" && alan.lead && alan.affiliations.length === 2, "readAuthors: Alan is corresponding with email, still lead contact, two affiliations");
  assert(page.affiliations.some((a) => a.text === "MIT, USA"), "readAuthors: the edited affiliation prints with its country");
  assert(out.startsWith("---\n# Manuscript metadata") && out.includes("city: London   # campus") && out.includes('keywords: [sleep, "CA1"]'), "comments, quoting and unrelated keys survive a multi-field Save");
}

// ---- documents that start with nothing ----------------------------------------------------------
{
  const bare = "---\ntitle: T\nlang: en\n---\n\nBody.\n";
  const p = props(bare);
  p.authors.push({ src: null, name: "Ada Lovelace", email: "ada@x.org", orcid: "", corresponding: true, equal: false, lead: false, affiliations: ["ucl"], affiliationText: "" });
  p.affiliations.push({ src: null, id: "ucl", explicitId: true, department: "", name: "UCL", city: "", country: "", editable: true, text: "" });
  const out = save(bare, p);
  assert(out === "---\ntitle: T\nauthor:\n  - name: Ada Lovelace\n    email: ada@x.org\n    corresponding: true\n    affiliations:\n      - ucl\naffiliations:\n  - id: ucl\n    name: UCL\nlang: en\n---\n\nBody.\n",
    "author + affiliations keys are added after the title, other keys untouched");
  const one = "---\ntitle: T\nauthor: Jane Doe\n---\nb\n";
  const q = props(one);
  q.authors[0].email = "jane@x.org";
  const out2 = save(one, q);
  const meta = metaOf(out2);
  assert(JSON.stringify(meta.author) === JSON.stringify({ name: "Jane Doe", email: "jane@x.org" }) && out2.startsWith("---\ntitle: T\nauthor:"), "a bare-string author becomes a mapping when it gains a field");
  const attrs = "---\nauthor:\n  - name: A\n    attributes:\n      corresponding: true\n---\nb\n";
  const r = props(attrs);
  assert(r.authors[0].corresponding, "attributes.corresponding is read");
  r.authors[0].corresponding = false;
  assert(save(attrs, r) === "---\nauthor:\n  - name: A\n---\nb\n", "…and cleared where it lives (the empty attributes map goes too)");
}

// ---- refusals and helpers ------------------------------------------------------------------------
{
  let threw = false;
  try {
    planDocumentPropertiesWith(yaml, "---\ntitle: [x\n---\n", props("---\ntitle: ok\n---\n"));
  } catch (err) {
    threw = err instanceof FrontMatterEditError;
  }
  assert(threw, "invalid YAML refuses");
  assert(orcidValid("0000-0002-1825-0097") && orcidValid("https://orcid.org/0000-0001-5109-3700") && orcidValid("0000-0002-1694-233X"), "ORCID checksum accepts valid ids (incl. X and URL form)");
  assert(!orcidValid("0000-0002-1825-0098") && !orcidValid("1234"), "ORCID checksum rejects a typo");
  assert(newAffiliationId("University College London", []) === "ucl" && newAffiliationId("MIT", ["mit"]) === "mit-2", "new affiliation ids: initials, unique");
  // The generic patcher directly: a value whose shape changes is re-written as one pair.
  const shape = "---\na: 1\nb: x  # c\nz: 2\n---\n";
  const out = applyFmChanges(shape, planFrontMatterValuesWith(yaml, shape, [{ key: "b", value: ["p", "q"] }]));
  assert(out === "---\na: 1\nb:\n  - p\n  - q\nz: 2\n---\n", "shape change: only that pair is re-written");
}

console.log(failures ? `\nDOCUMENT-PROPERTIES: FAIL (${failures})` : "\nDOCUMENT-PROPERTIES: PASS");
process.exit(failures ? 1 : 0);
