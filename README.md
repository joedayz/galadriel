# Galadriel

> El Espejo muestra lo que es, lo que fue y lo que puede ser.

**1.0.0.** Galadriel indexa un repositorio en tu máquina y se lo sirve a Cursor por MCP. Responde tres preguntas sin llamar a ningún modelo: **dónde está** algo (`search`), **qué toca** un archivo (`relate`) y **qué se rompe** si lo cambio (`impact`). El razonamiento lo pone el modelo que Cursor ya usa.

Nada sale de la máquina. No hay telemetría. El índice vive en `.galadriel/espejo.db` dentro del repo. Añade `.galadriel/` al `.gitignore` del proyecto que indexes.

## Comandos

Todos aceptan `--workspace <dir>`. Sin él, trabajan sobre el directorio actual. `scan`, `watch` y `lsp` también aceptan el directorio como primer argumento.

| Comando | Qué devuelve |
|---|---|
| `galadriel scan [dir] [--full]` | Indexa código, docs y configuración. Incremental por SHA1. Si el mismo contenido cambia de ruta y no queda otra copia, las aristas lo siguen. `--full` reindexa todo. Un cambio de formato del índice también reindexa entero. |
| `galadriel search <consulta> [--kind code\|docs\|config] [--limit N]` | Fragmentos ordenados por relevancia (SQLite FTS5, bm25, sin acentos). `--limit` vale 10 si no lo pones. |
| `galadriel relate <ruta>` | Qué importa ese archivo y quién lo importa. Un salto en cada dirección. |
| `galadriel impact <ruta> [--depth N]` | Quién se ve afectado, por niveles. `--depth` vale 3 si no lo pones. |
| `galadriel graph [ruta] [--depth N] [--modules]` | Mermaid. Sin ruta, todas las aristas. Con ruta, el vecindario hasta `--depth` (1 por defecto). `--modules` agrupa por módulo Java o por proyecto .NET. |
| `galadriel cycles [--modules]` | Ciclos de imports. Como mucho 100. `--modules` los muestra entre módulos. |
| `galadriel unused` | Código que nadie importa. Omite entradas cuyo nombre es `Program` o termina en `Activity`, `Controller`, `Resource`, `Application` o `Test`. |
| `galadriel watch [dir]` | Vuelve a indexar al guardar. Ctrl+C deja el índice al día. |
| `galadriel lsp` | Servidor LSP por stdio. Definición y referencias a nivel de archivo. |
| `galadriel advisories [--catalog archivo]` | Compara manifiestos con un catálogo local. Sin red. |
| `galadriel stats` | Archivos, fragmentos y aristas. |
| `galadriel serve` | Servidor MCP por stdio. |

La línea de un scan es `indexados · sin cambios · movidos · quitados · omitidos · ms`.

## Qué entra al índice

Se recorren los archivos de hasta 512 KB. Se ignoran directorios de herramienta y de build: `.git`, `node_modules`, `dist`, `build`, `out`, `.next`, `target`, `coverage`, `.galadriel`, `bin`, `obj`, `testresults`, `packages`, `.vs`, `.synthesis`, `.idea`, `.vscode` y `.gradle`.

