#!/usr/bin/env node

// src/config.ts
import os from "os";
import path from "path";
import { readFileSync } from "fs";
var DEFAULT_DIGEST_MODEL = "haiku";
var DIGEST_VERSION = 2;
var EMBED_TEXT_VERSION = 1;
var EMBED_TIERS = {
  light: { model: "Xenova/multilingual-e5-small", dim: 384, pooling: "mean" },
  medium: { model: "Xenova/multilingual-e5-base", dim: 768, pooling: "mean", reranker: "Xenova/bge-reranker-base" },
  heavy: {
    model: "Xenova/multilingual-e5-large",
    dim: 1024,
    pooling: "mean",
    reranker: "onnx-community/bge-reranker-v2-m3-ONNX"
  }
};
var DEFAULT_TIER = "light";
var DEFAULT_MCP_PORT = 47832;
function resolveDevice(raw) {
  if (raw !== "auto") return raw;
  if (process.platform === "win32") return "dml";
  if (process.platform === "darwin") return "coreml";
  return "";
}
function readConfigFile(dataDir) {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}
var ConfigSource = class {
  constructor(file) {
    this.file = file;
  }
  file;
  envValue(envKey) {
    const e = process.env[envKey];
    return e !== void 0 && e !== "" && !e.startsWith("${") ? e : void 0;
  }
  /** env > file > undefined. */
  get(envKey, fileKey) {
    const e = this.envValue(envKey);
    if (e !== void 0) return e;
    const f = this.file[fileKey];
    return f === void 0 || f === null ? void 0 : String(f);
  }
  /**
   * file > env > undefined. Used for the embedding tier so the runtime config.json (written by
   * /memory:config and the /memory:*-load commands) overrides the install-time
   * `${user_config.embedTier}` env injected by .mcp.json — otherwise the install choice would pin
   * the tier forever and /memory:config would be a silent no-op.
   */
  fileFirst(fileKey, envKey) {
    const f = this.file[fileKey];
    if (f !== void 0 && f !== null && String(f) !== "") return String(f);
    return this.envValue(envKey);
  }
  /** Numeric setting (env > file), falling back to `def` when unset or unparseable. */
  num(envKey, fileKey, def) {
    return Number(this.get(envKey, fileKey)) || def;
  }
  /** Boolean flag: true unless explicitly set to '0'. */
  flag(envKey, fileKey) {
    return this.get(envKey, fileKey) !== "0";
  }
};
function loadConfig() {
  const dataDir = process.env.MEMORY_DATA_DIR || path.join(os.homedir(), ".claude-memory");
  const src = new ConfigSource(readConfigFile(dataDir));
  const dbPath = src.get("MEMORY_DB_PATH", "dbPath") || path.join(dataDir, "memories.db");
  const contextLimit = src.num("MEMORY_CONTEXT_LIMIT", "contextLimit", 10);
  const tier = (src.fileFirst("embedTier", "MEMORY_EMBED_TIER") || DEFAULT_TIER).toLowerCase();
  const picked = EMBED_TIERS[tier] ?? EMBED_TIERS[DEFAULT_TIER];
  const model = src.get("MEMORY_EMBED_MODEL", "embedModel") || picked.model;
  const dim = src.num("MEMORY_EMBED_DIM", "embedDim", picked.dim);
  const pooling = (src.get("MEMORY_EMBED_POOLING", "embedPooling") || picked.pooling || "mean").toLowerCase();
  const queryPrefix = src.get("MEMORY_EMBED_QUERY_PREFIX", "embedQueryPrefix") ?? picked.queryPrefix ?? "";
  const enabled = src.flag("MEMORY_EMBED_ENABLED", "embedEnabled");
  const cacheDir = src.get("MEMORY_EMBED_CACHE_DIR", "embedCacheDir") || path.join(dataDir, "models");
  const device = resolveDevice((src.get("MEMORY_EMBED_DEVICE", "embedDevice") || "").toLowerCase());
  const dtypeOverride = src.get("MEMORY_EMBED_DTYPE", "embedDtype");
  const onGpu = device !== "" && device !== "cpu";
  const dtype = (dtypeOverride || (onGpu ? "fp32" : "q8")).toLowerCase();
  const loadPercent = Math.max(5, Math.min(100, src.num("MEMORY_LOAD_PERCENT", "loadPercent", 30)));
  const threadFraction = { light: 1 / 3, medium: 2 / 3, heavy: 1 };
  const fraction = Math.min(threadFraction[tier] ?? 0.25, loadPercent / 100);
  const threads = Math.max(1, Math.floor(os.cpus().length * fraction));
  const digestEnabled = src.flag("MEMORY_DIGEST_ENABLED", "digestEnabled");
  const digestModel = src.get("MEMORY_DIGEST_MODEL", "digestModel") || DEFAULT_DIGEST_MODEL;
  const rerankModel = src.get("MEMORY_RERANK_MODEL", "rerankModel") || picked.reranker || "";
  const rerankEnabled = src.flag("MEMORY_RERANK_ENABLED", "rerankEnabled") && !!rerankModel;
  const autoRecallEnabled = src.flag("MEMORY_AUTO_RECALL", "autoRecall");
  const autoRecallLimit = src.num("MEMORY_AUTO_RECALL_LIMIT", "autoRecallLimit", 3);
  const satisfactionWeight = src.num("MEMORY_SATISFACTION_WEIGHT", "satisfactionWeight", 0.12);
  const productionIdleGapMs = Math.max(
    6e4,
    src.num("MEMORY_PRODUCTION_IDLE_GAP_MS", "productionIdleGapMs", 3e5)
  );
  const mcpPort = src.num("MEMORY_MCP_PORT", "mcpPort", DEFAULT_MCP_PORT);
  const mcpIdleExitMs = Math.max(6e4, src.num("MEMORY_MCP_IDLE_EXIT_MS", "mcpIdleExitMs", 18e5));
  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, tier, model, dim, cacheDir, dtype, device, pooling, queryPrefix, threads, dataDir },
    digest: { enabled: digestEnabled, model: digestModel, version: DIGEST_VERSION },
    rerank: { enabled: rerankEnabled, model: rerankModel },
    autoRecall: { enabled: autoRecallEnabled, limit: autoRecallLimit },
    satisfactionWeight,
    loadPercent,
    productionIdleGapMs,
    mcpPort,
    mcpIdleExitMs
  };
}

// src/store.ts
import { mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createHash } from "crypto";
import path2 from "path";
var VECTORIZABLE = ["prompt", "turn", "session", "digest", "insight", "core", "doc"];
var VECTORIZABLE_SQL = VECTORIZABLE.map((t) => `'${t}'`).join(",");
function satisfactionFactor(satisfaction, weight) {
  if (weight <= 0 || satisfaction == null || !Number.isFinite(satisfaction)) return 1;
  const s = Math.max(0, Math.min(1, satisfaction));
  return 1 + weight * (s - 0.5) * 2;
}
var HERE = path2.dirname(fileURLToPath(import.meta.url));
var COLS = [
  "mem_id",
  "type",
  "session_id",
  "project",
  "branch",
  "cwd",
  "ts",
  "ts_epoch",
  "prompt_number",
  "user_prompt",
  "assistant_text",
  "summary",
  "tool_name",
  "tool_brief",
  "tools",
  "files_read",
  "files_modified",
  "prompts",
  "prompts_text",
  "turn_count",
  "started_at",
  "ended_at",
  "end_reason",
  "source",
  "satisfaction",
  "mood",
  "url",
  "doc_id",
  "title",
  "labels",
  "fetched_at",
  "active_ms"
];
var FTS_COLS = ["summary", "user_prompt", "assistant_text", "tool_brief", "prompts_text"];
var BM25_WEIGHTS = "3.0, 2.0, 1.0, 1.0, 1.5";
var RRF_K = 60;
var _DatabaseSync;
async function getDatabaseSync() {
  if (_DatabaseSync) return _DatabaseSync;
  const spec = "node:sqlite";
  ({ DatabaseSync: _DatabaseSync } = await import(spec));
  return _DatabaseSync;
}
function resolveVecExtension() {
  const libName = process.platform === "win32" ? "vec0.dll" : process.platform === "darwin" ? "vec0.dylib" : "vec0.so";
  const candidates = [process.env.MEMORY_VEC_EXTENSION];
  try {
    const req = createRequire(import.meta.url);
    candidates.push(req("sqlite-vec").getLoadablePath());
  } catch {
  }
  candidates.push(path2.join(HERE, libName));
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}
function ftsQuery(q) {
  const tokens = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}
