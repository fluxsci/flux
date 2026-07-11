// Read + lightly validate a project from disk.

import {
  PROJECT_SCHEMA_VERSION,
  fileBridge,
  joinPath,
  type LoadedProject,
  type ProjectManifest,
} from "./types";
import { pushToast } from "../toast";
import { validateProjectManifest } from "./validate";
import { isNewerSchema, newerSchemaMessage } from "./types";

export class NotAProjectError extends Error {}

export async function loadProject(root: string): Promise<LoadedProject> {
  const fig = fileBridge();
  if (!fig) throw new Error("No file bridge available (not running in the app).");

  // WS-9.3: pre-register the root with the main-process fsGuard (deny-by-default
  // — the reads below run BEFORE watchRoot promotes the root). One pending slot;
  // a failed load is superseded by the next beginOpen / cleared by watchRoot.
  await fig.beginOpen?.(root);

  const manifestPath = joinPath(root, "project.json");
  if (!(await fig.exists(manifestPath))) {
    throw new NotAProjectError("No project.json — not a Flux project.");
  }

  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(await fig.readText(manifestPath)) as ProjectManifest;
  } catch {
    throw new Error("project.json is not valid JSON.");
  }
  // WS-5.1 load gate: the ENTRY manifest refuses to open on schema failure
  // (same actionable-error path as the version guard below).
  {
    const errs = validateProjectManifest(manifest);
    if (errs.length)
      throw new Error(
        `project.json failed validation:\n${errs.slice(0, 6).join("\n")}${errs.length > 6 ? `\n… ${errs.length - 6} more` : ""}`,
      );
  }

  if (manifest.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    // Refuse a NEWER format outright: opening it means the app's next autosave
    // rewrites files it doesn't fully understand (a silent lossy downgrade).
    // WS-5.2: the comparator is shared by every load path (isNewerSchema).
    if (isNewerSchema(manifest.schemaVersion, PROJECT_SCHEMA_VERSION)) {
      throw new Error(newerSchemaMessage("This project", manifest.schemaVersion, PROJECT_SCHEMA_VERSION));
    }
    // Older format: opens fine today; surface it so "saving may upgrade files" is
    // never a surprise. Real migrations land with the first format bump.
    pushToast("info", `Project format ${manifest.schemaVersion} (this app writes ${PROJECT_SCHEMA_VERSION})`, {
      detail: "It opens fine; saving upgrades files in place. Back up first if an older Flux also uses this project.",
    });
  }

  return { root, manifest };
}

/**
 * Read a document's text for a loaded project (empty string if missing).
 * `relPath` defaults to the main manuscript; pass a sibling .qmd for F4 multi-doc.
 */
export async function readManuscript(p: LoadedProject, relPath?: string): Promise<string> {
  const fig = fileBridge();
  if (!fig) return "";
  const path = joinPath(p.root, relPath ?? p.manifest.manuscript.path);
  try {
    if (await fig.exists(path)) return await fig.readText(path);
  } catch {
    /* ignore */
  }
  return "";
}

export async function writeManuscript(
  p: LoadedProject,
  text: string,
  relPath?: string,
): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;
  const rel = relPath ?? p.manifest.manuscript.path;
  await fig.writeText(joinPath(p.root, rel), text);
  // WS6: provenance for the human's manuscript save (Electron only).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "set_manuscript", target: rel, client: "human" });
}
