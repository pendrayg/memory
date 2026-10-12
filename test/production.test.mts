import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/store.js';

// active_ms round-trips through the schema, and productionForSessions reads it per session
// (0 for a session with no timing / predating the feature).
test('productionForSessions reads active_ms per session', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-prod-'));
  const store = new MemoryStore(path.join(dir, 'm.db'), 384, '', 1);
  await store.init();
  try {
    store.upsert('s1:session', { type: 'session', session_id: 's1', project: 'p', ts: '2026-01-01T10:00:00Z', summary: 'ticket ABC-1', active_ms: 90 * 60_000 });
    store.upsert('s2:session', { type: 'session', session_id: 's2', project: 'p', ts: '2026-01-02T10:00:00Z', summary: 'ticket ABC-1 suite', active_ms: 30 * 60_000 });
    store.upsert('s3:session', { type: 'session', session_id: 's3', project: 'p', ts: '2026-01-03T10:00:00Z', summary: 'legacy no timing' }); // active_ms absent

    const rows = store.productionForSessions(['s1', 's2', 's3']);
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    assert.equal(byId.get('s1')!.active_ms, 90 * 60_000);
    assert.equal(byId.get('s2')!.active_ms, 30 * 60_000);
    assert.equal(byId.get('s3')!.active_ms, 0, 'missing timing → 0');

    const total = rows.reduce((s, r) => s + r.active_ms, 0);
    assert.equal(total, 120 * 60_000, 'sums to 2h');
    assert.equal(store.productionForSessions([]).length, 0, 'empty input → empty');
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL lock — best-effort */ }
  }
});
