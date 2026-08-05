// Selection-scoped dictionaries and aliases for Paper. This layer owns the
// compact UI + Vim-proof chords; storage and correction semantics stay in the
// local-correction profile/controller.

import { Facet, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import type { LocalLanguageScope, ResolvedLocalAlias } from "./localCorrectionProfile";

interface WordToolsSelection {
  from: number;
  to: number;
  text: string;
  focusAlias: boolean;
  rev: number;
}

export interface LocalWordToolsSnapshot {
  projectWord: boolean;
  personalWord: boolean;
  aliases: ResolvedLocalAlias[];
}

export interface LocalWordToolsController {
  snapshot(word: string): LocalWordToolsSnapshot;
  toggleWord(word: string, scope: LocalLanguageScope): void;
  setAlias(trigger: string, expansion: string, scope: LocalLanguageScope): void;
  removeAlias(trigger: string, scope: LocalLanguageScope): void;
  notice(message: string): void;
}

const EMPTY_CONTROLLER: LocalWordToolsController = {
  snapshot: () => ({ projectWord: false, personalWord: false, aliases: [] }),
  toggleWord: () => {},
  setAlias: () => {},
  removeAlias: () => {},
  notice: () => {},
};

const wordToolsController = Facet.define<LocalWordToolsController, LocalWordToolsController>({
  combine(values) {
    return values[0] ?? EMPTY_CONTROLLER;
  },
});

const setWordTools = StateEffect.define<WordToolsSelection | null>({
  map(value, changes) {
    if (!value) return null;
    return {
      ...value,
      from: changes.mapPos(value.from, -1),
      to: changes.mapPos(value.to, 1),
    };
  },
});
const refreshWordTools = StateEffect.define<number>();

const WORD_TOKEN = /^[\p{L}\p{M}\d][\p{L}\p{M}\d_'’.-]{0,63}$/u;
const ALIAS_TOKEN = /^[\p{L}\p{M}\d][\p{L}\p{M}\d_-]{0,31}$/u;

function wordToolsTooltip(selection: WordToolsSelection): Tooltip {
  return {
    pos: selection.from,
    end: selection.to,
    above: false,
    strictSide: false,
    arrow: true,
    create(view) {
      const controller = view.state.facet(wordToolsController);
      const snapshot = controller.snapshot(selection.text);
      const dom = document.createElement("div");
      dom.className = "cm-local-word-tools";
      dom.setAttribute("role", "dialog");
      dom.setAttribute("aria-label", `Word tools for ${selection.text}`);
      dom.addEventListener("mousedown", (event) => event.stopPropagation());

      const header = document.createElement("div");
      header.className = "cm-local-word-tools-header";
      const heading = document.createElement("div");
      const title = document.createElement("span");
      title.textContent = "Word tools";
      const term = document.createElement("strong");
      term.textContent = selection.text;
      heading.append(title, term);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "icon";
      close.setAttribute("aria-label", "Close word tools");
      close.textContent = "×";
      close.onclick = () => {
        view.dispatch({ effects: setWordTools.of(null) });
        view.focus();
      };
      header.append(heading, close);

      const label = document.createElement("div");
      label.className = "cm-local-word-tools-label";
      label.textContent = "Recognize spelling";
      const scopeButtons = document.createElement("div");
      scopeButtons.className = "cm-local-word-scopes";
      for (const scope of ["project", "personal"] as const) {
        const active = scope === "project" ? snapshot.projectWord : snapshot.personalWord;
        const button = document.createElement("button");
        button.type = "button";
        button.className = active ? "active" : "";
        button.dataset.wordScope = scope;
        button.setAttribute("aria-pressed", String(active));
        button.textContent = `${active ? "✓ " : "+ "}${scope === "project" ? "Project" : "Personal"}`;
        button.title = active
          ? `Remove “${selection.text}” from the ${scope} dictionary`
          : `Add “${selection.text}” to the ${scope} dictionary`;
        button.onclick = () => controller.toggleWord(selection.text, scope);
        scopeButtons.append(button);
      }

      const aliasLabel = document.createElement("div");
      aliasLabel.className = "cm-local-word-tools-label";
      aliasLabel.textContent = "Expand an alias";
      const form = document.createElement("div");
      form.className = "cm-local-alias-form";
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.maxLength = 32;
      input.placeholder = "Alias, e.g. igf";
      input.setAttribute("aria-label", `Alias for ${selection.text}`);
      const scope = document.createElement("select");
      scope.setAttribute("aria-label", "Alias scope");
      for (const [value, copy] of [["project", "Project"], ["personal", "Personal"]] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = copy;
        scope.append(option);
      }
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Add";
      save.disabled = true;
      const validTrigger = () => {
        const trigger = input.value.trim();
        return ALIAS_TOKEN.test(trigger) && trigger.toLocaleLowerCase() !== selection.text.toLocaleLowerCase();
      };
      const submit = () => {
        const trigger = input.value.trim();
        if (!ALIAS_TOKEN.test(trigger)) {
          controller.notice("Aliases are one word: letters, numbers, underscores, or hyphens.");
          return;
        }
        if (trigger.toLocaleLowerCase() === selection.text.toLocaleLowerCase()) {
          controller.notice("Choose an alias different from the full word.");
          return;
        }
        controller.setAlias(trigger, selection.text, scope.value as LocalLanguageScope);
      };
      input.oninput = () => (save.disabled = !validTrigger());
      input.onkeydown = (event) => {
        event.stopPropagation();
        if (event.key === "Enter" && validTrigger()) {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          view.dispatch({ effects: setWordTools.of(null) });
          view.focus();
        }
      };
      scope.onkeydown = (event) => event.stopPropagation();
      save.onclick = submit;
      form.append(input, scope, save);

      const aliasList = document.createElement("div");
      aliasList.className = "cm-local-alias-list";
      if (!snapshot.aliases.length) {
        const empty = document.createElement("span");
        empty.className = "empty";
        empty.textContent = "No aliases yet";
        aliasList.append(empty);
      } else {
        for (const alias of snapshot.aliases) {
          const row = document.createElement("div");
          row.className = "cm-local-alias-row";
          const copy = document.createElement("span");
          const trigger = document.createElement("strong");
          trigger.textContent = alias.trigger;
          const aliasScope = document.createElement("small");
          aliasScope.textContent = alias.scope === "project" ? "Project" : "Personal";
          copy.append(trigger, aliasScope);
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "icon";
          remove.setAttribute("aria-label", `Remove alias ${alias.trigger}`);
          remove.title = `Remove “${alias.trigger}”`;
          remove.textContent = "×";
          remove.onclick = () => controller.removeAlias(alias.trigger, alias.scope);
          row.append(copy, remove);
          aliasList.append(row);
        }
      }

      dom.append(header, label, scopeButtons, aliasLabel, form, aliasList);
      if (selection.focusAlias) requestAnimationFrame(() => input.focus());
      return { dom };
    },
  };
}

const wordToolsField = StateField.define<WordToolsSelection | null>({
  create: () => null,
  update(value, tr) {
    let next = value;
    if (next && tr.docChanged) {
      const from = tr.changes.mapPos(next.from, -1);
      const to = tr.changes.mapPos(next.to, 1);
      next = tr.newDoc.sliceString(from, to) === next.text ? { ...next, from, to } : null;
    }
    if (next && tr.selection && !tr.selection.eq(tr.startState.selection)) next = null;
    for (const effect of tr.effects) {
      if (effect.is(setWordTools)) next = effect.value;
      else if (effect.is(refreshWordTools) && next) {
        next = { ...next, focusAlias: false, rev: effect.value };
      }
    }
    return next;
  },
  provide: (field) => showTooltip.from(field, (value) => value ? wordToolsTooltip(value) : null),
});

function selectedWord(view: EditorView): WordToolsSelection | null {
  const range = view.state.selection.main;
  if (range.empty) return null;
  let from = range.from;
  let to = range.to;
  while (from < to && /\s/.test(view.state.doc.sliceString(from, from + 1))) from += 1;
  while (to > from && /\s/.test(view.state.doc.sliceString(to - 1, to))) to -= 1;
  const text = view.state.doc.sliceString(from, to);
  return WORD_TOKEN.test(text) ? { from, to, text, focusAlias: false, rev: 0 } : null;
}

export function openLocalWordTools(view: EditorView, focusAlias = false): boolean {
  const selection = selectedWord(view);
  if (!selection) {
    view.state.facet(wordToolsController).notice("Select one word to use Word tools.");
    return true;
  }
  view.dispatch({ effects: setWordTools.of({ ...selection, focusAlias }) });
  return true;
}

export function toggleSelectedLocalWord(view: EditorView, scope: LocalLanguageScope): boolean {
  const selection = selectedWord(view);
  if (!selection) {
    view.state.facet(wordToolsController).notice(`Select one word to change the ${scope} dictionary.`);
    return true;
  }
  view.state.facet(wordToolsController).toggleWord(selection.text, scope);
  return true;
}

export function refreshLocalWordTools(view: EditorView): void {
  const tools = view.state.field(wordToolsField, false);
  if (tools) view.dispatch({ effects: refreshWordTools.of(tools.rev + 1) });
}

export function localWordTools(resolve: () => LocalWordToolsController | null): Extension {
  const keys = Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || !event.altKey || event.getModifierState?.("AltGraph")) return false;
      if (event.code === "KeyK") {
        event.preventDefault();
        toggleSelectedLocalWord(view, event.shiftKey ? "personal" : "project");
        return true;
      }
      if (event.code === "KeyL" && !event.shiftKey) {
        event.preventDefault();
        openLocalWordTools(view, true);
        return true;
      }
      return false;
    },
  }));
  const dismiss = ViewPlugin.define(() => ({}), {
    eventHandlers: {
      mousedown(event, view) {
        if (!view.state.field(wordToolsField, false)) return false;
        const inside = event.target instanceof Element && event.target.closest(".cm-local-word-tools");
        if (!inside) view.dispatch({ effects: setWordTools.of(null) });
        return false;
      },
    },
  });
  return [
    wordToolsField,
    wordToolsController.of({
      snapshot: (word) => resolve()?.snapshot(word) ?? EMPTY_CONTROLLER.snapshot(word),
      toggleWord: (word, scope) => resolve()?.toggleWord(word, scope),
      setAlias: (trigger, expansion, scope) => resolve()?.setAlias(trigger, expansion, scope),
      removeAlias: (trigger, scope) => resolve()?.removeAlias(trigger, scope),
      notice: (message) => resolve()?.notice(message),
    }),
    keys,
    dismiss,
    keymap.of([{
      key: "Escape",
      run(view) {
        if (!view.state.field(wordToolsField, false)) return false;
        view.dispatch({ effects: setWordTools.of(null) });
        return true;
      },
    }]),
  ];
}
