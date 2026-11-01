import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJavaModules, readModules, scan } from "../src/scan.js";
import { Store, toFtsQuery } from "../src/store.js";
import { collapseToModules, cycles, graphEdges, impact, toMermaid, unused } from "../src/graph.js";

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

test("graph dibuja en mermaid que login importa session", () => {
  const root = repo();
  try {
    scan(root);
    const store = new Store(root);
    const diagram = toMermaid(graphEdges(store, "src/auth/login.ts", 1), ["src/auth/login.ts"]);
    store.close();
    assert.match(diagram, /^flowchart LR/);
    const id = (label: string) => {
      const m = diagram.match(new RegExp(`(n\\d+)\\["${label}"\\]`));
      assert.ok(m, label);
      return m[1];
    };
    assert.match(diagram, new RegExp(`${id("src/auth/login.ts")} --> ${id("src/auth/session.ts")}`));
    assert.doesNotMatch(diagram, /src\/audit\/log\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph --modules agrupa requires e imports de un módulo Java", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    const app = join(root, "src/com.acme.app/com/acme/app");
    const lib = join(root, "src/com.acme.lib/com/acme/lib");
    mkdirSync(app, { recursive: true });
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(root, "src/com.acme.app/module-info.java"),
      "module com.acme.app { requires com.acme.lib; requires java.base; }\n",
    );
    writeFileSync(join(root, "src/com.acme.lib/module-info.java"), "module com.acme.lib {}\n");
    writeFileSync(join(lib, "Util.java"), "package com.acme.lib;\npublic class Util {}\n");
    writeFileSync(
      join(app, "Main.java"),
      "package com.acme.app;\nimport com.acme.lib.Util;\npublic class Main { Util u; }\n",
    );
    scan(root);
    const store = new Store(root);
    const info = "src/com.acme.app/module-info.java";
    assert.deepEqual(store.dependenciesOf(info), ["src/com.acme.lib/module-info.java"]);
    const diagram = toMermaid(collapseToModules(graphEdges(store), readJavaModules(root)));
    store.close();
    const id = (label: string) => {
      const m = diagram.match(new RegExp(`(n\\d+)\\["${label}"\\]`));
      assert.ok(m, label);
      return m[1];
    };
    assert.match(diagram, new RegExp(`${id("com.acme.app")} ==>\\|2\\| ${id("com.acme.lib")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kotlin enlaza una función de primer nivel y no toma el receiver", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    const app = join(root, "feature/src/main/kotlin/com/acme/app");
    const ui = join(root, "feature/src/main/kotlin/com/acme/ui");
    mkdirSync(app, { recursive: true });
    mkdirSync(ui, { recursive: true });
    writeFileSync(
      join(ui, "Home.kt"),
      "package com.acme.ui\n@Composable\nfun HomeScreen() {}\nfun Context.shareText() {}\n",
    );
    writeFileSync(join(ui, "Orphan.kt"), "package com.acme.ui\nfun Nobody() {}\nval Marker = 1\n");
    writeFileSync(
      join(ui, "UsesContext.kt"),
      "package com.acme.ui\nclass UsesContext { val c: Context? = null; val m = Marker }\n",
    );
    writeFileSync(
      join(app, "MainActivity.kt"),
      "package com.acme.app\nimport com.acme.ui.HomeScreen\nclass MainActivity { fun onCreate() { HomeScreen() } }\n",
    );
    scan(root);
    const store = new Store(root);
    const main = "feature/src/main/kotlin/com/acme/app/MainActivity.kt";
    const home = "feature/src/main/kotlin/com/acme/ui/Home.kt";
    assert.deepEqual(store.dependenciesOf(main), [home]);
    assert.deepEqual(store.dependenciesOf("feature/src/main/kotlin/com/acme/ui/UsesContext.kt"), [
      "feature/src/main/kotlin/com/acme/ui/Orphan.kt",
    ]);
    assert.deepEqual(unused(store), ["feature/src/main/kotlin/com/acme/ui/UsesContext.kt"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kotlin resuelve import, mismo paquete y módulo anidado", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    const app = join(root, "feature/src/main/kotlin/com/acme/app");
    const lib = join(root, "lib/src/main/kotlin/com/acme/lib");
    mkdirSync(app, { recursive: true });
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "Used.kt"), "package com.acme.lib\nclass Used\n");
    writeFileSync(join(lib, "Unused.kt"), "package com.acme.lib\nobject Unused\n");
    writeFileSync(
      join(app, "App.kt"),
      "package com.acme.app\nimport com.acme.lib.Used\nimport java.util.List\nclass App { val u: Used? = null }\n",
    );
    writeFileSync(join(app, "Peer.kt"), "package com.acme.app\nclass Peer { val app: App? = null }\n");
    writeFileSync(
      join(app, "Star.kt"),
      "package com.acme.app\nimport com.acme.lib.*\nclass Star { val u: Unused? = null }\n",
    );
    scan(root);
    const store = new Store(root);
    const appFile = "feature/src/main/kotlin/com/acme/app/App.kt";
    const peer = "feature/src/main/kotlin/com/acme/app/Peer.kt";
    const star = "feature/src/main/kotlin/com/acme/app/Star.kt";
    assert.deepEqual(store.dependenciesOf(appFile), ["lib/src/main/kotlin/com/acme/lib/Used.kt"]);
    assert.deepEqual(store.dependenciesOf(peer), [appFile]);
    assert.deepEqual(store.dependenciesOf(star), ["lib/src/main/kotlin/com/acme/lib/Unused.kt"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("un markdown enlaza archivos del repo y deja fuera un enlace externo", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "docs/perspectives"), { recursive: true });
    mkdirSync(join(root, "docs/guides"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "docs/perspectives/DEVELOPER.md"), "# Developer\n");
    writeFileSync(join(root, "docs/guides/USER-GUIDE.md"), "# Guía\n");
    writeFileSync(join(root, "docs/guides/QUICK-START.md"), "# Rápido\n");
    writeFileSync(join(root, "src/scan.ts"), "export const scan = 1;\n");
    writeFileSync(
      join(root, "docs/perspectives/README.md"),
      [
        "# Elige tu perspectiva",
        "",
        "| Rol | Guía |",
        "|---|---|",
        "| Developer | [Developer](./DEVELOPER.md) |",
        "| Referencia | [Guía](../guides/USER-GUIDE.md#comandos) |",
        "| Código | [scan](../../src/scan.ts) |",
        "| Ancla | [aquí](#elige) |",
        "| Fuera | [GitHub](https://github.com/exoreaction/Synthesis) |",
        "",
        "```",
        "Ver [falso](../guides/QUICK-START.md) dentro del ejemplo.",
        "```",
        "",
        "[guia]: ../guides/USER-GUIDE.md",
        "",
      ].join("\n"),
    );
    scan(root);
    const store = new Store(root);
    assert.deepEqual(store.dependenciesOf("docs/perspectives/README.md"), [
      "docs/guides/USER-GUIDE.md",
      "docs/perspectives/DEVELOPER.md",
      "src/scan.ts",
    ]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unused lista el huérfano y omite la entrada", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "src/api"), { recursive: true });
    writeFileSync(join(root, "src/used.ts"), "export const n = 1;\n");
    writeFileSync(join(root, "src/orphan.ts"), "import { n } from './used';\nexport const x = n;\n");
    writeFileSync(join(root, "src/api/UserController.ts"), "export class UserController {}\n");
    writeFileSync(join(root, "src/Program.cs"), "class Program {}\n");
    writeFileSync(join(root, "src/UserResource.java"), "class UserResource {}\n");
    writeFileSync(join(root, "src/DemoApplication.java"), "class DemoApplication {}\n");
    writeFileSync(join(root, "src/UserTest.kt"), "class UserTest\n");
    writeFileSync(join(root, "README.md"), "# notas\n");
    scan(root);
    const store = new Store(root);
    assert.deepEqual(unused(store), ["src/orphan.ts"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mover un archivo conserva la ruta nueva y las aristas", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    const dir = join(root, "src/main/java/com/acme");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Used.java"), "package com.acme;\nclass Used { int marcaunica; }\n");
    writeFileSync(join(dir, "App.java"), "package com.acme;\nclass App { Used u; }\n");
    scan(root);
    const next = join(root, "src/main/java/com/acme/model");
    mkdirSync(next, { recursive: true });
    renameSync(join(dir, "Used.java"), join(next, "Used.java"));
    const again = scan(root);
    assert.equal(again.moved, 1);
    assert.equal(again.removed, 0);
    const store = new Store(root);
    const used = "src/main/java/com/acme/model/Used.java";
    assert.equal(store.fileHash("src/main/java/com/acme/Used.java"), undefined);
    assert.deepEqual(store.dependenciesOf("src/main/java/com/acme/App.java"), [used]);
    assert.deepEqual(store.dependentsOf(used), ["src/main/java/com/acme/App.java"]);
    assert.ok(store.search("marcaunica").some((h) => h.path === used));
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dos copias iguales no heredan las aristas de la que se borra", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const body = "export const marca = 1;\n";
    writeFileSync(join(root, "src/a.ts"), body);
    writeFileSync(join(root, "src/b.ts"), body);
    writeFileSync(join(root, "src/c.ts"), "import { marca } from './a';\n");
    scan(root);
    rmSync(join(root, "src/a.ts"));
    const again = scan(root);
    assert.equal(again.moved, 0);
    assert.equal(again.removed, 1);
    const store = new Store(root);
    assert.deepEqual(store.dependenciesOf("src/c.ts"), []);
    assert.deepEqual(store.dependentsOf("src/b.ts"), []);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cycles lista una sola vez que A importa a B y B importa a A", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(join(root, "src/b.ts"), "import { a } from './a';\nexport const b = a;\n");
    writeFileSync(join(root, "src/c.ts"), "import { a } from './a';\nexport const c = a;\n");
    scan(root);
    const store = new Store(root);
    assert.deepEqual(cycles(store.edges()), [["src/a.ts", "src/b.ts"]]);
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

test("un índice de una versión anterior se reindexa entero", () => {
  const root = repo();
  try {
    scan(root);
    const store = new Store(root);
    store.setScanVersion("0");
    store.close();
    const again = scan(root);
    assert.equal(again.indexed, 4);
    assert.equal(again.unchanged, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("java resuelve multi-módulo, mismo paquete e import con asterisco", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    const b = join(root, "modulo-b/src/main/java/com/acme/b");
    const a = join(root, "modulo-a/src/main/java/com/acme/a");
    mkdirSync(b, { recursive: true });
    mkdirSync(a, { recursive: true });
    writeFileSync(join(b, "Used.java"), "package com.acme.b;\npublic class Used {}\n");
    writeFileSync(join(b, "Unused.java"), "package com.acme.b;\npublic class Unused {}\n");
    writeFileSync(
      join(a, "App.java"),
      "package com.acme.a;\nimport com.acme.b.Used;\nimport java.util.List;\npublic class App { Used u; }\n",
    );
    writeFileSync(join(a, "Peer.java"), "package com.acme.a;\npublic class Peer { App app; }\n");
    writeFileSync(
      join(a, "Star.java"),
      "package com.acme.a;\nimport com.acme.b.*;\npublic class Star { Unused u; }\n",
    );
    scan(root);
    const store = new Store(root);
    const app = "modulo-a/src/main/java/com/acme/a/App.java";
    const peer = "modulo-a/src/main/java/com/acme/a/Peer.java";
    const star = "modulo-a/src/main/java/com/acme/a/Star.java";
    assert.deepEqual(store.dependenciesOf(app), ["modulo-b/src/main/java/com/acme/b/Used.java"]);
    assert.deepEqual(store.dependenciesOf(peer), [app]);
    assert.deepEqual(store.dependenciesOf(star), ["modulo-b/src/main/java/com/acme/b/Unused.java"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("csharp cruza un servicio por el proto y --modules agrupa por csproj", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    const product = join(root, "src/Product");
    const order = join(root, "src/Order");
    mkdirSync(join(product, "Protos"), { recursive: true });
    mkdirSync(order, { recursive: true });
    writeFileSync(join(product, "Product.csproj"), "<Project></Project>\n");
    writeFileSync(join(order, "Order.csproj"), "<Project></Project>\n");
    writeFileSync(
      join(product, "Protos/product.proto"),
      'syntax = "proto3";\noption csharp_namespace = "Product.Grpc";\nservice ProductGrpc { rpc Get (GetRequest) returns (Reply); }\nmessage GetRequest {}\nmessage Reply {}\n',
    );
    writeFileSync(
      join(order, "Client.cs"),
      "using Product.Grpc;\nnamespace Order.Clients;\npublic class Client { ProductGrpc.ProductGrpcClient c; GetRequest r; }\n",
    );
    scan(root);
    const store = new Store(root);
    const client = "src/Order/Client.cs";
    const proto = "src/Product/Protos/product.proto";
    assert.deepEqual(store.dependenciesOf(client), [proto]);
    const diagram = toMermaid(collapseToModules(store.edges(), readModules(root)));
    assert.match(diagram, /\["Order"\]/);
    assert.match(diagram, /\["Product"\]/);
    assert.match(diagram, /-->/);
    assert.doesNotMatch(diagram, /\["src"\]/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("csharp resuelve using, mismo namespace y global using; ignora bin y obj", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "src/Api/Controllers"), { recursive: true });
    mkdirSync(join(root, "src/Domain"), { recursive: true });
    mkdirSync(join(root, "obj"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "src/Api/Api.csproj"), "<Project>ProjectMarker</Project>\n");
    writeFileSync(join(root, "src/Domain/Domain.csproj"), "<Project></Project>\n");
    writeFileSync(join(root, "Demo.sln"), "SolutionMarker\n");
    writeFileSync(
      join(root, "src/Api/GlobalUsings.cs"),
      "global using Demo.Domain;\nglobal using Demo.Extra;\nnamespace Demo.Api;\npublic class GlobalUsings {}\n",
    );
    writeFileSync(
      join(root, "src/Api/OnlyGlobal.cs"),
      "namespace Demo.Extra;\npublic class Widget {}\n",
    );
    writeFileSync(
      join(root, "src/Api/Controllers/Home.cs"),
      "namespace Demo.Api;\npublic class Home { public Product Item { get; set; } public Widget W { get; set; } }\n",
    );
    writeFileSync(
      join(root, "src/Api/Noise.cs"),
      "using Demo.Domain;\nnamespace Demo.Api;\npublic class Noise {}\n",
    );
    writeFileSync(
      join(root, "src/Api/Qualified.cs"),
      "namespace Demo.Api;\npublic class Qualified { Demo.Domain.Product P; }\n",
    );
    writeFileSync(join(root, "src/Domain/Product.cs"), "namespace Demo.Domain;\npublic class Product {}\n");
    writeFileSync(
      join(root, "src/Domain/Other.cs"),
      "namespace Demo.Domain;\npublic class Other { Product p; }\n",
    );
    writeFileSync(
      join(root, "src/Domain/Peek.cs"),
      "namespace Demo.Domain;\npublic class Peek { Widget w; }\n",
    );
    writeFileSync(join(root, "obj/Generated.cs"), "namespace Demo.Domain;\npublic class Generated {}\n");
    writeFileSync(join(root, "bin/appsettings.json"), '{ "a": 1 }\n');
    scan(root);
    const store = new Store(root);
    const product = "src/Domain/Product.cs";
    const widget = "src/Api/OnlyGlobal.cs";
    assert.deepEqual(store.dependenciesOf("src/Api/Controllers/Home.cs"), [widget, product]);
    assert.deepEqual(store.dependenciesOf("src/Domain/Other.cs"), [product]);
    assert.deepEqual(store.dependenciesOf("src/Api/Qualified.cs"), [product]);
    assert.deepEqual(store.dependenciesOf("src/Api/Noise.cs"), []);
    assert.deepEqual(store.dependenciesOf("src/Domain/Peek.cs"), []);
    assert.equal(store.fileHash("obj/Generated.cs"), undefined);
    assert.equal(store.fileHash("bin/appsettings.json"), undefined);
    assert.ok(store.fileHash("Demo.sln"));
    assert.ok(store.search("ProjectMarker", 5, "config").some((h) => h.path === "src/Api/Api.csproj"));
    assert.ok(store.search("SolutionMarker", 5, "config").some((h) => h.path === "Demo.sln"));
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("toFtsQuery escapa comillas y descarta términos de una letra", () => {
  assert.equal(toFtsQuery('a sesión "jwt"'), '"sesión" OR "jwt"');
  assert.equal(toFtsQuery("   "), "");
});
