// Almacén local: SQLite con FTS5 para texto y una tabla de aristas para el grafo.
// Vive en <repo>/.galadriel/espejo.db. No sale nada de la máquina.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const GALADRIEL_DIR = ".galadriel";

export interface Chunk {
  path: string;
  ordinal: number;
  kind: string;
  content: string;
}

export interface Edge {
  from: string;
  to: string;
  type: "imports";
}

export interface Hit {
  path: string;
  ordinal: number;
  kind: string;
  snippet: string;
  score: number;
}

interface FileMeta {
  path: string;
  kind: string;
  size: number;
  mtime: number;
  hash: string;
}

export class Store {
  private db: Database.Database;

  constructor(root: string) {
    const dir = join(root, GALADRIEL_DIR);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "espejo.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        path UNINDEXED,
        ordinal UNINDEXED,
        kind UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS edges (
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (src, dst, type)
      );
      CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
    `);
  }

  fileHash(path: string): string | undefined {
    const row = this.db.prepare("SELECT hash FROM files WHERE path = ?").get(path) as
      | { hash: string }
      | undefined;
    return row?.hash;
  }

  replaceFile(meta: FileMeta, chunks: Chunk[], edges: Edge[]): void {
    const delChunks = this.db.prepare("DELETE FROM chunks WHERE path = ?");
    const delEdges = this.db.prepare("DELETE FROM edges WHERE src = ?");
    const upFile = this.db.prepare(
      "INSERT OR REPLACE INTO files(path, kind, size, mtime, hash) VALUES (?, ?, ?, ?, ?)",
    );
    const insChunk = this.db.prepare(
      "INSERT INTO chunks(path, ordinal, kind, content) VALUES (?, ?, ?, ?)",
    );
    const insEdge = this.db.prepare(
      "INSERT OR IGNORE INTO edges(src, dst, type) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      delChunks.run(meta.path);
      delEdges.run(meta.path);
      upFile.run(meta.path, meta.kind, meta.size, meta.mtime, meta.hash);
      for (const c of chunks) insChunk.run(c.path, c.ordinal, c.kind, c.content);
      for (const e of edges) insEdge.run(e.from, e.to, e.type);
    });
    tx();
  }

  removeMissing(present: Set<string>): number {
    const rows = this.db.prepare("SELECT path FROM files").all() as { path: string }[];
    const delFile = this.db.prepare("DELETE FROM files WHERE path = ?");
    const delChunks = this.db.prepare("DELETE FROM chunks WHERE path = ?");
    const delEdges = this.db.prepare("DELETE FROM edges WHERE src = ? OR dst = ?");
    let removed = 0;
    const tx = this.db.transaction(() => {
      for (const { path } of rows) {
        if (present.has(path)) continue;
        delFile.run(path);
        delChunks.run(path);
        delEdges.run(path, path);
        removed++;
      }
    });
    tx();
    return removed;
  }

  search(query: string, limit = 10, kind?: string): Hit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const sql = `
      SELECT path, ordinal, kind,
             snippet(chunks, 3, '[', ']', '…', 24) AS snippet,
             bm25(chunks) AS score
      FROM chunks
      WHERE chunks MATCH ?
        ${kind ? "AND kind = ?" : ""}
      ORDER BY score
      LIMIT ?`;
    const args: (string | number)[] = kind ? [match, kind, limit] : [match, limit];
    return this.db.prepare(sql).all(...args) as Hit[];
  }

  dependenciesOf(path: string): string[] {
    const rows = this.db
      .prepare("SELECT dst FROM edges WHERE src = ? ORDER BY dst")
      .all(path) as { dst: string }[];
    return rows.map((r) => r.dst);
  }

  dependentsOf(path: string): string[] {
    const rows = this.db
      .prepare("SELECT src FROM edges WHERE dst = ? ORDER BY src")
      .all(path) as { src: string }[];
    return rows.map((r) => r.src);
  }

  stats(): { files: number; chunks: number; edges: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      files: one("SELECT COUNT(*) AS n FROM files"),
      chunks: one("SELECT COUNT(*) AS n FROM chunks"),
      edges: one("SELECT COUNT(*) AS n FROM edges"),
    };
  }

  close(): void {
    this.db.close();
  }
}

// Convierte texto libre en una consulta FTS5 segura: cada término entre comillas,
// unidos con OR para que cualquier palabra cuente; bm25 ordena las mejores arriba.
export function toFtsQuery(text: string): string {
  const terms = text
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}