function toEpoch(ts) {
  if (!ts) return Date.now();
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Date.now() : n;
}
function jsonArr(v) {
  if (!v || typeof v !== "string") return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function rowToDoc(r) {
  return {
    id: r.mem_id ?? void 0,
    type: r.type,
    session_id: r.session_id ?? void 0,
    project: r.project ?? void 0,
    branch: r.branch ?? void 0,
    cwd: r.cwd ?? void 0,
    ts: r.ts ?? void 0,
    prompt_number: r.prompt_number ?? void 0,
    user_prompt: r.user_prompt ?? void 0,
    assistant_text: r.assistant_text ?? void 0,
    summary: r.summary ?? void 0,
    tool_name: r.tool_name ?? void 0,
    tool_brief: r.tool_brief ?? void 0,
    tools: jsonArr(r.tools),
    files_read: jsonArr(r.files_read),
    files_modified: jsonArr(r.files_modified),
    prompts: jsonArr(r.prompts),
    turn_count: r.turn_count ?? void 0,
    started_at: r.started_at ?? void 0,
    ended_at: r.ended_at ?? void 0,
    end_reason: r.end_reason ?? void 0,
    source: r.source ?? void 0,
    satisfaction: r.satisfaction == null ? void 0 : Number(r.satisfaction),
    mood: r.mood ?? void 0,
    url: r.url ?? void 0,
    doc_id: r.doc_id ?? void 0,
    title: r.title ?? void 0,
    labels: jsonArr(r.labels),
    fetched_at: r.fetched_at ?? void 0,
    active_ms: r.active_ms == null ? void 0 : Number(r.active_ms)
  };
}
function toBlob(arr) {
  return new Uint8Array(Float32Array.from(arr).buffer);
}
var MemoryStore = class _MemoryStore {
  constructor(dbPath, dim = 384, model = "", embedTextVersion = 0) {
    this.dbPath = dbPath;
    this.dim = dim;
    this.model = model;
    this.embedTextVersion = embedTextVersion;
  }
  dbPath;
  dim;
  model;
  embedTextVersion;
  db;
  _vectorEnabled = false;
  get path() {
    return this.dbPath;
  }
  get vectorEnabled() {
    return this._vectorEnabled;
  }
  metaGet(k) {
    try {
      const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
      return r ? String(r.v) : null;
    } catch {
      return null;
    }
  }
  metaSet(k, v) {
    this.db.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  /** Adds a column to an existing table if missing (lightweight forward migration). Best-effort. */
  ensureColumn(table, col, decl) {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${table});`).all().map((r) => String(r.name));
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl};`);
    } catch {
    }
  }
  async init() {
    if (this.db) return;
    const DatabaseSync = await getDatabaseSync();
    mkdirSync(path2.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=3000;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
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
    this.ensureColumn("memories", "satisfaction", "REAL");
    this.ensureColumn("memories", "mood", "TEXT");
    this.ensureColumn("memories", "url", "TEXT");
    this.ensureColumn("memories", "doc_id", "TEXT");
    this.ensureColumn("memories", "title", "TEXT");
    this.ensureColumn("memories", "labels", "TEXT");
    this.ensureColumn("memories", "fetched_at", "TEXT");
    this.ensureColumn("memories", "active_ms", "INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mem_doc ON memories(type, doc_id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mem_recent ON memories(project, type, ts_epoch);");
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        ${FTS_COLS.join(", ")}, content='memories', content_rowid='rowid'
      );
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, ${FTS_COLS.join(", ")})
        VALUES (new.rowid, ${FTS_COLS.map((c) => "new." + c).join(", ")});
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, ${FTS_COLS.join(", ")})
        VALUES ('delete', old.rowid, ${FTS_COLS.map((c) => "old." + c).join(", ")});
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, ${FTS_COLS.join(", ")})
        VALUES ('delete', old.rowid, ${FTS_COLS.map((c) => "old." + c).join(", ")});
        INSERT INTO memories_fts(rowid, ${FTS_COLS.join(", ")})
        VALUES (new.rowid, ${FTS_COLS.map((c) => "new." + c).join(", ")});
      END;
    `);
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);");
    const ext = resolveVecExtension();
    if (ext) {
      try {
        this.db.enableLoadExtension(true);
        this.db.loadExtension(ext);
        const prevModel = this.metaGet("embed_model");
        const prevDim = this.metaGet("embed_dim");
        const prevTextV = this.metaGet("embed_text_version");
        const modelChanged = this.model !== "" && (prevModel !== this.model || prevDim !== null && Number(prevDim) !== this.dim);
        const textChanged = this.embedTextVersion > 0 && prevTextV !== null && Number(prevTextV) !== this.embedTextVersion;
        if (modelChanged || textChanged) this.db.exec("DROP TABLE IF EXISTS vec_memories;");
        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${this.dim}]);`
        );
        this.metaSet("embed_model", this.model);
        this.metaSet("embed_dim", String(this.dim));
        this.metaSet("embed_text_version", String(this.embedTextVersion));
        this._vectorEnabled = true;
      } catch {
        this._vectorEnabled = false;
      } finally {
        try {
          this.db.enableLoadExtension(false);
        } catch {
        }
      }
    }
  }
  docToParams(id, d) {
    const prompts = d.prompts ?? [];
    const promptsText = prompts.join(" \n ");
    const map = {
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
      active_ms: d.active_ms ?? null
    };
    return COLS.map((c) => map[c]);
  }
  upsertSql() {
    const placeholders = COLS.map(() => "?").join(", ");
    const updates = COLS.filter((c) => c !== "mem_id").map((c) => `${c}=excluded.${c}`).join(", ");
    return `INSERT INTO memories (${COLS.join(", ")}) VALUES (${placeholders})
            ON CONFLICT(mem_id) DO UPDATE SET ${updates};`;
  }
  rowidOf(memId) {
    const r = this.db.prepare("SELECT rowid FROM memories WHERE mem_id = ?").get(memId);
    return r ? Number(r.rowid) : null;
  }
  /** Updates a doc's vector (vec0 doesn't support OR REPLACE → DELETE+INSERT). */
  upsertVector(rowid, embedding) {
    if (!this._vectorEnabled || !embedding || embedding.length !== this.dim) return;
    try {
      this.db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(BigInt(rowid));
      this.db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)").run(BigInt(rowid), toBlob(embedding));
    } catch {
    }
  }
  /** Inserts or updates a document (idempotent on mem_id) + its vector if provided. */
  upsert(id, doc, embedding) {
    this.db.prepare(this.upsertSql()).run(...this.docToParams(id, doc));
    if (embedding) {
      const rid = this.rowidOf(id);
      if (rid != null) this.upsertVector(rid, embedding);
    }
  }
  /** Sets/updates a doc's vector by rowid (used by the server's backfill). */
  setVectorByRowid(rowid, embedding) {
    this.upsertVector(rowid, embedding);
  }
  /** Bulk vector writes in a single transaction (one commit instead of one fsync per vector). */
  setVectorsBulk(items) {
    if (!this._vectorEnabled || items.length === 0) return;
    this.db.exec("BEGIN;");
    try {
      for (const it of items) this.upsertVector(it.rowid, it.embedding);
      this.db.exec("COMMIT;");
    } catch {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
      }
    }
  }
  /**
   * Vectorizable documents (prompt/turn/session) without a vector, most recent first.
   * Returns the rowid + the text to embed. Empty if the vector index is disabled.
   */
  missingVectorDocs(limit = 32) {
    if (!this._vectorEnabled) return [];
    const rows = this.db.prepare(
      `SELECT rowid, summary, user_prompt, assistant_text, prompts_text
         FROM memories
         WHERE type IN (${VECTORIZABLE_SQL})
           AND rowid NOT IN (SELECT rowid FROM vec_memories)
         ORDER BY ts_epoch DESC LIMIT ?;`
    ).all(limit);
    return rows.map((r) => ({
      rowid: Number(r.rowid),
      text: [r.summary, r.user_prompt, r.assistant_text, r.prompts_text].filter((s) => typeof s === "string" && s.trim()).join("\n").slice(0, 2e3)
    }));
  }
  /** Number of vectorizable docs still without a vector (backfill lag). */
  countMissingVectors() {
    if (!this._vectorEnabled) return 0;
    try {
      return Number(
        this.db.prepare(
          `SELECT COUNT(*) c FROM memories
               WHERE type IN (${VECTORIZABLE_SQL})
                 AND rowid NOT IN (SELECT rowid FROM vec_memories);`
        ).get().c
      );
    } catch {
      return 0;
    }
  }
  /** Bulk upsert within a transaction. */
  bulkUpsert(items) {
    if (items.length === 0) return { indexed: 0, errors: 0 };
    const stmt = this.db.prepare(this.upsertSql());
    let indexed = 0;
    let errors = 0;
    this.db.exec("BEGIN;");
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
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
    return { indexed, errors };
  }
  /** BM25 rowids ordered by relevance. */
  bm25Rows(query, project, type, n = 40) {
    const ftsq = ftsQuery(query);
    if (!ftsq) return [];
    const where = ["memories_fts MATCH ?"];
    const args = [ftsq];
    if (project) {
      where.push("m.project = ?");
      args.push(project);
    }
    if (type) {
      where.push("m.type = ?");
      args.push(type);
    }
    args.push(n);
    const sql = `SELECT m.rowid FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
                 WHERE ${where.join(" AND ")}
                 ORDER BY bm25(memories_fts, ${BM25_WEIGHTS}) LIMIT ?;`;
    return this.db.prepare(sql).all(...args).map((r) => Number(r.rowid));
  }
  /** KNN (semantic) rowids ordered by distance, filtered by project/type. */
  vecRows(embedding, project, type, n = 40) {
    if (!this._vectorEnabled || embedding.length !== this.dim) return [];
    const knn = this.db.prepare(
      "SELECT rowid, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?;"
    ).all(toBlob(embedding), n).map((r) => Number(r.rowid));
    if (knn.length === 0 || !project && !type) return knn;
    const placeholders = knn.map(() => "?").join(",");
    const where = [`rowid IN (${placeholders})`];
    const args = [...knn];
    if (project) {
      where.push("project = ?");
      args.push(project);
    }
    if (type) {
      where.push("type = ?");
      args.push(type);
    }
    const kept = new Set(
      this.db.prepare(`SELECT rowid FROM memories WHERE ${where.join(" AND ")};`).all(...args).map((r) => Number(r.rowid))
    );
    return knn.filter((rid) => kept.has(rid));
  }
  docsByRowids(rowids) {
    if (rowids.length === 0) return [];
    const placeholders = rowids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM memories WHERE rowid IN (${placeholders});`).all(...rowids);
    const byRowid = new Map(rows.map((r) => [Number(r.rowid), r]));
    return rowids.map((rid) => byRowid.get(rid)).filter(Boolean).map(rowToDoc);
  }
  /** Satisfaction scores for a set of rowids (rowid → satisfaction in [0,1]). Missing → absent. */
  satisfactionByRowids(rowids) {
    const m = /* @__PURE__ */ new Map();
    if (rowids.length === 0) return m;
    const placeholders = rowids.map(() => "?").join(",");
    try {
      const rows = this.db.prepare(`SELECT rowid, satisfaction FROM memories WHERE rowid IN (${placeholders});`).all(...rowids);
      for (const r of rows) {
        if (r.satisfaction != null && Number.isFinite(Number(r.satisfaction)))
          m.set(Number(r.rowid), Number(r.satisfaction));
      }
    } catch {
    }
    return m;
  }
  /** Search: BM25 only, or hybrid (RRF of BM25 + KNN) if an embedding is provided. */
  search(params) {
    const limit = params.limit ?? 10;
    const cand = Math.max(limit * 4, 40);
    const bm = this.bm25Rows(params.query, params.project, params.type, cand);
    const vec = params.embedding && this._vectorEnabled ? this.vecRows(params.embedding, params.project, params.type, cand) : [];
    const score = /* @__PURE__ */ new Map();
    if (vec.length === 0) {
      bm.forEach((rid, i) => score.set(rid, 1 / (RRF_K + i + 1)));
    } else {
      bm.forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (RRF_K + i + 1)));
      vec.forEach((rid, i) => score.set(rid, (score.get(rid) ?? 0) + 1 / (RRF_K + i + 1)));
    }
    if (score.size === 0) return [];
    const weight = params.satisfactionWeight ?? 0;
    const rowids = [...score.keys()];
    const sat = weight > 0 ? this.satisfactionByRowids(rowids) : null;
    const ordered = rowids.map((rid) => ({
      rid,
      s: score.get(rid) * (sat ? satisfactionFactor(sat.get(rid), weight) : 1)
    })).sort((a, b) => b.s - a.s).slice(0, limit).map((e) => e.rid);
    return this.docsByRowids(ordered);
  }
  recent(params) {
    const where = [];
    const args = [];
    if (params.project) {
      where.push("project = ?");
      args.push(params.project);
    }
    if (params.type) {
      where.push("type = ?");
      args.push(params.type);
    }
    args.push(params.limit ?? 10);
    const sql = `SELECT * FROM memories
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY ts_epoch DESC LIMIT ?;`;
    return this.db.prepare(sql).all(...args).map(rowToDoc);
  }
  stats() {
    const total = Number(this.db.prepare("SELECT COUNT(*) c FROM memories").get().c);
    const byType = {};
    for (const r of this.db.prepare("SELECT type, COUNT(*) c FROM memories GROUP BY type").all())
      byType[r.type] = Number(r.c);
    const byProject = {};
    for (const r of this.db.prepare("SELECT project, COUNT(*) c FROM memories GROUP BY project ORDER BY c DESC LIMIT 20").all())
      byProject[r.project ?? "?"] = Number(r.c);
    let vectorCount = 0;
    if (this._vectorEnabled) {
      try {
        vectorCount = Number(this.db.prepare("SELECT COUNT(*) c FROM vec_memories").get().c);
      } catch {
      }
    }
    return { dbPath: this.dbPath, total, byType, byProject, vectorEnabled: this._vectorEnabled, vectorCount };
  }
  /**
   * Production (active) time per session for a set of session_ids. Only `session` rollups carry the
   * metric; sessions predating the feature (or with no tracked activity) come back with active_ms 0.
   */
  productionForSessions(sessionIds) {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT session_id, active_ms, project, ts, ended_at, summary
         FROM memories WHERE type='session' AND session_id IN (${placeholders});`
    ).all(...sessionIds);
    return rows.map((r) => ({
      session_id: r.session_id,
      active_ms: r.active_ms == null ? 0 : Number(r.active_ms),
      project: r.project ?? void 0,
      ts: r.ended_at ?? r.ts ?? void 0,
      summary: r.summary ?? void 0
    }));
  }
  // ---- Digests (LLM session compression) -------------------------------------------------
  /** Turns of a session, in order — the raw material fed to the digest LLM. */
  turnsForSession(session_id) {
    const rows = this.db.prepare(
      `SELECT user_prompt, assistant_text, tools, files_modified
         FROM memories WHERE type='turn' AND session_id = ?
         ORDER BY prompt_number ASC, ts_epoch ASC;`
    ).all(session_id);
    return rows.map((r) => ({
      user_prompt: r.user_prompt ?? void 0,
      assistant_text: r.assistant_text ?? void 0,
      tools: jsonArr(r.tools),
      files_modified: jsonArr(r.files_modified)
    }));
  }
  /**
   * Sessions that have a `session` rollup but no digest at the current version.
   * A digest stores its version in `source`, so bumping DIGEST_VERSION re-selects every session.
   */
  sessionsNeedingDigest(version, limit = 5) {
    const rows = this.db.prepare(
      `SELECT m.session_id, m.project, m.branch FROM memories m
         WHERE m.type='session' AND m.session_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM memories d
             WHERE d.type='digest' AND d.session_id = m.session_id AND d.source = ?
           )
         ORDER BY m.ts_epoch DESC LIMIT ?;`
    ).all(String(version), limit);
    return rows.map((r) => ({
      session_id: r.session_id,
      project: r.project ?? void 0,
      branch: r.branch ?? void 0
    }));
  }
  /** Count of sessions still awaiting a digest at the given version (for status/progress). */
  countSessionsNeedingDigest(version) {
    try {
      return Number(
        this.db.prepare(
          `SELECT COUNT(*) c FROM memories m
               WHERE m.type='session' AND m.session_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM memories d
                   WHERE d.type='digest' AND d.session_id = m.session_id AND d.source = ?
                 );`
        ).get(String(version)).c
      );
    } catch {
      return 0;
    }
  }
  /** Replaces a session's digest + insight docs (idempotent). Vectors are filled by the backfill. */
  writeDigest(session_id, digest, insights) {
    this.deleteSessionDigest(session_id);
    this.upsert(`${session_id}:digest`, digest);
    insights.forEach((d, i) => this.upsert(`${session_id}:insight:${i}`, d));
  }
  /** Deletes a session's digest + insights and their vectors. */
  deleteSessionDigest(session_id) {
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE session_id = ? AND type IN ('digest','insight');`).all(session_id).map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    this.db.prepare(`DELETE FROM memories WHERE session_id = ? AND type IN ('digest','insight');`).run(session_id);
  }
  /** Deletes every digest + insight doc (and their vectors). Used by /memory:reindex. */
  clearDigests() {
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE type IN ('digest','insight');`).all().map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE type IN ('digest','insight');`).run();
    return Number(info?.changes ?? rids.length);
  }
  /**
   * Deletes memories matching a filter (+ their vectors; FTS is kept in sync by the delete trigger).
   * Requires at least one filter — never deletes everything implicitly. Returns the count removed.
   */
  deleteMemories(opts) {
    const where = [];
    const args = [];
    if (opts.idPrefix) {
      where.push("substr(mem_id, 1, ?) = ?");
      args.push(opts.idPrefix.length, opts.idPrefix);
    }
    if (opts.project) {
      where.push("project = ?");
      args.push(opts.project);
    }
    if (opts.type) {
      where.push("type = ?");
      args.push(opts.type);
    }
    if (where.length === 0) return 0;
    const w = where.join(" AND ");
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE ${w};`).all(...args).map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE ${w};`).run(...args);
    return Number(info?.changes ?? rids.length);
  }
  /** Empties the vector index so the backfill refills it from scratch. Used by /memory:reindex. */
  resetVectors() {
    if (!this._vectorEnabled) return;
    try {
      this.db.exec("DROP TABLE IF EXISTS vec_memories;");
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${this.dim}]);`
      );
    } catch {
    }
  }
  // ---- Core memories (always injected at SessionStart) ------------------------------------
  /**
   * Adds (or updates) a core memory — a high-priority fact injected into every session's context.
   * Global by default (project undefined) or scoped to a project. Idempotent: the id is a hash of
   * (project, text), so the same fact isn't duplicated. Returns the mem_id.
   */
  addCore(text, project) {
    const id = "core:" + createHash("sha1").update(`${project ?? ""}\0${text}`).digest("hex").slice(0, 12);
    this.upsert(id, {
      type: "core",
      project,
      summary: text.trim().slice(0, 2e3),
      ts: (/* @__PURE__ */ new Date()).toISOString()
    });
    return id;
  }
  /** Core memories visible for a project: its own + globals (project IS NULL). Recent first. */
  listCore(project) {
    const sql = project ? `SELECT * FROM memories WHERE type='core' AND (project = ? OR project IS NULL) ORDER BY ts_epoch DESC;` : `SELECT * FROM memories WHERE type='core' ORDER BY ts_epoch DESC;`;
    const rows = project ? this.db.prepare(sql).all(project) : this.db.prepare(sql).all();
    return rows.map((r) => ({ id: r.mem_id, doc: rowToDoc(r) }));
  }
  /** Removes a core memory by id (+ its vector). Returns the count removed (0 or 1). */
  removeCore(id) {
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE mem_id = ? AND type='core';`).all(id).map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE mem_id = ? AND type='core';`).run(id);
    return Number(info?.changes ?? 0);
  }
  /**
   * Frequency signals to help propose core memories: files touched across the most memories
   * (a file recurring over many sessions is likely structurally important). Best-effort (JSON1).
   */
  coreSignals(limit = 15) {
    try {
      const rows = this.db.prepare(
        `SELECT j.value AS f, COUNT(*) AS c
           FROM memories, json_each(memories.files_modified) j
           WHERE memories.files_modified IS NOT NULL AND memories.files_modified != '[]'
           GROUP BY j.value ORDER BY c DESC LIMIT ?;`
      ).all(limit);
      return { files: rows.map((r) => ({ file: String(r.f), count: Number(r.c) })) };
    } catch {
      return { files: [] };
    }
  }
  // ---- Docs (curated, ingested external documentation) -----------------------------------
  /** Chunk sizing (chars). ~1400 stays inside the e5 token window and the 2000-char embed slice. */
  static DOC_CHUNK_CHARS = 1400;
  static DOC_CHUNK_OVERLAP = 150;
  /** Stable doc_id from a source URL — groups every chunk/pointer of one document. */
  docIdFor(url) {
    return "doc:" + createHash("sha1").update(url.trim()).digest("hex").slice(0, 12);
  }
  /**
   * Splits text into ~chunkChars pieces, preferring paragraph/sentence/word boundaries, with a small
   * overlap so a fact straddling a cut stays recallable from either side.
   */
  chunkText(text, chunkChars = _MemoryStore.DOC_CHUNK_CHARS, overlap = _MemoryStore.DOC_CHUNK_OVERLAP) {
    const clean = text.replace(/\r\n/g, "\n").trim();
    if (clean.length <= chunkChars) return clean ? [clean] : [];
    const chunks = [];
    let i = 0;
    while (i < clean.length) {
      let end = Math.min(i + chunkChars, clean.length);
      if (end < clean.length) {
        const slice = clean.slice(i, end);
        const min = chunkChars * 0.5;
        const para = slice.lastIndexOf("\n\n");
        const sent = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"));
        const ws = slice.lastIndexOf(" ");
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
  addDoc(input) {
    const url = input.url.trim();
    const title = input.title.trim();
    const docId = this.docIdFor(url);
    const labels = (input.labels ?? []).filter((s) => typeof s === "string" && s.trim());
    const fetchedAt = input.fetchedAt ?? (/* @__PURE__ */ new Date()).toISOString();
    this.removeDoc(docId);
    const base = {
      type: "doc",
      project: input.project,
      url,
      doc_id: docId,
      title,
      labels,
      fetched_at: fetchedAt,
      ts: fetchedAt
    };
    const body = (input.body ?? "").trim();
    if (body) {
      const pieces = this.chunkText(body);
      pieces.forEach((piece, i) => {
        this.upsert(`${docId}:${i}`, {
          ...base,
          summary: `${title}

${piece}`.slice(0, 4e3)
        });
      });
      return { docId, chunks: pieces.length };
    }
    this.upsert(docId, {
      ...base,
      summary: (input.summary ? `${title} \u2014 ${input.summary}` : title).slice(0, 2e3)
    });
    return { docId, chunks: 1 };
  }
  /** Lists ingested docs (one entry per source URL), most recent first. Scoped to project + globals. */
  listDocs(project) {
    const where = ["type='doc'"];
    const args = [];
    if (project) {
      where.push("(project = ? OR project IS NULL)");
      args.push(project);
    }
    const rows = this.db.prepare(
      `SELECT doc_id, MAX(title) title, MAX(url) url, MAX(labels) labels, MAX(fetched_at) fetched_at,
                MAX(project) project, COUNT(*) c, MAX(ts_epoch) e
         FROM memories WHERE ${where.join(" AND ")}
         GROUP BY doc_id ORDER BY e DESC;`
    ).all(...args);
    return rows.map((r) => ({
      docId: r.doc_id,
      title: r.title ?? "(untitled)",
      url: r.url ?? "",
      labels: jsonArr(r.labels),
      fetchedAt: r.fetched_at ?? void 0,
      chunks: Number(r.c),
      project: r.project ?? void 0
    }));
  }
  /** Removes every row (chunks + pointer) of an ingested doc by its doc_id (+ vectors). */
  removeDoc(docId) {
    const rids = this.db.prepare(`SELECT rowid FROM memories WHERE type='doc' AND doc_id = ?;`).all(docId).map((r) => Number(r.rowid));
    this.deleteVectors(rids);
    const info = this.db.prepare(`DELETE FROM memories WHERE type='doc' AND doc_id = ?;`).run(docId);
    return Number(info?.changes ?? rids.length);
  }
  /** vec0 has no FK to memories → orphan vectors must be removed explicitly on delete. */
  deleteVectors(rowids) {
    if (!this._vectorEnabled || rowids.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM vec_memories WHERE rowid = ?");
    for (const rid of rowids) {
      try {
        stmt.run(BigInt(rid));
      } catch {
      }
    }
  }
  close() {
    try {
      this.db?.close();
    } catch {
    }
  }
};

// src/memory-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync as existsSync5 } from "fs";
import { randomBytes } from "crypto";
import path8 from "path";

// src/log.ts
import { appendFileSync, mkdirSync as mkdirSync2, existsSync as existsSync2, statSync, renameSync, readFileSync as readFileSync2, writeFileSync } from "fs";
import path3 from "path";
function logDir(dataDir) {
  return path3.join(dataDir, "logs");
}
var MAX_LOG_BYTES = 1e6;
function log(dataDir, msg) {
  try {
    const dir = logDir(dataDir);
    mkdirSync2(dir, { recursive: true });
    const file = path3.join(dir, "memory.log");
    try {
      if (existsSync2(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
    }
    appendFileSync(file, `${(/* @__PURE__ */ new Date()).toISOString()} pid=${process.pid} ${msg}
`);
  } catch {
  }
}
function statusPath(dataDir) {
  return path3.join(dataDir, "status.json");
}
function writeStatus(dataDir, patch) {
  try {
    mkdirSync2(dataDir, { recursive: true });
    const file = statusPath(dataDir);
    let cur = {};
    try {
      cur = JSON.parse(readFileSync2(file, "utf8"));
    } catch {
    }
    writeFileSync(file, JSON.stringify({ ...cur, ...patch, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch {
  }
}

// src/model-host.ts
var ModelHost = class {
  constructor(cacheDir, device, dtype, threads, dataDir, tag) {
    this.cacheDir = cacheDir;
    this.device = device;
    this.dtype = dtype;
    this.threads = threads;
    this.dataDir = dataDir;
    this.tag = tag;
  }
  cacheDir;
  device;
  dtype;
  threads;
  dataDir;
  tag;
  model = null;
  loading = null;
  failed = false;
  /** Effective device after load ('cpu' or a GPU EP); '' until loaded. For status reporting. */
  effectiveDevice = "";
  /** True if the model is ALREADY loaded — never triggers a (blocking) load. For status reporting. */
  loaded() {
    return this.model !== null;
  }
  /** Effective device after load ('cpu' or a GPU EP); '' if not loaded yet. */
  deviceUsed() {
    return this.effectiveDevice;
  }
  /**
   * Frees the loaded model and resets to the unloaded state. Called when this process stops being the
   * leader: an ex-leader would otherwise pin its ONNX session (~2 GB for e5-large) for the lifetime of
   * the process, so with leadership flapping across sessions RAM piles up (observed: several GB).
   *
   * transformers.js pipelines/models expose `dispose()` which releases the underlying ONNX session;
   * we call it best-effort (it may be absent on some model kinds/versions). Resetting the load-state
   * fields lets a later `load()` transparently re-load if this process becomes leader again.
   */
  dispose() {
    try {
      this.model?.dispose?.();
    } catch {
    }
    this.model = null;
    this.loading = null;
    this.failed = false;
    this.effectiveDevice = "";
    try {
      log(this.dataDir, `[${this.tag}] model disposed`);
    } catch {
    }
  }
  /** Loads the model once (shared promise) and returns it, or null if unavailable. */
  async load() {
    if (this.model) return this.model;
    if (this.failed) return null;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const mod = "@huggingface/transformers";
        const tf = await import(mod);
        tf.env.cacheDir = this.cacheDir;
        tf.env.allowRemoteModels = true;
        const threads = Math.max(1, this.threads || 1);
        try {
          tf.env.backends.onnx.numThreads = threads;
          if (tf.env.backends.onnx.wasm) tf.env.backends.onnx.wasm.numThreads = threads;
        } catch {
        }
        const session_options = this.sessionOptions(threads);
        const dtype = this.dtype || "q8";
        await this.beforeAttempts(tf, threads, dtype);
        const attempt = async (device, dt) => {
          const m2 = await this.build(tf, device, dt, session_options);
          await this.warmup(m2);
          return m2;
        };
        let m;
        try {
          m = await attempt(this.device, dtype);
          this.effectiveDevice = this.device && this.device !== "cpu" ? this.device : "cpu";
        } catch (e) {
          log(
            this.dataDir,
            `[${this.tag}] device=${this.device || "cpu"}/dtype=${dtype} failed (${e instanceof Error ? e.message : String(e)}); falling back to cpu/fp32`
          );
          m = await attempt("cpu", "fp32");
          this.effectiveDevice = "cpu";
        }
        this.model = m;
        await this.afterLoad();
        return m;
      } catch (err) {
        this.failed = true;
        const message = err instanceof Error ? err.message : String(err);
        await this.onLoadError(message);
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
  // --- Varying steps (defaults are no-ops; subclasses override what they need) ---
  /** ONNX session tuning. Default: single-pool sequential. */
  sessionOptions(threads) {
    return { intraOpNumThreads: threads, interOpNumThreads: 1 };
  }
  /** One-time pre-load step (logging, status writes, tokenizer load). */
  async beforeAttempts(_tf, _threads, _dtype) {
  }
  /** Success side-effects (final logging, status idle). */
  async afterLoad() {
  }
  /** Failure side-effects (logging, status idle, stderr). */
  async onLoadError(_message) {
  }
};

// src/embeddings.ts
var POOLINGS = /* @__PURE__ */ new Set(["mean", "cls", "last_token"]);
var EmbedderHost = class extends ModelHost {
  constructor(cfg) {
    super(cfg.cacheDir, cfg.device, cfg.dtype, cfg.threads, cfg.dataDir, "embed");
    this.cfg = cfg;
  }
  cfg;
  progressCb;
  // Maximize a single sequential embedding across its allowed threads:
  //  - intraOpNumThreads = threads → fans the heavy matmuls of ONE inference over every allowed core.
  //  - interOpNumThreads = 1 + executionMode sequential → no second pool (a transformer encoder is a
  //    serial layer stack, so inter-op parallelism adds nothing and would risk exceeding the cap).
  //  - graphOptimizationLevel 'all' → fused kernels run faster on the same threads.
  sessionOptions(threads) {
    return {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      executionMode: "sequential",
      graphOptimizationLevel: "all"
    };
  }
  async beforeAttempts(_tf, threads, dtype) {
    log(this.dataDir, `[embed] onnx threads capped at ${threads}`);
    log(this.dataDir, `[embed] loading ${this.cfg.model} (dtype=${dtype}) cache=${this.cfg.cacheDir}`);
    writeStatus(this.dataDir, { state: "loading", model: this.cfg.model, progress: void 0, file: void 0 });
    const lastPct = {};
    this.progressCb = (p) => {
      try {
        if (p?.status === "progress" && p.file && typeof p.progress === "number") {
          const pct = Math.round(p.progress);
          const bucket = Math.floor(pct / 10);
          if (lastPct[p.file] !== bucket) {
            lastPct[p.file] = bucket;
            log(this.dataDir, `[embed] download ${p.file} ${pct}%`);
          }
          writeStatus(this.dataDir, { state: "downloading", model: this.cfg.model, file: p.file, progress: pct });
        } else if (p?.status === "done" && p.file) {
          log(this.dataDir, `[embed] downloaded ${p.file}`);
        } else if (p?.status === "ready") {
          log(this.dataDir, `[embed] model ready (${this.cfg.model})`);
        }
      } catch {
      }
    };
  }
  async build(tf, device, dt, session_options) {
    const opts = { dtype: dt, progress_callback: this.progressCb, session_options };
    if (device && device !== "cpu") opts.device = device;
    return tf.pipeline("feature-extraction", this.cfg.model, opts);
  }
  async warmup(pipe) {
    const pooling = this.cfg.pooling === "cls" ? "cls" : "mean";
    await pipe(["warmup"], { pooling, normalize: true });
  }
  async afterLoad() {
    log(this.dataDir, `[embed] device=${this.effectiveDevice}`);
    writeStatus(this.dataDir, { state: "idle", progress: void 0, file: void 0 });
  }
  async onLoadError(message) {
    log(this.dataDir, `[embed] unavailable: ${message}`);
    writeStatus(this.dataDir, { state: "idle", progress: void 0, file: void 0 });
    process.stderr.write(`[memory] embedder unavailable: ${message}
`);
  }
  /** True if the model is loadable (triggers loading). */
  async ready() {
    if (!this.cfg.enabled) return false;
    return !!await this.load();
  }
  /**
   * Embeds one text. `isQuery` matters for instruction-tuned models (e.g. Qwen3-Embedding) that want
   * a query-side prefix; documents are embedded raw. No-op for models without a queryPrefix.
   */
  async embed(text, isQuery = false) {
    const r = await this.embedBatch([text], isQuery);
    return r[0] ?? null;
  }
  /** Batch embeddings (pooling per model + L2 normalization). null per entry on failure. */
  async embedBatch(texts, isQuery = false) {
    if (!this.cfg.enabled || texts.length === 0) return texts.map(() => null);
    const pipe = await this.load();
    if (!pipe) return texts.map(() => null);
    try {
      const inputs = isQuery && this.cfg.queryPrefix ? texts.map((t) => `${this.cfg.queryPrefix}${t}`) : texts;
      const pooling = POOLINGS.has(this.cfg.pooling) ? this.cfg.pooling : "mean";
      const out = await pipe(inputs, { pooling, normalize: true });
      const arr = out.tolist();
      return texts.map((_, i) => Array.isArray(arr[i]) && arr[i].length > 0 ? arr[i] : null);
    } catch {
      return texts.map(() => null);
    }
  }
};

// src/rerank.ts
var RerankerHost = class extends ModelHost {
  constructor(opts) {
    super(opts.cacheDir, opts.device, opts.dtype, opts.threads, opts.dataDir, "rerank");
    this.opts = opts;
  }
  opts;
  tok = null;
  async beforeAttempts(tf, threads, dtype) {
    log(
      this.dataDir,
      `[rerank] loading ${this.opts.model} (dtype=${dtype}, device=${this.opts.device || "cpu"}, threads=${threads})`
    );
    this.tok = await tf.AutoTokenizer.from_pretrained(this.opts.model);
  }
  async build(tf, device, dt, session_options) {
    const o = { dtype: dt, session_options };
    if (device && device !== "cpu") o.device = device;
    return tf.AutoModelForSequenceClassification.from_pretrained(this.opts.model, o);
  }
  async warmup(model) {
    const probe = this.tok(["warmup"], { text_pair: ["warmup"], padding: true, truncation: true });
    await model(probe);
  }
  async afterLoad() {
    log(this.dataDir, `[rerank] model ready (${this.opts.model})`);
  }
  async onLoadError(message) {
    log(this.dataDir, `[rerank] unavailable: ${message}`);
  }
  /**
   * Cross-encoder relevance scores for (query, doc) pairs. Returns one score per doc (higher = more
   * relevant), aligned to `docs`, or null if the reranker is unavailable (→ caller keeps RRF order).
   */
  async rerank(query, docs) {
    if (docs.length === 0) return [];
    if (!this.opts.model) return null;
    const model = await this.load();
    if (!model) return null;
    try {
      const inputs = this.tok(new Array(docs.length).fill(query), {
        text_pair: docs,
        padding: true,
        truncation: true
      });
      const { logits } = await model(inputs);
      const rows = logits.sigmoid().tolist();
      return rows.map((row) => Array.isArray(row) ? Number(row[0]) : Number(row));
    } catch {
      return null;
    }
  }
};

// src/leader.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3, unlinkSync, openSync, closeSync, renameSync as renameSync2 } from "fs";
import path4 from "path";
var STALE_MS = 9e4;
var READ_RETRIES = 3;
var READ_RETRY_MS = 10;
var amHolder = false;
function lockPath(dataDir) {
  return path4.join(dataDir, "worker.lock");
}
function tempPath(dataDir) {
  return path4.join(dataDir, `worker.lock.${process.pid}.tmp`);
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function busySleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
  }
}
function readLockStrict(dataDir) {
  const file = lockPath(dataDir);
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    try {
      const raw = readFileSync3(file, "utf8");
      const info = JSON.parse(raw);
      return { kind: "present", info };
    } catch (e) {
      if (e?.code === "ENOENT") return { kind: "absent" };
      if (attempt < READ_RETRIES - 1) busySleep(READ_RETRY_MS);
    }
  }
  return { kind: "transient" };
}
function readLock(dataDir) {
  try {
    return JSON.parse(readFileSync3(lockPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}
function releaseLeadership(dataDir) {
  try {
    const cur = readLock(dataDir);
    if (cur && cur.pid === process.pid) unlinkSync(lockPath(dataDir));
  } catch {
  }
}
function removeStaleLock(file) {
  try {
    unlinkSync(file);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
}
function tryCreateExclusive(file, content) {
  let fd;
  try {
    fd = openSync(file, "wx");
    writeFileSync2(fd, content);
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    return false;
  } finally {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
function atomicRenew(dataDir, file, content) {
  const tmp = tempPath(dataDir);
  try {
    writeFileSync2(tmp, content);
    renameSync2(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
    }
    return false;
  }
}
function refreshLeadership(dataDir, extra) {
  const file = lockPath(dataDir);
  const now = Date.now();
  try {
    mkdirSync3(path4.dirname(file), { recursive: true });
  } catch {
  }
  const content = JSON.stringify({ pid: process.pid, ts: now, ...extra ?? {} });
  const read = readLockStrict(dataDir);
  if (read.kind === "absent") {
    return amHolder = tryCreateExclusive(file, content);
  }
  if (read.kind === "transient") {
    return amHolder;
  }
  const cur = read.info;
  if (cur.pid === process.pid) {
    return amHolder = atomicRenew(dataDir, file, content);
  }
  const fresh = typeof cur.ts === "number" && now - cur.ts < STALE_MS;
  const alive = typeof cur.pid === "number" && pidAlive(cur.pid);
  if (fresh && alive) return amHolder = false;
  try {
    removeStaleLock(file);
  } catch {
    return amHolder = false;
  }
  return amHolder = tryCreateExclusive(file, content);
}

// src/embed-service.ts
import { createServer, request as httpRequest } from "http";

// src/activity.ts
var last = Date.now();
function touch() {
  last = Date.now();
}
function idleMs() {
  return Date.now() - last;
}

// src/embed-service.ts
var TOKEN_HEADER = "x-mem-token";
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}
async function startLeaderService(handlers, token) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.headers[TOKEN_HEADER] !== token) {
      res.writeHead(404);
      res.end();
      return;
    }
    touch();
    try {
      const body = await readBody(req);
      let payload;
      if (req.url === "/embed") {
        payload = { vector: await handlers.embed(String(body?.text ?? "")) };
      } else if (req.url === "/rerank") {
        const docs = Array.isArray(body?.docs) ? body.docs.map((d) => String(d)) : [];
        payload = { scores: await handlers.rerank(String(body?.query ?? ""), docs) };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  server.unref?.();
  return port;
}
function post(endpoint, path10, body, pick, timeoutMs = 8e3) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        method: "POST",
        path: path10,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          [TOKEN_HEADER]: endpoint.token
        }
      },
      (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => {
          try {
            resolve(pick(JSON.parse(d)));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}
function remoteEmbed(endpoint, text, timeoutMs = 8e3) {
  return post(endpoint, "/embed", { text }, (j) => Array.isArray(j?.vector) ? j.vector : null, timeoutMs);
}
function remoteRerank(endpoint, query, docs) {
  return post(endpoint, "/rerank", { query, docs }, (j) => Array.isArray(j?.scores) ? j.scores : null);
}

// src/query-executor.ts
var LocalExecutor = class {
  constructor(embedder, reranker) {
    this.embedder = embedder;
    this.reranker = reranker;
  }
  embedder;
  reranker;
  embedQuery(text) {
    return this.embedder.embed(text, true);
  }
  rerankQuery(query, docs) {
    return this.reranker.rerank(query, docs);
  }
};
var RemoteExecutor = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  dataDir;
  async embedQuery(text) {
    const lock = readLock(this.dataDir);
    if (lock?.port && lock?.token) return remoteEmbed({ port: lock.port, token: lock.token }, text);
    return null;
  }
  async rerankQuery(query, docs) {
    const lock = readLock(this.dataDir);
    if (lock?.port && lock?.token) return remoteRerank({ port: lock.port, token: lock.token }, query, docs);
    return null;
  }
};

// src/leader-coordinator.ts
import { EventEmitter } from "events";
import { watch } from "fs";
var HEARTBEAT_MS = 3e4;
var LeaderCoordinator = class extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
  }
  dataDir;
  leader = false;
  /** Extra fields published into the lock (the leader's loopback endpoint). */
  extra = {};
  heartbeat;
  watcher;
  watchT;
  releasing = false;
  isLeader() {
    return this.leader;
  }
  /** Publishes the leader's loopback endpoint into the lock (re-refreshes immediately). */
  publishEndpoint(port, token) {
    this.extra = { port, token };
    this.sync();
  }
  /**
   * Acquires/renews the lock once and emits a transition event if leadership changed. Safe to call
   * repeatedly (heartbeat + fs.watch). A tiny two-leaders race is harmless (writes are idempotent).
   */
  sync() {
    const was = this.leader;
    this.leader = refreshLeadership(this.dataDir, this.extra);
    if (this.leader !== was) {
      log(this.dataDir, `[server] leadership \u2192 ${this.leader}`);
      this.emit(this.leader ? "becameLeader" : "lostLeadership");
    }
  }
  /**
   * First sync + heartbeat + near-instant failover watch. When the leader releases the lock, a
   * follower re-checks immediately instead of waiting for its 30 s heartbeat (only followers react;
   * a leader ignores its own writes). Heartbeat remains the fallback if fs.watch is unsupported.
   */
  start() {
    this.sync();
    this.heartbeat = setInterval(() => this.sync(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    try {
      this.watcher = watch(this.dataDir, (_event, filename) => {
        if (!this.leader && filename && String(filename).includes("worker.lock")) {
          clearTimeout(this.watchT);
          const delay = 200 + Math.floor(Math.random() * 300);
          this.watchT = setTimeout(() => this.sync(), delay);
        }
      });
      this.watcher.unref?.();
    } catch {
    }
  }
  /**
   * Releases leadership if held (called on exit/session close) so a sibling takes over on its next
   * heartbeat instead of waiting out the stale timeout. Idempotent.
   */
  release() {
    if (this.releasing) return;
    this.releasing = true;
    if (this.leader) {
      releaseLeadership(this.dataDir);
      log(this.dataDir, `[server] released leadership on exit (pid ${process.pid})`);
    }
  }
};

// src/throttle.ts
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
function throttlePause(workMs, loadPercent, capMs = 3e4) {
  if (!Number.isFinite(loadPercent) || loadPercent >= 100 || loadPercent <= 0 || workMs <= 0) return 0;
  return Math.min(capMs, Math.round(workMs * (100 / loadPercent - 1)));
}

// src/backfill-loop.ts
var BACKFILL_INTERVAL_MS = 6e4;
var BACKFILL_BATCH = 32;
var BackfillLoop = class {
  constructor(store, cfg, embedder) {
    this.store = store;
    this.cfg = cfg;
    this.embedder = embedder;
  }
  store;
  cfg;
  embedder;
  running = false;
  timer;
  /** Kicks one pass now (warm + drain) and every interval afterwards. */
  start() {
    if (this.timer || !this.store.vectorEnabled || !this.cfg.embed.enabled) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), BACKFILL_INTERVAL_MS);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
  }
  /** One backfill drain: batched ONNX passes, each written in a single transaction. Best-effort. */
  async run() {
    if (this.running || !this.store.vectorEnabled || !this.cfg.embed.enabled) return;
    if (!await this.embedder.ready()) return;
    this.running = true;
    try {
      for (; ; ) {
        const docs = this.store.missingVectorDocs(BACKFILL_BATCH);
        if (docs.length === 0) break;
        writeStatus(this.cfg.dataDir, {
          state: "backfilling",
          model: this.cfg.embed.model,
          vectorized: this.store.stats().vectorCount,
          missing: this.store.countMissingVectors(),
          loadPercent: this.cfg.loadPercent
        });
        const t0 = Date.now();
        const vectors = await this.embedder.embedBatch(docs.map((d) => d.text));
        const writes = [];
        for (let i = 0; i < docs.length; i++) {
          const v = vectors[i];
          if (v) writes.push({ rowid: docs[i].rowid, embedding: v });
        }
        this.store.setVectorsBulk(writes);
        const pause = throttlePause(Date.now() - t0, this.cfg.loadPercent);
        if (pause > 0) await sleep(pause);
      }
    } catch {
    } finally {
      this.running = false;
      const s = this.store.stats();
      writeStatus(this.cfg.dataDir, {
        state: "idle",
        vectorized: s.vectorCount,
        missing: this.store.countMissingVectors()
      });
    }
  }
};

// src/digest.ts
import { spawn } from "child_process";
import { existsSync as existsSync3 } from "fs";
import os2 from "os";
import path5 from "path";
var KINDS = /* @__PURE__ */ new Set(["decision", "bugfix", "discovery", "conclusion"]);
var INPUT_BUDGET = 48e3;
var TIMEOUT_MS = 18e4;
var QUOTA_RE = /usage limit reached|rate[ _-]?limit|\b429\b|\b529\b|overloaded|quota (?:exceeded|reached)|insufficient_quota/i;
function parseResetMs(text) {
  const m = text.match(/usage limit reached\s*\|\s*(\d{9,13})/i);
  if (!m) return void 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return void 0;
  return n < 1e12 ? n * 1e3 : n;
}
function renderSession(input) {
  const parts = [];
  let size = 0;
  let truncated = false;
  for (const t of input.turns) {
    const u = (t.user_prompt ?? "").trim();
    const a = (t.assistant_text ?? "").trim();
    const files = t.files_modified.length ? `
  files: ${t.files_modified.join(", ")}` : "";
    const block = `> user: ${u}
  assistant: ${a}${files}`;
    if (size + block.length > INPUT_BUDGET) {
      truncated = true;
      break;
    }
    parts.push(block);
    size += block.length;
  }
  if (truncated) parts.push("\u2026 [session truncated for length]");
  return parts.join("\n\n");
}
function buildPrompt(input) {
  return [
    "You compress a Claude Code coding session into durable memory for future sessions.",
    "Read the session (user prompts + assistant turns + touched files) and extract only durable, reusable facts.",
    "",
    "Output ONLY a JSON object \u2014 no prose, no markdown fences \u2014 with exactly this shape:",
    "{",
    '  "conclusion": "1-3 sentences: what was achieved and the final state",',
    '  "insights": [',
    '    { "kind": "decision|bugfix|discovery|conclusion", "text": "one concrete durable fact", "files": ["path"] }',
    "  ],",
    '  "satisfaction": 0.0,',
    '  "mood": "one or two words"',
    "}",
    "",
    "Rules:",
    "- 3 to 8 insights max. Only decisions made, bugs fixed, things discovered, or conclusions. Skip chit-chat and intermediate noise.",
    '- "files" is optional; include only files actually touched for that fact.',
    '- "satisfaction" is a number in [0, 1] rating how satisfied/content the USER seemed by the end:',
    "  0 = clearly frustrated or dissatisfied (repeated corrections, complaints, things still broken),",
    "  0.5 = neutral or unclear, 1 = clearly satisfied/pleased (thanks, praise, goal achieved cleanly).",
    "  Judge ONLY from the user's tone and reactions, not your own opinion. Use 0.5 when in doubt.",
    `- "mood" is one or two words for the user's overall mood (e.g. satisfied, frustrated, neutral, grateful).`,
    "- Be concise and specific. Write in the language of the session.",
    "- Do not use any tools. Just read the session text below and respond with the JSON.",
    "",
    `SESSION (project: ${input.project ?? "?"}, branch: ${input.branch ?? "?"}):`,
    renderSession(input)
  ].join("\n");
}
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
function resolveClaudeExe() {
  const isWin = process.platform === "win32";
  const name = isWin ? "claude.exe" : "claude";
  const sep = isWin ? ";" : ":";
  const dirs = [path5.join(os2.homedir(), ".local", "bin"), ...(process.env.PATH || "").split(sep)];
  for (const d of dirs) {
    if (!d) continue;
    const p = path5.join(d, name);
    if (existsSync3(p)) return p;
  }
  return null;
}
function claudeAvailable() {
  return resolveClaudeExe() !== null;
}
function runClaude(prompt, model) {
  return new Promise((resolve) => {
    const exe = resolveClaudeExe();
    if (!exe) {
      resolve({ kind: "fail" });
      return;
    }
    const args = [
      "-p",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--output-format",
      "json"
    ];
    if (model) args.push("--model", model);
    let child;
    try {
      child = spawn(exe, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MEMORY_HOOK_DISABLE: "1" }
      });
    } catch {
      resolve({ kind: "fail" });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const classifyFailure = () => {
      const blob = `${out}
${err}`;
      if (QUOTA_RE.test(blob)) return { kind: "rate_limited", retryAtMs: parseResetMs(blob) };
      return { kind: "fail" };
    };
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ kind: "fail" }), TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => finish({ kind: "fail" }));
    child.stdout?.on("data", (d) => out += d);
    child.stderr?.on("data", (d) => err += d);
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(classifyFailure());
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(out);
      } catch {
        resolve(classifyFailure());
        return;
      }
      if (envelope?.is_error && QUOTA_RE.test(String(envelope.result ?? out))) {
        resolve({ kind: "rate_limited", retryAtMs: parseResetMs(String(envelope.result ?? out)) });
        return;
      }
      resolve({ kind: "ok", envelope });
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      finish({ kind: "fail" });
    }
  });
}
async function digestSession(input) {
  if (input.turns.length === 0) return { status: "skip" };
  const run = await runClaude(buildPrompt(input), input.model);
  if (run.kind === "rate_limited") return { status: "rate_limited", retryAtMs: run.retryAtMs };
  if (run.kind !== "ok") return { status: "skip" };
  const envelope = run.envelope;
  if (!envelope || typeof envelope.result !== "string") return { status: "skip" };
  const parsed = extractJsonObject(envelope.result);
  const conclusion = parsed && typeof parsed.conclusion === "string" && parsed.conclusion.trim() || envelope.result.trim().slice(0, 1e3);
  if (!conclusion) return { status: "skip" };
  const rawInsights = parsed && Array.isArray(parsed.insights) ? parsed.insights : [];
  const insights = rawInsights.filter((x) => x && typeof x.text === "string" && x.text.trim()).slice(0, 8).map((x) => ({
    kind: KINDS.has(x.kind) ? x.kind : "discovery",
    text: String(x.text).trim().slice(0, 1e3),
    files: Array.isArray(x.files) ? x.files.filter((f) => typeof f === "string").slice(0, 10) : void 0
  }));
  const satRaw = parsed ? Number(parsed.satisfaction) : NaN;
  const satisfaction = Number.isFinite(satRaw) ? Math.max(0, Math.min(1, satRaw)) : 0.5;
  const mood = parsed && typeof parsed.mood === "string" && parsed.mood.trim() ? parsed.mood.trim().slice(0, 40) : void 0;
  return {
    status: "ok",
    result: {
      conclusion,
      insights,
      satisfaction,
      mood,
      usage: envelope.usage,
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : void 0
    }
  };
}

// src/memory.ts
import { readFileSync as readFileSync4 } from "fs";
import path6 from "path";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// src/digest-loop.ts
var DIGEST_INTERVAL_MS = 6e4;
var DIGEST_PER_TICK = 3;
var BACKOFF_MIN_MS = 5 * 6e4;
var BACKOFF_MAX_MS = 60 * 6e4;
var RESET_BUFFER_MS = 1e4;
var DigestLoop = class {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
  }
  store;
  cfg;
  running = false;
  timer;
  warnedNoClaude = false;
  // Quota pause: epoch-ms until which we must NOT call `claude -p` (0 = not paused). `backoffMs`
  // holds the current exponential step used when the limit carries no explicit reset time.
  pausedUntilMs = 0;
  backoffMs = 0;
  /** Records a usage/rate-limit hit and arms the pause (honoring an explicit reset, else backoff). */
  pauseForRateLimit(retryAtMs) {
    const now = Date.now();
    let until;
    if (retryAtMs && retryAtMs > now) {
      until = retryAtMs + RESET_BUFFER_MS;
    } else {
      this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
      until = now + this.backoffMs;
    }
    this.pausedUntilMs = until;
    const iso = new Date(until).toISOString();
    log(this.cfg.dataDir, `[digest] usage/rate-limit hit \u2192 pausing digests until ${iso}`);
    writeStatus(this.cfg.dataDir, {
      state: "idle",
      digestPending: this.store.countSessionsNeedingDigest(this.cfg.digest.version),
      digestPausedUntil: iso
    });
  }
  /** Kicks one pass now and every interval afterwards. */
  start() {
    if (this.timer || !this.cfg.digest.enabled) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), DIGEST_INTERVAL_MS);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
  }
  /** One drip of digests (up to DIGEST_PER_TICK sessions). Best-effort: never blocks the server. */
  async run() {
    if (this.running || !this.cfg.digest.enabled) return;
    if (this.pausedUntilMs && Date.now() < this.pausedUntilMs) return;
    if (!claudeAvailable()) {
      if (!this.warnedNoClaude) {
        this.warnedNoClaude = true;
        log(this.cfg.dataDir, "[digest] disabled: no native `claude` binary found on PATH (~/.local/bin)");
      }
      return;
    }
    this.running = true;
    try {
      const sessions = this.store.sessionsNeedingDigest(this.cfg.digest.version, DIGEST_PER_TICK);
      for (const sess of sessions) {
        const turns = this.store.turnsForSession(sess.session_id);
        if (turns.length === 0) continue;
        writeStatus(this.cfg.dataDir, {
          state: "digesting",
          digestPending: this.store.countSessionsNeedingDigest(this.cfg.digest.version),
          loadPercent: this.cfg.loadPercent
        });
        const t0 = Date.now();
        const outcome = await digestSession({
          session_id: sess.session_id,
          project: sess.project,
          branch: sess.branch,
          model: this.cfg.digest.model,
          turns
        });
        if (outcome.status === "rate_limited") {
          this.pauseForRateLimit(outcome.retryAtMs);
          return;
        }
        if (outcome.status !== "ok") continue;
        this.pausedUntilMs = 0;
        this.backoffMs = 0;
        const result = outcome.result;
        const ts = nowIso();
        const base = { session_id: sess.session_id, project: sess.project, branch: sess.branch, ts };
        const digestFiles = uniq(result.insights.flatMap((i) => i.files ?? []));
        const digestDoc = {
          type: "digest",
          ...base,
          summary: result.conclusion,
          source: String(this.cfg.digest.version),
          // version marker → re-digest selector
          files_modified: digestFiles,
          satisfaction: result.satisfaction,
          mood: result.mood
        };
        const insightDocs = result.insights.map((ins) => ({
          type: "insight",
          ...base,
          summary: ins.text,
          assistant_text: ins.text,
          source: ins.kind,
          // decision | bugfix | discovery | conclusion
          files_modified: ins.files ?? [],
          // Insights inherit the session's satisfaction so the weighting applies to them too.
          satisfaction: result.satisfaction
        }));
        this.store.writeDigest(sess.session_id, digestDoc, insightDocs);
        log(
          this.cfg.dataDir,
          `[digest] ${sess.session_id} \u2192 ${result.insights.length} insights${result.costUsd != null ? ` ($${result.costUsd.toFixed(4)})` : ""}`
        );
        const pause = throttlePause(Date.now() - t0, this.cfg.loadPercent);
        if (pause > 0) await sleep(pause);
      }
    } catch {
    } finally {
      this.running = false;
      const remaining = this.store.countSessionsNeedingDigest(this.cfg.digest.version);
      if (remaining === 0) writeStatus(this.cfg.dataDir, { state: "idle", digestPending: 0 });
    }
  }
};

// src/process-name.ts
import { existsSync as existsSync4, copyFileSync, mkdirSync as mkdirSync4, readdirSync, unlinkSync as unlinkSync2 } from "fs";
import path7 from "path";
function processName(tier) {
  const safe = (tier || "light").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `pendrayg_memory_${safe}`;
}
function ensureNamedBinary(name) {
  if (process.env.MEMORY_DISABLE_RENAME === "1") return;
  if (process.platform !== "win32") return;
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return;
    const root = path7.resolve(path7.dirname(scriptPath), "..");
    const binDir = path7.join(root, "bin");
    const exe = path7.join(binDir, `${name}.exe`);
    if (path7.basename(process.execPath).toLowerCase() === `${name}.exe`) return;
    if (!existsSync4(exe)) {
      mkdirSync4(binDir, { recursive: true });
      copyFileSync(process.execPath, exe);
    }
    try {
      const running = path7.basename(process.execPath).toLowerCase();
      for (const f of readdirSync(binDir)) {
        const low = f.toLowerCase();
        if (low.startsWith("pendrayg_memory_") && low.endsWith(".exe") && low !== `${name}.exe` && low !== running) {
          unlinkSync2(path7.join(binDir, f));
        }
      }
    } catch {
    }
  } catch {
  }
}

