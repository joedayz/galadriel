// Servidor MCP por stdio para Cursor. search, relate, impact, graph, cycles, unused, advisories y stats.
// Ninguna llama a un modelo. El razonamiento lo pone el modelo que Cursor ya usa.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "./store.js";
import { collapseToModules, cycles, graphEdges, impact, toMermaid, unused } from "./graph.js";
import { readModules } from "./scan.js";
import { advise, formatAdvice } from "./advisories.js";

export async function serve(root: string): Promise<void> {
  const store = new Store(root);
  const server = new McpServer({ name: "galadriel", version: "1.0.0" });

  server.tool(
    "search",
    "Busca texto en el índice local del repositorio. Devuelve ruta, fragmento y puntaje. Úsala antes de abrir archivos a ciegas.",
    {
      query: z.string().describe("Palabras clave o frase. Ej.: 'login session cookie'"),
      limit: z.number().int().min(1).max(50).default(10),
      kind: z.enum(["code", "docs", "config"]).optional().describe("Filtrar por tipo de archivo"),
    },
    async ({ query, limit, kind }) => {
      const hits = store.search(query, limit, kind);
      const text =
        hits.length === 0
          ? "Sin resultados. Prueba con otras palabras o corre `galadriel scan`."
          : hits
              .map((h) => `${h.path}#${h.ordinal} (${h.kind}, ${h.score.toFixed(2)})\n  ${h.snippet.replace(/\s+/g, " ")}`)
              .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "relate",
    "Qué archivos importa este archivo y quién lo importa a él. Un salto en cada dirección.",
    { path: z.string().describe("Ruta relativa al repositorio, ej.: src/auth/session.ts") },
    async ({ path }) => {
      const deps = store.dependenciesOf(path);
      const dependents = store.dependentsOf(path);
      const text = [
        `${path}`,
        `  importa (${deps.length}):`,
        ...deps.map((d) => `    → ${d}`),
        `  lo importan (${dependents.length}):`,
        ...dependents.map((d) => `    ← ${d}`),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "impact",
    "Si cambio este archivo, qué más se ve afectado. Sigue los dependientes hasta la profundidad indicada.",
    {
      path: z.string(),
      depth: z.number().int().min(1).max(6).default(3),
    },
    async ({ path, depth }) => {
      const levels = impact(store, path, depth);
      const text =
        levels.length === 0
          ? `Nadie importa ${path} según el índice.`
          : levels
              .map((paths, i) => `nivel ${i + 1} (${paths.length}):\n` + paths.map((p) => `  ${p}`).join("\n"))
              .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "graph",
    "Diagrama Mermaid del grafo de imports. Sin ruta, todas las aristas. Con ruta, el vecindario hasta depth. Con modules, agrupa por módulo Java o por proyecto .NET (.csproj). La flecha A --> B significa que A depende de B.",
    {
      path: z.string().optional().describe("Ruta relativa. Si se omite, el grafo entero."),
      depth: z.number().int().min(1).max(6).default(1),
      modules: z.boolean().optional().describe("Agrupar por módulo Java (module-info) o por proyecto .NET (.csproj)."),
    },
    async ({ path, depth, modules }) => {
      let edges = graphEdges(store, path, depth);
      if (modules) edges = collapseToModules(edges, readModules(root));
      return { content: [{ type: "text", text: toMermaid(edges, modules || !path ? [] : [path]) }] };
    },
  );

  server.tool(
    "cycles",
    "Ciclos de imports. Cada línea es un ciclo que vuelve al mismo archivo. Con modules, los ciclos son entre módulos Java o proyectos .NET (.csproj).",
    { modules: z.boolean().optional() },
    async ({ modules }) => {
      let edges = graphEdges(store);
      if (modules) edges = collapseToModules(edges, readModules(root));
      const found = cycles(edges);
      const text = found.length === 0 ? "sin ciclos" : found.map((c) => [...c, c[0]].join(" → ")).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "unused",
    "Archivos de código que nadie importa. Omite entradas: Program, *Activity, *Controller, *Resource, *Application y *Test.",
    {},
    async () => {
      const paths = unused(store);
      const text = paths.length === 0 ? "sin código huérfano" : paths.join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "advisories",
    "Compara package.json, pom.xml y .csproj con un catálogo local. Sin red. Si no hay catálogo, lo dice y no inventa CVEs. Solo coincide la versión declarada tal cual, no un rango.",
    { catalog: z.string().optional().describe("Ruta del JSON. Por defecto .galadriel/advisories.json") },
    async ({ catalog }) => {
      return { content: [{ type: "text", text: formatAdvice(advise(root, catalog)) }] };
    },
  );

  server.tool(
    "stats",
    "Tamaño del índice: archivos, fragmentos y aristas.",
    {},
    async () => {
      const s = store.stats();
      return { content: [{ type: "text", text: `archivos ${s.files} · fragmentos ${s.chunks} · aristas ${s.edges}` }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
