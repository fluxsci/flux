// WS4 — wire the renderer half of the live agent bridge: push an AppContext
// snapshot to the main process whenever the relevant UI state changes (debounced),
// and answer dispatch requests by running the allow-listed command and replying.
// No-ops unless running under Electron with the bridge preload (so dev/web are
// unaffected).

import { get, type Readable } from "svelte/store";
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
  embeddedProjectRoot,
} from "../store";
import { getAppContext } from "./appContext";
import { dispatchCommand, captureDispatchOwner, type Command } from "./commands";
import { touchActivityLock } from "./activityLock";
import { flushByIdChecked, flushOwnerRevision } from "../../shell/lifecycle";
import { currentProject, view } from "../../shell/shellStore";
import { focusedMode, focusedPaneId } from "../../shell/paneStore";
import { storeTenant, storeTenantState } from "../tenancy";
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
    currentProject, view, focusedMode, focusedPaneId, embeddedProjectRoot,
    storeTenantState, flushOwnerRevision,
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

  let pending: Promise<unknown> = Promise.resolve();
  bridge.onDispatch(({ id, command }) => {
    // Capture on receipt, not when the queue eventually starts.
    let assertOwner: () => void;
    try { assertOwner = captureDispatchOwner(); }
    catch (error) { bridge.reply(id, undefined, String(error)); return; }
    const tenant = storeTenant();
    pending = pending.catch(() => {}).then(async () => {
      let applied = false;
      try {
        assertOwner();
        const assertPersistenceOwner = captureDispatchOwner({ allowEdits: true });
        const result = await dispatchCommand(command as Command);
        applied = true;
        assertPersistenceOwner();
        const saved = await flushByIdChecked(tenant);
        if (!saved.ok) throw new Error(`applied-but-unsaved: ${saved.failed.join(', ')}; do not repeat the mutation, retry saving`);
        bridge.reply(id, result);
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        bridge.reply(id, undefined, applied ? (message.startsWith('applied-but-unsaved:') ? message : `applied-but-unsaved: ${message}`) : (message.startsWith('not-applied:') ? message : `not-applied: ${message}`));
      }
    });
  });

  push(); // initial snapshot
}
