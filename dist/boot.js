#!/usr/bin/env node

// src/boot.ts
import { existsSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import process from "process";
var REQUIRED_DEPS = ["@modelcontextprotocol/sdk", "sqlite-vec"];
var pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function depsPresent() {
  return REQUIRED_DEPS.every((dep) => existsSync(path.join(pluginRoot, "node_modules", dep)));
}
function installDeps() {
  const hasLock = existsSync(path.join(pluginRoot, "package-lock.json"));
  const args = hasLock ? ["ci", "--omit=dev", "--ignore-scripts"] : ["install", "--omit=dev", "--ignore-scripts"];
  process.stderr.write(`[boot] installing deps in ${pluginRoot} (npm ${args.join(" ")})
`);
  const res = spawnSync("npm", args, {
    cwd: pluginRoot,
    stdio: ["ignore", 2, 2],
    // ignore stdin; child stdout+stderr → parent stderr (keep stdout clean for MCP)
    shell: true
    // resolves npm.cmd on Windows
  });
  if (res.error) {
    const enoent = res.error.code === "ENOENT";
    if (enoent) {
      process.stderr.write(
        `[boot] 'npm' introuvable dans le PATH : impossible d'installer les d\xE9pendances dans ${pluginRoot}. Installe Node.js/npm puis relance, ou lance 'npm ci --omit=dev' manuellement dans ce dossier.
`
      );
    } else {
      process.stderr.write(`[boot] \xE9chec du lancement de npm : ${res.error.message}
`);
    }
    process.exit(1);
  }
  if (res.status !== 0) {
    process.stderr.write(
      `[boot] npm a \xE9chou\xE9 (code ${res.status ?? "inconnu"}) dans ${pluginRoot} : lance 'npm ${args.join(" ")}' manuellement pour voir l'erreur d\xE9taill\xE9e.
`
    );
    process.exit(1);
  }
}
async function main() {
  if (depsPresent()) {
    process.stderr.write("[boot] deps ok\n");
  } else {
    installDeps();
    if (!depsPresent()) {
      process.stderr.write(
        `[boot] d\xE9pendances toujours absentes apr\xE8s installation dans ${pluginRoot} : lance 'npm ci --omit=dev' manuellement dans ce dossier.
`
      );
      process.exit(1);
    }
    process.stderr.write("[boot] deps installed\n");
  }
  const serverUrl = new URL("./server.js", import.meta.url).href;
  await import(serverUrl);
}
main().catch((err) => {
  process.stderr.write(
    `[boot] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}
`
  );
  process.exit(1);
});
//# sourceMappingURL=boot.js.map