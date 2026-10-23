// Side-effect module: links the editor core into the store (./editorLink). Imported by every
// editor surface (FigureMode, SlideMode, the Inspector, the keymap, the source bridge, the dev
// handle) — never by the app shell, which must not statically reach ops.
import { autoLetterPanels } from "./ops";
import { applySourceUpdates } from "./plot/sourceSync";
import { linkEditorCore } from "./editorLink";

linkEditorCore({ autoLetterPanels, applySourceUpdates });
