import { get as httpGet } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processName } from './process-name.js';
import type { MemoryConfig } from './config.js';

/**
 * Starts the shared MCP daemon if it isn't up — called from the hooks, which are the only memory
 * code that runs as its own process now that `.mcp.json` points at an HTTP URL instead of a command.
 *
 * Nobody else can do it: the MCP client only connects to the URL, it never spawns anything. Hooks
 * run at session start AND on every prompt, which also makes this self-healing — if the daemon
 * idled out while the user was away, their next prompt brings it back.
 */

/**
 * The health route, declared here rather than in mcp-http.ts so the hook bundle doesn't drag in the
 * MCP SDK (tsup bundles it; hooks run on every prompt and must stay cheap to start).
 */
export const HEALTH_PATH = '/health';
/** Probe answer. Identifies OUR daemon — any other listener on the port must not be mistaken for it. */
export const HEALTH_BODY = 'memory-mcp';

/** Health probe budget. Loopback: a live daemon answers in ~1 ms; this only bounds the dead case. */
const PROBE_MS = 400;

/** True if OUR daemon answers on the port (any other listener → false, so we don't trust a squatter). */
function daemonAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: HEALTH_PATH, timeout: PROBE_MS }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body.trim() === HEALTH_BODY));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * The binary to launch: the tier-named copy prepared by {@link ensureNamedBinary} when it exists
 * (so the daemon shows up as `pendrayg_memory_heavy.exe` in a task manager rather than one more
 * anonymous `node.exe`), else the node running this hook — never a PATH lookup.
 */
function nodeBinary(bootPath: string, tier: string): string {
  const exe = path.join(path.dirname(path.dirname(bootPath)), 'bin', `${processName(tier)}.exe`);
  return process.platform === 'win32' && existsSync(exe) ? exe : process.execPath;
}

/**
 * @param waitMs how long to wait for a freshly spawned daemon to answer. `SessionStart` spends it
 * (it has a 20 s budget) because the MCP client dials the URL at about the same moment: a daemon
 * that isn't listening yet costs that session its memory tools. Per-prompt calls pass 0 — by then
 * the client is connected, and a hook must never make the user wait.
 */
export async function ensureDaemon(cfg: MemoryConfig, waitMs = 0): Promise<void> {
  if (process.env.MEMORY_MCP_HTTP === '0') return; // opted back into per-session stdio servers
  if (await daemonAlive(cfg.mcpPort)) return;

  // Through boot.js, not server.js: a freshly updated plugin ships an empty node_modules and boot
  // self-heals it. Spawned directly, no shell — which is how the daemon escapes the cmd.exe +
  // conhost.exe escort that Windows gave every stdio MCP server.
  const boot = fileURLToPath(new URL('./boot.js', import.meta.url));
  const child = spawn(nodeBinary(boot, cfg.embed.tier), ['--no-warnings', boot, '--http'], {
    detached: true, // survives this hook, and every session that spawned it
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Two sessions racing both spawn; the loser dies on EADDRINUSE, so waiting is never wasted — the
  // winner is what we end up seeing. Once it answers /health it also accepts MCP: it binds before
  // opening the store, and holds `initialize` until that's done (see runHttp).
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await daemonAlive(cfg.mcpPort)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
