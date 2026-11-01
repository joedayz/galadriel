// Compara dependencias declaradas con un catálogo local. Sin red.
// Si el catálogo no está, no inventa CVEs. Un rango (^, ~, ${…}) no coincide.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { walk } from "./scan.js";

const EXACT = /^[\w.+-]+$/;

interface Entry {
  name?: string;
  group?: string;
  version?: string;
  id?: string;
  summary?: string;
}

interface Catalog {
  npm?: Entry[];
  maven?: Entry[];
  nuget?: Entry[];
}

export interface Finding {
  manifest: string;
  coordinate: string;
  id: string;
  summary: string;
}

export interface AdviceReport {
  status: "missing" | "unreadable" | "ok";
  findings: Finding[];
}

export function advise(root: string, catalogPath?: string): AdviceReport {
  const dir = resolve(root);
  const path = catalogPath ? resolve(dir, catalogPath) : join(dir, ".galadriel", "advisories.json");
  if (!existsSync(path)) return { status: "missing", findings: [] };
  let catalog: Catalog;
  try {
    catalog = JSON.parse(readFileSync(path, "utf8")) as Catalog;
  } catch {
    return { status: "unreadable", findings: [] };
  }
  const npm = byKey(catalog.npm, (e) => e.name ?? "");
  const maven = byKey(catalog.maven, (e) => (e.group && e.name ? `${e.group}:${e.name}` : ""));
  const nuget = byKey(catalog.nuget, (e) => e.name ?? "");
  const findings: Finding[] = [];
  for (const abs of walk(dir)) {
    const rel = relative(dir, abs).split(sep).join("/");
    const base = basename(abs);
    if (base === "package.json") findings.push(...fromPackage(rel, abs, npm));
    else if (base === "pom.xml") findings.push(...fromPom(rel, abs, maven));
    else if (base.endsWith(".csproj")) findings.push(...fromCsproj(rel, abs, nuget));
  }
  findings.sort(
    (a, b) => a.manifest.localeCompare(b.manifest) || a.coordinate.localeCompare(b.coordinate) || a.id.localeCompare(b.id),
  );
  return { status: "ok", findings };
}

export function formatAdvice(report: AdviceReport): string {
  if (report.status === "missing") return "sin catálogo local. No consulto la red ni invento CVEs.";
  if (report.status === "unreadable") return "no pude leer el catálogo. No invento CVEs.";
  if (report.findings.length === 0) return "sin avisos para las dependencias declaradas";
  return report.findings
    .map((f) => [f.manifest, f.coordinate, f.id, f.summary].filter(Boolean).join("  "))
    .join("\n");
}

function byKey(entries: Entry[] | undefined, key: (e: Entry) => string): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  for (const e of entries ?? []) {
    const k = key(e);
    if (!k || !e.version || !e.id) continue;
    const list = map.get(k) ?? [];
    list.push(e);
    map.set(k, list);
  }
  return map;
}

function matches(entries: Entry[] | undefined, version: string): Entry[] {
  if (!entries || !EXACT.test(version)) return [];
  return entries.filter((e) => e.version === version);
}

function fromPackage(rel: string, abs: string, index: Map<string, Entry[]>): Finding[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: Finding[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const block = pkg[field];
    if (!block || typeof block !== "object") continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      for (const e of matches(index.get(name), spec.trim())) {
        out.push({ manifest: rel, coordinate: `${name}@${spec.trim()}`, id: e.id ?? "", summary: e.summary ?? "" });
      }
    }
  }
  return out;
}

function fromPom(rel: string, abs: string, index: Map<string, Entry[]>): Finding[] {
  const text = readText(abs);
  if (text === undefined) return [];
  const out: Finding[] = [];
  for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = tag(block[1], "groupId");
    const name = tag(block[1], "artifactId");
    const version = tag(block[1], "version");
    if (!group || !name || !version) continue;
    for (const e of matches(index.get(`${group}:${name}`), version)) {
      out.push({
        manifest: rel,
        coordinate: `${group}:${name}@${version}`,
        id: e.id ?? "",
        summary: e.summary ?? "",
      });
    }
  }
  return out;
}

function fromCsproj(rel: string, abs: string, index: Map<string, Entry[]>): Finding[] {
  const text = readText(abs);
  if (text === undefined) return [];
  const out: Finding[] = [];
  for (const tag of text.matchAll(/<PackageReference\b([^>]*)>/g)) {
    const name = attr(tag[1], "Include");
    const version = attr(tag[1], "Version");
    if (!name || !version) continue;
    for (const e of matches(index.get(name), version)) {
      out.push({ manifest: rel, coordinate: `${name}@${version}`, id: e.id ?? "", summary: e.summary ?? "" });
    }
  }
  return out;
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`));
  return m?.[1];
}

function attr(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m?.[1] || undefined;
}

function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}
