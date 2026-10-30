// Real keyboard edit → FigureMode's 700ms autosave → bridge watch echo.
import { launch, gotoApp, clickMode, APP_URL, realErrors, shot, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-fig-edit-echo');
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 1800 });
  await clickMode(page, 'Figure');
  await page.waitForSelector('[data-editor-element-id="el-a-rect"]');
  await page.evaluate(async () => {
    const { figRevision } = await import('/src/shell/scholar/revisions.ts');
    window.__echoBumps = [];
    figRevision.subscribe(n => window.__echoBumps.push(n));
    const bridge = window.fig, root = window.__flux.get(window.__flux.shell.projectModel).root;
    const write = bridge.writeText.bind(bridge);
    window.__echoRoot = root;
    bridge.writeText = async (path, text) => {
      await write(path, text);
      if (path.startsWith(root + '/fig/')) {
        // Native writes can create .bak siblings too, with their own watch event.
        await write(path + '.bak', text);
        window.__echoPath = path + '.bak';
        if (!window.__echoTimer) window.__echoTimer = setTimeout(() => {
          window.__echoTimer = null;
          bridge._emitFsChange({ subsystem: 'fig', path: window.__echoPath });
        }, 200); // native watcher coalesces the latest path per subsystem
      }
    };
  });
  const box = await page.$eval('[data-editor-element-id="el-a-rect"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(box.x, box.y);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => !window.__flux.get(window.__flux.fig.dirty) && window.__echoBumps.length > 1);
  await sleep(800); // include every watcher callback after the debounce
  const own = await page.evaluate(() => window.__echoBumps.at(-1) - window.__echoBumps[0]);
  h.eq(own, 1, 'one keyboard autosave increments figRevision exactly once; watcher adds zero');
  await shot(page, 'fig-edit-echo-saved');
  await page.evaluate(async () => {
    const path = window.__echoRoot + '/fig/canvases/canvas-1.json';
    const canvas = JSON.parse(await window.fig.readText(path));
    canvas.figures[0].elements.find(e => e.id === 'el-a-rect').fill = '#765432';
    // An external process does not use the app write adapter.
    window.fig._files.set(path, new TextEncoder().encode(JSON.stringify(canvas)));
    window.fig._emitFsChange({ subsystem: 'fig', path });
  });
  await page.waitForFunction(() => window.__flux.get(window.__flux.fig.project).figures[0].elements.find(e => e.id === 'el-a-rect').fill === '#765432');
  await sleep(300);
  h.eq(await page.evaluate(() => window.__echoBumps.at(-1) - window.__echoBumps[0]), 2, 'same path externally rewritten increments once and reloads the editor');
  await shot(page, 'fig-edit-echo-external');
  // QA-P4: the native watcher coalesces a flush window into ONE fs:changed event
  // (latest path wins; `paths` lists all of them). An own write landing last in
  // that window must not mask an external change made in the same window.
  const rect = await page.$eval('[data-editor-element-id="el-a-rect"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const before = await page.evaluate(() => window.__echoBumps.length);
  await page.mouse.click(rect.x, rect.y);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(n => !window.__flux.get(window.__flux.fig.dirty) && window.__echoBumps.length > n, {}, before);
  await sleep(800); // the own-save echo (latest path = our .bak) has been judged
  const ownBumps = await page.evaluate(() => window.__echoBumps.at(-1) - window.__echoBumps[0]);
  await page.evaluate(async () => {
    const path = window.__echoRoot + '/fig/canvases/canvas-1.json';
    const canvas = JSON.parse(await window.fig.readText(path));
    canvas.figures[0].elements.find(e => e.id === 'el-a-rect').fill = '#123456';
    window.fig._files.set(path, new TextEncoder().encode(JSON.stringify(canvas)));
    window.fig._emitFsChange({ subsystem: 'fig', path: window.__echoPath, paths: [path, window.__echoPath] });
  });
  await page.waitForFunction(() => window.__flux.get(window.__flux.fig.project).figures[0].elements.find(e => e.id === 'el-a-rect').fill === '#123456', { timeout: 4000 }).catch(() => {});
  await sleep(300);
  h.ok(await page.evaluate(() => window.__flux.get(window.__flux.fig.project).figures[0].elements.find(e => e.id === 'el-a-rect').fill === '#123456'), 'an external change coalesced with a later own write still reloads the editor');
  h.eq(await page.evaluate(() => window.__echoBumps.at(-1) - window.__echoBumps[0]), ownBumps + 1, 'the coalesced event increments figRevision once');
  h.eq(realErrors(page).length, 0, 'console clean');
} finally { await browser.close(); }
await h.done();