// src/tools/search.ts
var TYPES = ["observation", "prompt", "turn", "session", "digest", "insight", "doc"];
function moodMarker(d) {
  if (d.satisfaction == null || !Number.isFinite(d.satisfaction)) return "";
  const emoji = d.satisfaction >= 0.66 ? "\u{1F600}" : d.satisfaction <= 0.33 ? "\u{1F641}" : "\u{1F610}";
  return d.mood ? ` ${emoji} ${d.mood}` : ` ${emoji}`;
}
function fmtDoc(d) {
  const date = (d.ts ?? d.ended_at ?? "").slice(0, 16).replace("T", " ");
  const proj = d.project ?? "?";
  const label = d.summary || d.user_prompt || d.assistant_text || d.prompts && d.prompts.join(" | ") || d.tool_brief || "(no summary)";
  const text = label.replace(/\s+/g, " ").trim().slice(0, 300);
  const files = (d.files_modified ?? []).slice(0, 4);
  const filesLine = files.length ? `
  \u{1F4DD} ${files.join(", ")}` : "";
  const docLine = d.type === "doc" && d.url ? `
  \u{1F4C4} ${d.title ? `${d.title} \xB7 ` : ""}${d.url}` : "";
  return `- **[${d.type}]** \`${proj}\` \xB7 ${date}${moodMarker(d)}
  ${text}${docLine}${filesLine}`;
}
function rerankText(d) {
  const t = d.summary || d.assistant_text || d.user_prompt || d.prompts && d.prompts.join(" ") || d.tool_brief || "";
  return t.replace(/\s+/g, " ").trim().slice(0, 2e3);
}
var memorySearch = {
  name: "memory_search",
  description: "Searches the Claude Code session memories (local SQLite). Hybrid: BM25 full-text + semantic (local embeddings) if available. Useful to recall how a problem was solved, what was decided, which files were touched in previous sessions.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for." },
      project: {
        type: "string",
        description: "Limit to a project (directory basename). Optional."
      },
      type: { type: "string", enum: TYPES, description: "Filter by memory type. Optional." },
      limit: { type: "number", description: "Number of results (default 10)." }
    },
    required: ["query"],
    additionalProperties: false
  },
  handler: async (args, { store, embedQuery, rerank, config }) => {
    const query = String(args.query ?? "").trim();
    if (!query) return "\u274C `query` is required.";
    const limit = args.limit ? Number(args.limit) : 10;
    const project = args.project ? String(args.project) : void 0;
    const type = args.type ? String(args.type) : void 0;
    const embedding = store.vectorEnabled ? await embedQuery(query) : null;
    const rerankOn = config.rerank.enabled;
    const candidateK = rerankOn ? Math.min(100, Math.max(50, limit * 5)) : limit;
    const satWeight = config.satisfactionWeight;
    let docs = store.search({
      query,
      project,
      type,
      limit: candidateK,
      embedding,
      satisfactionWeight: satWeight
    });
    if (docs.length === 0) return `No memory for "${query}".`;
    let mode = embedding ? "hybrid BM25+semantic" : "BM25";
    if (rerankOn && docs.length > limit) {
      const scores = await rerank(query, docs.map(rerankText));
      if (scores && scores.length === docs.length) {
        docs = docs.map((d, i) => ({ d, s: (scores[i] ?? -Infinity) * satisfactionFactor(d.satisfaction, satWeight) })).sort((a, b) => b.s - a.s).map((x) => x.d);
        mode += " + rerank";
      }
    }
    docs = docs.slice(0, limit);
    return `\u{1F50E} **${docs.length} memory(ies)** for "${query}" _(${mode})_:

${docs.map(fmtDoc).join("\n")}`;
  }
};
var memoryRecent = {
  name: "memory_recent",
  description: "Lists the most recent memories (sorted by date), optionally filtered by project or type.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Limit to a project. Optional." },
      type: { type: "string", enum: TYPES, description: "Filter by type. Optional." },
      limit: { type: "number", description: "Number of results (default 10)." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const docs = store.recent({
      project: args.project ? String(args.project) : void 0,
      type: args.type ? String(args.type) : void 0,
      limit: args.limit ? Number(args.limit) : 10
    });
    if (docs.length === 0) return "No indexed memory.";
    return `\u{1F551} **${docs.length} recent memory(ies)**:

${docs.map(fmtDoc).join("\n")}`;
  }
};
var memoryStats = {
  name: "memory_stats",
  description: "Diagnostics: SQLite database path, total documents, breakdown by type/project, state of the vector index and the local embedder.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, { store, embedCfg, embedder, config }) => {
    const s = store.stats();
    const missing = store.countMissingVectors();
    const embedderUp = embedCfg.enabled && s.vectorEnabled ? embedder.loaded() : false;
    const lines = [];
    lines.push(`**memory \u2014 state**`);
    lines.push(`- SQLite database: \`${s.dbPath}\``);
    lines.push(`- Documents: **${s.total}**`);
    const byType = Object.entries(s.byType).map(([k, v]) => `${k}=${v}`).join(", ");
    const byProj = Object.entries(s.byProject).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(", ");
    if (byType) lines.push(`- By type: ${byType}`);
    if (byProj) lines.push(`- By project: ${byProj}`);
    lines.push(
      `- Vectors (sqlite-vec): ${s.vectorEnabled ? `\u2705 enabled (${s.vectorCount} indexed, ${missing} pending)` : "\u274C disabled"}`
    );
    const dev = embedderUp ? ` (device=${embedder.deviceUsed() || "cpu"})` : "";
    lines.push(
      `- Embedder (${embedCfg.model}): ${!embedCfg.enabled ? "disabled (MEMORY_EMBED_ENABLED=0)" : embedderUp ? `\u2705 loaded${dev}` : "\u23F3 not loaded yet / unavailable"}`
    );
    const digestPending = config.digest.enabled ? store.countSessionsNeedingDigest(config.digest.version) : 0;
    const load = config.loadPercent;
    lines.push(
      `- Background load cap: ${load >= 100 ? "none (100% \u2014 full speed)" : `${load}% of CPU/GPU (paced)`}`
    );
    if (missing > 0 || digestPending > 0) {
      const bits = [];
      if (digestPending > 0) bits.push(`${digestPending} session(s) to (re)digest`);
      if (missing > 0) bits.push(`${missing} vector(s) to compute`);
      lines.push(`- Background indexing in progress: ${bits.join(", ")}.`);
      lines.push(
        `  This is a **one-time catch-up** (e.g. after a plugin update that improves memories). It runs in the background and memory stays usable meanwhile. To use less CPU/GPU, lower the load cap via \`/memory:load <percent>\` (e.g. 30) \u2014 slower backfill, lighter machine.`
      );
    }
    return lines.join("\n");
  }
};
var searchTools = [memorySearch, memoryRecent, memoryStats];

