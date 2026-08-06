// Runtime bootstrap for the MCP server.
//
// Why this file exists: the bundled server (dist/server.js) imports the MCP SDK plus native deps
// (onnxruntime-node, sqlite-vec, sharp, @huggingface/transformers) from node_modules at runtime —
// they are NOT bundled. Claude Code runs `npm install --ignore-scripts` on the FIRST install of a
// plugin, but NOT when it *updates* to a new version: the new versioned folder ships with an empty
// node_modules and the server crashes at boot ("Cannot find package '@modelcontextprotocol/sdk'").
// There is no official postinstall/build hook on the update path, and we can't commit node_modules
// (native binaries are per-platform). So this entry self-heals: if the deps are missing, install
// them once, then hand off to the real server.
//
// HARD CONSTRAINT: this file must run with an EMPTY node_modules, so it may only import node
// builtins — no SDK, no native deps, and no internal module that transitively imports them.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Sentinel packages: if either is missing we treat node_modules as not (fully) installed.
// One JS-only dep (the SDK) + one native dep (sqlite-vec) covers both failure classes.
const REQUIRED_DEPS = ['@modelcontextprotocol/sdk', 'sqlite-vec'] as const;

// dist/boot.js → the plugin root is two levels up. CLAUDE_PLUGIN_ROOT wins when Claude Code sets it.
const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function depsPresent(): boolean {
  return REQUIRED_DEPS.every((dep) => existsSync(path.join(pluginRoot, 'node_modules', dep)));
}

/**
 * Install production deps into pluginRoot. Mirrors Claude Code's own behavior:
 *  - `npm ci` when a lockfile is present (reproducible), else `npm install`.
 *  - `--omit=dev` (only runtime deps) and `--ignore-scripts` (native deps ship prebuilds in their
 *    tarballs, so their install scripts aren't needed — and running them would be a trust/latency cost).
 *
 * CRITICAL: stdout is the MCP protocol channel. npm's own stdout MUST NOT reach it, so the child's
 * stdout is redirected to the parent's stderr (`stdio: ['ignore', 2, 2]`). All our logs go to stderr too.
 * On Windows npm is `npm.cmd`; `shell: true` lets the OS resolve it from PATH.
 */
function installDeps(): void {
  const hasLock = existsSync(path.join(pluginRoot, 'package-lock.json'));
  const args = hasLock
    ? ['ci', '--omit=dev', '--ignore-scripts']
    : ['install', '--omit=dev', '--ignore-scripts'];

  process.stderr.write(`[boot] installing deps in ${pluginRoot} (npm ${args.join(' ')})\n`);

  const res = spawnSync('npm', args, {
    cwd: pluginRoot,
    stdio: ['ignore', 2, 2], // ignore stdin; child stdout+stderr → parent stderr (keep stdout clean for MCP)
    shell: true, // resolves npm.cmd on Windows
  });

  if (res.error) {
    const enoent = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    if (enoent) {
      process.stderr.write(
        `[boot] 'npm' introuvable dans le PATH : impossible d'installer les dépendances dans ${pluginRoot}. ` +
          `Installe Node.js/npm puis relance, ou lance 'npm ci --omit=dev' manuellement dans ce dossier.\n`,
      );
    } else {
      process.stderr.write(`[boot] échec du lancement de npm : ${res.error.message}\n`);
    }
    process.exit(1);
  }

  if (res.status !== 0) {
    process.stderr.write(
      `[boot] npm a échoué (code ${res.status ?? 'inconnu'}) dans ${pluginRoot} : ` +
        `lance 'npm ${args.join(' ')}' manuellement pour voir l'erreur détaillée.\n`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (depsPresent()) {
    process.stderr.write('[boot] deps ok\n');
  } else {
    installDeps(); // single attempt, no retry/backoff — keep it simple
    if (!depsPresent()) {
      // npm exited 0 but the sentinels are still missing → surface it instead of a cryptic import crash.
      process.stderr.write(
        `[boot] dépendances toujours absentes après installation dans ${pluginRoot} : ` +
          `lance 'npm ci --omit=dev' manuellement dans ce dossier.\n`,
      );
      process.exit(1);
    }
    process.stderr.write('[boot] deps installed\n');
  }

  // Hand off to the real server. The specifier is built at runtime (new URL) so tsup can't statically
  // analyze it and won't bundle server.js into boot.js — boot.js must stay dependency-free until deps exist.
  const serverUrl = new URL('./server.js', import.meta.url).href;
  await import(serverUrl);
}

main().catch((err) => {
  process.stderr.write(
    `[boot] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
