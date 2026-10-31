#!/usr/bin/env node
// galadriel — el Espejo del repositorio.
//   galadriel scan [dir] [--full]       indexa (incremental por defecto)
//   galadriel search <consulta> [--kind code|docs|config] [--limit N]
//   galadriel relate <ruta>
//   galadriel impact <ruta> [--depth N]
//   galadriel stats
//   galadriel serve [--workspace dir]   servidor MCP por stdio para Cursor

import { resolve } from "node:path";
import { scan } from "./scan.js";
import { Store } from "./store.js";
import { impact } from "./graph.js";
import { serve } from "./mcp.js";

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
  const depth = Number(flag("depth") ?? 3);
  const root = resolve(workspace ?? (cmd === "scan" && rest[0] ? rest[0] : process.cwd()));

  switch (cmd) {
    case "scan": {
      const t0 = Date.now();
      const r = scan(root, { full });
      console.log(
        `indexados ${r.indexed} · sin cambios ${r.unchanged} · quitados ${r.removed} · omitidos ${r.skipped} · ${Date.now() - t0} ms`,
      );
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
    case "stats": {
      const store = new Store(root);
      const s = store.stats();
      console.log(`archivos ${s.files} · fragmentos ${s.chunks} · aristas ${s.edges}`);
      store.close();
      return;
    }
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
