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
