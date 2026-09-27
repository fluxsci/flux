import { assertNoCanonicalConflict, parseCanonical, assertCanonicalText } from "./canonical";
// Renderer twin of flux-core's organize persistence (3.3) — reads/writes
// .fluxlib/organize.json over window.fig, mutating under the FluxLib "library" lock so a
// concurrent CLI/MCP/agent edit merges instead of clobbering. Mutations return the fresh
// OrganizeData so the Library can update its in-memory view without a full reload.
import { fileBridge, joinPath } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import { withIpcLock } from "./libLock";
import { validateOrganize, addTag, removeTag, setTags, setStatus, setCollections, bulkAddTag, emptyOrganize, type OrganizeData, type ReadingStatus } from "./organize";

const organizePath = (lib: string) => joinPath(lib, ".fluxlib", "organize.json");

export async function loadOrganize(): Promise<OrganizeData> {
  const fb = fileBridge();
  if (!fb) return emptyOrganize();
  const lib = await resolveFluxLibPath();
  if (!lib) return emptyOrganize();
  const p = organizePath(lib);
  if (!(await fb.exists(p))) return emptyOrganize();
  return parseCanonical(p, await fb.readText(p), validateOrganize);
}

async function mutate(fn: (d: OrganizeData) => OrganizeData): Promise<OrganizeData> {
  const fb = fileBridge();
  if (!fb) return emptyOrganize();
  const lib = await resolveFluxLibPath();
  if (!lib) return emptyOrganize();
  return withIpcLock("fluxlib", "library", async lease => {
    const p = organizePath(lib);
    const read = async () => await fb.exists(p) ? await fb.readText(p) : null;
    const before = await read();
    const next = fn(before == null ? emptyOrganize() : parseCanonical(p, before, validateOrganize));
    if (fb.readdir) await assertNoCanonicalConflict(p, async dir => (await fb.readdir!(dir)).map(e=>e.name));
    await assertCanonicalText(p, before, read);
    if (fb.mkdir) await fb.mkdir(joinPath(lib, ".fluxlib"));
    await lease.assertOwned?.();
    await fb.writeText(organizePath(lib), JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

export const organizeSetTags = (key: string, tags: string[]): Promise<OrganizeData> => mutate((d) => setTags(d, key, tags));
export const organizeSetStatus = (key: string, status: ReadingStatus | undefined): Promise<OrganizeData> => mutate((d) => setStatus(d, key, status));
export const organizeSetCollections = (key: string, collections: string[]): Promise<OrganizeData> => mutate((d) => setCollections(d, key, collections));
export const organizeBulkAddTag = (keys: string[], tag: string): Promise<OrganizeData> => mutate((d) => bulkAddTag(d, keys, tag));

export const organizeAddTag = (key: string, tag: string): Promise<OrganizeData> => mutate(d => addTag(d, key, tag));
export const organizeRemoveTag = (key: string, tag: string): Promise<OrganizeData> => mutate(d => removeTag(d, key, tag));
