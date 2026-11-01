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
  "bin",
  "obj",
  "testresults",
  "packages",
  ".vs",
  ".synthesis",
  ".idea",
  ".vscode",
  ".gradle",
]);

export function ignoredPath(rel: string): boolean {
  return rel.split(/[/\\]/).some((part) => IGNORED_DIRS.has(part.toLowerCase()));
}

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
  ".proto": "code",
  ".csproj": "config",
  ".sln": "config",
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
// Sube cuando cambia el grafo. Un índice viejo se reindexa entero en el siguiente scan.
const SCAN_VERSION = "8";

export interface ScanResult {
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  moved: number;
}

export function formatScan(r: ScanResult, ms?: number): string {
  const time = ms === undefined ? "" : ` · ${ms} ms`;
  return `indexados ${r.indexed} · sin cambios ${r.unchanged} · movidos ${r.moved} · quitados ${r.removed} · omitidos ${r.skipped}${time}`;
}

export function scan(root: string, opts: { full?: boolean } = {}): ScanResult {
  const store = new Store(root);
  const result: ScanResult = { indexed: 0, unchanged: 0, removed: 0, skipped: 0, moved: 0 };
  const present = new Map<string, PresentFile>();
  const aliases = readPathAliases(root);
  const full = opts.full || store.scanVersion() !== SCAN_VERSION;
  const index = buildCodeIndex(root);

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
    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      result.skipped++;
      continue;
    }
    present.set(rel, {
      rel,
      abs,
      kind,
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
      hash: createHash("sha1").update(buf).digest("hex"),
    });
  }

  const movedTo = new Set<string>();
  if (!full) {
    for (const move of detectMoves(store.fileRecords(), present)) {
      const file = present.get(move.to);
      if (!file) continue;
      store.movePath(move.from, move.to, file);
      const text = readFileSync(file.abs, "utf8");
      store.replaceOutgoing(move.to, importsOf(root, move.to, text, aliases, index));
      movedTo.add(move.to);
      result.moved++;
    }
  }

  for (const file of present.values()) {
    if (movedTo.has(file.rel)) continue;
    if (!full && store.fileHash(file.rel) === file.hash) {
      result.unchanged++;
      continue;
    }
    const text = readFileSync(file.abs, "utf8");
    const chunks = chunk(file.rel, file.kind, text);
    const edges = importsOf(root, file.rel, text, aliases, index);
    store.replaceFile(
      { path: file.rel, kind: file.kind, size: file.size, mtime: file.mtime, hash: file.hash },
      chunks,
      edges,
    );
    result.indexed++;
  }

  result.removed = store.removeMissing(new Set(present.keys()));
  store.setScanVersion(SCAN_VERSION);
  store.close();
  return result;
}

interface PresentFile {
  rel: string;
  abs: string;
  kind: string;
  size: number;
  mtime: number;
  hash: string;
}

// Un archivo desaparecido y uno nuevo con el mismo hash son el mismo archivo.
// Hace falta una sola pareja: dos copias iguales no se reasignan entre sí.
function detectMoves(
  stored: { path: string; hash: string }[],
  present: Map<string, { hash: string }>,
): { from: string; to: string }[] {
  const storedPaths = new Set(stored.map((s) => s.path));
  const disappeared = new Map<string, string[]>();
  const stillThere = new Map<string, number>();
  for (const f of stored) {
    if (present.has(f.path)) {
      stillThere.set(f.hash, (stillThere.get(f.hash) ?? 0) + 1);
      continue;
    }
    const list = disappeared.get(f.hash) ?? [];
    list.push(f.path);
    disappeared.set(f.hash, list);
  }
  const appeared = new Map<string, string[]>();
  for (const [path, file] of present) {
    if (storedPaths.has(path)) continue;
    const list = appeared.get(file.hash) ?? [];
    list.push(path);
    appeared.set(file.hash, list);
  }
  const moves: { from: string; to: string }[] = [];
  for (const [hash, froms] of disappeared) {
    if (froms.length !== 1 || (stillThere.get(hash) ?? 0) > 0) continue;
    const tos = appeared.get(hash) ?? [];
    if (tos.length !== 1) continue;
    moves.push({ from: froms[0], to: tos[0] });
  }
  moves.sort((a, b) => a.from.localeCompare(b.from));
  return moves;
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
      if (IGNORED_DIRS.has(e.name.toLowerCase())) continue;
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

// JS/TS: imports relativos y alias. Java y Kotlin: import, mismo paquete y nombre
// calificado, en cualquier módulo. C#: using y el mismo namespace. Markdown: enlace
// relativo a un archivo del repo. Un enlace externo no crea arista.
const JS_IMPORT = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const JAVA_IMPORT = /^import\s+(?:static\s+)?([\w.]+)\s*;/gm;
const JAVA_IMPORT_ANY = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
const MODULE_DECL = /^\s*(?:open\s+)?module\s+([\w.]+)/m;
const MODULE_REQUIRES = /\brequires\s+(?:(?:transitive|static)\s+)*([\w.]+)\s*;/g;
const CS_USING = /^\s*(global\s+)?using\s+(?:(static)\s+)?(?:([\w.]+)\s*=\s*)?([\w.*]+)\s*;/gm;
const TYPE_DECL = /\b(?:(?:class|interface|struct|object|typealias)\s+|enum(?:\s+class)?\s+|record\s+(?:struct\s+|class\s+)?)(\w+)/g;
const KT_IMPORT = /^\s*import\s+([\w.*]+)(?:\s+as\s+\w+)?\s*$/gm;
const KT_TOP_FUN =
  /^(?:@[^\n]*\n)*(?:(?:public|private|internal|protected|open|abstract|suspend|inline|operator|infix)\s+)*fun(?:\s+<[^>\n]+>)?\s+(?:(?:[\w.]+(?:<[^>\n]*>)?\s*\.\s*)*)([A-Za-z_]\w*)/gm;
const KT_TOP_PROP =
  /^(?:@[^\n]*\n)*(?:(?:public|private|internal|const)\s+)*(?:val|var)\s+(?:(?:[\w.]+(?:<[^>\n]*>)?\s*\.\s*)*)([A-Za-z_]\w*)/gm;
const MD_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const MD_DEF = /^\s{0,3}\[[^\]]+\]:\s+<?([^\s>]+)>?/gm;
const QUALIFIED = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\b/g;
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

