// Recorrido del grafo de aristas guardado en el almacén.

import type { Store } from "./store.js";

// Dependientes por niveles: nivel 1 son los que importan `path` directamente,
// nivel 2 los que importan a esos, y así hasta `depth`.
export function impact(store: Store, path: string, depth: number): string[][] {
  const seen = new Set<string>([path]);
  const levels: string[][] = [];
  let frontier = [path];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const dep of store.dependentsOf(p)) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        next.push(dep);
      }
    }
    if (next.length === 0) break;
    next.sort();
    levels.push(next);
    frontier = next;
  }
  return levels;
}
