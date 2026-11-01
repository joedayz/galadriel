import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { advise, formatAdvice } from "../src/advisories.js";

test("sin catálogo no inventa CVEs", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }));
    const text = formatAdvice(advise(root));
    assert.match(text, /sin catálogo local/);
    assert.doesNotMatch(text, /CVE-\d/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("un catálogo ilegible no inventa CVEs", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    writeFileSync(join(root, "catalog.json"), "{");
    const text = formatAdvice(advise(root, "catalog.json"));
    assert.match(text, /no pude leer el catálogo/);
    assert.doesNotMatch(text, /CVE-\d/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("el catálogo marca la versión exacta en npm, maven y nuget", () => {
  const root = mkdtempSync(join(tmpdir(), "galadriel-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "1.0.0", ms: "^2.1.3" } }),
    );
    writeFileSync(
      join(root, "pom.xml"),
      [
        "<project><dependencies>",
        "<dependency><groupId>org.example</groupId><artifactId>lib</artifactId><version>1.2.3</version></dependency>",
        "<dependency><groupId>org.example</groupId><artifactId>other</artifactId><version>${lib.version}</version></dependency>",
        "</dependencies></project>",
      ].join(""),
    );
    writeFileSync(
      join(root, "src/App.csproj"),
      '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="12.0.1" /></ItemGroup></Project>',
    );
    writeFileSync(
      join(root, "catalog.json"),
      JSON.stringify({
        npm: [
          { name: "left-pad", version: "1.0.0", id: "CVE-2026-0001", summary: "ejemplo npm" },
          { name: "ms", version: "2.1.3", id: "CVE-2026-0009", summary: "no debe salir" },
        ],
        maven: [
          { group: "org.example", name: "lib", version: "1.2.3", id: "CVE-2026-0002", summary: "ejemplo maven" },
          { group: "org.example", name: "other", version: "1.0.0", id: "CVE-2026-0008" },
        ],
        nuget: [{ name: "Newtonsoft.Json", version: "12.0.1", id: "CVE-2026-0003", summary: "ejemplo nuget" }],
      }),
    );
    const text = formatAdvice(advise(root, "catalog.json"));
    assert.deepEqual(text.split("\n"), [
      "package.json  left-pad@1.0.0  CVE-2026-0001  ejemplo npm",
      "pom.xml  org.example:lib@1.2.3  CVE-2026-0002  ejemplo maven",
      "src/App.csproj  Newtonsoft.Json@12.0.1  CVE-2026-0003  ejemplo nuget",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
