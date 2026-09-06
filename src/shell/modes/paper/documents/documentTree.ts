import type { DocEntry } from './documents';
import { fileName, parentDir } from '../../../../lib/project/documentFiles';
export interface DocumentTreeItem { path: string; depth: number; doc?: DocEntry }
/** Linear indexing before the sort avoids rescanning all documents per folder. */
export function documentTree(docs: DocEntry[], folders: string[], root: string, context: boolean, collapsed: string[]): DocumentTreeItem[] {
  const base = context ? 'Context' : root;
  const closed = new Set(collapsed);
  if (closed.has(base)) return [];
  const rows = docs.filter(d => !!d.isContext === context);
  const dirs = new Set(folders.filter(p => context ? p.startsWith('Context/') : p !== root && p !== 'Context' && !p.startsWith('Context/')));
  const ranks = new Map<string, number>();
  rows.forEach((d,i) => {
    ranks.set(d.path,i);
    let dir = parentDir(d.path);
    while (dir && dir !== base) {
      dirs.add(dir);
      if (!ranks.has(dir)) ranks.set(dir,i);
      dir = parentDir(dir);
    }
  });
  const children = new Map<string, DocumentTreeItem[]>();
  const add = (parent: string, item: DocumentTreeItem) => {
    if (!children.has(parent)) children.set(parent,[]);
    children.get(parent)!.push(item);
  };
  for(const d of rows) add(parentDir(d.path),{path:d.path,depth:0,doc:d});
  for(const dir of dirs) add(parentDir(dir),{path:dir,depth:0});
  for(const items of children.values()) items.sort((a,b) => (ranks.get(a.path) ?? Infinity) - (ranks.get(b.path) ?? Infinity) || fileName(a.path).localeCompare(fileName(b.path)));
  const out: DocumentTreeItem[] = [];
  const walk = (dir:string,depth:number) => {
    for(const item of children.get(dir) ?? []) {
      if(item.path === base) continue;
      out.push({...item,depth});
      if(!item.doc && !closed.has(item.path)) walk(item.path,depth+1);
    }
  };
  walk(base,0);
  if(!context && base) walk('',0); // registered legacy files outside the default root
  return out;
}
