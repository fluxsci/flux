// Renderer-side annotation persistence (the browser/Electron twin of flux-core/
// annotate.ts) over window.fig. Reuses the pure model in annotations.ts + the items
// path helpers. Annotations live in items/<citekey>/annotations.json.
import { fileBridge } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import { annotationsPath, itemDir } from "./items";
import { emptyAnnotationFile, type Annotation, type AnnotationFile } from "./annotations";

export async function loadAnnotations(key: string): Promise<AnnotationFile> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return emptyAnnotationFile();
  try {
    const p = annotationsPath(lib, key);
    return (await fb.exists(p)) ? (JSON.parse(await fb.readText(p)) as AnnotationFile) : emptyAnnotationFile();
  } catch {
    return emptyAnnotationFile();
  }
}

export async function saveAnnotations(key: string, file: AnnotationFile): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  await fb.mkdir(itemDir(lib, key));
  await fb.writeText(annotationsPath(lib, key), JSON.stringify(file, null, 2) + "\n");
}

export async function addAnnotation(
  key: string,
  partial: Omit<Annotation, "id" | "createdAt">,
): Promise<Annotation> {
  const file = await loadAnnotations(key);
  const ann: Annotation = {
    ...partial,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  file.annotations.push(ann);
  await saveAnnotations(key, file);
  return ann;
}

export async function updateAnnotation(key: string, id: string, patch: Partial<Annotation>): Promise<void> {
  const file = await loadAnnotations(key);
  const a = file.annotations.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  await saveAnnotations(key, file);
}

export async function deleteAnnotation(key: string, id: string): Promise<void> {
  const file = await loadAnnotations(key);
  file.annotations = file.annotations.filter((x) => x.id !== id);
  await saveAnnotations(key, file);
}
