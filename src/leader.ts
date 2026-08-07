import { readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Single-leader election across the MCP server instances (one per open Claude Code session).
 * Only the leader runs the heavy background work (model load + backfill + digest), so N sessions
 * don't each load the embedding model (~hundreds of MB) nor each spawn redundant `claude -p` digests
 * (which would multiply the quota cost). Non-leaders stay light and only load the model lazily if
 * the user actually runs a semantic search.
 *
 * Mechanism: a lock file holding {pid, ts}. A leader renews `ts` on a heartbeat; the lock is
 * considered free if its `ts` is stale or its `pid` is dead. No daemon, no socket — just a file.
 *
 * Concurrency (the hard part on Windows, N sibling processes):
 *   - Acquisition of a free/stale lock uses `openSync(file, 'wx')` (O_EXCL): the OS guarantees a
 *     SINGLE winner — every other process gets EEXIST and stays a follower. This is what prevents
 *     several followers from all electing themselves the instant the leader releases the lock (which
 *     would load the ~2 GB model N times and blow up RAM).
 *   - Renewal by the current holder uses a temp-file + `renameSync` so a concurrent reader never
 *     observes a truncated/partial lock (a bare `writeFileSync` truncates-then-writes, and under
 *     Windows share violations a reader could then see an empty/half file → mistake it for "free").
 *   - Reads distinguish ENOENT (truly free) from transient errors (EBUSY/EPERM/share violation/
 *     invalid JSON mid-write) and retry the latter, so a transient read NEVER looks like a free lock.
 */

// Stale threshold ≫ the heartbeat interval so a busy (but alive) leader is never usurped, but low
// enough that a HARD-killed leader (no clean release) is taken over reasonably fast.
const STALE_MS = 90_000;

// Transient-read retry budget. A renewing leader's rename window is sub-millisecond, so a couple of
// short retries comfortably rides out an in-progress write / share violation without electing a
// second leader. Kept tiny so a heartbeat call never blocks the event loop meaningfully.
const READ_RETRIES = 3;
const READ_RETRY_MS = 10;

// Last definitive leadership verdict for THIS process. Only read in the transient-read branch, so a
// holder that momentarily can't read the lock keeps its crown instead of falsely emitting a
// lostLeadership (which would dispose + later reload the ~2 GB model). One module instance per
// process = one election participant, so a plain module-level flag is correct.
let amHolder = false;

function lockPath(dataDir: string): string {
  return path.join(dataDir, 'worker.lock');
}

/** Per-pid temp path for atomic renewal (rename onto the real lock). Unique so siblings never clash. */
function tempPath(dataDir: string): string {
  return path.join(dataDir, `worker.lock.${process.pid}.tmp`);
}

/** True if a process with this pid exists (signal 0 probes without killing). EPERM ⇒ alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export interface LockInfo {
  pid?: number;
  ts?: number;
  /** Leader's loopback embedding endpoint (published so non-leaders can route query embeddings). */
  port?: number;
  token?: string;
}

/** Outcome of a strict read: the lock is absent (free), present (parsed), or unreadable right now. */
type ReadResult =
  | { kind: 'absent' } // ENOENT — the lock truly does not exist → free to acquire
  | { kind: 'present'; info: LockInfo } // a complete, valid lock
  | { kind: 'transient' }; // EBUSY/EPERM/share violation/partial JSON — DO NOT treat as free

function busySleep(ms: number): void {
  // Synchronous micro-wait between read retries. `refreshLeadership` is a sync heartbeat call and the
  // total budget is a few ms, so this is intentionally simple (no async plumbing through callers).
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin briefly */
  }
}

/**
 * Strict internal read used by the ELECTION. Unlike {@link readLock} (best-effort, public), this
 * classifies failures: ENOENT ⇒ absent (free), anything else (busy/partial/invalid JSON) ⇒ transient
 * and is retried a few times. A transient failure is never reported as "free" — that misclassification
 * was the root cause of followers stealing leadership from a live leader mid-write.
 */
function readLockStrict(dataDir: string): ReadResult {
  const file = lockPath(dataDir);
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    try {
      const raw = readFileSync(file, 'utf8');
      const info = JSON.parse(raw) as LockInfo;
      return { kind: 'present', info };
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { kind: 'absent' }; // genuinely no lock → free
      // EBUSY/EPERM/EACCES (Windows share violation) or a SyntaxError from a half-written file:
      // retry briefly; the writer's rename window is tiny.
      if (attempt < READ_RETRIES - 1) busySleep(READ_RETRY_MS);
    }
  }
  return { kind: 'transient' };
}

