import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan } from "../src/scan.js";
import { Store } from "../src/store.js";
import { watchWorkspace } from "../src/watch.js";

function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) resolve();
      else if (Date.now() - start > ms) reject(new Error("el watch no alcanzó a indexar"));
      else setTimeout(tick, 20);
    };
    tick();
  });
}

test("watch reindexa al guardar y al parar el índice queda consistente", { timeout: 8000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/session.ts"), "export function readSession(sid: string) { return sid; }\n");
    writeFileSync(
      join(root, "src/login.ts"),
      "import { readSession } from './session';\nexport function login(user: string) { return readSession(user); }\n",
    );
    scan(root);
    let scans = 0;
    const errors: unknown[] = [];
    const handle = watchWorkspace(root, {
      debounceMs: 30,
      onScan: () => scans++,
      onError: (err) => errors.push(err instanceof Error ? err.message : err),
    });
    await waitFor(() => scans >= 1 || errors.length > 0);
    if (errors.length > 0) throw new Error(String(errors[0]));
    await new Promise((r) => setTimeout(r, 150));
    const afterOpen = scans;

    writeFileSync(join(root, "src/login.ts"), "export const marcaunica = 1;\n");
    await waitFor(() => scans > afterOpen);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(scans <= afterOpen + 2, `el watch no se detuvo: ${scans - afterOpen} scans de más`);

    const mid = new Store(root);
    assert.ok(mid.search("marcaunica").some((h) => h.path === "src/login.ts"));
    assert.deepEqual(mid.dependenciesOf("src/login.ts"), []);
    mid.close();

    rmSync(join(root, "src/login.ts"));
    await handle.close();

    const store = new Store(root);
    assert.equal(store.fileHash("src/login.ts"), undefined);
    assert.equal(store.search("marcaunica").length, 0);
    assert.deepEqual(store.dependentsOf("src/session.ts"), []);
    assert.equal(store.stats().files, 1);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
