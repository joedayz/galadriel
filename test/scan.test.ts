import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan } from "../src/scan.js";
import { Store, toFtsQuery } from "../src/store.js";
import { impact } from "../src/graph.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/audit"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), "export function readSession(sid: string) { return sid; }\n");
  writeFileSync(
    join(root, "src/auth/login.ts"),
    "import { readSession } from './session';\nexport function login(user: string, password: string) { return readSession(user); }\n",
  );
  writeFileSync(
    join(root, "src/audit/log.ts"),
    "import { readSession } from '../auth/session';\nexport function audit(action: string) { return readSession(action); }\n",
  );
  writeFileSync(join(root, "README.md"), "# API clientes\n\nEl login valida usuario y clave contra la tabla users.\n");
  return root;
}

test("scan indexa archivos, fragmentos y aristas", () => {
  const root = repo();
  try {
    const r = scan(root);
    assert.equal(r.indexed, 4);
    const store = new Store(root);
    const s = store.stats();
    assert.equal(s.files, 4);
    assert.equal(s.edges, 2);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan incremental no reindexa lo que no cambió", () => {
  const root = repo();
  try {
    scan(root);
    const r2 = scan(root);
    assert.equal(r2.indexed, 0);
    assert.equal(r2.unchanged, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search encuentra por palabra y por acento insensible", () => {
  const root = repo();
  try {
    scan(root);
    const store = new Store(root);
    const hits = store.search("login usuario");
    assert.ok(hits.some((h) => h.path === "README.md"));
    assert.ok(hits.some((h) => h.path === "src/auth/login.ts"));
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("impact muestra quién depende de session.ts", () => {
  const root = repo();
  try {
    scan(root);
    const store = new Store(root);
    const levels = impact(store, "src/auth/session.ts", 3);
    assert.deepEqual(levels, [["src/audit/log.ts", "src/auth/login.ts"]]);
    assert.deepEqual(store.dependenciesOf("src/auth/login.ts"), ["src/auth/session.ts"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports con alias de tsconfig paths (@/lib/x) crean aristas", () => {
  const root = repo();
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      '{ "compilerOptions": { "paths": { "@/*": ["./*"] } }, }\n', // coma final a propósito
    );
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app/page.tsx"), "import { login } from '@/src/auth/login';\nexport default () => login('a','b');\n");
    scan(root);
    const store = new Store(root);
    assert.deepEqual(store.dependenciesOf("app/page.tsx"), ["src/auth/login.ts"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("toFtsQuery escapa comillas y descarta términos de una letra", () => {
  assert.equal(toFtsQuery('a sesión "jwt"'), '"sesión" OR "jwt"');
  assert.equal(toFtsQuery("   "), "");
});
