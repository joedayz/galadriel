# Correr los tests

```bash
npm test
```

Usa el runner de Node (`node --test`) con `tsx`. Cada test crea un repo temporal en `os.tmpdir()`, lo indexa y lo borra al final.

Éxito: la última línea dice `# fail 0`. Si falla un test de `impact`, revisa primero `importsOf` en `src/scan.ts`: casi siempre es una ruta relativa que no se resolvió.
