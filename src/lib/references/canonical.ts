import { conflictBaseFor } from "../project/conflictRules";
/** Canonical user data is absent only on ENOENT. Parsing/IO errors must never
 * become an empty model that a later mutation can publish over the original. */
export class CanonicalReadError extends Error {
  constructor(readonly path: string, readonly reason: "unreadable" | "malformed", cause: unknown) {
    super(`Cannot read ${path}: ${reason} canonical data. Original bytes were preserved; check the file and retry. ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CanonicalReadError";
  }
}
export function isMissing(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}
export async function readCanonicalText(path: string, read: () => Promise<string>): Promise<string | null> {
  try { return await read(); }
  catch (error) { if (isMissing(error)) return null; throw new CanonicalReadError(path, "unreadable", error); }
}
export function parseCanonical<T>(path: string, text: string, validate: (value: unknown) => T): T {
  try { return validate(JSON.parse(text)); }
  catch (error) { throw new CanonicalReadError(path, "malformed", error); }
}

const snapshots = new WeakMap<object, {path: string; text: string | null}>();
export function rememberCanonical<T extends object>(value: T, path: string, text: string | null): T {
  snapshots.set(value, {path, text}); return value;
}
export async function assertCanonicalText(path: string, expected: string | null, read: () => Promise<string | null>): Promise<void> {
  if (await read() !== expected) throw new Error(`Canonical conflict at ${path}: the file changed outside this operation. Original and current bytes were preserved; reload and retry.`);
}
export async function assertCanonicalSnapshot(value: object, read: (path: string) => Promise<string | null>): Promise<void> {
  const snapshot = snapshots.get(value);
  if (snapshot) await assertCanonicalText(snapshot.path, snapshot.text, () => read(snapshot.path));
}

/** Match the existing sync conflict grammar; never auto-merge canonical records. */
export async function assertNoCanonicalConflict(path: string, list: (directory: string) => Promise<string[]>): Promise<void> {
  const normalized = path.replace(/\\/g,"/"), at = normalized.lastIndexOf("/");
  const directory = normalized.slice(0,at), name = normalized.slice(at+1);
  let names: string[];
  try { names = await list(directory); } catch (error) { if (isMissing(error)) return; throw error; }
  const copies = names.filter(candidate => conflictBaseFor(candidate) === name);
  if (copies.length) throw new Error(`Unresolved canonical sync conflict at ${path}: ${copies.join(", ")}. Both revisions were preserved; review the conflict copies before editing.`);
}
