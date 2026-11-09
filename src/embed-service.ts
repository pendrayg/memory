import { createServer, request as httpRequest } from 'node:http';
import { touch } from './activity.js';

/**
 * Leader-only loopback service. The leader is the single process holding the models, so non-leader
 * sessions POST here instead of loading their own copies. Two routes:
 *   POST /embed  { text }           → { vector }   (query embedding)
 *   POST /rerank { query, docs }    → { scores }   (cross-encoder reranking)
 * Bound to 127.0.0.1, guarded by a shared token (published in the lock file).
 */

const TOKEN_HEADER = 'x-mem-token';

export interface LeaderHandlers {
  embed: (text: string) => Promise<number[] | null>;
  rerank: (query: string, docs: string[]) => Promise<number[] | null>;
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c: any) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

/** Starts the leader loopback service on an ephemeral 127.0.0.1 port. Returns the chosen port. */
export async function startLeaderService(handlers: LeaderHandlers, token: string): Promise<number> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.headers[TOKEN_HEADER] !== token) {
      res.writeHead(404);
      res.end();
      return;
    }
    touch(); // hook traffic counts as activity: it keeps the daemon's idle watchdog honest
    try {
      const body = await readBody(req);
      let payload: unknown;
      if (req.url === '/embed') {
        payload = { vector: await handlers.embed(String(body?.text ?? '')) };
      } else if (req.url === '/rerank') {
        const docs = Array.isArray(body?.docs) ? body.docs.map((d: any) => String(d)) : [];
        payload = { scores: await handlers.rerank(String(body?.query ?? ''), docs) };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  server.unref?.();
  return port;
}

function post(
  endpoint: { port: number; token: string },
  path: string,
  body: unknown,
  pick: (json: any) => any,
  timeoutMs = 8000,
): Promise<any> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          [TOKEN_HEADER]: endpoint.token,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(pick(JSON.parse(d)));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

/** Client: ask the leader to embed a query. Returns the vector, or null (→ BM25-only). */
export function remoteEmbed(
  endpoint: { port: number; token: string },
  text: string,
  timeoutMs = 8000,
): Promise<number[] | null> {
  return post(endpoint, '/embed', { text }, (j) => (Array.isArray(j?.vector) ? j.vector : null), timeoutMs);
}

/** Client: ask the leader to rerank docs for a query. Returns scores, or null (→ keep RRF order). */
export function remoteRerank(
  endpoint: { port: number; token: string },
  query: string,
  docs: string[],
): Promise<number[] | null> {
  return post(endpoint, '/rerank', { query, docs }, (j) => (Array.isArray(j?.scores) ? j.scores : null));
}
