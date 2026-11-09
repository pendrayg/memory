import { existsSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * Process name shown by monitoring tools: "pendrayg_memory_<tier>" instead of "node".
 * No "claude-code" prefix — the server already runs *under* the Claude Code process. The tier suffix
 * (light | medium | heavy) tells which embedding model is loaded.
 */
export function processName(tier: string): string {
  const safe = (tier || 'light').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `pendrayg_memory_${safe}`;
}

/**
 * Windows: make the daemon run under a "pendrayg_memory_<tier>.exe" image name instead of "node.exe".
 *
 * Done at startup (not postinstall) on purpose: Claude Code installs plugin deps with
 * `npm install --ignore-scripts`, so postinstall never runs — but the server is always launched.
 * The current process can't rename itself, so we self-heal for the NEXT launch: copy the running
 * node binary to <pluginRoot>/bin/<name>.exe, which {@link spawnDaemon} prefers over `node`.
 * Entirely best-effort and cosmetic.
 *
 * It used to repoint `.mcp.json#command` instead — dead, and harmful, since the switch to an HTTP
 * endpoint: the MCP client no longer spawns anything, so an injected `command` would just sit in a
 * config that describes a URL. The hook that spawns the daemon picks the exe up directly.
 *
 * Because the name carries the tier, a tier switch produces a new target name; stale
 * pendrayg_memory_*.exe copies from previous tiers are pruned (skipping the one in use).
 */
export function ensureNamedBinary(name: string): void {
  if (process.env.MEMORY_DISABLE_RENAME === '1') return; // tests / dev: don't copy the exe or touch .mcp.json
  if (process.platform !== 'win32') return; // Linux/macOS CLI is already covered by process.title
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return;
    const root = path.resolve(path.dirname(scriptPath), '..'); // <root>/dist/server.js → <root>
    const binDir = path.join(root, 'bin');
    const exe = path.join(binDir, `${name}.exe`);

    if (path.basename(process.execPath).toLowerCase() === `${name}.exe`) return; // already named

    if (!existsSync(exe)) {
      mkdirSync(binDir, { recursive: true });
      copyFileSync(process.execPath, exe); // ~85 MB, one-time (until node upgrades)
    }

    // Prune orphan copies from previous tiers (e.g. switched light → medium). Skip the running exe.
    try {
      const running = path.basename(process.execPath).toLowerCase();
      for (const f of readdirSync(binDir)) {
        const low = f.toLowerCase();
        if (low.startsWith('pendrayg_memory_') && low.endsWith('.exe') && low !== `${name}.exe` && low !== running) {
          unlinkSync(path.join(binDir, f));
        }
      }
    } catch {
      /* best-effort prune */
    }
  } catch {
    /* best-effort: cosmetic rename must never block startup */
  }
}
