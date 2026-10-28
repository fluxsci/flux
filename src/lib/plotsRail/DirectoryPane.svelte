<script lang="ts">
  import { fileBridge, joinPath } from "../project/types";
  import { isReservedPlotDirName } from "../project/plotsFolders";
  let { base, selected = "", onChoose, onClose }: { base: string; selected?: string; onChoose: (folder: string) => void; onClose: () => void } = $props();
  type Folder = { rel: string; name: string; depth: number };
  let folders = $state.raw<Folder[]>([]), search = $state(""), error = $state(""), loading = $state(false);
  let collapsed = $state.raw(new Set<string>()), focus = $state(""), revision = $state(0);
  let input = $state<HTMLInputElement>();
  let viewport = $state<HTMLDivElement>();
  let viewportHeight = $state(300), scrollTop = $state(0);
  const order = new Intl.Collator(undefined, { numeric:true, sensitivity:"base" });
  $effect(() => {
    const root = base; revision;
    let alive = true;
    folders = []; error = "";
    if (!root) return;
    loading = true;
    void (async () => {
      const out: Folder[] = [{ rel:"", name: root.split(/[\\/]/).pop() || "plots", depth:0 }];
      const todo = [""];
      const fb = fileBridge();
      if (!fb?.readdir) throw new Error("Folder navigation needs the desktop app");
      while (todo.length && alive) {
        const rel = todo.shift()!;
        const entries = await fb.readdir(rel ? joinPath(root, rel) : root, true);
        for (const entry of entries.filter(e => e.dir && !isReservedPlotDirName(e.name) && !e.name.startsWith(".") && !/[\\/]/.test(e.name)).sort((a,b) => order.compare(a.name,b.name))) {
          const next = rel ? `${rel}/${entry.name}` : entry.name;
          if (out.length >= 20000) throw new Error("More than 20,000 folders — narrow the plot library to browse it");
          out.push({ rel:next, name:entry.name, depth:next.split("/").length }); todo.push(next);
        }
      }
      out.sort((a,b) => { const aa=a.rel.split("/"), bb=b.rel.split("/"); for(let i=0;i<Math.min(aa.length,bb.length);i++) if(aa[i]!==bb[i]) return order.compare(aa[i],bb[i]); return aa.length-bb.length; });
      if (alive) { folders=out; focus=selected; }
    })().catch(e => { if(alive) error=String(e?.message??e); }).finally(() => { if(alive) loading=false; });
    return () => { alive=false; };
  });
  const q = $derived(search.trim().toLocaleLowerCase());
  const parents = $derived(new Set(folders.filter(f => f.rel).map(f => f.rel.includes("/") ? f.rel.slice(0,f.rel.lastIndexOf("/")) : "")));
  const shown = $derived.by(() => {
    const matching = new Set<string>([""]);
    if (q) for (const f of folders) if (f.rel.toLocaleLowerCase().includes(q)) {
      const segments = f.rel.split("/");
      while (segments.length) { matching.add(segments.join("/")); segments.pop(); }
    }
    return folders.filter(f => {
      if(q) return matching.has(f.rel);
      if(!f.rel) return true;
      const parts=f.rel.split("/"); parts.pop();
      if(collapsed.has("")) return false;
      while(parts.length) { if(collapsed.has(parts.join("/"))) return false; parts.pop(); }
      return true;
    });
  });
  const first = $derived(Math.max(0,Math.floor(scrollTop/25)-5));
  const windowed = $derived(shown.slice(first, first+Math.ceil(viewportHeight/25)+10));
  function choose(folder: Folder) { focus=folder.rel; onChoose(folder.rel); viewport?.focus(); }
  function toggle(folder: Folder) { const n=new Set(collapsed); n.has(folder.rel)?n.delete(folder.rel):n.add(folder.rel); collapsed=n; }
  function key(e: KeyboardEvent) {
    if(e.ctrlKey||e.metaKey||e.altKey||e.target===input) return;
    const i=Math.max(0,shown.findIndex(f=>f.rel===focus)), row=shown[i];
    if(!row) return;
    if(e.key==="ArrowDown"||e.key==="ArrowUp") { e.preventDefault(); focus=shown[Math.max(0,Math.min(shown.length-1,i+(e.key==="ArrowDown"?1:-1)))].rel; }
    else if(e.key==="Home"||e.key==="End") { e.preventDefault(); focus=shown[e.key==="Home"?0:shown.length-1].rel; }
    else if(e.key==="Enter"||e.key===" ") { e.preventDefault(); choose(row); }
    else if(e.key==="ArrowRight"&&collapsed.has(row.rel)) { e.preventDefault(); toggle(row); }
    else if(e.key==="ArrowLeft") { e.preventDefault(); if(!collapsed.has(row.rel)&&parents.has(row.rel)) toggle(row); else focus=row.rel.includes("/")?row.rel.slice(0,row.rel.lastIndexOf("/")):""; }
    else if(e.key==="Escape") { e.preventDefault(); if(search) search=""; else onClose(); }
    queueMicrotask(()=>{ if(!viewport) return; const y=shown.findIndex(f=>f.rel===focus)*25; if(y<viewport.scrollTop) viewport.scrollTop=y; else if(y+25>viewport.scrollTop+viewportHeight) viewport.scrollTop=y+25-viewportHeight; });
  }
