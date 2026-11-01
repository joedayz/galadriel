import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { scan } from "../src/scan.js";
import { encodeFrame, serveLsp, takeFrame } from "../src/lsp.js";

function uri(root: string, rel: string): string {
  return pathToFileURL(join(root, rel)).href;
}

function speak(root: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending: Buffer[] = [];
  let wake: (() => void) | undefined;
  output.on("data", (chunk: Buffer) => {
    pending.push(chunk);
    const ready = wake;
    wake = undefined;
    ready?.();
  });
  const done = serveLsp(root, input, output);
  let buf = Buffer.alloc(0);

  async function next(): Promise<{ id?: number; result?: unknown }> {
    for (;;) {
      buf = Buffer.concat([buf, ...pending.splice(0)]);
      const frame = takeFrame(buf);
      if (frame) {
        buf = frame.rest;
        if (frame.body.length === 0) continue;
        return JSON.parse(frame.body.toString("utf8")) as { id?: number; result?: unknown };
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (pending.length > 0) {
          const ready = wake;
          wake = undefined;
          ready();
        }
      });
    }
  }

  return {
    done,
    send(msg: unknown) {
      input.write(encodeFrame(msg));
    },
    next,
  };
}

test("lsp responde initialize, definition y references", async () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/b.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "src/a.ts"), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(join(root, "src/c.ts"), "import { b } from './b';\nexport const c = b;\n");
    scan(root);
    const lsp = speak(root);
    const at = (rel: string) => ({ textDocument: { uri: uri(root, rel) }, position: { line: 0, character: 0 } });

    lsp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: uri(root, "") } });
    const init = await lsp.next();
    const caps = (init.result as { capabilities: { definitionProvider: boolean; referencesProvider: boolean } }).capabilities;
    assert.equal(caps.definitionProvider, true);
    assert.equal(caps.referencesProvider, true);

    lsp.send({ jsonrpc: "2.0", method: "initialized" });
    lsp.send({ jsonrpc: "2.0", id: 2, method: "textDocument/definition", params: at("src/a.ts") });
    const definition = await lsp.next();
    assert.deepEqual(
      (definition.result as { uri: string }[]).map((loc) => loc.uri),
      [uri(root, "src/b.ts")],
    );

    lsp.send({ jsonrpc: "2.0", id: 3, method: "textDocument/references", params: at("src/b.ts") });
    const references = await lsp.next();
    assert.deepEqual(
      (references.result as { uri: string }[]).map((loc) => loc.uri),
      [uri(root, "src/a.ts"), uri(root, "src/c.ts")],
    );

    lsp.send({ jsonrpc: "2.0", id: 4, method: "shutdown" });
    const shutdown = await lsp.next();
    assert.equal(shutdown.result, null);
    lsp.send({ jsonrpc: "2.0", method: "exit" });
    await lsp.done;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
