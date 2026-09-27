import * as fs from "node:fs/promises";
import * as path from "node:path";
import { configureItemLocators } from "../src/lib/references/itemLocator";
import { assertBibValid } from "../src/lib/references/bibScanner";
const cached = new Map<string, string>();
export async function prepareItemLocators(root: string): Promise<void> {
  const bib = path.join(root, "library.bib"), items = path.join(root, "items");
  const stat = async (p: string) => { try { const s = await fs.stat(p); return `${s.mtimeMs}:${s.size}`; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw e; } };
  const token = (await Promise.all([stat(bib), stat(items)])).join("|");
  if (cached.get(root) === token) return;
  const text = await fs.readFile(bib, "utf8").catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return ""; throw e;});
  const dirs = await fs.readdir(items, {withFileTypes: true}).catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return []; throw e;});
  configureItemLocators(root, assertBibValid(text).records.filter(r => r.kind === "entry").map(r => r.key!), dirs.filter(d => d.isDirectory()).map(d => d.name));
  cached.set(root, token);
}
