// Real geometry and pointer interaction: the outline must use the whole rail,
// including after widening, hiding Files, and shrinking/reopening the window.
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-paper-sidebar-layout');
const { browser, page } = await launch();
try {
  await page.setViewport({width:1440,height:1000});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await gotoApp(page,{url:`${APP_URL}?fixture=demo`,settle:800});
  await clickMode(page,'Paper');
  await waitFor(page,()=>!!window.__fluxView);
  await page.evaluate(()=>{
    const headings = Array.from({length:8},(_,i)=>`## A${i+1} — Firing rates across wake, NREM and REM in cortical and subcortical regions\n\n` +
      Array.from({length:5},(_,j)=>`### Analysis ${j+1}: Paired comparisons across subjects and recording sessions\n\nDocument text for the comparison.\n\n`).join('')).join('');
    const v=window.__fluxView;
    v.dispatch({changes:{from:0,to:v.state.doc.length,insert:`---\ntitle: Firing rates across wake, NREM and REM in our data\n---\n\n# Results highlights\n\n${headings}`}});
  });
  await waitFor(page,()=>document.querySelectorAll('.outline .oitem').length>=49,null,{timeout:10000});
  await waitFor(page,async()=>(await window.fig.readText('/demo/myc-growth-paper/manuscript/main.qmd')).includes('Firing rates across wake, NREM and REM in our data'));
  await page.evaluate(()=>window.__fluxEmitFsChange({subsystem:'manuscript',path:'/demo/myc-growth-paper/manuscript/main.qmd'}));
  await waitFor(page,()=>document.querySelector('.dp-item.active')?.textContent.includes('Firing rates across wake, NREM and REM in our data'));
  const geometry=()=>page.evaluate(()=>{
    const rect=s=>document.querySelector(s)?.getBoundingClientRect();
    const rail=rect('.leftrail'), section=rect('.outline-section'), outline=rect('.outline'), editor=rect('.editor-col');
    const list=document.querySelector('.outline');
    return {rail:rail.width,section:section?.width,outline:outline?.width,height:section?.height,outlineHeight:outline?.height,
      editor:editor.width,scrolls:list?.scrollHeight>list?.clientHeight,overflows:list?.scrollWidth>list?.clientWidth,
      pageOverflows:document.documentElement.scrollWidth>innerWidth};
  });
  const paints=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const capture=async name=>{await page.mouse.move(10,10);await shot(page,name);};
  const drag=async width=>{
    const start=await page.$eval('.lr-grip',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
    const before=(await geometry()).rail;
    await page.mouse.move(start.x,start.y);await page.mouse.down();
    await page.mouse.move(start.x+width-before,start.y,{steps:8});await page.mouse.up();await paints();
  };
  // --- the outline is a tree you fold, walk and read (2026-11-18 rebuild) --------------------------
  const outlineState=()=>page.evaluate(()=>{
    const rows=[...document.querySelectorAll('.outline .orow')];
    const first=rows.find(r=>r.querySelector('.caret:not(.spacer)')&&Number(r.querySelector('.oitem').dataset.depth)===1);
    return {count:rows.length,firstText:first?.querySelector('.oitem').textContent.trim(),expanded:first?.querySelector('.caret').getAttribute('aria-expanded'),
      texts:rows.map(r=>r.querySelector('.oitem').textContent.trim()),focus:document.activeElement?.classList.contains('oitem')?document.activeElement.textContent.trim():null};
  });
  let o=await outlineState();
  h.ok(o.count>=49&&o.expanded==='true'&&/^A1 /.test(o.firstText),'sections start unfolded, and a fold control says so (aria-expanded)');
  await page.evaluate(()=>[...document.querySelectorAll('.outline .orow')].find(r=>/^A1 /.test(r.querySelector('.oitem').textContent.trim())).querySelector('.caret').click());
  await paints();o=await outlineState();
  h.ok(o.count===44&&o.expanded==='false','folding a section hides exactly its five subsections');
  // A heading typed ABOVE must not move the fold to another section: folds are remembered by heading, not by position.
  await page.evaluate(()=>{const v=window.__fluxView,at=v.state.doc.toString().indexOf('# Results highlights');v.dispatch({changes:{from:at,insert:'# A new opening section\n\nText.\n\n'}});});
  await waitFor(page,()=>[...document.querySelectorAll('.outline .oitem')].some(e=>e.textContent.trim()==='A new opening section'),null,{timeout:8000});
  await paints();
  const folded=await page.evaluate(()=>[...document.querySelectorAll('.outline .orow')].filter(r=>r.querySelector('.caret:not(.spacer)')?.getAttribute('aria-expanded')==='false').map(r=>r.querySelector('.oitem').textContent.trim()));
  h.ok(folded.length===1&&/^A1 /.test(folded[0]),`after a heading is inserted above, the SAME section is still the folded one (${folded.join(' | ').slice(0,60)})`);
  // Walk it: ↓ / ↑ between the rows on show, → unfolds, ← folds or steps out to the parent.
  await page.evaluate(()=>[...document.querySelectorAll('.outline .oitem')].find(e=>/^A1 /.test(e.textContent.trim())).focus());
  await page.keyboard.press('ArrowDown');o=await outlineState();h.ok(/^A2 /.test(o.focus??''),`ArrowDown steps past a folded section to the next row (${(o.focus??'').slice(0,12)})`);
  await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowRight');await paints();o=await outlineState();
  h.ok(o.expanded==='true'&&/^A1 /.test(o.focus??''),'ArrowRight unfolds the section and keeps the keyboard on it');
  await page.keyboard.press('ArrowRight');o=await outlineState();h.ok(/^Analysis 1/.test(o.focus??''),'ArrowRight again steps into it');
  await page.keyboard.press('ArrowLeft');o=await outlineState();h.ok(/^A1 /.test(o.focus??''),'ArrowLeft on a subsection steps out to its section');
  await page.keyboard.press('ArrowLeft');await paints();o=await outlineState();h.ok(o.expanded==='false','ArrowLeft on an open section folds it');
  await page.keyboard.press('ArrowRight');await paints();
  // One "this one" for both trees: the open document and the caret's section wear the same tint and rail.
  await page.evaluate(()=>{const v=window.__fluxView,at=v.state.doc.toString().indexOf('### Analysis 2');v.dispatch({selection:{anchor:at+6}});v.focus();});
  await waitFor(page,()=>!!document.querySelector('.outline .oitem.active'),null,{timeout:5000});
  await page.mouse.move(10,10);await new Promise(r=>setTimeout(r,220)); // past the 70 ms colour transitions
  const marks=await page.evaluate(()=>{const css=s=>{const c=getComputedStyle(document.querySelector(s));return{bg:c.backgroundColor,rail:c.boxShadow,ink:c.color};};return{doc:css('.dp-item.active'),section:css('.oitem.active'),page:getComputedStyle(document.querySelector('.paper-sidebar')).backgroundColor};});
  h.ok(marks.doc.bg===marks.section.bg&&marks.doc.ink===marks.section.ink&&/inset/.test(marks.doc.rail)&&marks.doc.rail===marks.section.rail,`the open document and the current section share one tint, ink and rail (${marks.doc.bg})`);
  h.ok(marks.doc.bg!==marks.page&&!/^rgb\(32, 94, 166\)$/.test(marks.section.bg),'a tint, never a solid accent block');
  await page.evaluate(()=>{const v=window.__fluxView,doc=v.state.doc.toString(),at=doc.indexOf('# A new opening section');v.dispatch({changes:{from:at,to:doc.indexOf('# Results highlights')}});});
  await waitFor(page,()=>![...document.querySelectorAll('.outline .oitem')].some(e=>e.textContent.trim()==='A new opening section'),null,{timeout:8000});
  await page.mouse.move(10,10);
  let g=await geometry();
  h.ok(Math.abs(g.outline-g.section)<2,'outline fills the default sidebar width');
  h.ok(g.scrolls && !g.overflows,'long nested headings scroll vertically without horizontal overflow');
  await drag(600);g=await geometry();
  h.ok(Math.abs(g.rail-600)<2,`sidebar drags beyond the old 420px limit (actual ${g.rail}px)`);
  h.ok(Math.abs(g.outline-g.section)<2,'outline fills the widened sidebar rather than retaining a fixed flex basis');
  h.ok(g.editor>=420 && !g.pageOverflows,'widening preserves room for the editor without overflowing the window');
  await capture('paper-sidebar-wide');
  await page.click('.sidebar-toolbar button:nth-child(1)');await paints();g=await geometry();
  h.ok(Math.abs(g.outline-g.section)<2 && Math.abs(g.outlineHeight-g.height)<2,'outline-only view fills both dimensions of the sidebar');
  await capture('paper-sidebar-outline-only');
  await page.click('.sidebar-toolbar button:nth-child(1)');await paints();
  await page.setViewport({width:1100,height:800});await paints();g=await geometry();
  h.ok(g.rail<600 && g.editor>=419 && !g.pageOverflows,'a narrower window fits the saved sidebar width around a usable editor');
  h.ok(Math.abs(g.outline-g.section)<2 && !g.overflows,'outline stays aligned and clipped correctly in a narrow window');
  await capture('paper-sidebar-narrow');
  await page.setViewport({width:1800,height:1000});await paints();g=await geometry();
  h.ok(Math.abs(g.rail-600)<2,'widening the window restores the preferred sidebar width');
  await page.evaluate(()=>window.__fluxView.focus());
  await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('b');await page.keyboard.up('Shift');await page.keyboard.up('Control');
  await waitFor(page,()=>!document.querySelector('.dm-wrap'));
  await drag(960);g=await geometry();
  h.ok(Math.abs(g.rail-960)<2 && g.editor>=420,'sidebar can use the extra room when the right margin is hidden');
  h.ok(Math.abs(g.outline-g.section)<2 && !g.overflows,'long headings use the expanded outline width');
  await capture('paper-sidebar-extra-wide');
  const resize=await page.evaluate(async()=>{
    const grip=document.querySelector('.lr-grip'), r=grip.getBoundingClientRect();
    const x=r.x+r.width/2, y=r.y+r.height/2, timings=[];
    grip.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:x,clientY:y}));
    for(const dx of [-20,-10,0,-10,-20,0]) {
      const start=performance.now();
      window.dispatchEvent(new PointerEvent('pointermove',{clientX:x+dx,clientY:y}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      timings.push(performance.now()-start);
    }
    window.dispatchEvent(new PointerEvent('pointercancel'));
    await new Promise(requestAnimationFrame);
    return {max:Math.max(...timings),released:!grip.classList.contains('active') && document.body.style.userSelect===''};
  });
  h.ok(resize.max<100,`sidebar resize paints within 100ms with long headings (max ${resize.max.toFixed(1)}ms)`);
  h.ok(resize.released,'a cancelled pointer gesture releases the grip and text selection');
  await page.reload({waitUntil:'networkidle0'});await clickMode(page,'Paper');
  await waitFor(page,()=>!!document.querySelector('.outline'));await paints();g=await geometry();
  h.ok(Math.abs(g.rail-960)<2,'resized width persists across reopening');
  await page.click('.lr-grip',{count:2});await paints();g=await geometry();
  h.ok(Math.abs(g.rail-280)<2,'double-click restores the default sidebar width');
  h.ok(Math.abs(g.outline-g.section)<2,'outline follows the reset width');
  h.ok(realErrors(page).length===0,`no browser errors: ${realErrors(page).join(' | ')}`);
  await h.done();
} finally { await browser.close(); }