// src/tools/reindex.ts
var memoryReindex = {
  name: "memory_reindex",
  description: "Forces reprocessing of existing memories. `vectors` empties the vector index (backfill refills it). `digests` deletes all LLM digests/insights (the digest loop regenerates them). With no argument, does both. Background, non-blocking; BM25 stays available throughout.",
  inputSchema: {
    type: "object",
    properties: {
      vectors: { type: "boolean", description: "Clear and rebuild the vector index. Default: true if neither given." },
      digests: { type: "boolean", description: "Delete and regenerate LLM digests/insights. Default: true if neither given." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const both = args.vectors === void 0 && args.digests === void 0;
    const doVectors = both || args.vectors === true;
    const doDigests = both || args.digests === true;
    const lines = ["**memory \u2014 reindex**"];
    if (doDigests) {
      const n = store.clearDigests();
      lines.push(`- Digests/insights: deleted **${n}** doc(s) \u2192 will be regenerated by the digest loop.`);
    }
    if (doVectors) {
      if (store.vectorEnabled) {
        store.resetVectors();
        lines.push("- Vectors: index emptied \u2192 will be refilled by the backfill.");
      } else {
        lines.push("- Vectors: index disabled (nothing to do).");
      }
    }
    lines.push("_Reprocessing runs in the background (non-blocking). BM25 stays available meanwhile._");
    return lines.join("\n");
  }
};
var reindexTools = [memoryReindex];

// src/tools/delete.ts
var TYPES2 = ["observation", "prompt", "turn", "session", "digest", "insight", "doc"];
var memoryDelete = {
  name: "memory_delete",
  description: 'DESTRUCTIVE. Deletes memories matching a filter (and their vectors). Filters combine with AND; at least one is required. Use idPrefix "migrated:" to remove claude-mem imports. Always confirm with the user before calling.',
  inputSchema: {
    type: "object",
    properties: {
      idPrefix: {
        type: "string",
        description: 'Delete docs whose mem_id starts with this (e.g. "migrated:" for claude-mem imports).'
      },
      project: { type: "string", description: "Limit to a project (directory basename)." },
      type: { type: "string", enum: TYPES2, description: "Limit to a memory type." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const idPrefix = args.idPrefix ? String(args.idPrefix) : void 0;
    const project = args.project ? String(args.project) : void 0;
    const type = args.type ? String(args.type) : void 0;
    if (!idPrefix && !project && !type) {
      return "\u274C Refusing to delete: provide at least one filter (idPrefix, project, or type).";
    }
    const n = store.deleteMemories({ idPrefix, project, type });
    const filters = [
      idPrefix ? `idPrefix="${idPrefix}"` : null,
      project ? `project="${project}"` : null,
      type ? `type="${type}"` : null
    ].filter(Boolean).join(", ");
    return `\u{1F5D1}\uFE0F Deleted **${n}** memory(ies) matching ${filters}. Their vectors were removed too; BM25 index stays in sync.`;
  }
};
var deleteTools = [memoryDelete];

// src/tools/core.ts
function line(d) {
  const date = (d.ts ?? "").slice(0, 10);
  const proj = d.project ?? "global";
  return `\`${proj}\`${date ? ` \xB7 ${date}` : ""} \u2014 ${(d.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200)}`;
}
var coreAdd = {
  name: "memory_core_add",
  description: "Saves a CORE memory: a primordial fact injected into every session at load time. Use when the user explicitly asks to remember something important, or \u2014 after confirming with the user \u2014 for a recurring fact you detected. Keep it one concise, durable sentence. Omit `project` for a global core (shown everywhere); pass a project name to scope it.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The core fact (one concise, durable sentence)." },
      project: { type: "string", description: "Scope to a project (directory basename). Omit for global." }
    },
    required: ["text"],
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const text = String(args.text ?? "").trim();
    if (!text) return "\u274C `text` is required.";
    const project = args.project ? String(args.project) : void 0;
    const id = store.addCore(text, project);
    return `\u{1F9E0}\u2B50 Core memory saved (${project ? `project \`${project}\`` : "global"}): "${text}"
_id: ${id}_ \u2014 it will be injected at the start of every${project ? " matching" : ""} session.`;
  }
};
var coreList = {
  name: "memory_core_list",
  description: "Lists core memories (the always-injected facts). Optionally scoped to a project (also shows globals).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Limit to a project (also includes globals). Optional." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const project = args.project ? String(args.project) : void 0;
    const cores = store.listCore(project);
    if (cores.length === 0) return "No core memory yet.";
    return `\u{1F9E0}\u2B50 **${cores.length} core memory(ies)**:

${cores.map((c) => `- ${line(c.doc)}
  _id: ${c.id}_`).join("\n")}`;
  }
};
var coreRemove = {
  name: "memory_core_remove",
  description: "Removes a core memory by its id (get ids from memory_core_list). Confirm with the user first.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: 'The core memory id (e.g. "core:ab12cd34ef56").' } },
    required: ["id"],
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const id = String(args.id ?? "").trim();
    if (!id) return "\u274C `id` is required.";
    const n = store.removeCore(id);
    return n > 0 ? `\u{1F5D1}\uFE0F Core memory \`${id}\` removed.` : `No core memory with id \`${id}\`.`;
  }
};
var coreSuggest = {
  name: "memory_core_suggest",
  description: "Surfaces signals to help propose a core memory: files touched across many memories, and recent conclusions. Review them; if a durable, important fact recurs, PROPOSE it to the user and, on agreement, call memory_core_add. Do not create a core without the user agreeing.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Bias toward a project. Optional." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const project = args.project ? String(args.project) : void 0;
    const { files } = store.coreSignals(15);
    const digests = store.recent({ project, type: "digest", limit: 8 });
    const existing = store.listCore(project);
    const lines = ["**Core-memory signals** \u2014 review, then propose to the user if warranted."];
    if (files.length) {
      lines.push("\nFiles recurring across many memories:");
      for (const f of files) lines.push(`- ${f.file} (${f.count})`);
    }
    if (digests.length) {
      lines.push("\nRecent conclusions:");
      for (const d of digests) lines.push(`- ${line(d)}`);
    }
    if (existing.length) {
      lines.push(`
Already core (${existing.length}) \u2014 do not duplicate:`);
      for (const c of existing) lines.push(`- ${line(c.doc)}`);
    }
    lines.push(
      "\nIf a durable, repeatedly-relevant fact stands out (a convention, a key path, a deploy step, a decision that keeps mattering), propose it as a core memory and, once the user agrees, call `memory_core_add`."
    );
    return lines.join("\n");
  }
};
var coreTools = [coreAdd, coreList, coreRemove, coreSuggest];

