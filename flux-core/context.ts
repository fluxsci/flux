// flux-core/context.ts — the project Context layer, headless engine.
// ensureProjectContext heals Context/ into projects scaffolded before the
// principal-agent scheme (additive + existence-guarded; the GUI twin is
// src/lib/project/contextHeal.ts — both drive contextTemplates.ts).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  agentsStubTemplate,
  contextScaffoldEntries,
  isRetiredAgentsGuide,
  CONTEXT_PATHS,
} from "../src/lib/project/contextTemplates";
import { loadManifest, safeJoin, exists } from "./model";
import { journal } from "./journal";

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
