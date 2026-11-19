// Type surface of electron/documentRoots.js. Keep in sync with its exports.

export interface DocumentRootManifest {
  documentRoot?: string;
  manuscript?: { path?: string; config?: string };
}

export const STANDARD_DOCUMENT_ROOTS: readonly string[];
export function parentDir(rel: string): string;
export function documentRoot(m: DocumentRootManifest): string;
export function documentRoots(m: DocumentRootManifest): string[];
