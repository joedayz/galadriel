#!/usr/bin/env node
// galadriel — el Espejo del repositorio.
//   galadriel scan [dir] [--full]       indexa (incremental por defecto)
//   galadriel search <consulta> [--kind code|docs|config] [--limit N]
//   galadriel relate <ruta>
//   galadriel impact <ruta> [--depth N]
//   galadriel graph [ruta] [--depth N] [--modules]  Mermaid; --modules agrupa por módulo Java o .csproj
//   galadriel cycles [--modules]                   ciclos de imports
//   galadriel unused                               código sin dependientes, salvo entradas
//   galadriel watch [dir]                      reindexa al guardar
//   galadriel lsp                              definición y referencias por stdio
//   galadriel advisories [--catalog file]      avisos locales, sin red
//   galadriel stats
//   galadriel serve [--workspace dir]   servidor MCP por stdio para Cursor

import { resolve } from "node:path";
import { formatScan, readModules, scan } from "./scan.js";
import { Store } from "./store.js";
import { collapseToModules, cycles, graphEdges, impact, toMermaid, unused, type Arrow } from "./graph.js";
import { serve } from "./mcp.js";
import { watchWorkspace } from "./watch.js";
import { serveLsp } from "./lsp.js";
import { advise, formatAdvice } from "./advisories.js";

const [, , cmd, ...rest] = process.argv;

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = rest[i + 1];
  rest.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "true";
}

async function main(): Promise<void> {
  const workspace = flag("workspace");
  const full = flag("full") === "true";
  const kind = flag("kind") as "code" | "docs" | "config" | undefined;
  const limit = Number(flag("limit") ?? 10);
  const depth = Number(flag("depth") ?? (cmd === "graph" ? 1 : 3));
  const modules = flag("modules") === "true";
  const catalog = flag("catalog");
  const rooted = cmd === "scan" || cmd === "watch" || cmd === "lsp";
  const root = resolve(workspace ?? (rooted && rest[0] ? rest[0] : process.cwd()));

  switch (cmd) {
    case "scan": {
      const t0 = Date.now();
      const r = scan(root, { full });
      console.log(formatScan(r, Date.now() - t0));
      return;
    }
    case "search": {
      const store = new Store(root);
      const hits = store.search(rest.join(" "), limit, kind);
      for (const h of hits) {
        console.log(`${h.path}#${h.ordinal}  (${h.kind}, ${h.score.toFixed(2)})`);
        console.log(`  ${h.snippet.replace(/\s+/g, " ")}`);
      }
      if (hits.length === 0) console.log("sin resultados");
      store.close();
      return;
    }
    case "relate": {
      const store = new Store(root);
      const p = rest[0];
      console.log(`${p}\n  importa:`);
      for (const d of store.dependenciesOf(p)) console.log(`    → ${d}`);
      console.log(`  lo importan:`);
      for (const d of store.dependentsOf(p)) console.log(`    ← ${d}`);
      store.close();
      return;
    }
    case "impact": {
      const store = new Store(root);
      const levels = impact(store, rest[0], depth);
      if (levels.length === 0) console.log(`nadie importa ${rest[0]}`);
      levels.forEach((paths, i) => {
        console.log(`nivel ${i + 1}:`);
        for (const p of paths) console.log(`  ${p}`);
      });
      store.close();
      return;
    }
    case "graph": {
      const store = new Store(root);
      const focus = rest[0];
      let edges = graphEdges(store, focus, depth);
      if (modules) edges = collapseToModules(edges, readModules(root));
      console.log(toMermaid(edges, modules || !focus ? [] : [focus]));
      store.close();
      return;
    }
    case "cycles": {
      const store = new Store(root);
      let edges: Arrow[] = store.edges();
      if (modules) edges = collapseToModules(edges, readModules(root));
      const found = cycles(edges);
      store.close();
      if (found.length === 0) {
        console.log("sin ciclos");
        return;
      }
      for (const c of found) console.log([...c, c[0]].join(" → "));
      if (found.length === 100) console.log("hay más ciclos; se muestran 100");
      return;
    }
    case "unused": {
      const store = new Store(root);
      const paths = unused(store);
      store.close();
      if (paths.length === 0) {
        console.log("sin código huérfano");
        return;
      }
      for (const p of paths) console.log(p);
      return;
    }
    case "stats": {
      const store = new Store(root);
      const s = store.stats();
      console.log(`archivos ${s.files} · fragmentos ${s.chunks} · aristas ${s.edges}`);
      store.close();
      return;
    }
    case "watch": {
      console.log(`mirando ${root}\nCtrl+C para parar`);
      const handle = watchWorkspace(root, {
        onScan: (r) => console.log(formatScan(r)),
        onError: (err) => console.error(err instanceof Error ? err.message : err),
      });
      await new Promise<void>((resolveStop) => {
        process.once("SIGINT", () => resolveStop());
        process.once("SIGTERM", () => resolveStop());
      });
      await handle.close();
      console.log("índice al día");
      return;
    }
    case "lsp":
      await serveLsp(root, process.stdin, process.stdout);
      return;
    case "advisories":
      console.log(formatAdvice(advise(root, catalog && catalog !== "true" ? catalog : undefined)));
      return;
    case "serve":
      await serve(root);
      return;
    default:
      console.log(
        [
          "galadriel — el Espejo del repositorio",
          "",
          "  galadriel scan [dir] [--full]",
          "  galadriel search <consulta> [--kind code|docs|config] [--limit N]",
          "  galadriel relate <ruta>",
          "  galadriel impact <ruta> [--depth N]",
          "  galadriel graph [ruta] [--depth N] [--modules]",
          "  galadriel cycles [--modules]",
          "  galadriel unused",
          "  galadriel watch [dir]",
          "  galadriel lsp",
          "  galadriel advisories [--catalog file]",
          "  galadriel stats",
          "  galadriel serve [--workspace dir]",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
