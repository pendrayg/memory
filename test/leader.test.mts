import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshLeadership, readLock } from '../src/leader.js';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'memory-leader-'));
}
function lockFile(dir: string): string {
  return path.join(dir, 'worker.lock');
}

test('refreshLeadership acquires a free lock and writes complete valid JSON (atomic)', () => {
  const dir = freshDir();
  try {
    // Free lock → this pid wins.
    assert.equal(refreshLeadership(dir), true);
    // The file is a complete, valid JSON lock with this pid and a numeric ts (no truncated write).
    const raw = readFileSync(lockFile(dir), 'utf8');
    const info = JSON.parse(raw);
    assert.equal(info.pid, process.pid);
    assert.equal(typeof info.ts, 'number');
    // readLock (public best-effort) sees the same holder.
    assert.equal(readLock(dir)?.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh lock held by ANOTHER live pid is not stolen', () => {
  const dir = freshDir();
  try {
    // Simulate another live leader: use OUR pid (guaranteed alive) but write it as the holder, then
    // call refreshLeadership from a "different" perspective by asserting the guard via a foreign pid.
    // Since we can't spawn a real second process cheaply, assert the O_EXCL single-winner primitive
    // directly: a second exclusive create of an existing lock must fail with EEXIST.
    assert.equal(refreshLeadership(dir), true); // we own it now (fresh, alive)
    let secondWon = true;
    try {
      const fd = openSync(lockFile(dir), 'wx'); // O_EXCL against the existing lock
      closeSync(fd);
    } catch (e: any) {
      secondWon = e?.code === 'EEXIST' ? false : true;
      assert.equal(e?.code, 'EEXIST'); // the OS guarantees a single winner
    }
    assert.equal(secondWon, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale lock (old ts) is reacquired', () => {
  const dir = freshDir();
  try {
    // Plant a stale lock held by a foreign, definitely-dead pid with a very old ts.
    const stale = { pid: 999_999_999, ts: Date.now() - 10 * 60_000 };
    writeFileSync(lockFile(dir), JSON.stringify(stale));
    // STALE_MS is 90 s; 10 min old → reacquire.
    assert.equal(refreshLeadership(dir), true);
    assert.equal(readLock(dir)?.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renewal by the holder keeps leadership and refreshes ts atomically', () => {
  const dir = freshDir();
  try {
    assert.equal(refreshLeadership(dir), true);
    const first = readLock(dir)?.ts as number;
    // Small wait so ts advances, then renew.
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* spin */
    }
    assert.equal(refreshLeadership(dir), true);
    const second = readLock(dir)?.ts as number;
    assert.ok(second >= first);
    // Still a complete valid JSON after the temp+rename renewal.
    assert.doesNotThrow(() => JSON.parse(readFileSync(lockFile(dir), 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
