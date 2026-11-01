// Servidor LSP mínimo por stdio. Definición y referencias salen de las aristas
// del índice: la unidad es el archivo, no el símbolo.

import { type Readable, type Writable } from "node:stream";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./store.js";

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { textDocument?: { uri?: string } };
  result?: unknown;
  error?: { code: number; message: string };
}

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

export function takeFrame(buf: Buffer): { body: Buffer; rest: Buffer } | null {
  const sepAt = buf.indexOf("\r\n\r\n");
  if (sepAt === -1) return null;
  const header = buf.subarray(0, sepAt).toString("utf8");
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return { body: Buffer.alloc(0), rest: Buffer.from(buf.subarray(sepAt + 4)) };
  const start = sepAt + 4;
  const len = Number(match[1]);
  if (buf.length < start + len) return null;
  return {
    body: Buffer.from(buf.subarray(start, start + len)),
    rest: Buffer.from(buf.subarray(start + len)),
  };
}

export function handleLsp(store: Store, root: string, msg: Rpc): Rpc | null {
  if (msg.id === undefined || msg.id === null) return null;
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          capabilities: { definitionProvider: true, referencesProvider: true },
          serverInfo: { name: "galadriel", version: "0.1.0" },
        },
      };
    case "shutdown":
      return { jsonrpc: "2.0", id, result: null };
    case "textDocument/definition":
      return { jsonrpc: "2.0", id, result: locations(store, root, msg.params?.textDocument?.uri, "out") };
    case "textDocument/references":
      return { jsonrpc: "2.0", id, result: locations(store, root, msg.params?.textDocument?.uri, "in") };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "método no encontrado" } };
  }
}

export async function serveLsp(root: string, input: Readable, output: Writable): Promise<void> {
  const dir = resolve(root);
  const store = new Store(dir);
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, piece]);
      while (true) {
        const frame = takeFrame(buffered);
        if (!frame) break;
        buffered = frame.rest;
        if (frame.body.length === 0) continue;
        let msg: Rpc;
        try {
          msg = JSON.parse(frame.body.toString("utf8")) as Rpc;
        } catch {
          continue;
        }
        const response = handleLsp(store, dir, msg);
        if (response) output.write(encodeFrame(response));
        if (msg.method === "exit") return;
      }
    }
  } finally {
    store.close();
  }
}

function locations(store: Store, root: string, uri: string | undefined, direction: "out" | "in") {
  const rel = uri ? fromUri(root, uri) : undefined;
  if (!rel) return [];
  const paths = direction === "out" ? store.dependenciesOf(rel) : store.dependentsOf(rel);
  return paths.map((path) => ({ uri: pathToFileURL(resolve(root, path)).href, range: RANGE }));
}

function fromUri(root: string, uri: string): string | undefined {
  let abs: string;
  try {
    abs = fileURLToPath(uri);
  } catch {
    return undefined;
  }
  const rel = relative(root, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return undefined;
  return rel.split(sep).join("/");
}
