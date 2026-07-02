// WS4 — wire the renderer half of the live agent bridge: push an AppContext
// snapshot to the main process whenever the relevant UI state changes (debounced),
// and answer dispatch requests by running the allow-listed command and replying.
// No-ops unless running under Electron with the bridge preload (so dev/web are
// unaffected).

import type { Readable } from "svelte/store";
import {
  project,
  selection,
  partSelection,
  activeFigureId,
  selectedFrameId,
  activeCanvasId,
  viewport,
  hoverId,
  dirty,
} from "../store";
import { getAppContext } from "./appContext";
import { dispatchCommand, type Command } from "./commands";
import { touchActivityLock } from "./activityLock";
import { flushById } from "../../shell/lifecycle";
import { fileBridge } from "../project/types";

export function installBridge(): void {
  // SHL-16: the live bridge (window.fig.bridge) is typed centrally on FileBridge (LiveBridge).
  const bridge = fileBridge()?.bridge;
  if (!bridge) return; // only under Electron + the bridge preload

  // WS6/W3: hold the advisory "project" activity lock while the human is
  // actively editing figures (grace-windowed + heartbeat-restamped), so a
  // concurrent agent/CLI file-write defers instead of clobbering — while an
  // idle-open app never locks agents out.
  dirty.subscribe((d) => {
    if (d) touchActivityLock("project");
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    try {
      bridge.pushContext(getAppContext());
    } catch {
      /* never let context push break the app */
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(push, 120);
  };

  const watched: Readable<unknown>[] = [
    project,
    selection,
    partSelection,
    activeFigureId,
    selectedFrameId,
    activeCanvasId,
    viewport,
    hoverId,
  ];
  for (const s of watched) s.subscribe(() => schedule());

  bridge.onDispatch(async ({ id, command }) => {
    try {
      // `command` arrives as untyped JSON off the loopback wire; narrow it here.
      const result = await dispatchCommand(command as Command);
      // AGT-10: a dispatched edit only reaches disk via the 700ms autosave, so an
      // agent's get_figure_image right after dispatch_command would read stale bytes.
      // Flush the figure subsystem now (no-op for selection-only commands / when the
      // editor isn't mounted) so the on-disk figure reflects the edit before we reply.
      await flushById("figure");
      bridge.reply(id, result);
    } catch (e) {
      bridge.reply(id, undefined, String((e as Error)?.message ?? e));
    }
  });

  push(); // initial snapshot
}
