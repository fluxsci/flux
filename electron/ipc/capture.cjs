"use strict";
const fs = require("node:fs"), path = require("node:path");
const {createCaptureIntake,newestXpi}=require("../captureIntake.cjs");
/** App-owned capture family; no project/session state is captured at construction. */
function createCaptureFamily({app,shell,readPrefs,fluxLibDir,appRoot,resourcesPath=()=>process.resourcesPath,createIntake=createCaptureIntake}) {
  let registered=false,disposed=false;
  const registrations=[];
  const ipc={handle:(channel,handler)=>registrations.push([channel,handler])};
/** The folder the browser downloads into. Overridable in prefs for a non-default setup. */
function captureDir() {
  const raw = readPrefs().captureDir;
  if (typeof raw === "string" && raw.trim()) return path.resolve(raw.trim());
  try {
    return app.getPath("downloads");
  } catch {
    return null;
  }
}
ipc.handle("capture:dir", () => captureDir());

// Web-capture intake. Implementation lives in ./captureIntake.cjs (extracted so the e2e gate
// can drive it without booting the app); main only injects the paths and registers channels.
const captureIntakeEngine = createIntake({
  captureDir,
  fluxLibDir,
  path,
  fs,
  fsp: require("node:fs/promises"),
  loadRules: () => import("../captureRules.js"),
});
ipc.handle("capture:count", () => captureIntakeEngine.count());
// Intake MOVES files out of the download folder; two windows both run it at
// startup, so concurrent calls collapse into one in-flight sweep (racing
// renames would otherwise double-process a capture).
let intakeInFlight = null;
ipc.handle(
  "capture:intake",
  () =>
    intakeInFlight ? Promise.resolve({pdfs:[],sidecars:[],supplements:[]}) : (intakeInFlight = Promise.resolve()
      .then(() => captureIntakeEngine.intake())
      .finally(() => {
        intakeInFlight = null;
      })),
);
ipc.handle("capture:discard", (_e, name) => captureIntakeEngine.discard(name));
ipc.handle("capture:park", (_e, name, note) => captureIntakeEngine.park(name, note));
ipc.handle("capture:release", (_e, id) => captureIntakeEngine.release(id));

// Web-capture onboarding. The extension is installed from a folder (Chromium) or a signed
// .xpi (Firefox), and a browser will not let a page navigate to chrome://extensions or
// about:addons — so the honest affordances are "open the folder for me" and "open the add-on
// file for me", with the address copied for the user to paste.
function extensionDir() {
  // Packaged: shipped beside the app. Dev: the build output.
  const packaged = path.join(resourcesPath() || "", "extension", "dist");
  return fs.existsSync(packaged) ? packaged : path.join(appRoot, "extension", "dist");
}
function signedXpi() {
  for (const dir of [path.join(resourcesPath() || "", "extension", "signed"), path.join(appRoot, "extension", "signed")]) {
    try {
      // NEWEST, not first: signing bumps the version and leaves the old .xpi behind, and
      // readdir order is arbitrary — see newestXpi's note.
      const hit = newestXpi(fs.readdirSync(dir));
      if (hit) return path.join(dir, hit);
    } catch {
      /* not there */
    }
  }
  return null;
}
ipc.handle("capture:extensionInfo", () => ({ dir: extensionDir(), hasDir: fs.existsSync(extensionDir()), xpi: signedXpi() }));
ipc.handle("capture:revealExtension", () => {
  const dir = extensionDir();
  if (!fs.existsSync(dir)) return { error: "the extension folder isn't in this build" };
  shell.showItemInFolder(path.join(dir, "manifest.json"));
  return { ok: true };
});
ipc.handle("capture:installXpi", async () => {
  const xpi = signedXpi();
  if (!xpi) return { error: "the signed add-on isn't bundled in this build yet" };
  // openPath hands the file to whatever the OS registered for `.xpi`. macOS registers NOTHING
  // — Launch Services answers "there is no application set to open the file" — and Linux and
  // Windows only sometimes do, depending on how Firefox was installed. So a failure here is the
  // NORMAL case on a Mac, not an exception, and reporting it as an error left the one browser
  // that needs a signed add-on with no working route at all.
  //
  // Falling back to revealing the file is the same honest move the Chromium column already
  // makes: Flux cannot drive about:addons from outside (browsers refuse that deliberately), so
  // it puts the file in front of you and hands you the address to paste.
  // And it does not always ANSWER. macOS fails fast with a message; Linux hands off to the
  // desktop's opener, which for an unregistered type can sit there indefinitely (measured: no
  // answer after 6s for a .xpi). An await with no bound is a button that does nothing at all,
  // forever, with no way for the panel to say so — so the wait is bounded and the fallback is
  // identical either way.
  const outcome = await Promise.race([
    shell.openPath(xpi).then((err) => (err ? "failed" : "opened")),
    new Promise((r) => setTimeout(() => r("no-answer"), 2500)),
  ]);
  if (outcome === "opened") return { ok: true };
  shell.showItemInFolder(xpi);
  return { revealed: true, path: xpi };
});

  return {captureDir,
    registerHandlers(target) {if(registered)throw new Error("Capture handlers already registered");registered=true;for(const [channel,handler] of registrations)target.handle(channel,(...args)=>{if(disposed)throw new Error("Capture family disposed");return handler(...args);});},
    async dispose(){disposed=true;await intakeInFlight?.catch(()=>{});},
  };
}
module.exports={createCaptureFamily};
