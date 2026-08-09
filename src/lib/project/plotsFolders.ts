// Typed re-export of the shared reserved-plots-folder rules. The rules themselves live in
// electron/plotsFolders.js — see that file for why they sit outside src/ (the Electron main
// process prunes its watch with the SAME module the Plot Importer hides rows with, so the
// two can never drift apart).
export {
  LIGHTTABLE_DIRNAME,
  LIGHTTABLE_REL,
  RESERVED_PLOT_FOLDERS,
  RESERVED_PLOT_DIRNAMES,
  isReservedPlotDirName,
  isLighttableProjectRel,
  reservedRootOfPlotsRel,
} from "../../../electron/plotsFolders.js";
export type { ReservedPlotFolder } from "../../../electron/plotsFolders.js";
