# Galadriel

> El Espejo muestra lo que es, lo que fue y lo que puede ser.

Galadriel indexa un repositorio en tu máquina y se lo sirve a Cursor por MCP. Responde tres preguntas sin llamar a ningún modelo: **dónde está** algo (`search`), **qué toca** un archivo (`relate`) y **qué se rompe** si lo cambio (`impact`). El razonamiento lo pone el modelo que Cursor ya usa.

Nada sale de la máquina. No hay telemetría. El índice vive en `.galadriel/espejo.db` dentro del repo.

## Qué hace

| Comando | Qué devuelve |
|---|---|
| `galadriel scan [dir]` | Indexa código, docs y configuración. Incremental por hash; si el mismo contenido cambia de ruta, las aristas lo siguen. `--full` reindexa todo. |
| `galadriel search <consulta>` | Fragmentos ordenados por relevancia (SQLite FTS5, bm25, sin acentos). |
| `galadriel relate <ruta>` | Qué importa ese archivo y quién lo importa. |
| `galadriel impact <ruta>` | Dependientes por niveles hasta `--depth`. |
| `galadriel graph [ruta]` | Mermaid del grafo. Sin ruta, todas las aristas. Con ruta, el vecindario hasta `--depth` (1 por defecto). `--modules` agrupa por módulo Java (`module-info.java`) o por proyecto .NET (`.csproj`). `A --> B` significa que A depende de B. |
| `galadriel cycles` | Ciclos de imports. `--modules` los muestra entre módulos Java o proyectos .NET. |
| `galadriel unused` | Código que nadie importa. Omite entradas: `Program`, `*Activity`, `*Controller`, `*Resource`, `*Application`, `*Test`. |
| `galadriel watch [dir]` | Vuelve a indexar al guardar. Ctrl+C deja el índice al día. |
| `galadriel lsp` | Servidor LSP por stdio. Ir a la definición y buscar referencias, archivo por archivo, con las aristas del índice. |
| `galadriel advisories` | Compara `package.json`, `pom.xml` y `.csproj` con `.galadriel/advisories.json` (o `--catalog`). Sin red. Si no hay catálogo, lo dice y no inventa CVEs. Solo coincide una versión declarada tal cual, no un rango como `^1.2.3` ni `${propiedad}`. |
| `galadriel stats` | Archivos, fragmentos y aristas en el índice. |
| `galadriel serve` | Servidor MCP por stdio con las mismas herramientas. |

Grafo: imports relativos en JS/TS; en Java y Kotlin, `import`, el mismo paquete, las funciones de primer nivel y módulos anidados; en C#, `using`, el mismo namespace y los `service`/`message` de un `.proto` con `csharp_namespace`; en Markdown, un enlace relativo a un archivo del repo. Un enlace `http` no crea arista. Así un agente ve que `audit/log.ts` lee la sesión antes de tocar `session.ts`, y que una guía apunta a otra.

## Requisitos

Node 22 o superior. El índice usa `better-sqlite3`, que trae SQLite con FTS5 compilado y binarios listos para macOS, Linux y Windows.

## Instalar

```bash
git clone git@github.com:joedayz/galadriel.git
cd galadriel
npm install
npm run build
npm link        # deja `galadriel` en el PATH
```

## Usar en un repo

```bash
cd ~/proyectos/mi-api
galadriel scan
galadriel search "login session cookie"
galadriel relate src/auth/session.ts
galadriel impact src/auth/session.ts --depth 3
```

## Conectar a Cursor

En la configuración de MCP de Cursor (`.cursor/mcp.json` del proyecto o el global):

```json
{
  "mcpServers": {
    "galadriel": {
      "command": "node",
      "args": [
        "/ruta/absoluta/a/galadriel/dist/cli.js",
        "serve",
        "--workspace",
        "/ruta/absoluta/a/mi-api"
      ]
    }
  }
}
```

Corre `galadriel scan` antes, o agrega el scan al hook `sessionStart` de [Gandalf](https://github.com/joedayz/gandalf).

## Con KCP

Galadriel no reemplaza el `knowledge.yaml`. El índice responde dónde está algo; el manifiesto dice para qué sirve y hasta dónde puede actuar el agente. Usa los dos: Galadriel para descubrir, [KCP](https://github.com/Cantara/knowledge-context-protocol) para declarar.

## Desarrollo

```bash
npm run dev -- scan .
npm test
```

## Qué no hace

No llama a modelos. No genera resúmenes. No manda nada a ningún lado. Si algún día hace falta una pregunta en lenguaje natural, va en una herramienta aparte y con una clave que tú pongas.

## Licencia

Apache 2.0. Ver `LICENSE` y `NOTICE`. Implementación independiente; la idea de un índice local para agentes viene de proyectos como Synthesis y del Knowledge Context Protocol, ambos Apache 2.0.
