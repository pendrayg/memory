import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  REPO,
  freshDataDir,
  cleanup,
  baseEnv,
  readLock,
  pidAlive,
  runHook,
  startServer,
  startHttpDaemon,
  connectHttp,
  httpHealth,
  call,
  pollUntil,
  sleep,
} from './helpers.mjs';

const VECTO_TIMEOUT = 180_000; // first run may download the light model (~120 MB) + vectorize

/** Runs a one-shot node script (e.g. migrate) to completion. */
function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', args, { env, stdio: 'ignore' });
    child.on('close', (code) => resolve(code));
  });
}

// 1.1 — Leader failover: leader exits → a follower takes over within ~1s (lock released + fs.watch).
test('1.1 leader failover', { timeout: 60_000 }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir, { MEMORY_EMBED_ENABLED: '0' }); // no model → fast, election only
  let a, b;
  try {
    a = await startServer(env);
    const lock1 = await pollUntil(() => readLock(dataDir), { label: 'A becomes leader' });
    const pidA = lock1.pid;
    assert.ok(pidA, 'A wrote a leader lock');

    b = await startServer(env);
    await sleep(1000);
    assert.equal(readLock(dataDir).pid, pidA, 'B is a follower while A leads');

    await a.close(); // ends A's stdin → releaseAndExit removes the lock
    const lock2 = await pollUntil(
      () => {
        const l = readLock(dataDir);
        return l && l.pid !== pidA ? l : null;
      },
      { timeoutMs: 15_000, label: 'B takes over' },
    );
    assert.notEqual(lock2.pid, pidA, 'leadership moved off A');
    assert.ok(pidAlive(lock2.pid), 'new leader is alive');
  } finally {
    await b?.close();
    await a?.close();
    cleanup(dataDir);
  }
});

// 1.2 — Follower routes query embedding to the leader's loopback service (QueryExecutor Strategy:
// RemoteExecutor). A follower must NOT load its own model; its semantic search only works if it
// reaches the leader. The query shares no token with the doc, so a hit can only come from a vector
// match — proving the remote-embed path (leader publishes endpoint → follower posts /embed).
test('1.2 follower routes query embed to leader', { timeout: 240_000 }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir); // embed enabled (light tier)
  const cwd = path.join(dataDir, 'proj12');
  let leader, follower;
  try {
    await runHook(
      'prompt',
      {
        session_id: 't12',
        prompt: 'Le déploiement en production utilise la pipeline Azure DevOps tous les vendredis',
        cwd,
      },
      env,
    );
    leader = await startServer(env);

    // Leader publishes its loopback endpoint (port + token) in the lock once the service is up.
    const lock = await pollUntil(
      () => {
        const l = readLock(dataDir);
        return l?.port && l?.token ? l : null;
      },
      { label: 'leader publishes loopback endpoint' },
    );
    const pidLeader = lock.pid;

    // Leader vectorizes the doc (backfill) → leader semantic search returns it.
    await pollUntil(
      async () => {
        const r = await call(leader.client, 'memory_search', {
          query: 'publier le logiciel en ligne chaque fin de semaine',
        });
        return /DevOps|production|vendredis/.test(r) ? r : null;
      },
      { timeoutMs: VECTO_TIMEOUT, stepMs: 1000, label: 'leader vectorized the doc' },
    );

    // Start a follower; it stays a follower (leader alive) → its executor is RemoteExecutor.
    follower = await startServer(env);
    await sleep(500);
    assert.equal(readLock(dataDir).pid, pidLeader, 'follower did not steal leadership');

    // Follower's semantic search (paraphrase, no shared token) only succeeds by routing to the leader.
    const r = await pollUntil(
      async () => {
        const x = await call(follower.client, 'memory_search', {
          query: 'publier le logiciel en ligne chaque fin de semaine',
        });
        return /DevOps|production|vendredis/.test(x) ? x : null;
      },
      { timeoutMs: 30_000, stepMs: 1000, label: 'follower semantic search via leader' },
    );
    assert.match(r, /DevOps|production|vendredis/, 'follower got the semantic hit by routing query embed to the leader');
  } finally {
    await follower?.close();
    await leader?.close();
    cleanup(dataDir);
  }
});

