// The store's two HEAVY editor-core needs, bound late. The app shell imports the store for its
// shared state; a static `import * as ops` there made Home load the whole editor core (ops, text
// layout, plot parsing + css-tree, 3D scenes…) before first paint — the eager-shell budget
// (verify-startup) went 892 → 918 KB against 800. Both needs run only inside an editor (lettering
// a figure's panels; publishing / restoring accepted plot-source sizes), and every editor surface
// loads ./editorCore, which links them. Leaf module: no imports.

type Project = import("./types").Project;
export interface EditorCore {
  autoLetterPanels(p: Project, figId: string): { changed: boolean; letters: string[] };
  applySourceUpdates(p: Project, updates: readonly { assetId: string; width: number; height: number; layoutSupported?:boolean }[]): unknown;
}

let core: EditorCore | null = null;

/** Called once by ./editorCore when any editor surface loads. */
export function linkEditorCore(c: EditorCore): void {
  core = c;
}

export function editorCore(): EditorCore {
  if (!core) throw new Error("The figure editor core is not loaded");
  return core;
}
