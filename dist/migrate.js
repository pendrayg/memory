#!/usr/bin/env node

// src/migrate.ts
import os2 from "os";
import path4 from "path";
import { existsSync as existsSync3 } from "fs";

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
  const mcpClientWatch = src.flag("MEMORY_MCP_CLIENT_WATCH", "mcpClientWatch");
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
    mcpIdleExitMs,
    mcpClientWatch
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
function embedText(parts, max = 2e3) {
  return parts.filter((p) => !!p && p.trim().length > 0).join("\n").slice(0, max);
}
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

// src/migrate.ts
function parseArgs(argv) {
  const args = {
    db: path4.join(os2.homedir(), ".claude-mem", "claude-mem.db"),
    dryRun: false,
    batch: 500,
    embed: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--embed") args.embed = true;
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--batch") args.batch = Number(argv[++i]) || 500;
  }
  return args;
}
function parseJsonArray(v) {
  if (!v || typeof v !== "string") return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function clip(v, max) {
  if (v == null) return void 0;
  const s = String(v).trim();
  return s ? s.slice(0, max) : void 0;
}
function joinParts(parts, max) {
  return parts.filter(([, v]) => v != null && String(v).trim()).map(([label, v]) => `${label}: ${String(v).trim()}`).join("\n\n").slice(0, max);
}
function docEmbedText(d) {
  return embedText([d.summary, d.user_prompt, d.assistant_text, ...d.prompts ?? []]);
}
var INSIGHT_KINDS = /* @__PURE__ */ new Set(["decision", "bugfix", "discovery", "conclusion"]);
function mapKind(t) {
  const s = typeof t === "string" ? t.toLowerCase() : "";
  return INSIGHT_KINDS.has(s) ? s : "discovery";
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (!existsSync3(args.db)) {
    console.error(`\u274C claude-mem SQLite database not found: ${args.db}`);
    process.exit(1);
  }
  const sqliteModule = "node:sqlite";
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import(sqliteModule));
  } catch {
    console.error(
      `\u274C Module 'node:sqlite' unavailable. Node ${process.version}; requires Node \u2265 22.5.`
    );
    process.exit(1);
  }
  const embedCfg = cfg.embed;
  const embedder = new EmbedderHost(embedCfg);
  if (args.embed && !args.dryRun) {
    if (!await embedder.ready()) {
      console.error(
        `\u274C --embed requested but the local embedder (${embedCfg.model}) failed to load. Migrate without --embed, or check model access.`
      );
      process.exit(1);
    }
  }
  const db = new DatabaseSync(args.db, { readOnly: true });
  const safeAll = (sql) => {
    try {
      return db.prepare(sql).all();
    } catch (err) {
      console.error(`\u26A0\uFE0F Read failed (${sql}): ${err instanceof Error ? err.message : err}`);
      return [];
    }
  };
  const memToContent = /* @__PURE__ */ new Map();
  const contentToProject = /* @__PURE__ */ new Map();
  for (const s of safeAll("SELECT * FROM sdk_sessions")) {
    if (s.memory_session_id && s.content_session_id)
      memToContent.set(s.memory_session_id, s.content_session_id);
    if (s.content_session_id && s.project) contentToProject.set(s.content_session_id, s.project);
  }
  const resolveSession = (memId) => memId && memToContent.get(memId) || memId || "claude-mem";
  const resolveProject = (rowProject, contentId) => args.project || rowProject || contentId && contentToProject.get(contentId) || "claude-mem";
  const items = [];
  const counts = { observations: 0, session_summaries: 0, user_prompts: 0 };
  for (const o of safeAll("SELECT * FROM observations")) {
    counts.observations++;
    const text = joinParts(
      [
        ["Detail", o.subtitle],
        ["Narrative", o.narrative],
        ["Facts", o.facts],
        ["Text", o.text]
      ],
      12e3
    );
    items.push({
      id: `migrated:insight:${o.id}`,
      doc: {
        type: "insight",
        session_id: resolveSession(o.memory_session_id),
        project: resolveProject(o.project, memToContent.get(o.memory_session_id)),
        ts: o.created_at,
        prompt_number: o.prompt_number ?? void 0,
        summary: clip(o.title, 1e3) || clip(o.subtitle, 1e3) || clip(text, 200),
        assistant_text: text,
        source: mapKind(o.type),
        files_read: parseJsonArray(o.files_read),
        files_modified: parseJsonArray(o.files_modified)
      }
    });
  }
  for (const s of safeAll("SELECT * FROM session_summaries")) {
    counts.session_summaries++;
    const conclusion = clip(s.completed, 1e3) || clip(s.learned, 1e3) || clip(s.request, 1e3);
    items.push({
      id: `migrated:digest:${s.id}`,
      doc: {
        type: "digest",
        session_id: resolveSession(s.memory_session_id),
        project: resolveProject(s.project, memToContent.get(s.memory_session_id)),
        ts: s.created_at,
        started_at: s.created_at,
        prompt_number: s.prompt_number ?? void 0,
        summary: conclusion,
        assistant_text: joinParts(
          [
            ["Request", s.request],
            ["Investigated", s.investigated],
            ["Learned", s.learned],
            ["Completed", s.completed],
            ["Next steps", s.next_steps],
            ["Notes", s.notes]
          ],
          12e3
        ),
        source: String(DIGEST_VERSION),
        files_read: parseJsonArray(s.files_read),
        files_modified: parseJsonArray(s.files_edited)
      }
    });
  }
  for (const p of safeAll("SELECT * FROM user_prompts")) {
    counts.user_prompts++;
    items.push({
      id: `migrated:prompt:${p.id}`,
      doc: {
        type: "prompt",
        session_id: p.content_session_id || "claude-mem",
        project: resolveProject(void 0, p.content_session_id),
        ts: p.created_at,
        prompt_number: p.prompt_number ?? void 0,
        user_prompt: clip(p.prompt_text, 4e3),
        summary: clip(p.prompt_text, 200)
      }
    });
  }
  db.close();
  console.error(
    `\u{1F4CA} Read: observations=${counts.observations}, session_summaries=${counts.session_summaries}, user_prompts=${counts.user_prompts} \u2192 ${items.length} documents.`
  );
  if (args.dryRun) {
    console.error(`\u{1F7E1} --dry-run: no writes.${args.embed ? " (--embed would be applied)" : ""}`);
    process.exit(0);
  }
  const store = new MemoryStore(cfg.dbPath, cfg.embed.dim, cfg.embed.model, EMBED_TEXT_VERSION);
  await store.init();
  if (args.embed && !store.vectorEnabled) {
    console.error("\u26A0\uFE0F --embed requested but vector index unavailable (sqlite-vec) \u2192 importing without vectors.");
  }
  const doEmbed = args.embed && store.vectorEnabled;
  let indexed = 0;
  let errors = 0;
  let embedded = 0;
  for (let i = 0; i < items.length; i += args.batch) {
    const slice = items.slice(i, i + args.batch);
    if (doEmbed) {
      const vectors = await embedder.embedBatch(slice.map((it) => docEmbedText(it.doc)));
      slice.forEach((it, j) => {
        it.embedding = vectors[j];
        if (vectors[j]) embedded++;
      });
    }
    const res = store.bulkUpsert(slice);
    indexed += res.indexed;
    errors += res.errors;
    console.error(
      `  \u2026indexed ${indexed}/${items.length} (errors: ${errors}${doEmbed ? `, vectors: ${embedded}` : ""})`
    );
  }
  store.close();
  console.error(
    `\u2705 Migration done: ${indexed} indexed, ${errors} errors${doEmbed ? `, ${embedded} vectors` : ""} \u2192 ${cfg.dbPath}`
  );
  process.exit(errors > 0 ? 2 : 0);
}
main().catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
//# sourceMappingURL=migrate.js.map