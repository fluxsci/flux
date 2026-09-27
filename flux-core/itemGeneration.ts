import * as fs from "node:fs/promises";
import * as path from "node:path";
/** Cheap generation token; the same shape is produced by the renderer bridge. */
export async function pdfIdentityAt(dir: string): Promise<string | null> {
  let target = path.join(dir, "paper.pdf");
  try { await fs.access(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const link = JSON.parse(await fs.readFile(path.join(dir, "paper.link.json"), "utf8"));
      if (typeof link?.path !== "string") return null;
      target = link.path;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
  }
  try { const stat = await fs.stat(target); return stat.isFile() ? JSON.stringify({path: target.replace(/\\/g, "/"), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs}) : null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function fulltextIsCurrent(dir: string): Promise<boolean> {
  try { await fs.access(path.join(dir, "source.pending.json")); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, "fulltext.source.json"), "utf8"));
    return meta.version === 1 && meta.identity === await pdfIdentityAt(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    // Legacy copied PDFs/text-only fixtures remain readable. A legacy linked
    // cache has no proof of source identity and is rebuilt on its first use.
    try { await fs.access(path.join(dir, "paper.link.json")); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  }
}
