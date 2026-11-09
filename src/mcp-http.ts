import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { touch } from './activity.js';
import { HEALTH_BODY, HEALTH_PATH } from './daemon.js';

/**
 * MCP over Streamable HTTP — the alternative to stdio, and the whole point of the daemon: ONE
 * server process for every open session instead of one per session.
 *
 * stdio ties the protocol to a process's stdin/stdout, so each client needs its own child. Measured
 * here: 5 sessions → 5 `memory` processes (one leader ~676 MB, four followers ~50 MB), each wrapped
 * on Windows in a `cmd.exe` + `conhost.exe`. The followers do nothing but relay to the leader
 * (see {@link RemoteExecutor}); they exist only because stdio can't be shared.
 *
 * Sharing is safe because the MCP surface is already session-agnostic: tool scope arrives as the
 * `project` argument, and `projectFromCwd` is called only from hook.ts on the payload's `cwd` —
 * never on `process.cwd()`. A tool that started guessing its caller from process state would be the
 * thing that breaks this.
 */

export const MCP_PATH = '/mcp';

const SESSION_HEADER = 'mcp-session-id';

export interface McpHttpOptions {
  /** Fixed loopback port (see config.mcpPort) — `.mcp.json` carries a static URL. */
  port: number;
  /**
   * Builds the MCP `Server` for a newly initialized session. Async so the listener can bind before
   * the store is ready: an early client waits instead of getting ECONNREFUSED.
   */
  createServer: () => Promise<Server>;
  log: (message: string) => void;
}

/**
 * Starts the endpoint, or resolves false if the port is already taken.
 *
 * The bind doubles as the daemon mutex: two sessions racing to spawn one produce a loser that fails
 * to bind and exits. EADDRINUSE is a normal outcome ("someone already serves"), not a failure —
 * unless a foreign process squats the port, which is what {@link HEALTH_BODY} makes diagnosable.
 */
export async function startMcpHttp(options: McpHttpOptions): Promise<boolean> {
  /** One transport per open MCP session, keyed by the id the SDK minted. */
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(HEALTH_BODY);
      return;
    }
    if (url !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    touch();

    const sessionId = req.headers[SESSION_HEADER];
    const known = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (known) {
      void known.handleRequest(req, res);
      return;
    }

    // No known session → an `initialize` (or a client whose session we lost). The SDK rejects
    // anything else itself, so we don't pre-validate.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        options.log(`[mcp-http] session ${id} opened (${transports.size} live)`);
      },
    });
    // Only a DELETE or an explicit close() fires this — a client killed outright leaves its entry
    // behind. That's why the idle watchdog keys off request time, not off this map's size.
    transport.onclose = () => {
      if (transport.sessionId && transports.delete(transport.sessionId)) {
        options.log(`[mcp-http] session ${transport.sessionId} closed (${transports.size} live)`);
      }
    };

    void options
      .createServer()
      .then((server) => server.connect(transport))
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        options.log(`[mcp-http] connect failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
  });

  return new Promise<boolean>((resolve) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      options.log(
        err.code === 'EADDRINUSE'
          ? `[mcp-http] port ${options.port} already served — nothing to do`
          : `[mcp-http] listen failed: ${err.message}`,
      );
      resolve(false);
    });
    // Loopback only: a personal memory has no business on the network. That's also why there's no
    // token here, unlike the leader service (which publishes one through the lock file).
    httpServer.listen(options.port, '127.0.0.1', () => {
      options.log(`[mcp-http] listening on http://127.0.0.1:${options.port}${MCP_PATH}`);
      resolve(true);
    });
  });
}