interface TypeRef {
  path: string;
  simpleName: string;
}

interface CodeIndex {
  javaByFqcn: Map<string, string>;
  javaByPackage: Map<string, TypeRef[]>;
  csByFqcn: Map<string, string>;
  csByNamespace: Map<string, TypeRef[]>;
  csGlobalUsings: Map<string, string[]>;
  csGlobalTypes: Map<string, string[]>;
  csprojDirs: string[];
  /** Nombre JPMS → rutas de module-info.java */
  modulesByName: Map<string, string[]>;
}

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

export function importsOf(
  root: string,
  rel: string,
  text: string,
  aliases: PathAliases = [],
  index?: CodeIndex,
): Edge[] {
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
  } else if (ext === ".java" || ext === ".kt") {
    if (index) addJvmEdges(rel, text, edges, index, ext === ".kt" ? KT_IMPORT : JAVA_IMPORT_ANY);
    else if (ext === ".java") {
      for (const m of text.matchAll(JAVA_IMPORT)) {
        const target = resolveJava(root, m[1]);
        if (target) edges.push({ from: rel, to: target, type: "imports" });
      }
    }
  } else if (ext === ".cs" && index) {
    addCsEdges(rel, text, edges, index);
  } else if (ext === ".md" || ext === ".mdx") {
    addDocEdges(root, rel, text, edges);
  }
  return edges;
}