// 2.1 — Create a memory (hook) → BM25 search → semantic search → delete → gone.
test('2.1 tools: memory BM25 + vecto + delete', { timeout: 240_000 }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir);
  const cwd = path.join(dataDir, 'proj21');
  let srv;
  try {
    // Memory created BEFORE the server starts → startup backfill vectorizes it.
    await runHook(
      'prompt',
      {
        session_id: 't21',
        prompt: 'Le déploiement en production utilise la pipeline Azure DevOps tous les vendredis',
        cwd,
      },
      env,
    );
    srv = await startServer(env);

    // BM25: query has an exact token of the doc; assert a DOC-ONLY word (not in the query echo) shows.
    const bm25 = await call(srv.client, 'memory_search', { query: 'déploiement pipeline' });
    assert.match(bm25, /DevOps|production|vendredis/, 'BM25 finds the memory by exact word');

    // Semantic: paraphrase with NO shared token → a doc-only word can only come from the vector hit.
    const vecto = await pollUntil(
      async () => {
        const r = await call(srv.client, 'memory_search', {
          query: 'publier le logiciel en ligne chaque fin de semaine',
        });
        return /DevOps|production|vendredis/.test(r) ? r : null;
      },
      { timeoutMs: VECTO_TIMEOUT, stepMs: 1000, label: 'semantic search returns the memory' },
    );
    assert.match(vecto, /DevOps|production|vendredis/, 'semantic search finds the memory via embeddings');

    // Delete → gone (empty result message).
    await call(srv.client, 'memory_delete', { idPrefix: 't21:' });
    const after = await call(srv.client, 'memory_search', { query: 'déploiement pipeline' });
    assert.match(after, /No memory/, 'memory is gone after delete');
  } finally {
    await srv?.close();
    cleanup(dataDir);
  }
});

// 2.2 — Core memory added in one session is injected at the start of the next session.
test('2.2 core memory injected at SessionStart', { timeout: 60_000 }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir, { MEMORY_EMBED_ENABLED: '0' }); // cores need no vectors
  const cwd = path.join(dataDir, 'proj22');
  let srv;
  try {
    srv = await startServer(env);
    const CORE = 'Toujours utiliser pnpm et jamais npm dans ce projet';
    await call(srv.client, 'memory_core_add', { text: CORE });

    // A new session starts → SessionStart hook must inject the core.
    const start1 = await runHook('sessionstart', { cwd }, env);
    const ctx1 = start1?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx1, /pnpm/, 'core memory present in SessionStart context');
    assert.match(ctx1, /Core memory/i, 'core section header present');

    // Remove it → no longer injected.
    const list = await call(srv.client, 'memory_core_list', {});
    const id = (list.match(/core:[0-9a-f]+/) ?? [])[0];
    assert.ok(id, 'a core id is listed');
    await call(srv.client, 'memory_core_remove', { id });

    const start2 = await runHook('sessionstart', { cwd }, env);
    const ctx2 = start2?.hookSpecificOutput?.additionalContext ?? '';
    assert.doesNotMatch(ctx2, /pnpm/, 'core memory gone after remove');
  } finally {
    await srv?.close();
    cleanup(dataDir);
  }
});

