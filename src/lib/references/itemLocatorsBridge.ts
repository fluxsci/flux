import { fileBridge } from "../project/types";
import { configureItemLocators } from "./itemLocator";
import { assertBibValid } from "./bibScanner";
const cached = new Map<string, string>();
export async function prepareItemLocators(root: string): Promise<void> {
  const fb = fileBridge(); if (!fb) return;
  const bib = `${root}/library.bib`, items = `${root}/items`;
  let token = "";
  if (fb.stat) { const values = await Promise.all([fb.stat(bib), fb.stat(items)]); token = JSON.stringify(values); if (cached.get(root) === token) return; }
  const text = await fb.exists(bib) ? await fb.readText(bib) : "";
  const directories = await fb.exists(items) ? await fb.readdir?.(items) ?? [] : [];
  configureItemLocators(root, assertBibValid(text).records.filter(r => r.kind === "entry").map(r => r.key!), directories.filter(d => d.dir).map(d => d.name));
  if (token) cached.set(root, token);
}
