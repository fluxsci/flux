"use strict";
const path = require("node:path");
const { createAgentRunner } = require("../agentRunner.cjs");

function createRunnerFamily({ rootForSender, userDataDir, launcher, preferences, runnerOptions = {} }) {
  let runner;
  const owners = new Map();
  function getRunner() {
    return runner ??= createAgentRunner({ ...runnerOptions, userDataDir: userDataDir(), launcher: launcher(), preferences,
      emit(owner, event) { const sender = owners.get(owner); if (sender && !sender.isDestroyed()) sender.send("runner:event", event); } });
  }
  function registerHandlers(ipc) {
    ipc.handle("runner:capabilities", () => getRunner().capabilities());
    ipc.handle("runner:start", async (e, options) => {
      const root = rootForSender(e);
      if (!root || typeof options?.root !== "string" || path.resolve(options.root) !== path.resolve(root)) throw new Error("Ask must use this window's open project");
      if (!owners.has(e.sender.id)) {
        owners.set(e.sender.id, e.sender);
        e.sender.once("destroyed", () => { runner?.cancelOwner(e.sender.id); owners.delete(e.sender.id); });
      }
      const result = await getRunner().start(e.sender.id, options);
      if (e.sender.isDestroyed() || rootForSender(e) !== root) { runner.cancelOwner(e.sender.id); throw new Error("Project changed while starting Ask"); }
      return result;
    });
    ipc.handle("runner:send", (e, options) => getRunner().send(e.sender.id, options));
    ipc.handle("runner:cancel", (e, options) => getRunner().cancel(e.sender.id, options));
  }
  return { registerHandlers, cancelOwner: owner => runner?.cancelOwner(owner), dispose: () => runner?.dispose() };
}
module.exports = { createRunnerFamily };
