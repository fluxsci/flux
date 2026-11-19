"use strict";
// fluximg:* — import a .fluximg bundle into the requesting window's project, read small ranges of its
// files, and discard an unplaced one. The file work is electron/fluximgFiles.cjs; this family adds the
// same per-window checks the model3d family applies: the request's root must be the window's open
// project, and the project must not change (switch, or reopen: watch generation) while the call runs.
// Source folders outside the project need the window's read capability (fsReadGuard), as every other
// renderer-named read does.
const fluximgFiles = require("../fluximgFiles.cjs");

function createFluximgCore({ rootFor, generationFor = rootFor, fsReadGuard }) {
  /** The window's project as of now, and a check that it is still the project the request named. */
  function bind(e, request) {
    const root = rootFor(e), generation = generationFor(e);
    const checkCurrent = () => {
      if (!root || request?.root !== root || e.sender.isDestroyed() || rootFor(e) !== root || generationFor(e) !== generation) {
        throw new Error("The project changed while working on the image");
      }
    };
    checkCurrent();
    return { root, checkCurrent, readGuard: (file) => fsReadGuard(file, e.sender.id) };
  }
  function registerHandlers(ipcMain) {
    ipcMain.handle("fluximg:import", async (e, request) => {
      const { root, checkCurrent, readGuard } = bind(e, request);
      // Only the named fields cross: never a renderer-chosen limit or option.
      return fluximgFiles.importBundle({ root, sourcePath: request.sourcePath, assetId: request.assetId, checkCurrent, readGuard });
    });
    ipcMain.handle("fluximg:read", async (e, request) => {
      const { root, checkCurrent, readGuard } = bind(e, request);
      const bytes = await fluximgFiles.readRange({ root, bundle: request.bundle, path: request.path, offset: request.offset, length: request.length, readGuard });
      // Bytes of a project the window has since left are not handed to it.
      checkCurrent();
      // readRange allocates outside the Buffer pool, so this is normally the buffer itself; the copy is
      // the fallback that keeps the result sized to exactly the bytes read.
      return bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length
        ? bytes.buffer
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    });
    ipcMain.handle("fluximg:discard", async (e, request) => {
      const { root, checkCurrent } = bind(e, request);
      await fluximgFiles.discardBundle({ root, assetId: request.assetId, checkCurrent });
    });
  }
  return { registerHandlers };
}

module.exports = { createFluximgCore };
