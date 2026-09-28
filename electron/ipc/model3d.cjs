"use strict";
const modelIO = require("../model3dImport.cjs");

function createModel3dCore({ rootFor, generationFor = rootFor, fsReadGuard, noteWrite = () => {} }) {
  const owners = new Map(), prepared = new Map();
  function owner(e) {
    let current = owners.get(e.sender.id);
    if (!current) {
      current = { sender: e.sender };
      owners.set(e.sender.id, current);
      e.sender.once("destroyed", () => {
        owners.delete(e.sender.id);
        for (const [token, item] of prepared) if (item.owner === current) {
          prepared.delete(token);
          // A persisted asset is owned by the document. Unreadable ownership
          // metadata never licenses deleting it.
          void modelIO.cleanupPreparedModel3d(item.owned).catch(() => {});
        }
      });
    }
    return current;
  }
  function receipt(e, request) {
    const item = prepared.get(request?.receipt);
    if (!item || item.owner !== owner(e) || item.root !== request?.root ||
        request?.target?.kind !== "figure" || request?.assetId !== item.owned.result.asset.id) {
      throw new Error("Unknown or already adopted model import receipt");
    }
    return item;
  }
  async function importModel(e, request, dropped = false) {
    const root = rootFor(e), generation = generationFor(e), current = owner(e);
    const checkCurrent = () => {
      if (!root || request?.root !== root || e.sender.isDestroyed() || rootFor(e) !== root || generationFor(e) !== generation) {
        throw new Error("The project changed while importing the model");
      }
    };
    checkCurrent();
    const owned = await modelIO.prepareModel3d({
      root, target: request?.target, sourcePath: request?.sourcePath, checkCurrent,
      // Only importDroppedModel3d(File, ...) in the isolated preload can reach
      // the drop channel; it obtains sourcePath from webUtils, never a caller
      // path string or a renderer-controlled grant flag.
      readGuard: dropped ? () => {} : file => fsReadGuard(file, e.sender.id),
    });
    try {
      checkCurrent();
      prepared.set(owned.result.receipt, { owner: current, root, generation, state: 'pending', owned });
      for (const file of owned.files) noteWrite(file, e.sender.id);
      return owned.result;
    } catch (error) {
      await modelIO.cleanupPreparedModel3d(owned, { checkSaved: false }).catch(() => {});
      throw error;
    }
  }
  function registerHandlers(ipcMain) {
    ipcMain.handle("model3d:import", (e, request) => importModel(e, request));
    ipcMain.handle("model3d:importDropped", (e, request) => importModel(e, request, true));
    ipcMain.handle("model3d:adopt", (e, request) => {
      const item = receipt(e, request);
      if (item.state !== 'pending') throw new Error("This model import was canceled and cannot be adopted");
      // Placement is synchronous in the renderer. Even a late generation
      // rejection must retain those files: a cleanup capability cannot outlive
      // the renderer's valid-receipt attempt to install this asset.
      prepared.delete(request.receipt);
      if (rootFor(e) !== item.root || generationFor(e) !== item.generation) throw new Error("The project changed before adopting the model; its files were retained");
    });
    ipcMain.handle("model3d:discard", async (e, request) => {
      const item = receipt(e, request);
      if (item.state === 'discarding') throw new Error("This model import is already being discarded");
      // Claim deletion before the first await. An adopt can never succeed while
      // an earlier discard is suspended in its saved-ownership read.
      item.state = 'discarding';
      try {
        await modelIO.cleanupPreparedModel3d(item.owned);
        prepared.delete(request.receipt);
      } catch (error) {
        // Some files may already be gone. Cleanup may be retried, but an import
        // whose cancellation started must never become adoptable again.
        if (prepared.get(request.receipt) === item) item.state = 'discard-failed';
        throw error;
      }
    });
    ipcMain.handle("model3d:availability", () => ({ disabled: process.env.FLUX_MODEL3D_DISABLE === "1" }));
  }
  return { registerHandlers, stats: () => ({ pendingImports: prepared.size, owners: owners.size }) };
}
module.exports = { createModel3dCore };