// src/tools/doc.ts
function asLabels(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
var docAdd = {
  name: "memory_doc_add",
  description: "Ingests an external documentation source (e.g. a Confluence page, a README, a spec) into memory so it becomes searchable later. This plugin does NO network access: YOU fetch the content first (via the Atlassian MCP, a web fetch, or a file) and pass it here. Provide `text` (the full body) to store it as vectorized chunks \u2014 semantic search over the real content offline (Tier 2). Omit `text` and pass a short `summary` to store only a lightweight pointer (title + URL + summary) to re-fetch on demand (Tier 1). Idempotent on `url`: re-ingesting the same URL refreshes it. Use for durable component/business knowledge you want to recall fast and precisely.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Canonical source URL \u2014 the identity key. Re-ingesting the same URL replaces it."
      },
      title: { type: "string", description: "Human title of the document/page." },
      text: {
        type: "string",
        description: "Full body to ingest as searchable, vectorized chunks (Tier 2). Omit for a pointer-only memory."
      },
      summary: {
        type: "string",
        description: "Short summary stored on the pointer (Tier 1, used when `text` is omitted)."
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Tags/labels (component, domain\u2026). Optional."
      },
      project: {
        type: "string",
        description: "Scope to a project (directory basename). Omit for a global doc."
      },
      fetched_at: {
        type: "string",
        description: "ISO timestamp of when the content was fetched (defaults to now)."
      }
    },
    required: ["url", "title"],
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const url = String(args.url ?? "").trim();
    const title = String(args.title ?? "").trim();
    if (!url) return "\u274C `url` is required.";
    if (!title) return "\u274C `title` is required.";
    const text = args.text ? String(args.text) : void 0;
    const { docId, chunks } = store.addDoc({
      url,
      title,
      body: text,
      summary: args.summary ? String(args.summary) : void 0,
      labels: asLabels(args.labels),
      project: args.project ? String(args.project) : void 0,
      fetchedAt: args.fetched_at ? String(args.fetched_at) : void 0
    });
    const tier = text ? `Tier 2 \u2014 ${chunks} searchable chunk(s)` : "Tier 1 \u2014 pointer";
    return `\u{1F4C4} Doc ingested (${tier}): "${title}"
  ${url}
  _doc_id: ${docId}_ \u2014 searchable now via \`memory_search\` (type: doc); vectors fill in the background.`;
  }
};
var docList = {
  name: "memory_doc_list",
  description: "Lists ingested documentation sources (one entry per URL): title, labels, chunk count, fetch date. Optionally scoped to a project (also shows globals).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Limit to a project (also includes globals). Optional." }
    },
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const docs = store.listDocs(args.project ? String(args.project) : void 0);
    if (docs.length === 0) return "No ingested doc yet. Use `memory_doc_add`.";
    return `\u{1F4C4} **${docs.length} ingested doc(s)**:

` + docs.map((d) => {
      const date = (d.fetchedAt ?? "").slice(0, 10);
      const labels = d.labels.length ? ` [${d.labels.join(", ")}]` : "";
      const scope = d.project ?? "global";
      return `- **${d.title}** (${d.chunks} chunk${d.chunks > 1 ? "s" : ""})${labels}
  \`${scope}\`${date ? ` \xB7 ${date}` : ""} \xB7 ${d.url}
  _doc_id: ${d.docId}_`;
    }).join("\n");
  }
};
var docRemove = {
  name: "memory_doc_remove",
  description: "Removes an ingested doc and all its chunks by doc_id (get ids from memory_doc_list). Confirm with the user first.",
  inputSchema: {
    type: "object",
    properties: { doc_id: { type: "string", description: 'The doc_id (e.g. "doc:ab12cd34ef56").' } },
    required: ["doc_id"],
    additionalProperties: false
  },
  handler: async (args, { store }) => {
    const id = String(args.doc_id ?? "").trim();
    if (!id) return "\u274C `doc_id` is required.";
    const n = store.removeDoc(id);
    return n > 0 ? `\u{1F5D1}\uFE0F Removed doc \`${id}\` (${n} row(s) + vectors).` : `No doc with doc_id \`${id}\`.`;
  }
};
var docTools = [docAdd, docList, docRemove];

