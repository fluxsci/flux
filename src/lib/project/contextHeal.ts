// Open-time heal: existing projects (scaffolded before the principal-agent
// scheme) gain their Context/ layer the first time they are opened. Additive
// and existence-guarded — never touches a file that already exists, except an
// AGENTS.md that is byte-recognizably the retired generated verb guide (whose
// content moved to the machine FluxContext). GUI engine (file bridge); the
// flux-core twin is flux-core/context.ts — both drive the same pure entries
// from contextTemplates.ts.

import { fileBridge, joinPath, type LoadedProject } from "./types";
import {
  agentsStubTemplate,
  contextScaffoldEntries,
  isRetiredAgentsGuide,
} from "./contextTemplates";

export async function ensureProjectContext(p: LoadedProject): Promise<string[]> {
  const fb = fileBridge();
  if (!fb) return [];
  const created: string[] = [];
  const { dirs, files } = contextScaffoldEntries(p.manifest.title);
  try {
    for (const d of dirs) {
      if (!(await fb.exists(joinPath(p.root, d)))) {
        await fb.mkdir(joinPath(p.root, d));
        created.push(d + "/");
      }
    }
    for (const [rel, body] of files) {
      if (!(await fb.exists(joinPath(p.root, rel)))) {
        await fb.writeText(joinPath(p.root, rel), body);
        created.push(rel);
      }
    }
    const agentsPath = joinPath(p.root, "AGENTS.md");
    if (!(await fb.exists(agentsPath))) {
      await fb.writeText(agentsPath, agentsStubTemplate());
      created.push("AGENTS.md");
    } else {
      try {
        const cur = await fb.readText(agentsPath);
        if (isRetiredAgentsGuide(cur)) {
          await fb.writeText(agentsPath, agentsStubTemplate());
          created.push("AGENTS.md (retired guide → stub)");
        }
      } catch {
        /* unreadable — leave it */
      }
    }
    if (created.length) {
      // journalAppend is Electron-only and untyped on FileBridge (bibLoad idiom).
      const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
      host?.journalAppend?.({ action: "ensure-context", detail: created.join(", ") });
    }
  } catch {
    /* heal is best-effort — an open must never fail because of it */
  }
  return created;
}