</script>
<section class="directory" data-plots-directories>
  <header><span>Folders</span><span class="grow"></span><button aria-label="Refresh folders" title="Refresh folders" onclick={()=>revision++}>↻</button><button aria-label="Show dissections" title="Show dissections (Alt+/)" onclick={onClose}>⧉</button></header>
  <input bind:this={input} bind:value={search} aria-label="Search plot folders" placeholder="Find a folder" spellcheck="false" onkeydown={e=>{if(e.key==="ArrowDown"){e.preventDefault();(e.currentTarget.nextElementSibling as HTMLElement)?.focus();}if(e.key==="Escape"){e.preventDefault();search?search="":onClose();}}}/>
  <div class="tree" bind:this={viewport} bind:clientHeight={viewportHeight} role="tree" tabindex="0" aria-label="Plot folders" aria-activedescendant={windowed.some(f=>f.rel===focus)?`plot-folder-${encodeURIComponent(focus)}`:undefined} onkeydown={key} onscroll={()=>scrollTop=viewport?.scrollTop??0}>
    <div class="tree-space" role="none" style:height={`${shown.length*25}px`}>
    {#each windowed as folder, i (folder.rel)}
      {@const children=parents.has(folder.rel)}
      <!-- svelte-ignore a11y_click_events_have_key_events (the parent tree owns keyboard navigation) -->
      <div id={`plot-folder-${encodeURIComponent(folder.rel)}`} class="row" class:selected={selected===folder.rel} class:focused={focus===folder.rel} role="treeitem" aria-level={folder.depth+1} aria-selected={selected===folder.rel} aria-expanded={children?!collapsed.has(folder.rel):undefined} tabindex="-1" style:top={`${(first+i)*25}px`} style:padding-left={`${6+folder.depth*13}px`} onclick={()=>choose(folder)} ondblclick={()=>toggle(folder)}>
        <button class="disclose" tabindex="-1" disabled={!children} aria-label={`${collapsed.has(folder.rel)?"Expand":"Collapse"} ${folder.name}`} onclick={e=>{e.stopPropagation();toggle(folder);}}>{children?(collapsed.has(folder.rel)?"▸":"▾"):""}</button><span>▰</span><span class="name">{folder.name}</span>
      </div>
    {/each}
    </div>
    {#if loading}<p>Reading folders…</p>{/if}{#if error}<p role="alert">{error}</p>{/if}{#if !loading&&q&&shown.length<=1}<p>No matching folders.</p>{/if}
  </div>
</section>
<style>
  .directory { display:flex; flex-direction:column; flex:1; min-height:0; font:11.5px var(--font-ui); background:var(--c-bg-raised); } header{display:flex;align-items:center;height:28px;padding:0 6px 0 8px;border-bottom:1px solid var(--c-line);color:var(--c-tx-muted);font:600 10px var(--font-mono);text-transform:uppercase;letter-spacing:.08em;} .grow{flex:1} button{height:22px;width:22px;padding:0;background:none;border:0;color:var(--c-tx-muted);border-radius:var(--r-ui);cursor:var(--cursor-cross-hover)}button:hover{background:var(--c-surface-2);color:var(--c-tx-hi)}button:disabled{visibility:hidden}input{height:27px;flex-shrink:0;min-width:0;padding:0 8px;border:0;border-bottom:1px solid var(--c-line);outline:0;background:var(--c-bg);color:var(--c-tx);font:11.5px var(--font-mono)}input:focus{border-color:var(--c-accent)}.tree{overflow:auto;flex:1;min-height:0;outline:0}.row{display:flex;align-items:center;gap:5px;height:25px;cursor:var(--cursor-cross-hover);color:var(--c-tx-2)}.row:hover{background:var(--c-surface-2)}.row.selected{background:var(--c-accent-tint);box-shadow:inset 2px 0 var(--c-accent);color:var(--c-tx-hi)}.tree:focus .row.focused{outline:1px solid var(--c-accent);outline-offset:-1px}.name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.disclose{flex:0 0 16px;width:16px}.tree p{padding:8px;color:var(--c-tx-muted);font-size:11px}

  .tree-space { position:relative; min-width:100%; } .tree .row { position:absolute; left:0; right:0; box-sizing:border-box; }
</style>