// src/tools/timesheet.ts
function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 6e4));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}
var memoryTaskTime = {
  name: "memory_task_time",
  description: "Estimates the production (active working) time spent on a task. Finds the sessions that worked on it (semantic + full-text search on the query \u2014 a ticket key, feature name, or keywords) and sums their active time (wall-clock minus idle gaps). Session-granularity: a session may mix several tasks, and sessions predating the feature have no timing.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Task identifier: ticket key, feature name, or keywords describing the work."
      },
      project: { type: "string", description: "Limit to a project (directory basename). Optional." },
      sessions: { type: "number", description: "Max sessions to consider (default 20)." }
    },
    required: ["query"],
    additionalProperties: false
  },
  handler: async (args, { store, embedQuery, config }) => {
    const query = String(args.query ?? "").trim();
    if (!query) return "\u274C `query` is required.";
    const project = args.project ? String(args.project) : void 0;
    const maxSessions = args.sessions ? Number(args.sessions) : 20;
    const embedding = store.vectorEnabled ? await embedQuery(query) : null;
    const cand = store.search({
      query,
      project,
      limit: 120,
      embedding,
      satisfactionWeight: config.satisfactionWeight
    });
    const sessionIds = [];
    const seen = /* @__PURE__ */ new Set();
    for (const d of cand) {
      if (d.session_id && !seen.has(d.session_id)) {
        seen.add(d.session_id);
        sessionIds.push(d.session_id);
      }
      if (sessionIds.length >= maxSessions) break;
    }
    if (sessionIds.length === 0) return `No session found for "${query}".`;
    const rows = store.productionForSessions(sessionIds).sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
    const total = rows.reduce((s, r) => s + r.active_ms, 0);
    const untracked = rows.filter((r) => r.active_ms <= 0).length;
    const lines = rows.map((r) => {
      const date = (r.ts ?? "").slice(0, 10) || "?";
      const label = (r.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      return `- ${date} \`${r.project ?? "?"}\` \u2014 **${fmtDuration(r.active_ms)}** \xB7 ${label}`;
    });
    return [
      `\u23F1\uFE0F **Production time for "${query}"**: **${fmtDuration(total)}** over ${rows.length} session(s)` + (untracked > 0 ? ` (${untracked} without timing)` : ""),
      "",
      ...lines,
      "",
      "_Estimate: active time = wall-clock minus idle gaps; session-granularity, a session may mix several tasks._"
    ].join("\n");
  }
};
var timesheetTools = [memoryTaskTime];

