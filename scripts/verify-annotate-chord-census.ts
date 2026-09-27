// Window key ownership is a source contract: additions fail closed. Run via run-verifies.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const exemptions: Record<string, string> = {
  'src/shell/agent/annotateChord.ts:key': 'Bootstrap owner: captures the chord and buffers typing before the lazy surface mounts.',
  'src/shell/agent/AnnotationSurface.svelte:onKey': 'The annotation modal owns this keymap.',
  'src/shell/modes/paper/margin/DynamicBackground.svelte:yieldToTyping': 'Passive animation observer: pauses background drawing; never consumes or edits input.',
  'src/shell/modes/figure/FigureMode.svelte:handleKey': 'Delegates to lib/keyboard.ts:handleKey, whose guard is checked below.',
};
const local: Record<string, string> = {
  'src/lib/plot/GalleryExpandedPreview.svelte:node': 'Local preview root, beneath the modal.',
  'src/lib/ui/modalFocus.ts:node': 'Local focus trap on its own modal.',
  'src/lib/slide/embedPlayer.ts:host': 'Local Paper slide embed.',
  'src/lib/slide/export/runtime.ts:mount': 'Standalone exported deck; deliberately no app keymap.',
};
const retiredOwners = new Set(['src/shell/agent/annotateChord.ts', 'src/lib/plot/galleryWindow.ts']);
const walkFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkFiles(path.join(dir, e.name)) : /\.(ts|svelte|cjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []);
const inventory: { file: string; line: number; name: string; body: string }[] = [];
const errors: string[] = [];
const used = new Set<string>();
let saveBranches = 0;
for (const file of walkFiles('src').sort()) {
  const raw = readFileSync(file, 'utf8');
  let script = raw;
  if (file.endsWith('.svelte')) {
    const pieces: string[] = []; let offset = 0;
    for (const m of raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      const start = m.index! + m[0].indexOf(m[1]);
      pieces.push(raw.slice(offset, start).replace(/[^\n]/g, ' '), m[1]); offset = start + m[1].length;
    }
    pieces.push(raw.slice(offset).replace(/[^\n]/g, ' ')); script = pieces.join('');
  }
  const ast = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = new Map<string, string>();
  const walk = (n: ts.Node, fn: (n: ts.Node) => void) => { fn(n); ts.forEachChild(n, c => walk(c, fn)); };
  walk(ast, n => {
    if (ts.isFunctionDeclaration(n) && n.name) functions.set(n.name.text, n.getText(ast));
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) functions.set(n.name.text, n.initializer.getText(ast));
  });
  walk(ast, n => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'addEventListener' && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'keydown') {
      const receiver = n.expression.expression.getText(ast), localKey = `${file}:${receiver}`;
      if (local[localKey]) { used.add(localKey); return; }
      let cb = n.arguments[1];
      if (!cb) { errors.push(`${file}: missing key callback`); return; }
      while (ts.isAsExpression(cb) || ts.isParenthesizedExpression(cb)) cb = cb.expression;
      const name = cb.getText(ast);
      inventory.push({ file, line: ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1, name, body: functions.get(name) ?? name });
    }
    if (ts.isIfStatement(n)) {
      const cond = n.expression.getText(ast);
      if (!/(?:\.code\s*===?\s*['"]KeyS['"]|\.key(?:\.toLowerCase\(\))?\s*===?\s*['"][sS]['"])/.test(cond) || !/\bmod\b|ctrlKey|metaKey/.test(cond)) return;
      saveBranches++;
      if (retiredOwners.has(file)) {
        // These are the ONLY explicit swallowers, never save or toggle anything.
        if (!/preventDefault\(\)/.test(n.thenStatement.getText(ast)) || /requestAnnotation|save|flush|onSave/i.test(n.thenStatement.getText(ast))) errors.push(`${file}: retired chord must only be absorbed`);
      } else if (!/!\s*\w+\.shiftKey/.test(cond)) errors.push(`${file}: modified S branch still accepts Shift: ${cond}`);
    }
  });
  for (const m of raw.matchAll(/<svelte:window\b[\s\S]*?\/>/g)) {
    const tag = m[0];
    const attr = tag.match(/on:?keydown(?:capture|\|capture)?\s*=\s*\{\s*([\w$]+)\s*\}/) ?? tag.match(/\{(onkeydown)\}/);
    if (attr) inventory.push({ file, line: raw.slice(0, m.index).split('\n').length, name: attr[1], body: functions.get(attr[1]) ?? '' });
    else if (/on:?keydown/.test(tag)) inventory.push({ file, line: raw.slice(0, m.index).split('\n').length, name: '(inline)', body: tag });
  }
  if (/\bwindow\.onkeydown\s*=/.test(script)) errors.push(`${file}: direct window.onkeydown needs census support`);
  if (/(?:Mod|Ctrl|Cmd)-Shift-[sS]['"]/.test(script)) errors.push(`${file}: retired save key binding`);
}
// Alt+Q was unbound across app and native menus at F1. Reserve the physical
// key in one predicate; future keymaps and native accelerators fail closed.
const chordOwner = 'src/shell/inbox/inboxState.ts';
for (const file of [...walkFiles('src'), ...walkFiles('electron')]) {
  const source = readFileSync(file, 'utf8');
  if (file !== chordOwner && /["']KeyQ["']|(?:Alt|Option)[+-](?:Shift[+-])?[qQ]["']/.test(source) &&
      !['src/lib/Help.svelte', 'src/shell/TitleBar.svelte', 'src/shell/command/globalCommands.ts'].includes(file)) errors.push(`${file}: Inbox chord collision; use isInboxChord`);
  if (/key(?:\.toLowerCase\(\))?\s*={2,3}\s*["'][qQ]["']/.test(source)) errors.push(`${file}: Q key handler needs an explicit Inbox census review`);
}
const chord = readFileSync(chordOwner, 'utf8');
if (!/e\.altKey && !e\.ctrlKey && !e\.metaKey && !e\.shiftKey && e\.code === "KeyQ"/.test(chord)) errors.push('Inbox must remain Alt+Q on the physical left-hand key');
const bootstrap = readFileSync('src/shell/agent/annotateChord.ts', 'utf8');
if (!/if \(isInboxChord\(e\)\) \{[\s\S]*?e\.preventDefault\(\); e\.stopImmediatePropagation\(\)/.test(bootstrap)) errors.push('Inbox chord must be captured before editor key owners');
if (!/isInboxChord\(e\)/.test(readFileSync('src/lib/plot/galleryWindow.ts', 'utf8'))) errors.push('Inert utilities must forward the Inbox chord');
console.log('ANNOTATE CHORD CENSUS — window-level handlers');
for (const item of inventory) {
  const id = `${item.file}:${item.name}`, exemption = exemptions[id];
  console.log(`${item.file}:${item.line} ${item.name}${exemption ? ` [exempt: ${exemption}]` : ''}`);
  if (exemption) used.add(id);
  else if (!/\b(?:yieldsToShellModal|isAnnotateChord)\s*\(/.test(item.body)) errors.push(`${id} does not yield`);
}
const keyboard = readFileSync('src/lib/keyboard.ts', 'utf8');
if (!/function handleKey\([^)]*\)\s*\{\s*if \(yieldsToShellModal\(e\)/.test(keyboard)) errors.push('FigureMode delegated handleKey must guard first');
for (const id of [...Object.keys(exemptions), ...Object.keys(local)]) if (!used.has(id)) errors.push(`Stale census exemption: ${id}`);
if (inventory.length < 30 || saveBranches !== 5) errors.push(`Census extraction drift: ${inventory.length} handlers, ${saveBranches} modified-S branches`);
for (const e of errors) console.error('FAIL:', e);
console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-annotate-chord-census', ok: !errors.length, checks: inventory.length + saveBranches + 1, failed: errors.length })}`);
process.exitCode = errors.length ? 1 : 0;
