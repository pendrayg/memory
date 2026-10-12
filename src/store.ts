import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type MemoryType =
  | 'observation'
  | 'prompt'
  | 'turn'
  | 'session'
  | 'digest'
  | 'insight'
  | 'core'
  | 'doc';

// Doc types whose text is worth vectorizing. Observations (tool calls = identifiers) stay BM25-only.
const VECTORIZABLE = ['prompt', 'turn', 'session', 'digest', 'insight', 'core', 'doc'] as const;
const VECTORIZABLE_SQL = VECTORIZABLE.map((t) => `'${t}'`).join(',');

/** Memory document. All fields are optional depending on the type. */
export interface MemoryDoc {
  /** Stable mem_id (set on docs read back from the store; absent on docs being written). */
  id?: string;
  type: MemoryType;
  session_id?: string;
  project?: string;
  branch?: string;
  cwd?: string;
  ts?: string;
  prompt_number?: number;
  user_prompt?: string;
  assistant_text?: string;
  summary?: string;
  tool_name?: string;
  tool_brief?: string;
  tools?: string[];
  files_read?: string[];
  files_modified?: string[];
  prompts?: string[];
  turn_count?: number;
  started_at?: string;
  ended_at?: string;
  end_reason?: string;
  /** Production (active) time of the session in ms — idle-capped. Set on `session` docs. */
  active_ms?: number;
  source?: string;
  /** User satisfaction across the session, in [0, 1] (0.5 = neutral). Set on digest/insight docs. */
  satisfaction?: number;
  /** One or two words for the user's mood (e.g. "satisfied", "frustrated"). Set on digest docs. */
  mood?: string;
  // ---- Doc fields (type 'doc': ingested external documentation) --------------------------
  /** Canonical source URL of the document (identity key; all chunks of one source share it). */
  url?: string;
  /** Stable id grouping every chunk/pointer of one source (hash of the URL). */
  doc_id?: string;
  /** Human title of the document/page. */
  title?: string;
  /** Tags/labels attached to the doc (component, domain…). */
  labels?: string[];
  /** ISO timestamp of when the content was fetched (for staleness display). */
  fetched_at?: string;
}

/**
 * Maps a satisfaction score (0..1, 0.5 = neutral) to a bounded relevance multiplier in
 * [1 - weight, 1 + weight]. Undefined/NaN satisfaction → 1 (neutral), so memories without a
 * satisfaction signal are never penalised. Keeps satisfaction a tie-breaker that lifts the memories
 * that pleased the user at (near-)equal relevance — not an override of relevance.
 */
export function satisfactionFactor(satisfaction: number | undefined | null, weight: number): number {
  if (weight <= 0 || satisfaction == null || !Number.isFinite(satisfaction)) return 1;
  const s = Math.max(0, Math.min(1, satisfaction));
  return 1 + weight * (s - 0.5) * 2;
}

export interface SearchParams {
  query: string;
  project?: string;
  type?: MemoryType;
  limit?: number;
  /** Query embedding (enables hybrid search if provided and vectors enabled). */
  embedding?: number[] | null;
  /** Satisfaction weighting strength (0 = off). See {@link satisfactionFactor}. */
  satisfactionWeight?: number;
}

export interface RecentParams {
  project?: string;
  type?: MemoryType;
  limit?: number;
}

export interface BulkItem {
  id: string;
  doc: MemoryDoc;
  embedding?: number[] | null;
}