// src/tools/index.ts
var allTools = [
  ...searchTools,
  ...reindexTools,
  ...deleteTools,
  ...coreTools,
  ...docTools,
  ...timesheetTools
];

// src/memory-server.ts
var PKG_VERSION = true ? "0.14.0" : "0.0.0-dev";
var IDLE_CHECK_MS = 6e4;
var MemoryServer = class {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.embedder = new EmbedderHost(config.embed);
    this.reranker = new RerankerHost({
      model: config.rerank.model,
      dtype: config.embed.dtype,
      cacheDir: config.embed.cacheDir,
      threads: config.embed.threads,
      dataDir: config.dataDir,
      device: config.embed.device
    });
    this.local = new LocalExecutor(this.embedder, this.reranker);
    this.remote = new RemoteExecutor(config.dataDir);
    this.executor = this.remote;
    this.coordinator = new LeaderCoordinator(config.dataDir);
    this.backfill = new BackfillLoop(store, config, this.embedder);
    this.digest = new DigestLoop(store, config);
  }
  config;
  store;
  embedder;
  reranker;
  local;
  remote;
  coordinator;
  backfill;
  digest;
  /** Active strategy (Local when leader, Remote otherwise). */
  executor;
  embedPort = 0;
  embedToken = "";
  /**
   * Query embedding for search: routed through the active executor (leader embeds locally; a follower
   * routes to the leader's loopback service; null mid-failover → search degrades to BM25-only).
   */
  embedQuery(text) {
    if (!this.config.embed.enabled || !this.store.vectorEnabled) return Promise.resolve(null);
    return this.executor.embedQuery(text);
  }
  /** Reranking shares the leader/loopback pattern. null → caller keeps the RRF order. */
  rerankQuery(query, docs) {
    if (!this.config.rerank.enabled || docs.length === 0) return Promise.resolve(null);
    return this.executor.rerankQuery(query, docs);
  }
  /**
   * Builds an MCP server bound to this instance's tools. One per connected client: the object is
   * just a handler table — the weight (store, models) lives in the context it closes over, shared
   * by every client. stdio builds exactly one; the HTTP daemon builds one per session.
   */
  buildMcpServer() {
    const ctx = {
      store: this.store,
      embedCfg: this.config.embed,
      config: this.config,
      embedder: this.embedder,
      embedQuery: (t) => this.embedQuery(t),
      rerank: (q, d) => this.rerankQuery(q, d)
    };
    const server = new Server({ name: "memory", version: PKG_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = allTools.find((t) => t.name === req.params.name);
      if (!tool) {
        return { content: [{ type: "text", text: `\u274C Unknown tool: ${req.params.name}` }], isError: true };
      }
      try {
        const text = await tool.handler(req.params.arguments ?? {}, ctx);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `\u274C ${tool.name} failed: ${message}` }], isError: true };
      }
    });
    return server;
  }
  /**
   * Boots the subsystem. `mode` only decides who talks to the MCP surface:
   *  - `stdio`: this process serves its one parent session and dies with it (legacy shape).
   *  - `http`: the caller already bound the endpoint (see {@link startMcpHttp}); this process is a
   *    detached daemon serving every session, so it must NOT die with any one stdin, and needs the
   *    idle watchdog below to ever go away.
   */
  async start(mode = "stdio") {
    const name = processName(this.config.embed.tier);
    try {
      process.title = name;
    } catch {
    }
    ensureNamedBinary(name);
    if (mode === "stdio") await this.buildMcpServer().connect(new StdioServerTransport());
    process.stderr.write(
      `memory v${PKG_VERSION} ready (${mode}) \u2192 ${this.config.dbPath} | vectors: ${this.store.vectorEnabled ? "on" : "off"}
`
    );
    this.logStartupDiagnostics();
    this.coordinator.on("becameLeader", () => this.onBecameLeader());
    this.coordinator.on("lostLeadership", () => this.onLostLeadership());
    this.coordinator.start();
    log(this.config.dataDir, `[server] leader=${this.coordinator.isLeader()} (pid ${process.pid})`);
    let releasing = false;
    const releaseAndExit = () => {
      if (releasing) return;
      releasing = true;
      this.coordinator.release();
      process.exit(0);
    };
    process.on("SIGTERM", releaseAndExit);
    process.on("SIGINT", releaseAndExit);
    if (mode === "stdio") {
      process.stdin.on("end", releaseAndExit);
      process.stdin.on("close", releaseAndExit);
    } else {
      this.watchIdle(releaseAndExit);
    }
  }
  /**
   * Daemon lifetime. stdio gave this for free (the server died with its session); a shared daemon
   * has to decide for itself, or the heavy tier would sit on ~676 MB forever after the last window
   * closed — the very cost this transport was meant to cut.
   *
   * Keyed off REQUEST TIME, not open MCP sessions: a client killed without a DELETE leaves its
   * session in the transport map, so counting sessions would keep the daemon alive forever.
   * Anything unfinished (vector backfill, digests) resumes on the next spawn — both loops are
   * incremental and idempotent.
   */
  watchIdle(exit) {
    const timer = setInterval(() => {
      if (idleMs() < this.config.mcpIdleExitMs) return;
      log(this.config.dataDir, `[server] idle ${Math.round(idleMs() / 6e4)} min \u2192 exit`);
      clearInterval(timer);
      exit();
    }, IDLE_CHECK_MS);
    timer.unref?.();
  }
  /** Just acquired leadership (startup or failover): swap to local, start the service + loops. */
  onBecameLeader() {
    this.executor = this.local;
    if (!this.embedPort && this.store.vectorEnabled && this.config.embed.enabled) {
      this.embedToken = randomBytes(16).toString("hex");
      startLeaderService(
        {
          embed: (text) => this.embedder.embed(text, true),
          rerank: (query, docs) => this.config.rerank.enabled ? this.reranker.rerank(query, docs) : Promise.resolve(null)
        },
        this.embedToken
      ).then((port) => {
        this.embedPort = port;
        this.coordinator.publishEndpoint(port, this.embedToken);
        log(this.config.dataDir, `[server] leader service on 127.0.0.1:${port}`);
      }).catch(() => {
        this.embedPort = 0;
      });
    }
    this.backfill.start();
    this.digest.start();
  }
  /** Lost leadership (rare for a healthy process): swap back to remote, stop the loops. */
  onLostLeadership() {
    this.executor = this.remote;
    this.backfill.stop();
    this.digest.stop();
    this.embedder.dispose();
    this.reranker.dispose();
  }
  logStartupDiagnostics() {
    const { dataDir, dbPath, embed } = this.config;
    log(dataDir, `[server] memory v${PKG_VERSION} \u2014 node ${process.version} ${process.platform}/${process.arch}`);
    log(dataDir, `[server] exec=${process.execPath}`);
    log(
      dataDir,
      `[server] db=${dbPath} model=${embed.model} dim=${embed.dim} dtype=${embed.dtype} vectors=${this.store.vectorEnabled ? "on" : "off"}`
    );
    const modelDir = path8.join(embed.cacheDir, ...embed.model.split("/"));
    log(dataDir, `[server] model cache: ${existsSync5(modelDir) ? "present" : "absent \u2192 download on first use"} (${modelDir})`);
    writeStatus(dataDir, {
      state: "idle",
      model: embed.model,
      vectorized: this.store.stats().vectorCount,
      missing: this.store.countMissingVectors()
    });
  }
};