// 2.3 — Migrate a tiny claude-mem DB (2 observations) → search (BM25 + vecto) → delete.
test('2.3 claude-mem migration', { timeout: 240_000 }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir);
  const cmDb = path.join(dataDir, 'claude-mem.db');
  let srv;
  try {
    // Build a minimal claude-mem DB (only the `observations` table is required; migrate's safeAll
    // tolerates the others being absent).
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(cmDb);
    db.exec(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, created_at TEXT,
      prompt_number INTEGER, title TEXT, subtitle TEXT, narrative TEXT, facts TEXT, text TEXT,
      type TEXT, files_read TEXT, files_modified TEXT);`);
    const ins = db.prepare(
      `INSERT INTO observations (id, memory_session_id, project, created_at, title, subtitle, type)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    );
    const now = new Date().toISOString();
    ins.run(1, 'sess', 'projX', now, 'Configuration du cache Redis pour les sessions', 'TTL 1h', 'decision');
    ins.run(2, 'sess', 'projX', now, 'Correction du bug de pagination sur la liste produits', 'offset', 'bugfix');
    db.close();

    const code = await runNode([path.join(REPO, 'dist', 'migrate.js'), '--db', cmDb], env);
    assert.equal(code, 0, 'migrate.js exits 0');

    srv = await startServer(env);

    // BM25 on exact words from the two observations; assert a doc-only word (not in the query echo).
    const r1 = await call(srv.client, 'memory_search', { query: 'Redis cache' });
    assert.match(r1, /Configuration|sessions/, 'migrated obs #1 found by BM25');
    const r2 = await call(srv.client, 'memory_search', { query: 'pagination produits' });
    assert.match(r2, /Correction|liste/, 'migrated obs #2 found by BM25');

    // Semantic: paraphrase with no shared token → a doc-only word proves the vector hit.
    const vecto = await pollUntil(
      async () => {
        const r = await call(srv.client, 'memory_search', {
          query: 'stockage rapide en mémoire des connexions utilisateurs',
        });
        return /Configuration|Correction|sessions|liste/.test(r) ? r : null;
      },
      { timeoutMs: VECTO_TIMEOUT, stepMs: 1000, label: 'semantic search returns a migrated memory' },
    );
    assert.match(vecto, /Configuration|Correction|sessions|liste/, 'semantic search finds a migrated memory');

    // Delete all migrated docs → gone.
    await call(srv.client, 'memory_delete', { idPrefix: 'migrated:' });
    const after = await call(srv.client, 'memory_search', { query: 'Redis pagination' });
    assert.match(after, /No memory/, 'migrated memories gone after delete');
  } finally {
    await srv?.close();
    cleanup(dataDir);
  }
});

// 2.4 — Auto-recall: the UserPromptSubmit hook injects the relevant memory into the prompt context.
// The recall query is a paraphrase with NO shared token, so a hit can only come from the hybrid path
// (hook embeds the query via the leader's loopback service) — proving lever B end-to-end.
test('2.4 auto-recall injects relevant memory into the prompt', { timeout: 240_000 }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir); // auto-recall is ON by default; embed enabled (light)
  const cwd = path.join(dataDir, 'proj24');
  let srv;
  try {
    await runHook(
      'prompt',
      {
        session_id: 't24a',
        prompt: 'Le déploiement en production utilise la pipeline Azure DevOps tous les vendredis',
        cwd,
      },
      env,
    );
    srv = await startServer(env); // leader: vectorizes the doc + serves the loopback embed

    // Wait until the doc is vectorized (leader semantic search returns it).
    await pollUntil(
      async () => {
        const r = await call(srv.client, 'memory_search', { query: 'publier le logiciel en ligne' });
        return /DevOps|production|vendredis/.test(r) ? r : null;
      },
      { timeoutMs: VECTO_TIMEOUT, stepMs: 1000, label: 'doc vectorized' },
    );

    // A NEW session sends a paraphrase prompt → the prompt hook must inject the memory via auto-recall
    // (BM25 can't match — no shared token — so success proves the hook→leader hybrid embed path).
    const ctx = await pollUntil(
      async () => {
        const o = await runHook(
          'prompt',
          { session_id: 't24b', prompt: 'comment publier le logiciel en ligne chaque fin de semaine ?', cwd },
          env,
        );
        const c = o?.hookSpecificOutput?.additionalContext ?? '';
        return /DevOps|production|vendredis/.test(c) ? c : null;
      },
      { timeoutMs: 30_000, stepMs: 1500, label: 'auto-recall injects the memory' },
    );
    assert.match(ctx, /DevOps|production|vendredis/, 'auto-recall injected the relevant memory into the prompt');
    assert.match(ctx, /Related memories/, 'injection carries the auto-recall header');
  } finally {
    await srv?.close();
    cleanup(dataDir);
  }
});

