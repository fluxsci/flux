// Typed re-export of the shared dissection rules. The rules themselves live in
// electron/dissectRules.js — see that file for why they sit outside src/ (the Electron main
// process routes watcher events with the SAME module, so the importer's exclusion, the
// watcher's subsystem split, and the viewer's listing can never drift apart).
export {
  DISSECT_DIRNAME,
  DISSECT_REL,
  DISSECT_IMAGE_RE,
  DISSECT_TABLE_RE,
  isDissectDirName,
  isDissectionProjectRel,
  isDissectionPlotsRel,
  plotKeyFor,
  dissectionRootRelFor,
  classifyDissectionFile,
} from "../../../electron/dissectRules.js";
