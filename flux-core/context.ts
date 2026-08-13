// flux-core/context.ts — the project Context layer, headless engine.
// ensureProjectContext heals Context/ into projects scaffolded before the
// principal-agent scheme (additive + existence-guarded; the GUI twin is
// src/lib/project/contextHeal.ts — both drive contextTemplates.ts).
// addNote appends notebook session-log entries under the manuscript lock.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  agentsStubTemplate,
  appendSessionLogEntry,
  contextScaffoldEntries,
  isRetiredAgentsGuide,
  sessionLogStamp,
  CONTEXT_PATHS,
} from "../src/lib/project/contextTemplates";
import { loadManifest, safeJoin, exists, writeText } from "./model";
import { withLock } from "./locks";
import { CLIENT, journal } from "./journal";

export { CONTEXT_PATHS };

export async function ensureProjectContext(root: string): Promise<{ created: string[] }> {
  const manifest = await loadManifest(root).catch(() => null);
  const title = manifest?.title || path.basename(root);
  const created: string[] = [];
  const { dirs, files } = contextScaffoldEntries(title);
  for (const d of dirs) {
    const p = safeJoin(root, d);
    if (!(await exists(p))) {
      await fs.mkdir(p, { recursive: true });
      created.push(d + "/");
    }
  }
  for (const [rel, body] of files) {
    const p = safeJoin(root, rel);
    if (!(await exists(p))) {
      await fs.writeFile(p, body);
      created.push(rel);
    }
  }
  const agentsPath = safeJoin(root, "AGENTS.md");
  if (!(await exists(agentsPath))) {
    await fs.writeFile(agentsPath, agentsStubTemplate());
    created.push("AGENTS.md");
  } else {
    const cur = await fs.readFile(agentsPath, "utf8").catch(() => "");
    if (isRetiredAgentsGuide(cur)) {
      await fs.writeFile(agentsPath, agentsStubTemplate());
      created.push("AGENTS.md (retired guide → stub)");
    }
  }
  if (created.length) await journal(root, { action: "ensure-context", detail: created.join(", ") });
  return { created };
}

export interface NoteResult {
  rel: string;
  heading: string;
  createdSection: boolean;
}

/** `flux note` — append a stamped entry to the notebook's Session log. The whole
 *  read→insert→write cycle runs INSIDE the `manuscript` lock (the same name the
 *  GUI holds while the human edits a paper-surfaced doc — NOTEBOOK.md is one),
 *  so entries from concurrent principals serialize instead of clobbering, and a
 *  human mid-edit defers the write with the standard "deferred" message. This is
 *  the ONLY sanctioned way to write the session log; body edits stay direct and
 *  surgical (PRINCIPAL.md's notebook law). */
export async function addNote(
  root: string,
  opts: { text?: string; file?: string; title?: string; author?: string } = {},
): Promise<NoteResult> {
  let body = opts.text;
  if (!body?.trim() && opts.file) body = await fs.readFile(path.resolve(opts.file), "utf8");
  if (!body?.trim()) throw new Error("note needs text (positional or --text) or --file <path>");
  const author = (opts.author ?? CLIENT).trim() || CLIENT;
  const heading = `### ${sessionLogStamp()} — ${(opts.title?.trim() || author).replace(/\s+/g, " ")}`;
  const entry = `${heading}\n\n${body.trim()}\n`;
  const rel = CONTEXT_PATHS.notebook;
  let createdSection = false;
  await withLock(root, "manuscript", CLIENT, async () => {
    await ensureProjectContext(root); // heal-first, inside the lock (fresh projects race too)
    const p = safeJoin(root, rel);
    const doc = await fs.readFile(p, "utf8").catch(() => "");
    const r = appendSessionLogEntry(doc, entry);
    createdSection = r.createdSection;
    await writeText(p, r.text);
  });
  await journal(root, { action: "note", target: rel, heading });
  return { rel, heading, createdSection };
}