// 2.5 — Doc ingestion (Tier 2): add a page body → chunked + vectorized → found by BM25 and by a
// no-shared-token paraphrase (semantic) → listed → removed. Idempotent re-ingest doesn't duplicate.
test('2.5 doc ingestion: chunk, search, list, remove', { timeout: VECTO_TIMEOUT }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir); // embed enabled (light) so we exercise the vector path
  let srv;
  try {
    srv = await startServer(env);
    const URL = 'https://confluence.example.com/display/OCT/Composant-Quarantaine';
    const BODY =
      'La quarantaine des offres met en attente les annonces suspectes avant publication. ' +
      'Une offre passe en quarantaine quand le détecteur de fraude lève une alerte de score élevé. ' +
      'Un opérateur peut ensuite valider ou rejeter manuellement chaque offre depuis le back-office.';

    const add = await call(srv.client, 'memory_doc_add', {
      url: URL,
      title: 'Composant Quarantaine',
      text: BODY,
      labels: ['quarantaine', 'fraude'],
    });
    assert.match(add, /Doc ingested/, 'add reports success');
    const docId = (add.match(/doc:[0-9a-f]+/) ?? [])[0];
    assert.ok(docId, 'a doc_id is returned');

    // BM25 on exact words.
    const bm25 = await call(srv.client, 'memory_search', { query: 'quarantaine offres', type: 'doc' });
    assert.match(bm25, /Quarantaine/, 'doc found by BM25 with type filter');

    // Idempotent re-ingest: same URL → still one doc listed.
    await call(srv.client, 'memory_doc_add', {
      url: URL,
      title: 'Composant Quarantaine',
      text: BODY,
      labels: ['quarantaine', 'fraude'],
    });
    const list = await call(srv.client, 'memory_doc_list', {});
    assert.match(list, /1 ingested doc/, 're-ingest does not duplicate');
    assert.match(list, /quarantaine, fraude/, 'labels listed');

    // Semantic: paraphrase with no shared token → only a vector hit can match.
    const vecto = await pollUntil(
      async () => {
        const r = await call(srv.client, 'memory_search', {
          query: 'mise en attente des annonces douteuses avant mise en ligne',
        });
        return /Quarantaine/.test(r) ? r : null;
      },
      { timeoutMs: VECTO_TIMEOUT, stepMs: 1000, label: 'doc chunk vectorized + semantically found' },
    );
    assert.match(vecto, /Quarantaine/, 'semantic search finds the ingested doc');

    // Remove → gone.
    const rm = await call(srv.client, 'memory_doc_remove', { doc_id: docId });
    assert.match(rm, /Removed doc/, 'remove reports success');
    const after = await call(srv.client, 'memory_doc_list', {});
    assert.match(after, /No ingested doc/, 'doc gone after remove');
  } finally {
    await srv?.close();
    cleanup(dataDir);
  }
});

// 1.6 — Shared HTTP daemon: ONE process serves several sessions, and a second daemon on the same
// port exits instead of competing. This is what removes the per-session server (plus its cmd.exe +
// conhost.exe on Windows) — the whole reason the MCP surface moved off stdio.
test('1.6 one HTTP daemon serves several sessions', { timeout: 60_000 }, async () => {
  const dataDir = freshDataDir();
  const env = baseEnv(dataDir, { MEMORY_EMBED_ENABLED: '0' }); // no model → fast; transport is the subject
  const port = 47_900 + Math.floor(Math.random() * 90); // avoid a port left by a previous run
  let daemon, a, b;
  try {
    daemon = await startHttpDaemon(env, port);

    // Two independent clients, as two Claude sessions would be.
    a = await connectHttp(port);
    b = await connectHttp(port);
    const [statsA, statsB] = await Promise.all([call(a, 'memory_stats'), call(b, 'memory_stats')]);
    for (const s of [statsA, statsB]) assert.match(s, /memory — state/, 'both sessions get a working tool');

    // Same process, so the same DB: a write through one session is visible from the other.
    await call(a, 'memory_core_add', { text: 'daemon partagé entre sessions' });
    assert.match(await call(b, 'memory_core_list', {}), /daemon partagé/, 'sessions share one store');

    // The port IS the mutex: a second daemon must step aside, leaving the first untouched.
    const loser = await startHttpDaemon(env, port, { wait: false });
    const code = await new Promise((r) => loser.on('close', r));
    assert.equal(code, 0, 'the duplicate daemon exits cleanly');
    assert.ok(await httpHealth(port), 'the incumbent still serves');
  } finally {
    await a?.close();
    await b?.close();
    daemon?.kill();
    cleanup(dataDir);
  }
});