/**
 * Reads the current lock (for non-leaders to find the leader's embedding endpoint). Best-effort:
 * returns null on ANY failure. Kept for public callers (memory-server reads port/token); the
 * election uses {@link readLockStrict} instead, which must not conflate "busy" with "free".
 */
export function readLock(dataDir: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Releases leadership IF this process currently holds the lock (pid match). Called on exit/session
 * close so a sibling can take over immediately on its next heartbeat — no waiting for the stale
 * timeout or an unreliable Windows pid-liveness probe. No-op if we're not the lock holder.
 */
export function releaseLeadership(dataDir: string): void {
  try {
    const cur = readLock(dataDir);
    if (cur && cur.pid === process.pid) unlinkSync(lockPath(dataDir));
  } catch {
    /* best-effort */
  }
}

/** Removes a stale/dead lock so the exclusive acquire can re-create it. Ignores ENOENT (already gone). */
function removeStaleLock(file: string): void {
  try {
    unlinkSync(file);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e; // a real error (EPERM/EBUSY) → let the caller stay a follower
  }
}

/**
 * Exclusive create: the SINGLE-WINNER primitive. `openSync(file, 'wx')` is O_CREAT|O_EXCL, so exactly
 * one process across all sessions creates the file; every concurrent caller gets EEXIST and returns
 * false (stays a follower). Returns true iff THIS process created (and now owns) the lock.
 */
function tryCreateExclusive(file: string, content: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'wx'); // throws EEXIST if the lock already exists → we lose the race
    writeFileSync(fd, content);
    return true;
  } catch (e: any) {
    if (e?.code === 'EEXIST') return false; // someone else won → follower
    return false; // EPERM/EBUSY/etc. → don't claim leadership on a shaky write
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Atomic renewal by the current holder: write a per-pid temp then `renameSync` onto the real lock.
 * A reader either sees the old complete file or the new complete file — never a truncated one.
 * Returns true on success. Cleans up the temp on failure.
 */
function atomicRenew(dataDir: string, file: string, content: string): boolean {
  const tmp = tempPath(dataDir);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file); // atomic replace on both POSIX and Windows (same volume)
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp may not exist */
    }
    return false;
  }
}

/**
 * Acquire or renew leadership. Returns true iff THIS process is the leader after the call.
 * Safe to call repeatedly (heartbeat + fs.watch). Designed so that, when the lock is free/stale,
 * exactly one of N concurrent siblings wins (via O_EXCL) — no two-leaders window on release.
 *
 * @param extra optional fields to publish into the lock (e.g. the leader's loopback endpoint).
 */
export function refreshLeadership(dataDir: string, extra?: Record<string, unknown>): boolean {
  const file = lockPath(dataDir);
  const now = Date.now();

  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* dir likely exists; a real failure surfaces below */
  }

  const content = JSON.stringify({ pid: process.pid, ts: now, ...(extra ?? {}) });
  const read = readLockStrict(dataDir);

  // Case 1: lock genuinely absent → race for it. Exactly one sibling wins via O_EXCL.
  if (read.kind === 'absent') {
    return (amHolder = tryCreateExclusive(file, content));
  }

  // Case 2: read is unreadable right now (busy/partial). We must NOT treat this as free (that would
  // steal from a live leader). Return our LAST verdict: a holder keeps its crown (avoids a spurious
  // lostLeadership → model dispose/reload), a follower stays a follower. Resolves next heartbeat.
  if (read.kind === 'transient') {
    return amHolder;
  }

  const cur = read.info;

  // Case 3: we already hold the lock → renew atomically (temp + rename), refreshing ts/extra.
  if (cur.pid === process.pid) {
    return (amHolder = atomicRenew(dataDir, file, content));
  }

  // Case 4: held by someone else. Keep it if it's fresh AND its pid is alive.
  const fresh = typeof cur.ts === 'number' && now - cur.ts < STALE_MS;
  const alive = typeof cur.pid === 'number' && pidAlive(cur.pid);
  if (fresh && alive) return (amHolder = false); // a healthy leader — stay follower

  // Case 5: stale or dead holder → take over. Remove the corpse then race exclusively for a fresh
  // lock. If another sibling beats us to the recreate (EEXIST), it becomes leader → we stay follower.
  try {
    removeStaleLock(file);
  } catch {
    return (amHolder = false); // couldn't clear the stale lock (EPERM/EBUSY) → don't claim
  }
  return (amHolder = tryCreateExclusive(file, content));
}
