import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { spawnSync } from 'node:child_process';
import { claudeIsRunning, startClaudeWatch } from '../src/claude-watch.js';
import { loadConfig } from '../src/config.js';

const windows = process.platform === 'win32';

/** Fake `spawnSync` result — only the fields the probe reads. No real process is ever spawned. */
function fakeExec(result: unknown): typeof spawnSync {
  return (() => result) as unknown as typeof spawnSync;
}

/** Runs the watch with a tiny interval and resolves with `true` as soon as it decides to exit. */
function runWatch(probe: () => boolean | null, probes: number): Promise<boolean> {
  return new Promise((resolve) => {
    let calls = 0;
    const timer = startClaudeWatch({
      log: () => {},
      exit: () => resolve(true),
      intervalMs: 1,
      probe: () => {
        if (++calls >= probes) setTimeout(() => resolve(false), 5);
        return probe();
      },
    });
    // Kept ref'd: the watch timer is unref'd by design, so something must hold the event loop open.
    setTimeout(() => {
      clearInterval(timer);
      resolve(false);
    }, 200);
  });
}

test('claudeIsRunning: a matching process reads as present', () => {
  const stdout = windows ? 'claude.exe                    1234 Console    1    120 000 Ko\n' : '1234\n5678\n';
  assert.equal(claudeIsRunning(fakeExec({ status: 0, stdout })), true);
});

test('claudeIsRunning: no match reads as absent', () => {
  // tasklist exits 0 with an informational line even when nothing matched.
  const absent = windows
    ? { status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\n' }
    : { status: 1, stdout: '' };
  assert.equal(claudeIsRunning(fakeExec(absent)), false);
});

test('claudeIsRunning: an unusable probe reads as null, never as absent', () => {
  assert.equal(claudeIsRunning(fakeExec({ error: new Error('ENOENT'), stdout: '' })), null);
  assert.equal(claudeIsRunning(fakeExec({ status: 0, stdout: undefined })), null);
  assert.equal(claudeIsRunning(fakeExec(undefined)), null);
  assert.equal(claudeIsRunning(fakeExec({ status: 2, stdout: 'access denied' })), null); // unexpected status
});

test('startClaudeWatch exits after two consecutive empty probes', async () => {
  assert.equal(await runWatch(() => false, 10), true);
});

test('startClaudeWatch never exits while Claude Code is there', async () => {
  assert.equal(await runWatch(() => true, 10), false);
});

test('a single empty probe between two live ones does not exit', async () => {
  const answers = [true, false, true, false, true, true];
  let i = 0;
  assert.equal(await runWatch(() => answers[i++ % answers.length]!, 12), false);
});

test('an unusable probe never exits, however often it repeats', async () => {
  assert.equal(await runWatch(() => null, 10), false);
});

test('MEMORY_MCP_CLIENT_WATCH=0 turns the watch off (on by default)', () => {
  const previous = process.env.MEMORY_MCP_CLIENT_WATCH;
  try {
    delete process.env.MEMORY_MCP_CLIENT_WATCH;
    assert.equal(loadConfig().mcpClientWatch, true);
    process.env.MEMORY_MCP_CLIENT_WATCH = '0';
    assert.equal(loadConfig().mcpClientWatch, false);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_MCP_CLIENT_WATCH;
    else process.env.MEMORY_MCP_CLIENT_WATCH = previous;
  }
});
