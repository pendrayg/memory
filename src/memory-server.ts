import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { MemoryConfig } from './config.js';
import type { MemoryStore } from './store.js';
import { EmbedderHost } from './embeddings.js';
import { RerankerHost } from './rerank.js';
import { LocalExecutor, RemoteExecutor, type QueryExecutor } from './query-executor.js';
import { LeaderCoordinator } from './leader-coordinator.js';
import { BackfillLoop } from './backfill-loop.js';
import { DigestLoop } from './digest-loop.js';
import { startLeaderService } from './embed-service.js';
import { processName, ensureNamedBinary } from './process-name.js';
import { allTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';
import { log, writeStatus } from './log.js';

declare const __PKG_VERSION__: string;
const PKG_VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.0.0-dev';

/**
 * Composition root + facade over the memory subsystem. Owns the dependency graph (store, model
 * hosts, query executors, leader coordinator, background loops, MCP server) and the leadership
 * lifecycle, exposing a single `start()` to the entrypoint.
 *
 * Leadership is wired via the {@link LeaderCoordinator} (Observer): on `becameLeader` the active
 * {@link QueryExecutor} swaps to local, the loopback service starts, and the background loops run;
 * on `lostLeadership` it swaps back to remote and the loops stop. Tools call `embedQuery`/
 * `rerankQuery`, which delegate to whichever executor is active — they never branch on `amLeader`.
 */
export class MemoryServer {
  private readonly embedder: EmbedderHost;
  private readonly reranker: RerankerHost;
  private readonly local: LocalExecutor;
  private readonly remote: RemoteExecutor;
  private readonly coordinator: LeaderCoordinator;
  private readonly backfill: BackfillLoop;
  private readonly digest: DigestLoop;
  /** Active strategy (Local when leader, Remote otherwise). */
  private executor: QueryExecutor;
  private embedPort = 0;
  private embedToken = '';

  constructor(
    private readonly config: MemoryConfig,
    private readonly store: MemoryStore,
  ) {
    this.embedder = new EmbedderHost(config.embed);
    this.reranker = new RerankerHost({
      model: config.rerank.model,
      dtype: config.embed.dtype,
      cacheDir: config.embed.cacheDir,
      threads: config.embed.threads,
      dataDir: config.dataDir,
      device: config.embed.device,
    });
    this.local = new LocalExecutor(this.embedder, this.reranker);
    this.remote = new RemoteExecutor(config.dataDir);
    this.executor = this.remote; // until/unless we acquire leadership
    this.coordinator = new LeaderCoordinator(config.dataDir);
    this.backfill = new BackfillLoop(store, config, this.embedder);
    this.digest = new DigestLoop(store, config);
  }

  /**
   * Query embedding for search: routed through the active executor (leader embeds locally; a follower
   * routes to the leader's loopback service; null mid-failover → search degrades to BM25-only).
   */
  private embedQuery(text: string): Promise<number[] | null> {
    if (!this.config.embed.enabled || !this.store.vectorEnabled) return Promise.resolve(null);
    return this.executor.embedQuery(text);
  }

  /** Reranking shares the leader/loopback pattern. null → caller keeps the RRF order. */
  private rerankQuery(query: string, docs: string[]): Promise<number[] | null> {
    if (!this.config.rerank.enabled || docs.length === 0) return Promise.resolve(null);
    return this.executor.rerankQuery(query, docs);
  }

  async start(): Promise<void> {
    const name = processName(this.config.embed.tier);
    // On Linux/macOS process.title rewrites the cmdline; Windows needs the renamed exe copy.
    try {
      process.title = name;
    } catch {
      /* best-effort: never block startup on a cosmetic rename */
    }
    ensureNamedBinary(name);

    const ctx: ToolContext = {
      store: this.store,
      embedCfg: this.config.embed,
      config: this.config,
      embedder: this.embedder,
      embedQuery: (t) => this.embedQuery(t),
      rerank: (q, d) => this.rerankQuery(q, d),
    };

    const server = new Server({ name: 'memory', version: PKG_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = allTools.find((t) => t.name === req.params.name);
      if (!tool) {
        return { content: [{ type: 'text', text: `❌ Unknown tool: ${req.params.name}` }], isError: true };
      }
      try {
        const text = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, ctx);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `❌ ${tool.name} failed: ${message}` }], isError: true };
      }
    });

    await server.connect(new StdioServerTransport());
    process.stderr.write(
      `memory v${PKG_VERSION} ready (stdio) → ${this.config.dbPath} | vectors: ${this.store.vectorEnabled ? 'on' : 'off'}\n`,
    );

    this.logStartupDiagnostics();

    // Leadership (Observer): one server instance (across all open sessions) owns the heavy
    // background work AND the single loaded model, exposed to the others via the loopback service.
    this.coordinator.on('becameLeader', () => this.onBecameLeader());
    this.coordinator.on('lostLeadership', () => this.onLostLeadership());
    this.coordinator.start();
    log(this.config.dataDir, `[server] leader=${this.coordinator.isLeader()} (pid ${process.pid})`);

    // Release leadership the instant this session closes so a sibling takes over on its next
    // heartbeat instead of waiting out the stale timeout. Window close ends stdin (Windows) or sends
    // a signal (POSIX); both paths clean up. A hard kill falls back to STALE_MS.
    let releasing = false;
    const releaseAndExit = () => {
      if (releasing) return;
      releasing = true;
      this.coordinator.release();
      process.exit(0);
    };
    process.on('SIGTERM', releaseAndExit);
    process.on('SIGINT', releaseAndExit);
    process.stdin.on('end', releaseAndExit);
    process.stdin.on('close', releaseAndExit);
  }

  /** Just acquired leadership (startup or failover): swap to local, start the service + loops. */
  private onBecameLeader(): void {
    this.executor = this.local;
    if (!this.embedPort && this.store.vectorEnabled && this.config.embed.enabled) {
      this.embedToken = randomBytes(16).toString('hex');
      startLeaderService(
        {
          embed: (text) => this.embedder.embed(text, true),
          rerank: (query, docs) =>
            this.config.rerank.enabled ? this.reranker.rerank(query, docs) : Promise.resolve(null),
        },
        this.embedToken,
      )
        .then((port) => {
          this.embedPort = port;
          this.coordinator.publishEndpoint(port, this.embedToken); // publish the endpoint in the lock
          log(this.config.dataDir, `[server] leader service on 127.0.0.1:${port}`);
        })
        .catch(() => {
          this.embedPort = 0;
        });
    }
    // Warm the model and drain now, instead of waiting up to a full interval.
    this.backfill.start();
    this.digest.start();
  }

  /** Lost leadership (rare for a healthy process): swap back to remote, stop the loops. */
  private onLostLeadership(): void {
    this.executor = this.remote;
    this.backfill.stop();
    this.digest.stop();
    // Free the loaded models: an ex-leader must not keep pinning its embedder + reranker ONNX
    // sessions (~2 GB for e5-large) — that is what let RAM balloon when leadership flapped. Queries
    // now route to the new leader's loopback service (remote executor); if this process becomes
    // leader again, the hosts lazily re-load. Best-effort (dispose() swallows in-flight errors).
    this.embedder.dispose();
    this.reranker.dispose();
  }

  private logStartupDiagnostics(): void {
    const { dataDir, dbPath, embed } = this.config;
    log(dataDir, `[server] memory v${PKG_VERSION} — node ${process.version} ${process.platform}/${process.arch}`);
    log(dataDir, `[server] exec=${process.execPath}`); // reveals whether we run as node or the renamed exe
    log(
      dataDir,
      `[server] db=${dbPath} model=${embed.model} dim=${embed.dim} dtype=${embed.dtype} vectors=${this.store.vectorEnabled ? 'on' : 'off'}`,
    );
    const modelDir = path.join(embed.cacheDir, ...embed.model.split('/'));
    log(dataDir, `[server] model cache: ${existsSync(modelDir) ? 'present' : 'absent → download on first use'} (${modelDir})`);
    writeStatus(dataDir, {
      state: 'idle',
      model: embed.model,
      vectorized: this.store.stats().vectorCount,
      missing: this.store.countMissingVectors(),
    });
  }
}
