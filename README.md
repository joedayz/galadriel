# Galadriel

> El Espejo muestra lo que es, lo que fue y lo que puede ser.

Galadriel indexa un repositorio en tu máquina y se lo sirve a Cursor por MCP. Responde tres preguntas sin llamar a ningún modelo: **dónde está** algo (`search`), **qué toca** un archivo (`relate`) y **qué se rompe** si lo cambio (`impact`). El razonamiento lo pone el modelo que Cursor ya usa.

Nada sale de la máquina. No hay telemetría. El índice vive en `.galadriel/espejo.db` dentro del repo.

## Qué hace

| Comando | Qué devuelve |
|---|---|
| `galadriel scan [dir]` | Indexa código, docs y configuración. Incremental por hash; `--full` reindexa todo. |
| `galadriel search <consulta>` | Fragmentos ordenados por relevancia (SQLite FTS5, bm25, sin acentos). |
| `galadriel relate <ruta>` | Qué importa ese archivo y quién lo importa. |
| `galadriel impact <ruta>` | Dependientes por niveles hasta `--depth`. |
| `galadriel stats` | Archivos, fragmentos y aristas en el índice. |
| `galadriel serve` | Servidor MCP por stdio con las mismas herramientas. |

Grafo de imports: relativos en JS/TS y `import` de paquete en Java. Es lo justo para que un agente vea que `audit/log.ts` lee la sesión antes de tocar `session.ts`.

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
