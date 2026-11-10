import { spawnSync } from 'node:child_process';

/** How often the daemon asks the OS whether any Claude Code is still around. */
const WATCH_INTERVAL_MS = 300_000;

/** Consecutive empty probes before giving up. Two, so one transient miss never kills the daemon. */
const MISSES_BEFORE_EXIT = 2;

/**
 * Is any Claude Code process alive on this machine?
 *
 * `true` / `false` are answers; `null` means the probe itself is unusable (spawn error, missing
 * binary, unexpected output) — the caller must NOT treat that as "nobody is there".
 */
export function claudeIsRunning(exec: typeof spawnSync = spawnSync): boolean | null {
  const windows = process.platform === 'win32';
  const probe = windows
    ? exec('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
    : exec('pgrep', ['-f', 'claude'], { encoding: 'utf8' });

  if (!probe || probe.error || typeof probe.stdout !== 'string') return null;
  if (windows) {
    // `tasklist` exits 0 even with no match ("INFO: no tasks are running..."): the presence of the
    // executable name in the output is what decides, not the status code.
    return probe.status === 0 ? /claude\.exe/i.test(probe.stdout) : null;
  }
  if (probe.status === 1) return false; // pgrep: 1 = no process matched
  return probe.status === 0 ? probe.stdout.trim() !== '' : null;
}

/**
 * Client watchdog. The idle watchdog keys off TRAFFIC, which says nothing about whether a client
 * could still show up: after the last window closes, the heavy tier would sit on ~676 MB for the
 * whole idle timeout. This one keys off the existence of a possible client instead — no Claude Code
 * on the machine for two consecutive probes and the daemon has nobody left to serve, so it exits.
 * The next `SessionStart` spawns it again; backfill and digests resume where they stopped.
 *
 * Fail-open on an unusable probe (`null`): leaking a daemon is benign, cutting the MCP surface out
 * from under a live session is not.
 */
export function startClaudeWatch({
  log,
  exit,
  intervalMs = WATCH_INTERVAL_MS,
  probe = claudeIsRunning,
}: {
  log: (message: string) => void;
  exit: () => void;
  intervalMs?: number;
  probe?: () => boolean | null;
}): NodeJS.Timeout {
  let misses = 0;
  const timer = setInterval(() => {
    const alive = probe();
    if (alive === null) {
      misses = 0;
      log('[server] Claude Code probe unusable — daemon stays up');
      return;
    }
    misses = alive ? 0 : misses + 1;
    if (misses >= MISSES_BEFORE_EXIT) {
      clearInterval(timer);
      log(`[server] no Claude Code for ${Math.round((MISSES_BEFORE_EXIT * intervalMs) / 60_000)} min → exit`);
      exit();
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
