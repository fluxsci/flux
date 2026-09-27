import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NotConnectedError } from "./errors";
import { requireProject } from "./model";

/** A discovered root is a tool default only; discovering it never connects a session. */
export async function walkProjectRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (let level = 0; level < 8; level++) {
    try { if ((await fs.stat(path.join(dir, "project.json"))).isFile()) return await fs.realpath(dir); }
    catch (e) { if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function createMcpBinding(root?: string, env = process.env, cwd = process.cwd()) {
  let bound: string | null = root || env.FLUX_PROJECT
    ? path.resolve(cwd, root || env.FLUX_PROJECT!)
    : await walkProjectRoot(cwd);
  return {
    get bound() { return bound; },
    bind(root: string | null) { bound = root; },
    async getRoot(args: Record<string, unknown>): Promise<string> {
      const project = typeof args.project === "string" ? args.project : undefined;
      if (!bound && (!project || !path.isAbsolute(project))) throw new NotConnectedError();
      const resolved = project ? path.resolve(bound ?? cwd, project) : bound!;
      await requireProject(resolved);
      return await fs.realpath(resolved);
    },
  };
}

/** Phase 3's binding contract; the full brief engine replaces this handler later. */
export async function connectProject(defaultRoot: string, target?: string) {
  const global = () => ({ title: "global", brief: "Bound to global. The full flux-connect brief arrives in a later build." });
  if (target === "global") return global();
  const candidate = path.resolve(defaultRoot || process.cwd(), target || ".");
  const root = await walkProjectRoot(candidate);
  if (!root && !target) return global();
  if (!root) { await requireProject(candidate); throw new NotConnectedError(); }
  await requireProject(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  const title = typeof manifest.title === "string" ? manifest.title : path.basename(root);
  return { root, title, brief: `Bound to ${title} (${root}). The full flux-connect brief arrives in a later build.` };
}
