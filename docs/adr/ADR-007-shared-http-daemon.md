# ADR-007 — Serve MCP over loopback HTTP from a single shared daemon

**Status:** Accepted

## Context

The MCP surface was served over **stdio**. That transport binds the protocol to one process's
`stdin`/`stdout`, so the client must spawn a child per session — it is a property of the transport,
not of this implementation.

Measured on the reference machine with 5 open Claude Code sessions: 5 `memory` processes — one
leader holding the model (~676 MB on the heavy tier) and **four followers of ~50 MB that did nothing
but relay to the leader** (`RemoteExecutor`, see ADR-003). On Windows each was additionally escorted
by a `cmd.exe` and a `conhost.exe`. Across all stdio MCP servers of all plugins this accounted for
~33 processes per session.

ADR-004's leader election had already removed the *model* duplication. What remained was the
duplication of the **process** itself, which only a different transport can remove.

Two options were considered:

1. **Unload the leader's models when idle.** Rejected: the leader is called at least once a minute
   (every prompt embeds a query through its loopback service), and an ONNX session rebuild spikes
   RAM to ~2 GB before settling — reloading would cost more than it saves.
2. **Serve MCP over loopback HTTP from one shared process.** Retained.

What made option 2 possible is a property the codebase already had: the MCP surface is
**session-agnostic**. A tool's scope arrives as its `project` argument, and the only `cwd`-based
inference (`projectFromCwd`) lives in `hook.ts`, applied to the `cwd` Claude Code puts in the hook
payload — never to `process.cwd()`. A shared server therefore cannot confuse two sessions.

## Decision

`.mcp.json` declares `{"type": "http", "url": "http://127.0.0.1:47832/mcp"}`. A single detached
daemon serves every session through `StreamableHTTPServerTransport` (`mcp-http.ts`), one transport
per MCP session over one shared `MemoryStore` and one loaded model.

- **stdio stays the default** of `server.ts`; `--http` (or `MEMORY_MCP_HTTP=1`) selects the daemon.
  The e2e suite still drives stdio servers, and a user can revert by editing `.mcp.json` back.
- **The hooks start it.** Nothing else can: an HTTP MCP client only dials a URL. `SessionStart`
  covers the cold case and `UserPromptSubmit` makes it self-healing (`daemon.ts`).
- **Binding the port is the mutex.** Two sessions racing both spawn; the loser gets `EADDRINUSE` and
  exits 0. No second election mechanism was written for this.
- **The listener binds before the store opens.** The spawning session's client connects within the
  same second; bound early, its `initialize` waits instead of being refused.
- **An idle watchdog replaces the parent session's lifetime.** stdio gave process death for free;
  a shared daemon must decide for itself, or the heavy tier would stay resident forever after the
  last window closed. It keys off *request time* across both surfaces (MCP calls and hook
  embeddings), not off open MCP sessions — a client killed without a `DELETE` leaves its session in
  the transport map, so counting sessions would keep the daemon alive forever.
- **Leader election is kept** (ADR-004). The daemon normally *is* the leader, but the election is
  still what hands the role over on restart, and the **hooks** — ephemeral processes that load no
  model — depend on the lock file to find the loopback embedding service.

## Consequences

- **+** N sessions → **one** memory process, down from N, and zero `cmd.exe`/`conhost.exe`.
- **+** `claude -p` children and short sessions no longer pay a server start.
- **−** The plugin now has a daemon; the README's "zero daemon" claim was retired, not hidden.
- **−** A daemon can outlive the session that spawned it (bounded by `mcpIdleExitMs`, default 30 min).
- **−** The port is fixed, because `.mcp.json` is static. If another program owns it, `mcpPort` and
  the URL must both be changed; `/health` answering `memory-mcp` keeps a squatter from being
  mistaken for the daemon.
- **−** An HTTP server takes no `env`, so the install-time `${user_config.embedTier}` injection is
  gone: the tier now comes from `~/.claude-memory/config.json` (`/memory:config`), which was already
  the authoritative source (`ConfigSource.fileFirst`, ADR-005).
- **−** `ensureNamedBinary` no longer rewrites `.mcp.json#command` (dead, and harmful against a URL
  config); the cosmetic process name survives because `daemon.ts` spawns the renamed exe directly.
- **−** On a first-ever install the daemon self-installs its deps in the background, so memory tools
  appear one session later than before. The hooks (hence capture) are unaffected.
