"use strict";
// Packaged Electron always boots package.main, even when given another script.
// Dispatch capture before the editor creates sessions, config or an app lock.
if (process.env.FLUX_SLIDE_VIDEO_WORKER === "1") require("./slideVideoWorker.cjs");
else require("./main.cjs");
