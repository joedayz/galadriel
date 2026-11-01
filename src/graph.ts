// Recorrido del grafo de aristas guardado en el almacén, y su dibujo en Mermaid.

import type { Store } from "./store.js";

export interface Arrow {
  from: string;
  to: string;
  weight?: number;
}

export interface JavaModuleRef {
  name: string;
  dir: string;
  info: string;
}

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

// Ciclos simples dirigidos. Cada uno empieza en su nodo menor, así A↔B sale una sola vez.
// Se detiene en 100 para no enumerar un grafo denso hasta el infinito.
export function cycles(edges: Arrow[], limit = 100): string[][] {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    const list = adj.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    adj.set(e.from, list);
  }
  for (const list of adj.values()) list.sort();
  const found: string[][] = [];
  const seen = new Set<string>();
  for (const start of [...nodes].sort()) {
    if (found.length >= limit) break;
    const on = new Set<string>();
    const path: string[] = [];
    const walk = (node: string) => {
      if (found.length >= limit) return;
      on.add(node);
      path.push(node);
      for (const next of adj.get(node) ?? []) {
        if (next < start) continue;
        if (next === start) {
          const key = path.join("\0");
          if (!seen.has(key)) {
            seen.add(key);
            found.push([...path]);
          }
        } else if (!on.has(next)) {
          walk(next);
        }
      }
      path.pop();
      on.delete(node);
    };
    walk(start);
  }
  return found;
}

// Aristas del índice. Con `focus`, solo el vecindario: lo que ese archivo importa
// y quién lo importa, hasta `depth` saltos en cada dirección.
export function graphEdges(store: Store, focus?: string, depth = 1): Arrow[] {
  const all = store.edges();
  if (!focus) return all.map(({ from, to }) => ({ from, to }));
  const nodes = new Set<string>([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const q of [...store.dependenciesOf(p), ...store.dependentsOf(p)]) {
        if (nodes.has(q)) continue;
        nodes.add(q);
        next.push(q);
      }
    }
    frontier = next;
  }
  return all
    .filter((e) => nodes.has(e.from) && nodes.has(e.to))
    .map(({ from, to }) => ({ from, to }));
}

// Junta las aristas de archivos en aristas de módulo.
// Java usa el directorio del module-info. .NET usa el directorio del .csproj.
// Un archivo fuera de ambos se agrupa por su primera carpeta.
export function collapseToModules(edges: Arrow[], modules: JavaModuleRef[]): Arrow[] {
  const labels = moduleLabels(modules);
  const counts = new Map<string, number>();
  for (const e of edges) {
    const from = groupOf(e.from, modules, labels);
    const to = groupOf(e.to, modules, labels);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    counts.set(key, (counts.get(key) ?? 0) + (e.weight ?? 1));
  }
  return [...counts.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split("\0");
      return { from, to, weight };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function moduleLabels(modules: JavaModuleRef[]): Map<string, string> {
  const byName = new Map<string, JavaModuleRef[]>();
  for (const m of modules) {
    const list = byName.get(m.name) ?? [];
    list.push(m);
    byName.set(m.name, list);
  }
  const labels = new Map<string, string>();
  for (const m of modules) {
    const siblings = byName.get(m.name) ?? [];
    const top = m.dir.split("/").find((p) => p.length > 0) ?? m.dir;
    labels.set(m.info, siblings.length > 1 ? `${m.name} (${top})` : m.name);
  }
  return labels;
}

function groupOf(path: string, modules: JavaModuleRef[], labels: Map<string, string>): string | undefined {
  let best: JavaModuleRef | undefined;
  for (const m of modules) {
    if (path === m.info || path.startsWith(m.dir + "/")) {
      if (!best || m.dir.length > best.dir.length) best = m;
    }
  }
  if (best) return labels.get(best.info);
  const top = path.split("/")[0];
  if (!top || top === path) return undefined;
  return top;
}

// `A --> B` significa «A importa B». Los ids son estables: orden alfabético de rutas.
export function toMermaid(edges: Arrow[], extraNodes: string[] = []): string {
  const nodes = new Set<string>(extraNodes);
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }
  if (nodes.size === 0) return "flowchart LR\n%% sin aristas";
  const sortedNodes = [...nodes].sort();
  const id = new Map(sortedNodes.map((p, i) => [p, `n${i}`]));
  const lines = ["flowchart LR"];
  for (const p of sortedNodes) lines.push(`  ${id.get(p)}["${escapeLabel(p)}"]`);
  const seen = new Set<string>();
  for (const e of [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))) {
    const weight = e.weight ?? 1;
    const arrow = weight > 1 ? `==>|${weight}|` : "-->";
    const line = `  ${id.get(e.from)} ${arrow} ${id.get(e.to)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join("\n");
}

// Program, *Activity, *Controller, *Resource, *Application y *Test arrancan el programa.
// Nadie los importa y no son código huérfano.
const ENTRY_STEM = /^(?:Program|.*(?:Activity|Controller|Resource|Application|Test))$/;

export function isEntryPoint(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return ENTRY_STEM.test(stem);
}

export function unused(store: Store): string[] {
  const imported = store.importedPaths();
  return store.codePaths().filter((p) => !imported.has(p) && !isEntryPoint(p));
}

function escapeLabel(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', "#quot;");
}