// src/mcp-http.ts
import { createServer as createServer2 } from "http";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// src/daemon.ts
import { get as httpGet } from "http";
import { spawn as spawn2 } from "child_process";
import { existsSync as existsSync6 } from "fs";
import path9 from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var HEALTH_PATH = "/health";
var HEALTH_BODY = "memory-mcp";

// src/mcp-http.ts
var MCP_PATH = "/mcp";
var SESSION_HEADER = "mcp-session-id";
async function startMcpHttp(options) {
  const transports = /* @__PURE__ */ new Map();
  const httpServer = createServer2((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === HEALTH_PATH) {
      res.writeHead(200, { "content-type": "text/plain" }).end(HEALTH_BODY);
      return;
    }
    if (url !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    touch();
    const sessionId = req.headers[SESSION_HEADER];
    const known = typeof sessionId === "string" ? transports.get(sessionId) : void 0;
    if (known) {
      void known.handleRequest(req, res);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        options.log(`[mcp-http] session ${id} opened (${transports.size} live)`);
      }
    });
    transport.onclose = () => {
      if (transport.sessionId && transports.delete(transport.sessionId)) {
        options.log(`[mcp-http] session ${transport.sessionId} closed (${transports.size} live)`);
      }
    };
    void options.createServer().then((server) => server.connect(transport)).then(() => transport.handleRequest(req, res)).catch((err) => {
      options.log(`[mcp-http] connect failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  return new Promise((resolve) => {
    httpServer.once("error", (err) => {
      options.log(
        err.code === "EADDRINUSE" ? `[mcp-http] port ${options.port} already served \u2014 nothing to do` : `[mcp-http] listen failed: ${err.message}`
      );
      resolve(false);
    });
    httpServer.listen(options.port, "127.0.0.1", () => {
      options.log(`[mcp-http] listening on http://127.0.0.1:${options.port}${MCP_PATH}`);
      resolve(true);
    });
  });
}

// src/server.ts
console.log = (...args) => console.error("[stdout-redirected]", ...args);
function buildStore(config) {
  return new MemoryStore(config.dbPath, config.embed.dim, config.embed.model, EMBED_TEXT_VERSION);
}
async function runStdio(config) {
  const store = buildStore(config);
  await store.init();
  await new MemoryServer(config, store).start("stdio");
}
async function runHttp(config) {
  let publish;
  const ready = new Promise((resolve) => publish = resolve);
  const bound = await startMcpHttp({
    port: config.mcpPort,
    createServer: async () => (await ready).buildMcpServer(),
    log: (m) => log(config.dataDir, m)
  });
  if (!bound) process.exit(0);
  const store = buildStore(config);
  await store.init();
  const server = new MemoryServer(config, store);
  publish(server);
  await server.start("http");
}
async function main() {
  const config = loadConfig();
  const http = process.argv.includes("--http") || process.env.MEMORY_MCP_HTTP === "1";
  await (http ? runHttp(config) : runStdio(config));
}
main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}
`);
  process.exit(1);
});
//# sourceMappingURL=server.js.map