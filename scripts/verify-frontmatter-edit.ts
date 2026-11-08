#!/usr/bin/env -S npx tsx
// 2026-11-08 — the title pill's Save is BYTE-MINIMAL. It used to `yaml.dump`
// the whole front matter with `author:` rebuilt as names only, deleting
// affiliations / corresponding / email / orcid / equal-contributor /
// lead-contact (the journal export's title page) and every comment, and
// re-quoting the title. This gate pins the replacement editor
// (`src/shell/modes/paper/frontmatterEdit.ts`): each edit changes ONLY the
// intended bytes, asserted as exact expected documents, and the journal
// exporter reads the same title page before and after.
//   node scripts/run-verifies.mjs --tier pure --only frontmatter-edit

import * as yaml from "js-yaml";
import {
  planTitleAuthorsEditWith,
  planSetScalarKeyWith,
  readTitleAuthorsWith,
  applyFmChanges,
  planTitleAuthorsEdit,
  FrontMatterEditError,
  type TitleAuthorsEdit,
} from "../src/shell/modes/paper/frontmatterEdit";
import { readAuthors } from "../src/lib/style/journalManuscript";
import { frontMatterBounds } from "../src/shell/modes/paper/frontmatter";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const save = (src: string, edit: TitleAuthorsEdit) => applyFmChanges(src, planTitleAuthorsEditWith(yaml, src, edit));
function expectDoc(name: string, src: string, edit: TitleAuthorsEdit, want: string) {
  let got: string;
  try {
    got = save(src, edit);
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
const titlePage = (src: string) => {
  const meta = yaml.load(frontMatterBounds(src).fmText) as Record<string, unknown>;
  return JSON.stringify(readAuthors(meta));
};

// ---- the journal fixture: affiliations, orcid, flags, comments, quoting -------------
const JOURNAL = `---
# Manuscript metadata: keep in sync with the cover letter
title: 'Sleep spindles gate CA1 replay'   # working title
short-title: Spindles gate replay
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
abstract: |
  We show that spindles gate replay.
keywords: [sleep, "CA1"]
csl: references/nature.csl
---

Body text with Ca^2+^.
`;

{
  const read = readTitleAuthorsWith(yaml, JOURNAL);
  assert(read.title === "Sleep spindles gate CA1 replay" && read.authors.join("|") === "Ada Lovelace|Alan Turing", "read: title + names exactly as the export reads them");

  assert(planTitleAuthorsEditWith(yaml, JOURNAL, { title: read.title, authors: read.authors }).length === 0, "unchanged Save writes ZERO bytes (the old dump rewrote the whole block)");
  assert(planTitleAuthorsEditWith(yaml, JOURNAL, { title: read.title }).length === 0, "unchanged title alone: zero bytes");

  expectDoc("title edit: only the title scalar changes (single quotes + comment kept)", JOURNAL,
    { title: "Sleep spindles gate hippocampal replay", authors: read.authors },
    JOURNAL.replace("'Sleep spindles gate CA1 replay'", "'Sleep spindles gate hippocampal replay'"));

  expectDoc("title edit: an apostrophe doubles inside single quotes", JOURNAL,
    { title: "Spindles' gate" },
    JOURNAL.replace("'Sleep spindles gate CA1 replay'", "'Spindles'' gate'"));

  const renamed = save(JOURNAL, { authors: ["Ada Lovelace", "Alan M. Turing"] });
  assert(renamed === JOURNAL.replace("  - name: Alan Turing", "  - name: Alan M. Turing"), "author rename: only that name scalar changes");
  const before = JSON.parse(titlePage(JOURNAL)), after = JSON.parse(titlePage(renamed));
  assert(after.authors[1].name === "Alan M. Turing" && JSON.stringify({ ...after.authors[1], name: "" }) === JSON.stringify({ ...before.authors[1], name: "" }),
    "author rename: the exporter reads the same affiliations / lead-contact");
  assert(JSON.stringify(after.authors[0]) === JSON.stringify(before.authors[0]) && JSON.stringify(after.affiliations) === JSON.stringify(before.affiliations),
    "author rename: first author's orcid/email/corresponding/equal + affiliations untouched");

  const changes = planTitleAuthorsEditWith(yaml, JOURNAL, { authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper"] });
  assert(changes.length === 1 && changes[0].from === changes[0].to, "add author: a pure insertion (no existing byte replaced)");
  expectDoc("add author: one `- name:` line after the last entry", JOURNAL,
    { authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper"] },
    JOURNAL.replace("    affiliations: [ucl, mit]\n", "    affiliations: [ucl, mit]\n  - name: Grace Hopper\n"));

  expectDoc("remove author: her entry's lines go, the next author's comment stays with him", JOURNAL,
    { authors: ["Alan Turing"] },
    JOURNAL.replace(/  - name: Ada Lovelace\n(?:    .*\n)+/, ""));

  expectDoc("reorder: whole entries move verbatim", JOURNAL,
    { authors: ["Alan Turing", "Ada Lovelace"] },
    JOURNAL.replace(
      /  - name: Ada Lovelace\n(?:    .*\n)+  # second author joined in 2025\n  - name: Alan Turing\n    lead-contact: true\n    affiliations: \[ucl, mit\]\n/,
      "  # second author joined in 2025\n  - name: Alan Turing\n    lead-contact: true\n    affiliations: [ucl, mit]\n" +
        "  - name: Ada Lovelace\n    orcid: 0000-0002-1825-0097\n    email: ada@example.org\n    corresponding: true\n    equal-contributor: true\n    affiliations:\n      - ref: ucl\n",
    ));

  const both = save(JOURNAL, { title: "New: a title", authors: ["Ada King", "Alan Turing"] });
  assert(both === JOURNAL.replace("'Sleep spindles gate CA1 replay'", "'New: a title'").replace("  - name: Ada Lovelace", "  - name: Ada King"),
    "title + rename together: two scalars, nothing else");
  assert(titlePage(both).replace("Ada King", "Ada Lovelace") === titlePage(JOURNAL), "…and the journal title page is otherwise identical");
}

// ---- quoting styles are kept ----------------------------------------------------------
{
  const src = `---\ntitle: "My \\"Paper\\""\nauthor: Jane Doe\n---\nbody\n`;
  expectDoc("double-quoted title stays double-quoted", src, { title: 'My "New" Paper' }, src.replace('"My \\"Paper\\""', '"My \\"New\\" Paper"'));
  expectDoc("plain title stays plain when it can", "---\ntitle: Plain\n---\nb\n", { title: "Still plain" }, "---\ntitle: Still plain\n---\nb\n");
  expectDoc("plain title that needs quotes gets double quotes", "---\ntitle: Plain\n---\nb\n", { title: "Spindles: a gate # 1" }, '---\ntitle: "Spindles: a gate # 1"\n---\nb\n');
  expectDoc("a numeric-looking title is quoted (stays a string)", "---\ntitle: Plain\n---\nb\n", { title: "2024" }, '---\ntitle: "2024"\n---\nb\n');
  expectDoc("folded block title keeps its header", "---\ntitle: >-\n  A long\n  title\nx: 1\n---\nb\n", { title: "Short" }, "---\ntitle: >-\n  Short\nx: 1\n---\nb\n");
  expectDoc("scalar author renamed in place", src, { authors: ["Jane Q. Doe"] }, src.replace("author: Jane Doe", "author: Jane Q. Doe"));
  expectDoc("scalar author + a second name becomes a list", src, { authors: ["Jane Doe", "Bo Li"] }, src.replace("author: Jane Doe", "author:\n  - name: Jane Doe\n  - name: Bo Li"));
}

// ---- flow lists, structured names, null keys, absent keys ------------------------------
{
  const flow = "---\nauthors: [A One, \"B Two\"]  # list\ndate: 2024-01-02\n---\nb\n";
  expectDoc("flow list: rename keeps the item's quoting", flow, { authors: ["A One", "B Three"] }, flow.replace('"B Two"', '"B Three"'));
  expectDoc("flow list: add an item stays flow", flow, { authors: ["A One", "B Two", "C Four"] }, flow.replace('"B Two"]', '"B Two", C Four]'));

  const structured = "---\nauthor:\n  - name:\n      given: Jo\n      family: Smith\n    orcid: 0000-0001-2345-6789\n---\nb\n";
  expectDoc("given/family name: only the changed part", structured, { authors: ["Jo Smythe"] }, structured.replace("family: Smith", "family: Smythe"));
  expectDoc("given/family name: a new given name", structured, { authors: ["Joanna Smith"] }, structured.replace("given: Jo", "given: Joanna"));

  expectDoc("null author key gets a list", "---\ntitle: T\nauthor:\n---\nb\n", { authors: ["X Y"] }, "---\ntitle: T\nauthor:\n  - name: X Y\n---\nb\n");
  expectDoc("absent author key is added after the title", "---\ntitle: T\nlang: en\n---\nb\n", { authors: ["X Y"] }, "---\ntitle: T\nauthor:\n  - name: X Y\nlang: en\n---\nb\n");
  expectDoc("absent title is added first", "---\nlang: en\n---\nb\n", { title: "New" }, "---\ntitle: New\nlang: en\n---\nb\n");
  expectDoc("no front matter: one is created", "Body only.\n", { title: "T", authors: ["A B"] }, "---\ntitle: T\nauthor:\n  - name: A B\n---\n\nBody only.\n");
  expectDoc("removing every author removes only the key", "---\ntitle: T\nauthor:\n  - name: A\n    email: a@x\nlang: en\n---\nb\n", { authors: [] }, "---\ntitle: T\nlang: en\n---\nb\n");
}

// ---- CRLF, anchors, unnamed entries, invalid YAML ---------------------------------------
{
  const crlf = "---\r\ntitle: Old\r\nauthor:\r\n  - name: A\r\n    email: a@x\r\n---\r\nbody\r\n";
  expectDoc("CRLF: rename + add keep CRLF", crlf, { title: "New", authors: ["A", "B"] }, "---\r\ntitle: New\r\nauthor:\r\n  - name: A\r\n    email: a@x\r\n  - name: B\r\n---\r\nbody\r\n");

  const anchored = "---\nlab: &lab\n  - ref: ucl\nauthor:\n  - name: A\n    affiliations: *lab\n---\nb\n";
  expectDoc("an alias in an author entry survives a rename", anchored, { authors: ["A2"] }, anchored.replace("name: A\n", "name: A2\n"));

  const unnamed = "---\nauthor:\n  - id: consortium\n    note: no name\n  - name: B\n---\nb\n";
  expectDoc("an unnamed entry (the dialog never showed it) is kept", unnamed, { authors: ["B", "C"] }, unnamed.replace("  - name: B\n", "  - name: B\n  - name: C\n"));

  const bad = "---\ntitle: [unclosed\nauthor: A\n---\nb\n";
  let threw = false;
  try {
    planTitleAuthorsEditWith(yaml, bad, { title: "X" });
  } catch (err) {
    threw = err instanceof FrontMatterEditError;
  }
  assert(threw, "invalid YAML: refuses (FrontMatterEditError) instead of rewriting");
  let threwOpen = false;
  try {
    planTitleAuthorsEditWith(yaml, "---\ntitle: never closed\n", { title: "X" });
  } catch (err) {
    threwOpen = err instanceof FrontMatterEditError;
  }
  assert(threwOpen, "unterminated front matter: refuses");
}

// ---- the data-preserving fallback (a shape the span editor cannot express) ------------
{
  // One author written as a bare mapping, now two names: only the author key is
  // re-written (its data intact); the comment and every other key stay verbatim.
  const single = "---\n# keep me\ntitle: T\nauthor:\n  name: A\n  email: a@x  # mail\n  orcid: 0000-0001-2345-6789\nlang: en\n---\nb\n";
  const out = save(single, { authors: ["A", "B"] });
  const meta = yaml.load(frontMatterBounds(out).fmText) as Record<string, unknown>;
  assert(JSON.stringify(meta.author) === JSON.stringify([{ name: "A", email: "a@x", orcid: "0000-0001-2345-6789" }, { name: "B" }]),
    "fallback: a single author mapping becomes a list with every field kept");
  assert(out.startsWith("---\n# keep me\ntitle: T\nauthor:\n") && out.endsWith("lang: en\n---\nb\n"), "fallback: bytes outside the author key untouched");
}

// ---- the lazy-yaml wrapper agrees with the injected one --------------------------------
{
  const a = await planTitleAuthorsEdit(JOURNAL, { title: "Z" });
  const b = planTitleAuthorsEditWith(yaml, JOURNAL, { title: "Z" });
  assert(JSON.stringify(a) === JSON.stringify(b), "async (lazy js-yaml) plan ≡ injected plan");
}

// ---- single scalar keys (csl:) -----------------------------------------------------------
{
  const setKey = (src: string, k: string, v: string | null) => applyFmChanges(src, planSetScalarKeyWith(yaml, src, k, v));
  assert(setKey(JOURNAL, "csl", "references/styles/cell.csl") === JOURNAL.replace("csl: references/nature.csl", "csl: references/styles/cell.csl"), "csl: replaced in place");
  assert(setKey(JOURNAL, "csl", null) === JOURNAL.replace("csl: references/nature.csl\n", ""), "csl: removed (its line only)");
  const noCsl = JOURNAL.replace("csl: references/nature.csl\n", "");
  assert(setKey(noCsl, "csl", "a b.csl") === JOURNAL.replace("csl: references/nature.csl", "csl: a b.csl"), "csl: appended before the close");
  assert(planSetScalarKeyWith(yaml, JOURNAL, "csl", "references/nature.csl").length === 0, "csl: same value writes nothing");
  assert(setKey("---\ncsl: 'x.csl'\n---\n", "csl", "y.csl") === "---\ncsl: 'y.csl'\n---\n", "csl: quoting style kept");
}

console.log(failures ? `\nFRONTMATTER-EDIT: FAIL (${failures})` : "\nFRONTMATTER-EDIT: PASS");
process.exit(failures ? 1 : 0);
