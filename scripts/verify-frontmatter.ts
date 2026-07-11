#!/usr/bin/env -S npx tsx
// WS-4.1 (fortify plan) — the single front-matter parser's case table. Every
// exported API must agree with itself AND with the js-yaml tier across the
// divergence cases that used to split the string/line camps.
//   npx tsx scripts/verify-frontmatter.ts

import { Text } from "@codemirror/state";
import {
  frontMatterBounds,
  stripFrontMatter,
  frontMatterField,
  frontMatterMeta,
  frontMatterEndLine,
  parseFrontMatterYaml,
} from "../src/shell/modes/paper/frontmatter";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// ---- plain document --------------------------------------------------------
{
  const src = '---\ntitle: "My Paper"\nauthor: Jane Doe\ncitation-style: numeric\n---\n\nBody starts here.\n';
  const b = frontMatterBounds(src);
  assert(b.has && !b.open, "plain: closed front matter detected");
  assert(src.slice(b.bodyStart) === "\nBody starts here.\n", "plain: bodyStart lands after the close line's newline");
  assert(stripFrontMatter(src).startsWith("\nBody starts"), "plain: stripFrontMatter");
  assert(frontMatterField(src, "title") === "My Paper", "plain: quoted title unquoted");
  assert(frontMatterField(src, "citation-style") === "numeric", "plain: hyphenated key");
  assert(frontMatterField(src, "nope") === undefined, "plain: absent key → undefined");
  const meta = frontMatterMeta(src);
  assert(meta.title === "My Paper" && meta.authors.join() === "Jane Doe", "plain: meta title + inline author");
  const y = await parseFrontMatterYaml(src);
  assert((y.meta as { title?: string }).title === "My Paper" && y.body === src.slice(b.bodyStart), "plain: yaml tier agrees with bounds");
  assert(src.slice(b.closeEnd - 3, b.closeEnd) === "---", "plain: closeEnd sits at the end of the close fence");
}

// ---- missing close ----------------------------------------------------------
{
  const src = "---\ntitle: Broken\nno close here\nbody-ish line\n";
  const b = frontMatterBounds(src);
  assert(!b.has && b.open && b.bodyStart === 0, "unterminated: open flagged, whole doc is body");
  assert(stripFrontMatter(src) === src, "unterminated: strip returns the doc");
  assert(frontMatterField(src, "title") === undefined, "unterminated: no field extraction");
  const y = await parseFrontMatterYaml(src);
  assert(Object.keys(y.meta).length === 0 && y.body === src, "unterminated: yaml tier agrees");
}

// ---- `----` first body line (the camps used to DISAGREE here) ----------------
{
  const src = "---\ntitle: T\n---\n----\nreal body\n";
  const b = frontMatterBounds(src);
  assert(b.has && src.slice(b.bodyStart).startsWith("----\nreal body"), "`----` after the close is BODY (line-exact wins)");
  const src2 = "---\ntitle: T\n----\nstill front matter?\n---\nbody\n";
  const b2 = frontMatterBounds(src2);
  assert(b2.has && b2.fmText.includes("----"), "a `----` line inside front matter is NOT a close");
  assert(src2.slice(b2.bodyStart) === "body\n", "…the real `---` closes it");
}

// ---- CRLF ---------------------------------------------------------------------
{
  const src = '---\r\ntitle: "CR Title"\r\nauthors: [A One, B Two]\r\n---\r\nbody\r\n';
  const b = frontMatterBounds(src);
  assert(b.has, "CRLF: close detected");
  assert(frontMatterField(src, "title") === "CR Title", "CRLF: no trailing \\r in the title (the old string-camp bug)");
  const meta = frontMatterMeta(src);
  assert(meta.authors.join("|") === "A One|B Two", "CRLF: inline author list clean");
  assert(src.slice(b.bodyStart) === "body\r\n", "CRLF: bodyStart clean");
}

// ---- BOM ------------------------------------------------------------------------
{
  const src = "﻿---\ntitle: Bom\n---\nbody\n";
  assert(frontMatterBounds(src).has && frontMatterField(src, "title") === "Bom", "BOM before the opener tolerated");
}

// ---- block-sequence authors -------------------------------------------------------
{
  const src = "---\ntitle: X\nauthors:\n  - name: Ada Lovelace\n    affiliation: Analytical\n  - name: Alan Turing\n---\nbody\n";
  const meta = frontMatterMeta(src);
  assert(meta.authors.join("|") === "Ada Lovelace|Alan Turing", `block-sequence name: authors (${meta.authors.join("|")})`);
  const src2 = "---\nauthor:\n  - Plain One\n  - 'Quoted Two'\n---\nbody\n";
  assert(frontMatterMeta(src2).authors.join("|") === "Plain One|Quoted Two", "block-sequence plain/quoted items");
}

// ---- >100-line front matter (the old 100-line caps missed the close) --------------
{
  const lines = ["---", "title: Long"];
  for (let i = 0; i < 150; i++) lines.push(`key${i}: v${i}`);
  lines.push("---", "body line");
  const src = lines.join("\n");
  const b = frontMatterBounds(src);
  assert(b.has && src.slice(b.bodyStart) === "body line", ">100-line front matter closes (caps removed)");
  const doc = Text.of(src.split("\n"));
  assert(frontMatterEndLine(doc) === 153, `CM overload finds the close line (${frontMatterEndLine(doc)})`);
}

// ---- CM-doc overload agreement -------------------------------------------------------
{
  const src = "---\ntitle: T\n---\nbody\n";
  const doc = Text.of(src.split("\n"));
  const closeLine = frontMatterEndLine(doc);
  assert(closeLine === 3, "CM overload: close at line 3");
  const b = frontMatterBounds(src);
  assert(doc.line(closeLine).to === b.closeEnd, "CM overload agrees with the string bounds (closeEnd)");
  const noFm = Text.of(["plain doc", "no fences"]);
  assert(frontMatterEndLine(noFm) === 0, "CM overload: 0 when no front matter");
  const open = Text.of(["---", "title: x", "never closes"]);
  assert(frontMatterEndLine(open) === 0, "CM overload: 0 when unterminated");
}

// ---- fmText exactness ------------------------------------------------------------------
{
  const src = "---\na: 1\nb: 2\n---\nbody";
  const b = frontMatterBounds(src);
  assert(b.fmText === "a: 1\nb: 2\n", "fmText is exactly the YAML between the fences");
  const y = await parseFrontMatterYaml(src);
  assert((y.meta as { a?: number }).a === 1 && (y.meta as { b?: number }).b === 2, "yaml tier parses fmText");
}

console.log(failures ? `\nFRONTMATTER: FAIL (${failures})` : "\nFRONTMATTER: PASS");
process.exit(failures ? 1 : 0);
