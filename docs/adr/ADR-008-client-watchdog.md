# ADR-008 — Stop the daemon when no Claude Code is left on the machine

**Status:** Accepted

## Context

ADR-007 gave the daemon one lifetime rule: the **idle watchdog**, which exits after
`mcpIdleExitMs` (default 30 min) with no MCP call and no hook embedding. That rule keys off
**traffic**, and traffic is a poor proxy for "is anyone still there":

- after the last window closes, the heavy tier keeps ~676 MB resident for the whole timeout — the
  very cost the shared transport was meant to cut;
- the decision depends on how talkative the sessions were, not on whether a client can still exist.

The same problem was solved in the `peaksys-tech-workflow-core` MCP daemon
(`mcp-server/daemon.mjs`, `claudeIsRunning()` / `startWatchdog()`); this ADR adopts that strategy
here rather than inventing a second one.

## Decision

A second, complementary watchdog (`src/claude-watch.ts`) asks the OS every 5 min whether any
Claude Code process exists (`tasklist /FI "IMAGENAME eq claude.exe" /NH` on Windows,
`pgrep -f claude` elsewhere). **Two consecutive empty probes** → the daemon has no possible client
left and exits. The next `SessionStart` hook spawns it again.

- **Both watchdogs run**, on the `http` branch only. One covers traffic, the other the existence of
  a client at all; stdio still dies with its parent session and needs neither.
- **It exits through `releaseAndExit`**, like every other exit path: the leadership lock must be
  released, or a sibling waits out the staleness timeout instead of taking over at once.
- **Fail-open on an unusable probe.** The probe returns `true` / `false` / `null`, and `null`
  (spawn error, missing binary, unexpected output) resets the counter instead of counting as an
  absence. Leaking a daemon is benign — it idles out; cutting the MCP surface out from under a live
  session is not.
- **Two probes, not one**, so a single transient miss (a probe racing a restart, a momentarily
  unreadable process table) can never be the whole decision.
- **Escape hatch** `MEMORY_MCP_CLIENT_WATCH=0` (`mcpClientWatch` in `config.json`) for a machine
  where the probe misreads — a renamed binary, a locked-down `tasklist`/`pgrep`.
- The probe is **injected** (`exec` / `probe` parameters), which is how the tests cover the three
  outcomes without spawning anything.

## Consequences

- **+** The daemon disappears within ~10 min of the last window closing, instead of up to 30 min
  after the last request.
- **+** The rule now matches the actual question ("could anyone still call me?") rather than a
  traffic proxy.
- **−** One process probe every 5 min per daemon (a `tasklist`/`pgrep` spawn, negligible).
- **−** `pgrep -f claude` matches any command line containing `claude`, so on POSIX the watchdog
  errs towards "someone is there" — deliberately, given the fail-open stance.
- **−** A machine where the probe is permanently unusable keeps the pre-ADR behaviour: the idle
  watchdog remains the only bound.
