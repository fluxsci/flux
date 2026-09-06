import * as fs from "node:fs/promises";
import * as path from "node:path";
/** Convert only a disposable newly scaffolded test project into the legacy layout. */
export async function legacyPaperFixture(root: string): Promise<void> {
  const m = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  await fs.rename(path.join(root, "paper"), path.join(root, "manuscript"));
  await fs.rename(path.join(root, "manuscript/notes.qmd"), path.join(root, "manuscript/main.qmd"));
  delete m.documentRoot;
  m.manuscript.path = "manuscript/main.qmd";
  m.manuscript.config = "manuscript/_quarto.yml";
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify(m, null, 2) + "\n");
}