| Tipo | Extensiones |
|---|---|
| `code` | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.java` `.kt` `.cs` `.proto` `.go` `.py` `.rb` `.rs` `.php` `.sql` `.sh` |
| `docs` | `.md` `.mdx` `.txt` `.adoc` |
| `config` | `.yaml` `.yml` `.json` `.toml` `.xml` `.properties` `.gradle` `.csproj` `.sln` `.env.example` |

El texto de todos esos archivos se puede buscar. Las aristas salen solo de algunos.

## El grafo

`A --> B` significa que A depende de B. Si varias aristas caen en el mismo par, Mermaid dibuja `==>|n|`.

| Origen | Cómo se arma la arista |
|---|---|
| JS/TS | Import relativo y alias de `paths` en `tsconfig.json` o `jsconfig.json` (un `*` al final). |
| Java | `import`, tipos del mismo paquete, `import …*` si el nombre simple aparece en el archivo, y `requires` de `module-info.java`. |
| Kotlin | Lo mismo que Java, más `import … as`, y funciones, `val` y `var` declarados al inicio de línea. Un método dentro de una clase no entra. En `fun Context.shareText` el nombre indexado es `shareText`. |
| C# | `using` y `global using` del `.csproj` más cercano, y menciones del mismo namespace. |
| `.proto` | `option csharp_namespace` junto con `service`, `message` y `enum`. Un cliente C# que nombra ese tipo apunta al `.proto`. |
| Markdown | Enlace relativo a un archivo que existe, resuelto desde el directorio del `.md`. Un enlace `http`, `https`, `mailto` o un ancla sola no crea arista. El ejemplo dentro de un bloque cercado tampoco. |

Go, Python, Ruby, Rust, PHP, SQL y shell quedan en el índice para buscarlos. No generan aristas de import.

## Módulos

`--modules` agrupa cada archivo por el `module-info.java` de prefijo más largo, o por el `.csproj` del directorio que lo contiene. El nombre del proyecto .NET es el del archivo sin extensión. Lo que queda fuera se agrupa por la primera carpeta. Si dos módulos se llaman igual, el nombre lleva entre paréntesis el primer tramo de su directorio.

## Al guardar

`galadriel watch` observa el árbol, espera un instante y corre el mismo scan incremental. Ignora las escrituras del propio índice. Al parar, indexa una última vez lo que quedó en esa espera.

## Desde el editor

`galadriel lsp` habla JSON-RPC por stdio, con `Content-Length`. Anuncia definición y referencias. Definición son los archivos que este importa. Referencias son los que lo importan. La posición del cursor no se usa: la unidad es el archivo y el rango que devuelve está en cero. El servidor de lenguaje de Java, Kotlin o C# sigue resolviendo el símbolo dentro de un método. Galadriel cubre lo que esos servidores no miran: enlaces de Markdown y archivos fuera del proyecto cargado. No escribe en stdout fuera del protocolo.

Para usarlo, apunta un cliente LSP a `galadriel lsp`.

## Avisos

Lee `dependencies`, `devDependencies`, `optionalDependencies` y `peerDependencies` de cada `package.json` (solo versiones escritas como texto), cada `<dependency>` de `pom.xml` y cada `PackageReference` de un `.csproj`.

El catálogo es `.galadriel/advisories.json`, o el archivo de `--catalog` (relativo al workspace):

```json
{
  "npm": [{ "name": "left-pad", "version": "1.0.0", "id": "AVISO-1", "summary": "opcional" }],
  "maven": [{ "group": "org.example", "name": "lib", "version": "1.2.3", "id": "AVISO-2" }],
  "nuget": [{ "name": "Newtonsoft.Json", "version": "12.0.1", "id": "AVISO-3" }]
}
```

Solo coincide una versión exacta (`1.2.3`). Un rango (`^1.2.3`, `~1.2.3`) o una propiedad Maven (`${lib.version}`) no coincide. Sin catálogo responde `sin catálogo local. No consulto la red ni invento CVEs.` Si el JSON no se puede leer, lo dice y tampoco inventa. Si no hay coincidencias: `sin avisos para las dependencias declaradas`.

## Servidor MCP

`galadriel serve` expone `search`, `relate`, `impact`, `graph`, `cycles`, `unused`, `advisories` y `stats`. `watch` y `lsp` se quedan en la terminal: uno no termina y el otro habla otro protocolo.

En `.cursor/mcp.json` del proyecto, o en el global:

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

## Instalar

El nombre `galadriel` en npm ya está ocupado por otro proyecto. Esta versión se instala desde este repositorio.

```bash
git clone git@github.com:joedayz/galadriel.git
cd galadriel
git checkout v1.0.0
npm install
npm run build
npm link
```

Node 22 o superior. El índice usa `better-sqlite3`, que trae SQLite con FTS5 compilado y binarios para macOS, Linux y Windows. Node trae `node:sqlite`, y esa copia no incluye FTS5.

## Usar en un repo

```bash
cd ~/proyectos/mi-api
galadriel scan
galadriel search "login session cookie"
galadriel relate src/auth/session.ts
galadriel impact src/auth/session.ts --depth 3
galadriel graph src/auth/session.ts --modules
```

## Con KCP

Galadriel no reemplaza el `knowledge.yaml`. El índice responde dónde está algo; el manifiesto dice para qué sirve y hasta dónde puede actuar el agente. Usa los dos: Galadriel para descubrir, [KCP](https://github.com/Cantara/knowledge-context-protocol) para declarar.

## Desarrollo

```bash
npm run dev -- scan .
npm test
npm run build
```

## Qué no hace

- No llama a modelos ni calcula embeddings. Una pregunta en lenguaje natural la responde el modelo de Cursor o Copilot, usando estas herramientas.
- No sale a la red ni consulta bases de avisos.
- No indexa PDF ni video.
- El LSP no baja al símbolo dentro del archivo.
- `unused` puede listar scripts, migraciones o tests cuyo nombre no termina en `Test` (por ejemplo `*IT`), porque nadie los importa y no son entradas.
- No firma planes ni guarda sesiones de agente.

## Licencia

Apache 2.0. Ver `LICENSE` y `NOTICE`. Implementación independiente; la idea de un índice local para agentes viene de proyectos como Synthesis y del Knowledge Context Protocol, ambos Apache 2.0.
