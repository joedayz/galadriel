// Recorre el repositorio, trocea cada archivo en fragmentos y extrae aristas de import.
// Determinista. Sin red. Sin modelo.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, dirname, resolve, sep } from "node:path";
import { Store, type Chunk, type Edge } from "./store.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "coverage",
  ".galadriel",
  ".synthesis",
  ".idea",
  ".vscode",
]);

const KIND_BY_EXT: Record<string, string> = {
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".mjs": "code",
  ".cjs": "code",
  ".java": "code",
  ".kt": "code",
  ".go": "code",
  ".py": "code",
  ".rb": "code",
  ".rs": "code",
  ".cs": "code",
  ".php": "code",
  ".sql": "code",
  ".sh": "code",
  ".md": "docs",
  ".mdx": "docs",
  ".txt": "docs",
  ".adoc": "docs",
  ".yaml": "config",
  ".yml": "config",
  ".json": "config",
  ".toml": "config",
  ".env.example": "config",
  ".properties": "config",
  ".xml": "config",
  ".gradle": "config",
};

const MAX_FILE_BYTES = 512 * 1024;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

export interface ScanResult {
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
}

export function scan(root: string, opts: { full?: boolean } = {}): ScanResult {
  const store = new Store(root);
  const result: ScanResult = { indexed: 0, unchanged: 0, removed: 0, skipped: 0 };
  const present = new Set<string>();
  const aliases = readPathAliases(root);

  for (const abs of walk(root)) {
    const rel = toPosix(relative(root, abs));
    const kind = kindOf(rel);
    if (!kind) {
      result.skipped++;
      continue;
    }
    const st = statSync(abs);
    if (st.size > MAX_FILE_BYTES) {
      result.skipped++;
      continue;
    }
    present.add(rel);
    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      result.skipped++;
      present.delete(rel);
      continue;
    }
    const hash = createHash("sha1").update(buf).digest("hex");
    if (!opts.full && store.fileHash(rel) === hash) {
      result.unchanged++;
      continue;
    }
    const text = buf.toString("utf8");
    const chunks = chunk(rel, kind, text);
    const edges = kind === "code" ? importsOf(root, rel, text, aliases) : [];
    store.replaceFile(
      { path: rel, kind, size: st.size, mtime: Math.floor(st.mtimeMs), hash },
      chunks,
      edges,
    );
    result.indexed++;
  }

  result.removed = store.removeMissing(present);
  store.close();
  return result;
}

export function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

export function kindOf(rel: string): string | undefined {
  const base = rel.split("/").pop() ?? rel;
  if (/^(README|CHANGELOG|LICENSE|NOTICE|AGENTS|CLAUDE)(\..*)?$/i.test(base)) return "docs";
  if (base === "knowledge.yaml") return "config";
  if (base === "Dockerfile" || base === "Makefile") return "config";
  const ext = extname(base).toLowerCase();
  return KIND_BY_EXT[ext];
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 2048);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function chunk(path: string, kind: string, text: string): Chunk[] {
  const out: Chunk[] = [];
  if (text.length <= CHUNK_CHARS) {
    out.push({ path, ordinal: 0, kind, content: text });
    return out;
  }
  let start = 0;
  let ordinal = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    // Cortar en salto de línea si hay uno cerca, para no partir una línea por la mitad.
    const nl = text.lastIndexOf("\n", end);
    if (nl > start + CHUNK_CHARS / 2) end = nl + 1;
    out.push({ path, ordinal: ordinal++, kind, content: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return out;
}

// Imports relativos en JS/TS y imports de paquete en Java. Lo justo para un grafo útil.
const JS_IMPORT = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const JAVA_IMPORT = /^import\s+(?:static\s+)?([\w.]+)\s*;/gm;
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// Alias de tsconfig/jsconfig `paths`, p. ej. "@/*": ["./*"]. Solo el patrón con un `*` final.
export type PathAliases = { prefix: string; targets: string[] }[];

export function readPathAliases(root: string): PathAliases {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1");
      const json = JSON.parse(raw) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const baseUrl = json.compilerOptions?.baseUrl ?? ".";
      const paths = json.compilerOptions?.paths ?? {};
      const out: PathAliases = [];
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!pattern.endsWith("*")) continue;
        out.push({
          prefix: pattern.slice(0, -1),
          targets: targets.map((t) => join(baseUrl, t.replace(/\*$/, ""))),
        });
      }
      return out;
    } catch {
      return [];
    }
  }
  return [];
}

export function importsOf(root: string, rel: string, text: string, aliases: PathAliases = []): Edge[] {
  const edges: Edge[] = [];
  const ext = extname(rel).toLowerCase();
  if (JS_EXTS.includes(ext)) {
    for (const m of text.matchAll(JS_IMPORT)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      let target: string | undefined;
      if (spec.startsWith(".")) {
        target = resolveJs(root, rel, spec);
      } else {
        const alias = aliases.find((a) => spec.startsWith(a.prefix));
        if (alias) {
          const rest = spec.slice(alias.prefix.length);
          for (const t of alias.targets) {
            target = resolveJs(root, ".", "./" + join(t, rest));
            if (target) break;
          }
        }
      }
      if (target) edges.push({ from: rel, to: target, type: "imports" });
    }
  } else if (ext === ".java") {
    for (const m of text.matchAll(JAVA_IMPORT)) {
      const target = resolveJava(root, m[1]);
      if (target) edges.push({ from: rel, to: target, type: "imports" });
    }
  }
  return edges;
}

function resolveJs(root: string, fromRel: string, spec: string): string | undefined {
  const base = resolve(root, dirname(fromRel), spec.replace(/\.js$/, ""));
  if (!base.startsWith(resolve(root))) return undefined;
  const candidates = [
    ...JS_EXTS.map((e) => base + e),
    ...JS_EXTS.map((e) => join(base, "index" + e)),
    base,
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return toPosix(relative(root, c));
  }
  return undefined;
}

function resolveJava(root: string, fqcn: string): string | undefined {
  const parts = fqcn.split(".");
  // Quitar un posible miembro estático: a.b.C.METHOD → a.b.C
  for (let n = parts.length; n >= 2; n--) {
    const relPath = parts.slice(0, n).join("/") + ".java";
    for (const srcRoot of ["src/main/java", "src/test/java", "src", ""]) {
      const c = join(root, srcRoot, relPath);
      if (existsSync(c)) return toPosix(relative(root, c));
    }
  }
  return undefined;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}
