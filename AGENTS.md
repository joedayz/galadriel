# Para agentes que trabajan en este repo

Antes de buscar archivos, lee `knowledge.yaml` y elige la unidad por su `intent`.

Reglas del proyecto:

- Nada de red ni de modelos dentro de `src/`. Galadriel es determinista.
- El índice es `better-sqlite3` con FTS5. Node 22 trae `node:sqlite` sin FTS5; por eso no se usa.
- Los cambios en `src/scan.ts` que toquen `importsOf` necesitan un test en `test/scan.test.ts`.
- Mensajes para personas en español. Identificadores en inglés.
- No añadas dependencias sin decirlo: hoy son `@modelcontextprotocol/sdk`, `better-sqlite3` y `zod`.
