// F4: a project holds many documents (main manuscript + supplementary + section
// .qmd files). This module discovers them, reads their titles, and creates new
// ones — registering them in project.json so they survive a reload.

import { fileBridge, joinPath, type LoadedProject } from "../../../../lib/project/types";
import { readManuscript } from "../../../../lib/project/load";
import { frontMatterField } from "../frontmatter";

export interface DocEntry {
  path: string; // relative to the project root, e.g. "manuscript/main.qmd"
  title: string;
  isMain: boolean;
}

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

function dirOf(rel: string): string {
  return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
}

/** Pull a title from a .qmd's YAML front-matter; fall back if there is none. */
export function docTitle(src: string, fallback: string): string {
  // WS-4.1: single-source front-matter extraction (frontmatter.ts).
  const t = frontMatterField(src, "title");
  return t ? t : fallback;
}

/** Discover the project's documents: main + supplementary + manuscript/**.qmd. */
export async function listDocuments(p: LoadedProject): Promise<DocEntry[]> {
  const fb = fileBridge();
  const mainPath = p.manifest.manuscript.path;
  const rels = new Set<string>([mainPath]);
  for (const s of p.manifest.supplementary ?? []) if (s.path) rels.add(s.path);

  // Also scan the manuscript dir (+ a sections/ subdir) for any other .qmd.
  const dir = dirOf(mainPath);
  if (fb?.readdir) {
    const scan = async (d: string, prefix: string) => {
      try {
        for (const e of await fb.readdir!(joinPath(p.root, d))) {
          if (!e.dir && e.name.endsWith(".qmd")) rels.add(prefix ? `${prefix}/${e.name}` : e.name);
        }
      } catch {
        /* dir may not exist */
      }
    };
    await scan(dir, dir);
    await scan(dir ? `${dir}/sections` : "sections", dir ? `${dir}/sections` : "sections");
  }

  const out: DocEntry[] = [];
  for (const rel of rels) {
    const isMain = rel === mainPath;
    let title = baseName(rel).replace(/\.qmd$/, "");
    try {
      title = docTitle(await readManuscript(p, rel), isMain ? p.manifest.title || title : title);
    } catch {
      /* keep filename title */
    }
    out.push({ path: rel, title, isMain });
  }
  out.sort((a, b) => (a.isMain ? -1 : b.isMain ? 1 : a.title.localeCompare(b.title)));
  return out;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

/**
 * Create a new blank document (seeded front-matter), register it in the manifest
 * (so it persists + is rediscovered), and return its project-relative path.
 */
export async function createDocument(p: LoadedProject, name: string): Promise<string> {
  const fb = fileBridge();
  if (!fb) throw new Error("no file bridge");
  const dir = dirOf(p.manifest.manuscript.path);
  const slug = slugify(name);
  let rel = dir ? `${dir}/${slug}.qmd` : `${slug}.qmd`;
  let n = 2;
  while (await fb.exists(joinPath(p.root, rel))) {
    rel = dir ? `${dir}/${slug}-${n}.qmd` : `${slug}-${n}.qmd`;
    n++;
  }
  const stub = `---\ntitle: "${name.replace(/"/g, '\\"')}"\n---\n\n`;
  await fb.writeText(joinPath(p.root, rel), stub);

  if (!p.manifest.supplementary) p.manifest.supplementary = [];
  if (!p.manifest.supplementary.some((s) => s.path === rel)) {
    p.manifest.supplementary.push({ path: rel });
    await fb.writeText(joinPath(p.root, "project.json"), JSON.stringify(p.manifest, null, 2) + "\n");
  }
  return rel;
}
