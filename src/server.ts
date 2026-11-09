import { loadConfig, EMBED_TEXT_VERSION, type MemoryConfig } from './config.js';
import { MemoryStore } from './store.js';
import { MemoryServer } from './memory-server.js';
import { startMcpHttp } from './mcp-http.js';
import { log } from './log.js';

// The MCP SDK communicates on stdout: we guard against console.log (transformers.js logs the
// model download via console → redirected to stderr so as not to corrupt the protocol).
console.log = (...args: unknown[]) => console.error('[stdout-redirected]', ...args);

function buildStore(config: MemoryConfig): MemoryStore {
  return new MemoryStore(config.dbPath, config.embed.dim, config.embed.model, EMBED_TEXT_VERSION);
}

/** Legacy shape: one server per client session, speaking MCP on its own stdio. */
async function runStdio(config: MemoryConfig): Promise<void> {
  const store = buildStore(config);
  await store.init();
  await new MemoryServer(config, store).start('stdio');
}

/**
 * Shared daemon: one process serving every session over loopback HTTP (see mcp-http.ts).
 *
 * The listener binds BEFORE the store opens, on purpose. The session that spawns this daemon has
 * its MCP client connecting within the same second; if the port weren't up yet the client would get
 * ECONNREFUSED and give up on memory for that whole session. Bound early, its `initialize` just
 * waits on the `ready` promise for as long as init takes.
 */
async function runHttp(config: MemoryConfig): Promise<void> {
  let publish!: (server: MemoryServer) => void;
  const ready = new Promise<MemoryServer>((resolve) => (publish = resolve));

  const bound = await startMcpHttp({
    port: config.mcpPort,
    createServer: async () => (await ready).buildMcpServer(),
    log: (m) => log(config.dataDir, m),
  });
  // Lost the race (or a sibling is already up): the running daemon serves everyone. Not an error.
  if (!bound) process.exit(0);

  const store = buildStore(config);
  await store.init();
  const server = new MemoryServer(config, store);
  publish(server);
  await server.start('http');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const http = process.argv.includes('--http') || process.env.MEMORY_MCP_HTTP === '1';
  await (http ? runHttp(config) : runStdio(config));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
