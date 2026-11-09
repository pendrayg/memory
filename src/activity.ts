/**
 * Last-activity clock shared by the two surfaces a daemon serves: the MCP endpoint (tool calls) and
 * the leader's loopback service (hook embeddings). The idle watchdog in {@link MemoryServer} reads
 * it to decide whether anyone still needs this process.
 *
 * Why both surfaces: a session can go minutes without a tool call while its hooks keep embedding
 * every prompt. Counting only MCP traffic would kill a daemon that is, in fact, working.
 */
let last = Date.now();

/** Record incoming work. Cheap enough to call on every request. */
export function touch(): void {
  last = Date.now();
}

/** Milliseconds since the last request on either surface. */
export function idleMs(): number {
  return Date.now() - last;
}