export interface StatsResult {
  dbPath: string;
  total: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  vectorEnabled: boolean;
  vectorCount: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Columns persisted in `memories` (order = order of upsert params).
const COLS = [
  'mem_id', 'type', 'session_id', 'project', 'branch', 'cwd', 'ts', 'ts_epoch',
  'prompt_number', 'user_prompt', 'assistant_text', 'summary', 'tool_name', 'tool_brief',
  'tools', 'files_read', 'files_modified', 'prompts', 'prompts_text', 'turn_count',
  'started_at', 'ended_at', 'end_reason', 'source', 'satisfaction', 'mood',
  'url', 'doc_id', 'title', 'labels', 'fetched_at', 'active_ms',
] as const;

const FTS_COLS = ['summary', 'user_prompt', 'assistant_text', 'tool_brief', 'prompts_text'];
const BM25_WEIGHTS = '3.0, 2.0, 1.0, 1.0, 1.5';
const RRF_K = 60;

/** Loads node:sqlite via a specifier variable (prevents esbuild from rewriting the node: prefix). */
let _DatabaseSync: any;
async function getDatabaseSync(): Promise<any> {
  if (_DatabaseSync) return _DatabaseSync;
  const spec = 'node:sqlite';
  ({ DatabaseSync: _DatabaseSync } = await import(spec));
  return _DatabaseSync;
}

/** Locates the loadable sqlite-vec library (dev via node_modules, or copied into dist/). */
function resolveVecExtension(): string | null {
  const libName =
    process.platform === 'win32'
      ? 'vec0.dll'
      : process.platform === 'darwin'
        ? 'vec0.dylib'
        : 'vec0.so';
  const candidates: Array<string | undefined> = [process.env.MEMORY_VEC_EXTENSION];
  try {
    const req = createRequire(import.meta.url);
    candidates.push(req('sqlite-vec').getLoadablePath());
  } catch {
    /* wrapper absent (shipped build) */
  }
  candidates.push(path.join(HERE, libName));
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function ftsQuery(q: string): string | null {
  const tokens = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

function toEpoch(ts?: string): number {
  if (!ts) return Date.now();
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Date.now() : n;
}

function jsonArr(v: unknown): string[] {
  if (!v || typeof v !== 'string') return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToDoc(r: any): MemoryDoc {
  return {
    id: r.mem_id ?? undefined,
    type: r.type,
    session_id: r.session_id ?? undefined,
    project: r.project ?? undefined,
    branch: r.branch ?? undefined,
    cwd: r.cwd ?? undefined,
    ts: r.ts ?? undefined,
    prompt_number: r.prompt_number ?? undefined,
    user_prompt: r.user_prompt ?? undefined,
    assistant_text: r.assistant_text ?? undefined,
    summary: r.summary ?? undefined,
    tool_name: r.tool_name ?? undefined,
    tool_brief: r.tool_brief ?? undefined,
    tools: jsonArr(r.tools),
    files_read: jsonArr(r.files_read),
    files_modified: jsonArr(r.files_modified),
    prompts: jsonArr(r.prompts),
    turn_count: r.turn_count ?? undefined,
    started_at: r.started_at ?? undefined,
    ended_at: r.ended_at ?? undefined,
    end_reason: r.end_reason ?? undefined,
    source: r.source ?? undefined,
    satisfaction: r.satisfaction == null ? undefined : Number(r.satisfaction),
    mood: r.mood ?? undefined,
    url: r.url ?? undefined,
    doc_id: r.doc_id ?? undefined,
    title: r.title ?? undefined,
    labels: jsonArr(r.labels),
    fetched_at: r.fetched_at ?? undefined,
    active_ms: r.active_ms == null ? undefined : Number(r.active_ms),
  };
}

function toBlob(arr: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(arr).buffer);
}

/**
 * Stores memories in local SQLite. FTS5 full-text index (BM25) + optional vector index
 * (sqlite-vec) for hybrid semantic search. No server, in-process.
 */
export class MemoryStore {
  private db: any;
  private _vectorEnabled = false;

  constructor(
    private readonly dbPath: string,
    private readonly dim = 384,
    private readonly model = '',
    private readonly embedTextVersion = 0,
  ) {}

  get path(): string {
    return this.dbPath;
  }
  get vectorEnabled(): boolean {
    return this._vectorEnabled;
  }

  private metaGet(k: string): string | null {
    try {
      const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
      return r ? String(r.v) : null;
    } catch {
      return null;
    }
  }
  private metaSet(k: string, v: string): void {
    this.db
      .prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  /** Adds a column to an existing table if missing (lightweight forward migration). Best-effort. */
  private ensureColumn(table: string, col: string, decl: string): void {
    try {
      const cols = this.db
        .prepare(`PRAGMA table_info(${table});`)
        .all()
        .map((r: any) => String(r.name));
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl};`);
    } catch {
      /* ignore — the column is non-essential; capture still works without it */
    }
  }

  async init(): Promise<void> {
    if (this.db) return;
    const DatabaseSync = await getDatabaseSync();
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA busy_timeout=3000;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY,
        mem_id TEXT UNIQUE,
        type TEXT, session_id TEXT, project TEXT, branch TEXT, cwd TEXT,
        ts TEXT, ts_epoch INTEGER, prompt_number INTEGER,
        user_prompt TEXT, assistant_text TEXT, summary TEXT,
        tool_name TEXT, tool_brief TEXT,
        tools TEXT, files_read TEXT, files_modified TEXT,
        prompts TEXT, prompts_text TEXT,
        turn_count INTEGER, started_at TEXT, ended_at TEXT, end_reason TEXT, source TEXT,
        satisfaction REAL, mood TEXT,
        url TEXT, doc_id TEXT, title TEXT, labels TEXT, fetched_at TEXT,
        active_ms INTEGER
      );
    `);
    // Columns added after the initial schema: a CREATE TABLE IF NOT EXISTS won't add them to an
    // existing DB, so backfill them with ALTER TABLE (no-op once present).
    this.ensureColumn('memories', 'satisfaction', 'REAL');
    this.ensureColumn('memories', 'mood', 'TEXT');
    this.ensureColumn('memories', 'url', 'TEXT');
    this.ensureColumn('memories', 'doc_id', 'TEXT');
    this.ensureColumn('memories', 'title', 'TEXT');
    this.ensureColumn('memories', 'labels', 'TEXT');
    this.ensureColumn('memories', 'fetched_at', 'TEXT');
    this.ensureColumn('memories', 'active_ms', 'INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mem_doc ON memories(type, doc_id);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mem_recent ON memories(project, type, ts_epoch);');
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        ${FTS_COLS.join(', ')}, content='memories', content_rowid='rowid'
      );
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, ${FTS_COLS.join(', ')})
        VALUES (new.rowid, ${FTS_COLS.map((c) => 'new.' + c).join(', ')});
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, ${FTS_COLS.join(', ')})
        VALUES ('delete', old.rowid, ${FTS_COLS.map((c) => 'old.' + c).join(', ')});
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, ${FTS_COLS.join(', ')})
        VALUES ('delete', old.rowid, ${FTS_COLS.map((c) => 'old.' + c).join(', ')});
        INSERT INTO memories_fts(rowid, ${FTS_COLS.join(', ')})
        VALUES (new.rowid, ${FTS_COLS.map((c) => 'new.' + c).join(', ')});
      END;
    `);

    this.db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);');

    // Optional vector index: if the extension doesn't load, we continue with BM25 only.
    const ext = resolveVecExtension();
    if (ext) {
      try {
        this.db.enableLoadExtension(true);
        this.db.loadExtension(ext);

        // If the model/dimension changed since last time, the old vectors are no longer
        // comparable → we recreate the index empty; the server's backfill will re-vectorize.
        const prevModel = this.metaGet('embed_model');
        const prevDim = this.metaGet('embed_dim');
        const prevTextV = this.metaGet('embed_text_version');
        // Known and different model (or meta absent while vectors already exist) →
        // the old vectors are no longer comparable: we start from an empty index.
        const modelChanged =
          this.model !== '' &&
          (prevModel !== this.model || (prevDim !== null && Number(prevDim) !== this.dim));
        // The text we embed changed (e.g. we now embed digests): existing vectors are stale →
        // recreate empty so the backfill refills them with the new embed text.
        const textChanged =
          this.embedTextVersion > 0 &&
          prevTextV !== null &&
          Number(prevTextV) !== this.embedTextVersion;
        if (modelChanged || textChanged) this.db.exec('DROP TABLE IF EXISTS vec_memories;');

        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${this.dim}]);`,
        );
        this.metaSet('embed_model', this.model);
        this.metaSet('embed_dim', String(this.dim));
        this.metaSet('embed_text_version', String(this.embedTextVersion));
        this._vectorEnabled = true;
      } catch {
        this._vectorEnabled = false;
      } finally {
        try {
          this.db.enableLoadExtension(false);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private docToParams(id: string, d: MemoryDoc): unknown[] {
    const prompts = d.prompts ?? [];
    const promptsText = prompts.join(' \n ');
    const map: Record<string, unknown> = {
      mem_id: id,
      type: d.type,
      session_id: d.session_id ?? null,
      project: d.project ?? null,
      branch: d.branch ?? null,
      cwd: d.cwd ?? null,
      ts: d.ts ?? null,
      ts_epoch: toEpoch(d.ts ?? d.ended_at ?? d.started_at),
      prompt_number: d.prompt_number ?? null,
      user_prompt: d.user_prompt ?? null,
      assistant_text: d.assistant_text ?? null,
      summary: d.summary ?? null,
      tool_name: d.tool_name ?? null,
      tool_brief: d.tool_brief ?? null,
      tools: JSON.stringify(d.tools ?? []),
      files_read: JSON.stringify(d.files_read ?? []),
      files_modified: JSON.stringify(d.files_modified ?? []),
      prompts: JSON.stringify(prompts),
      prompts_text: promptsText || null,
      turn_count: d.turn_count ?? null,
      started_at: d.started_at ?? null,
      ended_at: d.ended_at ?? null,
      end_reason: d.end_reason ?? null,
      source: d.source ?? null,
      satisfaction: d.satisfaction ?? null,
      mood: d.mood ?? null,
      url: d.url ?? null,
      doc_id: d.doc_id ?? null,
      title: d.title ?? null,
      labels: JSON.stringify(d.labels ?? []),
      fetched_at: d.fetched_at ?? null,
      active_ms: d.active_ms ?? null,
    };
    return COLS.map((c) => map[c]);
  }

  private upsertSql(): string {
    const placeholders = COLS.map(() => '?').join(', ');
    const updates = COLS.filter((c) => c !== 'mem_id')
      .map((c) => `${c}=excluded.${c}`)
      .join(', ');
    return `INSERT INTO memories (${COLS.join(', ')}) VALUES (${placeholders})
            ON CONFLICT(mem_id) DO UPDATE SET ${updates};`;
  }

  private rowidOf(memId: string): number | null {
    const r = this.db.prepare('SELECT rowid FROM memories WHERE mem_id = ?').get(memId);
    return r ? Number(r.rowid) : null;
  }

  /** Updates a doc's vector (vec0 doesn't support OR REPLACE → DELETE+INSERT). */
  private upsertVector(rowid: number, embedding?: number[] | null): void {
    if (!this._vectorEnabled || !embedding || embedding.length !== this.dim) return;
    try {
      this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(BigInt(rowid));
      this.db
        .prepare('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)')
        .run(BigInt(rowid), toBlob(embedding));
    } catch {
      /* never break the main upsert */
    }
  }

  /** Inserts or updates a document (idempotent on mem_id) + its vector if provided. */
  upsert(id: string, doc: MemoryDoc, embedding?: number[] | null): void {
    this.db.prepare(this.upsertSql()).run(...this.docToParams(id, doc));
    if (embedding) {
      const rid = this.rowidOf(id);
      if (rid != null) this.upsertVector(rid, embedding);
    }
  }

  /** Sets/updates a doc's vector by rowid (used by the server's backfill). */
  setVectorByRowid(rowid: number, embedding: number[]): void {
    this.upsertVector(rowid, embedding);
  }

  /** Bulk vector writes in a single transaction (one commit instead of one fsync per vector). */
  setVectorsBulk(items: Array<{ rowid: number; embedding: number[] }>): void {
    if (!this._vectorEnabled || items.length === 0) return;
    this.db.exec('BEGIN;');
    try {
      for (const it of items) this.upsertVector(it.rowid, it.embedding);
      this.db.exec('COMMIT;');
    } catch {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Vectorizable documents (prompt/turn/session) without a vector, most recent first.
   * Returns the rowid + the text to embed. Empty if the vector index is disabled.
   */
  missingVectorDocs(limit = 32): Array<{ rowid: number; text: string }> {
    if (!this._vectorEnabled) return [];
    const rows = this.db
      .prepare(
        `SELECT rowid, summary, user_prompt, assistant_text, prompts_text
         FROM memories
         WHERE type IN (${VECTORIZABLE_SQL})
           AND rowid NOT IN (SELECT rowid FROM vec_memories)
         ORDER BY ts_epoch DESC LIMIT ?;`,
      )
      .all(limit);
    return rows.map((r: any) => ({
      rowid: Number(r.rowid),
      text: [r.summary, r.user_prompt, r.assistant_text, r.prompts_text]
        .filter((s: unknown) => typeof s === 'string' && s.trim())
        .join('\n')
        .slice(0, 2000),
    }));
  }

  /** Number of vectorizable docs still without a vector (backfill lag). */
  countMissingVectors(): number {
    if (!this._vectorEnabled) return 0;
    try {
      return Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) c FROM memories
               WHERE type IN (${VECTORIZABLE_SQL})
                 AND rowid NOT IN (SELECT rowid FROM vec_memories);`,
            )
            .get() as any
        ).c,
      );
    } catch {
      return 0;
    }
  }

  /** Bulk upsert within a transaction. */
  bulkUpsert(items: BulkItem[]): { indexed: number; errors: number } {
    if (items.length === 0) return { indexed: 0, errors: 0 };
    const stmt = this.db.prepare(this.upsertSql());
    let indexed = 0;
    let errors = 0;
    this.db.exec('BEGIN;');
    try {
      for (const it of items) {
        try {
          stmt.run(...this.docToParams(it.id, it.doc));
          if (it.embedding) {
            const rid = this.rowidOf(it.id);
            if (rid != null) this.upsertVector(rid, it.embedding);
          }
          indexed++;
        } catch {
          errors++;
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    return { indexed, errors };
  }

  /** BM25 rowids ordered by relevance. */
  private bm25Rows(query: string, project?: string, type?: MemoryType, n = 40): number[] {
    const ftsq = ftsQuery(query);
    if (!ftsq) return [];
    const where = ['memories_fts MATCH ?'];
    const args: unknown[] = [ftsq];
    if (project) {
      where.push('m.project = ?');
      args.push(project);
    }
    if (type) {
      where.push('m.type = ?');
      args.push(type);
    }
    args.push(n);
    const sql = `SELECT m.rowid FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
                 WHERE ${where.join(' AND ')}
                 ORDER BY bm25(memories_fts, ${BM25_WEIGHTS}) LIMIT ?;`;
    return this.db.prepare(sql).all(...args).map((r: any) => Number(r.rowid));
  }

  /** KNN (semantic) rowids ordered by distance, filtered by project/type. */
  private vecRows(embedding: number[], project?: string, type?: MemoryType, n = 40): number[] {
    if (!this._vectorEnabled || embedding.length !== this.dim) return [];
    const knn = this.db
      .prepare(
        'SELECT rowid, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?;',
      )
      .all(toBlob(embedding), n)
      .map((r: any) => Number(r.rowid));
    if (knn.length === 0 || (!project && !type)) return knn;
    // Filter project/type while preserving the KNN order.
    const placeholders = knn.map(() => '?').join(',');
    const where = [`rowid IN (${placeholders})`];
    const args: unknown[] = [...knn];
    if (project) {
      where.push('project = ?');
      args.push(project);
    }
    if (type) {
      where.push('type = ?');
      args.push(type);
    }
    const kept = new Set<number>(
      this.db
        .prepare(`SELECT rowid FROM memories WHERE ${where.join(' AND ')};`)
        .all(...args)
        .map((r: any) => Number(r.rowid)),
    );
    return knn.filter((rid: number) => kept.has(rid));
  }

  private docsByRowids(rowids: number[]): MemoryDoc[] {
    if (rowids.length === 0) return [];
    const placeholders = rowids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE rowid IN (${placeholders});`)
      .all(...rowids);
    const byRowid = new Map<number, any>(rows.map((r: any) => [Number(r.rowid), r]));
    return rowids.map((rid) => byRowid.get(rid)).filter(Boolean).map(rowToDoc);
  }

  /** Satisfaction scores for a set of rowids (rowid → satisfaction in [0,1]). Missing → absent. */
  private satisfactionByRowids(rowids: number[]): Map<number, number> {
    const m = new Map<number, number>();
    if (rowids.length === 0) return m;
    const placeholders = rowids.map(() => '?').join(',');
    try {
      const rows = this.db
        .prepare(`SELECT rowid, satisfaction FROM memories WHERE rowid IN (${placeholders});`)
        .all(...rowids);
      for (const r of rows) {
        if (r.satisfaction != null && Number.isFinite(Number(r.satisfaction)))
          m.set(Number(r.rowid), Number(r.satisfaction));
      }
    } catch {
      /* satisfaction column absent on a very old DB → no weighting */
    }
    return m;
  }

  /** Search: BM25 only, or hybrid (RRF of BM25 + KNN) if an embedding is provided. */
  search(params: SearchParams): MemoryDoc[] {
    const limit = params.limit ?? 10;
    const cand = Math.max(limit * 4, 40);
    const bm = this.bm25Rows(params.query, params.project, params.type, cand);
    const vec =
      params.embedding && this._vectorEnabled
        ? this.vecRows(params.embedding, params.project, params.type, cand)
        : [];

    // Base relevance score per rowid: Reciprocal Rank Fusion of BM25 + KNN, or — when BM25 only —
    // a strictly-decreasing inverse-rank score that preserves the BM25 order.
    const score = new Map<number, number>();
    if (vec.length === 0) {
      bm.forEach((rid, i) => score.set(rid, 1 / (RRF_K + i + 1)));
    } else {
      bm.forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (RRF_K + i + 1)));
      vec.forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (RRF_K + i + 1)));
    }
    if (score.size === 0) return [];

    // Satisfaction weighting: at (near-)equal relevance, lift the memories that pleased the user
    // most. A bounded multiplier (satisfactionFactor) keeps it a tie-breaker, not an override.
    const weight = params.satisfactionWeight ?? 0;
    const rowids = [...score.keys()];
    const sat = weight > 0 ? this.satisfactionByRowids(rowids) : null;
    const ordered = rowids
      .map((rid) => ({
        rid,
        s: (score.get(rid) as number) * (sat ? satisfactionFactor(sat.get(rid), weight) : 1),
      }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((e) => e.rid);
    return this.docsByRowids(ordered);
  }

  recent(params: RecentParams): MemoryDoc[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.project) {
      where.push('project = ?');
      args.push(params.project);
    }
    if (params.type) {
      where.push('type = ?');
      args.push(params.type);
    }
    args.push(params.limit ?? 10);
    const sql = `SELECT * FROM memories
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY ts_epoch DESC LIMIT ?;`;
    return this.db.prepare(sql).all(...args).map(rowToDoc);
  }

  stats(): StatsResult {
    const total = Number((this.db.prepare('SELECT COUNT(*) c FROM memories').get() as any).c);
    const byType: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT type, COUNT(*) c FROM memories GROUP BY type').all())
      byType[r.type] = Number(r.c);
    const byProject: Record<string, number> = {};
    for (const r of this.db
      .prepare('SELECT project, COUNT(*) c FROM memories GROUP BY project ORDER BY c DESC LIMIT 20')
      .all())
      byProject[r.project ?? '?'] = Number(r.c);
    let vectorCount = 0;
    if (this._vectorEnabled) {
      try {
        vectorCount = Number((this.db.prepare('SELECT COUNT(*) c FROM vec_memories').get() as any).c);
      } catch {
        /* ignore */
      }
    }
    return { dbPath: this.dbPath, total, byType, byProject, vectorEnabled: this._vectorEnabled, vectorCount };
  }

  /**
   * Production (active) time per session for a set of session_ids. Only `session` rollups carry the
   * metric; sessions predating the feature (or with no tracked activity) come back with active_ms 0.
   */
  productionForSessions(
    sessionIds: string[],
  ): Array<{ session_id: string; active_ms: number; project?: string; ts?: string; summary?: string }> {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT session_id, active_ms, project, ts, ended_at, summary
         FROM memories WHERE type='session' AND session_id IN (${placeholders});`,
      )
      .all(...sessionIds);
    return rows.map((r: any) => ({
      session_id: r.session_id,
      active_ms: r.active_ms == null ? 0 : Number(r.active_ms),
      project: r.project ?? undefined,
      ts: r.ended_at ?? r.ts ?? undefined,
      summary: r.summary ?? undefined,
    }));
  }

  // ---- Digests (LLM session compression) -------------------------------------------------

  /** Turns of a session, in order — the raw material fed to the digest LLM. */
  turnsForSession(
    session_id: string,
  ): Array<{ user_prompt?: string; assistant_text?: string; tools: string[]; files_modified: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT user_prompt, assistant_text, tools, files_modified
         FROM memories WHERE type='turn' AND session_id = ?
         ORDER BY prompt_number ASC, ts_epoch ASC;`,
      )
      .all(session_id);
    return rows.map((r: any) => ({
      user_prompt: r.user_prompt ?? undefined,
      assistant_text: r.assistant_text ?? undefined,
      tools: jsonArr(r.tools),
      files_modified: jsonArr(r.files_modified),
    }));
  }

  /**
   * Sessions that have a `session` rollup but no digest at the current version.
   * A digest stores its version in `source`, so bumping DIGEST_VERSION re-selects every session.
   */
  sessionsNeedingDigest(
    version: number,
    limit = 5,
  ): Array<{ session_id: string; project?: string; branch?: string }> {
    const rows = this.db
      .prepare(
        `SELECT m.session_id, m.project, m.branch FROM memories m
         WHERE m.type='session' AND m.session_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM memories d
             WHERE d.type='digest' AND d.session_id = m.session_id AND d.source = ?
           )
         ORDER BY m.ts_epoch DESC LIMIT ?;`,
      )
      .all(String(version), limit);
    return rows.map((r: any) => ({
      session_id: r.session_id,
      project: r.project ?? undefined,
      branch: r.branch ?? undefined,
    }));
  }

  /** Count of sessions still awaiting a digest at the given version (for status/progress). */
  countSessionsNeedingDigest(version: number): number {
    try {
      return Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) c FROM memories m
               WHERE m.type='session' AND m.session_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM memories d
                   WHERE d.type='digest' AND d.session_id = m.session_id AND d.source = ?
                 );`,
            )
            .get(String(version)) as any
        ).c,
      );
    } catch {
      return 0;
    }
  }

  /** Replaces a session's digest + insight docs (idempotent). Vectors are filled by the backfill. */
  writeDigest(session_id: string, digest: MemoryDoc, insights: MemoryDoc[]): void {
    this.deleteSessionDigest(session_id);
    this.upsert(`${session_id}:digest`, digest);
    insights.forEach((d, i) => this.upsert(`${session_id}:insight:${i}`, d));
  }

  /** Deletes a session's digest + insights and their vectors. */
  deleteSessionDigest(session_id: string): void {
    const rids = this.db
      .prepare(`SELECT rowid FROM memories WHERE session_id = ? AND type IN ('digest','insight');`)
      .all(session_id)
      .map((r: any) => Number(r.rowid));
    this.deleteVectors(rids);
    this.db
      .prepare(`DELETE FROM memories WHERE session_id = ? AND type IN ('digest','insight');`)
      .run(session_id);
  }

  /** Deletes every digest + insight doc (and their vectors). Used by /memory:reindex. */
  clearDigests(): number {
    const rids = this.db
      .prepare(`SELECT rowid FROM memories WHERE type IN ('digest','insight');`)
      .all()
      .map((r: any) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE type IN ('digest','insight');`).run();
    return Number(info?.changes ?? rids.length);
  }

  /**
   * Deletes memories matching a filter (+ their vectors; FTS is kept in sync by the delete trigger).
   * Requires at least one filter — never deletes everything implicitly. Returns the count removed.
   */
  deleteMemories(opts: { idPrefix?: string; project?: string; type?: MemoryType }): number {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.idPrefix) {
      // Exact prefix match (no LIKE wildcards: '_'/'%' in an id must stay literal).
      where.push('substr(mem_id, 1, ?) = ?');
      args.push(opts.idPrefix.length, opts.idPrefix);
    }
    if (opts.project) {
      where.push('project = ?');
      args.push(opts.project);
    }
    if (opts.type) {
      where.push('type = ?');
      args.push(opts.type);
    }
    if (where.length === 0) return 0; // refuse a filter-less delete-all
    const w = where.join(' AND ');
    const rids = this.db
      .prepare(`SELECT rowid FROM memories WHERE ${w};`)
      .all(...args)
      .map((r: any) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE ${w};`).run(...args);
    return Number(info?.changes ?? rids.length);
  }

  /** Empties the vector index so the backfill refills it from scratch. Used by /memory:reindex. */
  resetVectors(): void {
    if (!this._vectorEnabled) return;
    try {
      this.db.exec('DROP TABLE IF EXISTS vec_memories;');
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${this.dim}]);`,
      );
    } catch {
      /* best-effort */
    }
  }

  // ---- Core memories (always injected at SessionStart) ------------------------------------

  /**
   * Adds (or updates) a core memory — a high-priority fact injected into every session's context.
   * Global by default (project undefined) or scoped to a project. Idempotent: the id is a hash of
   * (project, text), so the same fact isn't duplicated. Returns the mem_id.
   */
  addCore(text: string, project?: string): string {
    const id =
      'core:' + createHash('sha1').update(`${project ?? ''} ${text}`).digest('hex').slice(0, 12);
    this.upsert(id, {
      type: 'core',
      project,
      summary: text.trim().slice(0, 2000),
      ts: new Date().toISOString(),
    });
    return id;
  }

  /** Core memories visible for a project: its own + globals (project IS NULL). Recent first. */
  listCore(project?: string): Array<{ id: string; doc: MemoryDoc }> {
    const sql = project
      ? `SELECT * FROM memories WHERE type='core' AND (project = ? OR project IS NULL) ORDER BY ts_epoch DESC;`
      : `SELECT * FROM memories WHERE type='core' ORDER BY ts_epoch DESC;`;
    const rows = project ? this.db.prepare(sql).all(project) : this.db.prepare(sql).all();
    return rows.map((r: any) => ({ id: r.mem_id, doc: rowToDoc(r) }));
  }

  /** Removes a core memory by id (+ its vector). Returns the count removed (0 or 1). */
  removeCore(id: string): number {
    const rids = this.db
      .prepare(`SELECT rowid FROM memories WHERE mem_id = ? AND type='core';`)
      .all(id)
      .map((r: any) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE mem_id = ? AND type='core';`).run(id);
    return Number(info?.changes ?? 0);
  }

  /**
   * Frequency signals to help propose core memories: files touched across the most memories
   * (a file recurring over many sessions is likely structurally important). Best-effort (JSON1).
   */
  coreSignals(limit = 15): { files: Array<{ file: string; count: number }> } {
    try {
      const rows = this.db
        .prepare(
          `SELECT j.value AS f, COUNT(*) AS c
           FROM memories, json_each(memories.files_modified) j
           WHERE memories.files_modified IS NOT NULL AND memories.files_modified != '[]'
           GROUP BY j.value ORDER BY c DESC LIMIT ?;`,
        )
        .all(limit);
      return { files: rows.map((r: any) => ({ file: String(r.f), count: Number(r.c) })) };
    } catch {
      return { files: [] };
    }
  }

  // ---- Docs (curated, ingested external documentation) -----------------------------------

  /** Chunk sizing (chars). ~1400 stays inside the e5 token window and the 2000-char embed slice. */
  private static readonly DOC_CHUNK_CHARS = 1400;
  private static readonly DOC_CHUNK_OVERLAP = 150;

  /** Stable doc_id from a source URL — groups every chunk/pointer of one document. */
  private docIdFor(url: string): string {
    return 'doc:' + createHash('sha1').update(url.trim()).digest('hex').slice(0, 12);
  }

  /**
   * Splits text into ~chunkChars pieces, preferring paragraph/sentence/word boundaries, with a small
   * overlap so a fact straddling a cut stays recallable from either side.
   */
  private chunkText(
    text: string,
    chunkChars = MemoryStore.DOC_CHUNK_CHARS,
    overlap = MemoryStore.DOC_CHUNK_OVERLAP,
  ): string[] {
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (clean.length <= chunkChars) return clean ? [clean] : [];
    const chunks: string[] = [];
    let i = 0;
    while (i < clean.length) {
      let end = Math.min(i + chunkChars, clean.length);
      if (end < clean.length) {
        const slice = clean.slice(i, end);
        const min = chunkChars * 0.5; // don't cut too early — avoids tiny fragments
        const para = slice.lastIndexOf('\n\n');
        const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
        const ws = slice.lastIndexOf(' ');
        const cut = para > min ? para : sent > min ? sent + 1 : ws > min ? ws : -1;
        if (cut > 0) end = i + cut;
      }
      const piece = clean.slice(i, end).trim();
      if (piece) chunks.push(piece);
      if (end >= clean.length) break;
      i = Math.max(end - overlap, i + 1);
    }
    return chunks;
  }

  /**
   * Ingests an external documentation source (idempotent on its URL). With `body`, stores it as N
   * vectorized chunks (Tier 2 — semantic search on the real content); otherwise stores a single
   * pointer row carrying title + summary + URL (Tier 1 — light, re-fetch on demand). Re-ingesting the
   * same URL replaces all its rows. Vectors are filled in the background by the server's backfill.
   */
  addDoc(input: {
    url: string;
    title: string;
    summary?: string;
    body?: string;
    labels?: string[];
    project?: string;
    fetchedAt?: string;
  }): { docId: string; chunks: number } {
    const url = input.url.trim();
    const title = input.title.trim();
    const docId = this.docIdFor(url);
    const labels = (input.labels ?? []).filter((s) => typeof s === 'string' && s.trim());
    const fetchedAt = input.fetchedAt ?? new Date().toISOString();
    this.removeDoc(docId); // idempotent refresh: drop the previous version's rows + vectors

    const base: Partial<MemoryDoc> = {
      type: 'doc',
      project: input.project,
      url,
      doc_id: docId,
      title,
      labels,
      fetched_at: fetchedAt,
      ts: fetchedAt,
    };

    const body = (input.body ?? '').trim();
    if (body) {
      // Tier 2: one searchable+vectorized row per chunk. The title is prepended to each chunk so it
      // grounds the embedding and matches BM25 on every fragment of the document.
      const pieces = this.chunkText(body);
      pieces.forEach((piece, i) => {
        this.upsert(`${docId}:${i}`, {
          ...(base as MemoryDoc),
          summary: `${title}\n\n${piece}`.slice(0, 4000),
        });
      });
      return { docId, chunks: pieces.length };
    }

    // Tier 1: a single lightweight pointer row.
    this.upsert(docId, {
      ...(base as MemoryDoc),
      summary: (input.summary ? `${title} — ${input.summary}` : title).slice(0, 2000),
    });
    return { docId, chunks: 1 };
  }

  /** Lists ingested docs (one entry per source URL), most recent first. Scoped to project + globals. */
  listDocs(project?: string): Array<{
    docId: string;
    title: string;
    url: string;
    labels: string[];
    fetchedAt?: string;
    chunks: number;
    project?: string;
  }> {
    const where = ["type='doc'"];
    const args: unknown[] = [];
    if (project) {
      where.push('(project = ? OR project IS NULL)');
      args.push(project);
    }
    const rows = this.db
      .prepare(
        `SELECT doc_id, MAX(title) title, MAX(url) url, MAX(labels) labels, MAX(fetched_at) fetched_at,
                MAX(project) project, COUNT(*) c, MAX(ts_epoch) e
         FROM memories WHERE ${where.join(' AND ')}
         GROUP BY doc_id ORDER BY e DESC;`,
      )
      .all(...args);
    return rows.map((r: any) => ({
      docId: r.doc_id,
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      labels: jsonArr(r.labels),
      fetchedAt: r.fetched_at ?? undefined,
      chunks: Number(r.c),
      project: r.project ?? undefined,
    }));
  }

  /** Removes every row (chunks + pointer) of an ingested doc by its doc_id (+ vectors). */
  removeDoc(docId: string): number {
    const rids = this.db
      .prepare(`SELECT rowid FROM memories WHERE type='doc' AND doc_id = ?;`)
      .all(docId)
      .map((r: any) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE type='doc' AND doc_id = ?;`).run(docId);
    return Number(info?.changes ?? rids.length);
  }

  /** vec0 has no FK to memories → orphan vectors must be removed explicitly on delete. */
  private deleteVectors(rowids: number[]): void {
    if (!this._vectorEnabled || rowids.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
    for (const rid of rowids) {
      try {
        stmt.run(BigInt(rid));
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
  }
}
