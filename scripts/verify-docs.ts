#!/usr/bin/env -S npx tsx
// User-docs corpus gate (pure tier). docs/ is a Quarto website project
// (docs/_quarto.yml → `quarto preview docs`); this pins its structural contract:
//
//   1. _quarto.yml render globs are .qmd-only, so the contributor-facing
//      AGENT_ENGINEERING_GUIDE-RUNNING.md can never enter the rendered site.
//   2. No orphans: every docs/**/*.qmd appears in the _quarto.yml sidebar, and
//      every sidebar entry exists on disk (the sidebar IS the table of contents).
//   3. Per-page frontmatter is title + subtitle ONLY — toc/numbering/theme are
//      centralized in _quarto.yml and must not drift back into pages.
//   4. Every relative .qmd/.md/image link resolves (anchors stripped, code
//      fences/spans excluded) — the corpus is "a base of LINKED documents".
//   5. Machine-path hygiene: no absolute /home/... paths, and never a
//      capital-F ".config/Flux" (the machine config dir is lowercase; the
//      user-level ~/FluxConfig dir is legitimately capitalized).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const { harness } = await import("./lib/harness.mjs");
const h = harness("verify-docs");
const ok = (c: unknown, m: string) => h.ok(!!c, m);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(repoRoot, "docs");

// --- enumerate the corpus ---------------------------------------------------
const SKIP_DIRS = new Set(["_site", ".quarto"]);
function walkQmd(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkQmd(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith(".qmd")) {
      out.push(path.relative(docsDir, path.join(dir, ent.name)));
    }
  }
  return out;
}
const pages = walkQmd(docsDir).sort();
ok(pages.length >= 10, `docs corpus enumerated (${pages.length} .qmd pages)`);
ok(pages.includes("index.qmd"), "index.qmd exists (the site homepage)");
ok(
  fs.existsSync(path.join(docsDir, "AGENT_ENGINEERING_GUIDE-RUNNING.md")),
  "AGENT_ENGINEERING_GUIDE-RUNNING.md still lives in docs/ (AGENTS.md depends on it)",
);

// --- 1+2. _quarto.yml: render globs + sidebar completeness -------------------
h.section("_quarto.yml contract");
type QuartoCfg = {
  project?: { type?: string; render?: string[] };
  website?: { sidebar?: { contents?: unknown } };
};
const cfgRaw = fs.readFileSync(path.join(docsDir, "_quarto.yml"), "utf8");
const cfg = yaml.load(cfgRaw) as QuartoCfg;
ok(cfg?.project?.type === "website", "project type is website");

const render = cfg?.project?.render ?? [];
ok(render.length > 0, "project.render is an explicit list");
ok(
  render.every((g) => g.endsWith(".qmd")),
  "render globs are .qmd-only (the engineering guide never enters the site)",
);

function sidebarQmds(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    if (node.endsWith(".qmd")) out.push(node);
  } else if (Array.isArray(node)) {
    for (const n of node) sidebarQmds(n, out);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) sidebarQmds(v, out);
  }
  return out;
}
const sidebar = sidebarQmds(cfg?.website?.sidebar?.contents).sort();
{
  const onDisk = new Set(pages);
  const inSidebar = new Set(sidebar);
  const orphans = pages.filter((p) => !inSidebar.has(p));
  const dangling = sidebar.filter((s) => !onDisk.has(s));
  ok(orphans.length === 0, orphans.length ? `orphan pages not in sidebar: ${orphans.join(", ")}` : "every page is reachable from the sidebar");
  ok(dangling.length === 0, dangling.length ? `sidebar entries missing on disk: ${dangling.join(", ")}` : "every sidebar entry exists on disk");
}

// --- 3+4+5. per-page checks ---------------------------------------------------
h.section("per-page frontmatter, links, hygiene");
const PAGE_KEYS = new Set(["title", "subtitle"]);
const LINK_EXT = /\.(qmd|md|png|svg|jpe?g|gif|webp)$/i;

/** Strip fenced code blocks and inline code spans so their contents aren't link-scanned. */
function scrubCode(src: string): string {
  const lines = src.split("\n");
  let fenced = false;
  const kept = lines.map((ln) => {
    if (/^\s*(```|~~~)/.test(ln)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : ln;
  });
  return kept.join("\n").replace(/`[^`\n]*`/g, "");
}

for (const rel of pages) {
  const abs = path.join(docsDir, rel);
  const src = fs.readFileSync(abs, "utf8");

  // frontmatter: title + subtitle only
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (!ok(!!fm, `${rel}: has YAML frontmatter`)) continue;
  const meta = (yaml.load(fm![1]) ?? {}) as Record<string, unknown>;
  ok(typeof meta.title === "string" && meta.title.length > 0, `${rel}: frontmatter has a title`);
  ok(typeof meta.subtitle === "string" && meta.subtitle.length > 0, `${rel}: frontmatter has a subtitle`);
  const extra = Object.keys(meta).filter((k) => !PAGE_KEYS.has(k));
  ok(
    extra.length === 0,
    extra.length
      ? `${rel}: page-local frontmatter keys ${extra.join(", ")} — toc/numbering/theme live in _quarto.yml only`
      : `${rel}: frontmatter is title+subtitle only`,
  );

  // links: every relative doc/image link resolves
  const body = scrubCode(src);
  let broken = 0;
  for (const m of body.matchAll(/\]\(([^()\s]+)\)/g)) {
    let target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    target = target.replace(/[#?].*$/, "");
    if (!LINK_EXT.test(target)) continue;
    const resolved = path.resolve(path.dirname(abs), target);
    if (!fs.existsSync(resolved)) {
      broken++;
      h.fail(`${rel}: broken link → ${m[1]}`);
    }
  }
  if (broken === 0) ok(true, `${rel}: all relative links resolve`);

  // machine-path hygiene
  ok(!/\/home\/[a-z]/.test(src), `${rel}: no absolute /home/... machine paths`);
  ok(!/\.config\/Flux\b/.test(src), `${rel}: machine config dir never capitalized`);
}

await h.done();
