#!/usr/bin/env node
// Cross-platform tail of `npm run electron:dev`: set VITE_DEV_SERVER_URL and
// launch Electron against the repo root. Exists because the previous inline
// `VITE_DEV_SERVER_URL=… electron .` is POSIX shell syntax — cmd.exe has no
// inline env assignment, which broke the Windows dev loop at this exact spot.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// Under plain Node (not inside Electron) require("electron") resolves to the
// path of the platform's Electron binary — the portable way to find it.
const require = createRequire(import.meta.url);
const electronBin = require("electron");
const root = path.resolve(import.meta.dirname, "..");

const child = spawn(electronBin, ["."], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:1420",
  },
});
child.on("error", (e) => {
  console.error(`electron-dev: ${e.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