function addDocEdges(root: string, rel: string, text: string, edges: Edge[]): void {
  const body = text.replace(/^ {0,3}(`{3,}|~{3,}).*$[\s\S]*?^ {0,3}\1.*$/gm, "");
  const seen = new Set<string>();
  for (const re of [MD_LINK, MD_DEF]) {
    for (const m of body.matchAll(re)) {
      const target = resolveDocLink(root, rel, m[1]);
      if (!target || target === rel || seen.has(target)) continue;
      seen.add(target);
      edges.push({ from: rel, to: target, type: "imports" });
    }
  }
}

function resolveDocLink(root: string, fromRel: string, raw: string): string | undefined {
  let spec = raw.trim();
  try {
    spec = decodeURI(spec);
  } catch {
    return undefined;
  }
  spec = spec.split(/[?#]/)[0];
  if (!spec || /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("//")) return undefined;
  const abs = resolve(root, dirname(fromRel), spec);
  const relTarget = toPosix(relative(root, abs));
  if (!relTarget || relTarget.startsWith("..") || relTarget.split("/").some((p) => IGNORED_DIRS.has(p.toLowerCase()))) {
    return undefined;
  }
  const full = join(root, relTarget);
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  return relTarget;
}

function emptyCodeIndex(): CodeIndex {
  return {
    javaByFqcn: new Map(),
    javaByPackage: new Map(),
    csByFqcn: new Map(),
    csByNamespace: new Map(),
    csGlobalUsings: new Map(),
    csGlobalTypes: new Map(),
    csprojDirs: [],
    modulesByName: new Map(),
  };
}

function buildCodeIndex(root: string): CodeIndex {
  const index = emptyCodeIndex();
  const sources: { rel: string; ext: string; text: string }[] = [];
  for (const abs of walk(root)) {
    const rel = toPosix(relative(root, abs));
    const ext = extname(rel).toLowerCase();
    if (ext === ".csproj") index.csprojDirs.push(dirOf(rel));
    if (ext !== ".java" && ext !== ".kt" && ext !== ".cs" && ext !== ".proto") continue;
    const st = statSync(abs);
    if (st.size > MAX_FILE_BYTES) continue;
    const buf = readFileSync(abs);
    if (looksBinary(buf)) continue;
    sources.push({ rel, ext, text: buf.toString("utf8") });
  }
  for (const s of sources) {
    if (s.ext === ".proto") indexProto(index, s.rel, s.text);
    else if (s.ext === ".java" || s.ext === ".kt") indexJava(index, s.rel, s.text);
    else indexCs(index, s.rel, s.text);
  }
  return index;
}

function indexJava(index: CodeIndex, rel: string, text: string): void {
  const pkg = packageName(text);
  const names = new Set(declaredTypes(text));
  if (rel.endsWith(".kt")) {
    for (const name of kotlinTopFunctions(text)) names.add(name);
    for (const name of text.matchAll(KT_TOP_PROP)) names.add(name[1]);
  }
  for (const name of names) addType(index.javaByFqcn, index.javaByPackage, rel, pkg, name);
  if (isModuleInfo(rel)) {
    const mod = text.match(MODULE_DECL)?.[1];
    if (mod) pushMap(index.modulesByName, mod, rel);
  }
}

function indexCs(index: CodeIndex, rel: string, text: string): void {
  const ns = namespaceName(text);
  for (const name of declaredTypes(text)) addType(index.csByFqcn, index.csByNamespace, rel, ns, name);
  const project = nearestProject(rel, index.csprojDirs);
  for (const m of text.matchAll(CS_USING)) {
    if (!m[1]) continue;
    const target = m[4].replace(/\.\*$/, "");
    if (m[2] || m[3]) pushMap(index.csGlobalTypes, project, target);
    else pushMap(index.csGlobalUsings, project, target);
  }
}

function addJvmEdges(rel: string, text: string, edges: Edge[], index: CodeIndex, imports: RegExp): void {
  if (isModuleInfo(rel)) {
    for (const m of text.matchAll(MODULE_REQUIRES)) {
      const target = closestPath(rel, index.modulesByName.get(m[1]) ?? []);
      if (target) pushEdge(edges, rel, target);
    }
  }
  for (const m of text.matchAll(imports)) {
    const spec = m[1];
    if (spec.endsWith(".*")) {
      const pkg = spec.slice(0, -2);
      const types = index.javaByPackage.get(pkg);
      if (types && types.length > 0) {
        const body = codeBody(text);
        for (const t of types) {
          if (t.path !== rel && mentionsIdent(body, t.simpleName)) pushEdge(edges, rel, t.path);
        }
      } else {
        const path = index.javaByFqcn.get(pkg);
        if (path) pushEdge(edges, rel, path);
      }
    } else {
      const path = lookupFqcn(index.javaByFqcn, spec);
      if (path) pushEdge(edges, rel, path);
    }
  }
  const body = codeBody(text);
  for (const t of index.javaByPackage.get(packageName(text)) ?? []) {
    if (t.path !== rel && mentionsIdent(body, t.simpleName)) pushEdge(edges, rel, t.path);
  }
  linkQualified(body, index.javaByFqcn, rel, edges);
}

function addCsEdges(rel: string, text: string, edges: Edge[], index: CodeIndex): void {
  const project = nearestProject(rel, index.csprojDirs);
  const visible = new Set<string>(index.csGlobalUsings.get(project) ?? []);
  const own = namespaceName(text);
  if (own) visible.add(own);
  for (const m of text.matchAll(CS_USING)) {
    if (m[1]) continue;
    const target = m[4];
    if (m[2] || m[3]) {
      const path = lookupFqcn(index.csByFqcn, target.replace(/\.\*$/, ""));
      if (path) pushEdge(edges, rel, path);
      else if (!m[2] && index.csByNamespace.has(target)) visible.add(target);
    } else {
      visible.add(target.replace(/\.\*$/, ""));
    }
  }
  const body = codeBody(text);
  for (const ns of visible) {
    for (const t of index.csByNamespace.get(ns) ?? []) {
      if (t.path !== rel && mentionsIdent(body, t.simpleName)) pushEdge(edges, rel, t.path);
    }
  }
  for (const fqcn of index.csGlobalTypes.get(project) ?? []) {
    const path = lookupFqcn(index.csByFqcn, fqcn);
    if (path) pushEdge(edges, rel, path);
  }
  linkQualified(body, index.csByFqcn, rel, edges);
}

function addType(
  byFqcn: Map<string, string>,
  byQual: Map<string, TypeRef[]>,
  path: string,
  qualifier: string,
  simple: string,
): void {
  const fq = qualifier ? `${qualifier}.${simple}` : simple;
  if (byFqcn.has(fq)) return;
  byFqcn.set(fq, path);
  const list = byQual.get(qualifier) ?? [];
  list.push({ path, simpleName: simple });
  byQual.set(qualifier, list);
}

function declaredTypes(text: string): string[] {
  return [...new Set([...text.matchAll(TYPE_DECL)].map((m) => m[1]))];
}

function kotlinTopFunctions(text: string): string[] {
  return [...new Set([...text.matchAll(KT_TOP_FUN)].map((m) => m[1]))];
}

function indexProto(index: CodeIndex, rel: string, text: string): void {
  const ns = text.match(/option\s+csharp_namespace\s*=\s*"([^"]+)"/)?.[1] ?? "";
  if (!ns) return;
  for (const m of text.matchAll(/\b(?:service|message|enum)\s+(\w+)/g)) {
    addType(index.csByFqcn, index.csByNamespace, rel, ns, m[1]);
  }
}

function packageName(text: string): string {
  return text.match(/^\s*package\s+([\w.]+)\s*;?/m)?.[1] ?? "";
}

function namespaceName(text: string): string {
  return text.match(/^\s*namespace\s+([\w.]+)/m)?.[1] ?? "";
}

function codeBody(text: string): string {
  return text
    .replace(/^\s*package\s+[\w.]+\s*;?/gm, "")
    .replace(/^\s*import\s+[\w.*]+(?:\s+as\s+\w+)?\s*;?/gm, "")
    .replace(/^\s*namespace\s+[\w.]+/gm, "")
    .replace(/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[\w.]+\s*=\s*)?[\w.*]+\s*;/gm, "");
}

function mentionsIdent(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

function lookupFqcn(map: Map<string, string>, spec: string): string | undefined {
  let name = spec;
  while (true) {
    const path = map.get(name);
    if (path) return path;
    const i = name.lastIndexOf(".");
    if (i === -1) return undefined;
    name = name.slice(0, i);
  }
}

function linkQualified(text: string, map: Map<string, string>, rel: string, edges: Edge[]): void {
  for (const m of text.matchAll(QUALIFIED)) {
    const path = lookupFqcn(map, m[1]);
    if (path) pushEdge(edges, rel, path);
  }
}

function pushEdge(edges: Edge[], from: string, to: string): void {
  if (!to || from === to) return;
  if (edges.some((e) => e.to === to)) return;
  edges.push({ from, to, type: "imports" });
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export interface JavaModule {
  name: string;
  dir: string;
  info: string;
}

export function readModules(root: string): JavaModule[] {
  return [...readJavaModules(root), ...readCsprojModules(root)];
}

export function readCsprojModules(root: string): JavaModule[] {
  const out: JavaModule[] = [];
  for (const abs of walk(root)) {
    const rel = toPosix(relative(root, abs));
    if (!rel.toLowerCase().endsWith(".csproj")) continue;
    const base = rel.split("/").pop() ?? rel;
    out.push({ name: base.slice(0, -".csproj".length), dir: dirOf(rel), info: rel });
  }
  return out;
}

export function readJavaModules(root: string): JavaModule[] {
  const out: JavaModule[] = [];
  for (const abs of walk(root)) {
    const rel = toPosix(relative(root, abs));
    if (!isModuleInfo(rel)) continue;
    const text = readFileSync(abs, "utf8");
    const name = text.match(MODULE_DECL)?.[1];
    if (!name) continue;
    out.push({ name, dir: dirOf(rel), info: rel });
  }
  return out;
}

function isModuleInfo(rel: string): boolean {
  return rel === "module-info.java" || rel.endsWith("/module-info.java");
}

function closestPath(from: string, paths: string[]): string | undefined {
  let best: string | undefined;
  let score = -1;
  for (const p of paths) {
    if (p === from) continue;
    let i = 0;
    const n = Math.min(from.length, p.length);
    while (i < n && from.charCodeAt(i) === p.charCodeAt(i)) i++;
    if (i > score) {
      score = i;
      best = p;
    }
  }
  return best;
}

function dirOf(rel: string): string {
  const d = toPosix(dirname(rel));
  return d === "." ? "" : d;
}

function nearestProject(rel: string, dirs: string[]): string {
  const fileDir = dirOf(rel);
  let best = "";
  let found = false;
  for (const d of dirs) {
    if (d === "" || fileDir === d || fileDir.startsWith(d + "/")) {
      if (!found || d.length >= best.length) {
        best = d;
        found = true;
      }
    }
  }
  return found ? best : "";
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
