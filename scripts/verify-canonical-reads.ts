import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCanonical, readCanonicalText } from "../src/lib/references/canonical";
import { validateAnnotations } from "../src/lib/references/annotations";
import { validateOrganize, addTag, removeTag } from "../src/lib/references/organize";
import { loadAnnotations, addAnnotation } from "../flux-core/annotate";
import { loadOrganize, organizeSetTags } from "../flux-core/fluxlib";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-canonical-reads");
const root = await mkdtemp(path.join(tmpdir(), "flux-canonical-"));
try {
  await mkdir(path.join(root, "items", "paper"), { recursive: true });
  await mkdir(path.join(root, ".fluxlib"));
  for (const [rel, load, mutate] of [
    ["items/paper/annotations.json", () => loadAnnotations("paper", root), () => addAnnotation("paper", { page: 1, anchor: { quote: "q", prefix: "", suffix: "" }, color: "yellow" }, root)],
    [".fluxlib/organize.json", () => loadOrganize(root), () => organizeSetTags("paper", ["new"], root)],
  ] as const) {
    for (const bad of ["{invalid", '{"version":99,"annotations":[],"items":{}}', "null", '"scalar"']) {
      const target = path.join(root, rel);
      await writeFile(target, bad);
      await assert.rejects(load, /malformed canonical/);
      await assert.rejects(mutate, /malformed canonical/);
      h.eq(await readFile(target, "utf8"), bad, `${rel}: failed mutation preserves exact bytes`);
    }
  }
  const org=path.join(root,".fluxlib","organize.json"), originalOrg='{"version":1,"items":{"paper":{"tags":["original"]}}}';
  await writeFile(org,originalOrg);
  const originalRead=fs.promises.readFile;let revoked=false;
  fs.promises.readFile=(async (file: any,...args: any[])=>{
    const data=await (originalRead as any)(file,...args);
    if(file===org&&!revoked){revoked=true;await rm(path.join(root,".fluxlib","locks","library.json"));}
    return data;
  }) as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  try { await assert.rejects(()=>organizeSetTags("paper",["lost-owner"],root),/Lost lease/); }
  finally { fs.promises.readFile=originalRead; syncBuiltinESMExports(); }
  h.ok(revoked,"fixture revokes the actual Node lease after canonical read");
  h.eq(await readFile(org,"utf8"),originalOrg,"Node lost lease is rejected before canonical bytes publish");
  const conflictPath = path.join(root,".fluxlib","organize.sync-conflict-20260921-123456-ABCDEFG.json");
  await writeFile(path.join(root,".fluxlib","organize.json"),'{"version":1,"items":{}}');
  await writeFile(conflictPath,'{"version":1,"items":{"paper":{"tags":["other"]}}}');
  await assert.rejects(()=>organizeSetTags("paper",["new"],root),/Unresolved canonical sync conflict/);
  h.eq(await readFile(path.join(root,".fluxlib","organize.json"),"utf8"),'{"version":1,"items":{}}',"sync conflict blocks canonical mutation without replacing either revision");
  h.eq(await readFile(conflictPath,"utf8"),'{"version":1,"items":{"paper":{"tags":["other"]}}}',"sync conflict copy remains byte-identical for review");
  await assert.rejects(() => readCanonicalText("blocked", async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }), /unreadable canonical/);
  h.eq(await readCanonicalText("absent", async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }), null, "only ENOENT permits initialization");
  const data = parseCanonical("org", '{"version":1,"future":42,"items":{"paper":{"tags":["a"],"collections":[],"custom":"keep"}}}', validateOrganize);
  const changed = removeTag(addTag(data, "paper", "b"), "paper", "a") as any;
  h.eq([changed.future, changed.items.paper.custom, changed.items.paper.tags], [42, "keep", ["b"]], "intent edits preserve unrelated and unknown canonical fields");
  assert.throws(() => validateAnnotations({ version: 1, annotations: [{ id: "x" }] }));
  h.ok(true, "annotation schema rejects malformed records");
} finally { await rm(root, { recursive: true, force: true }); }
h.done();
