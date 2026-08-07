---
name: memory:load
description: Cap the CPU/GPU load of background memory work (vectorization + digests) to a percentage
---

# Memory → background load cap

Sets how much of the machine the **background memory work** (semantic vectorization + LLM digests)
may use — a duty-cycle cap, in percent. It paces the loops so they keep the inference device (CPU
**or** GPU) busy only ~`loadPercent` of the time. Lower = lighter machine, slower catch-up.

| Value | Effect |
|---|---|
| `100` | No throttle — drain at full speed (finishes the backlog fastest). |
| `50` | Background work idles ~half the time → ~half the average CPU/GPU. |
| `30` (default) | A good "quiet" setting while you work — noticeably lighter, backfill still progresses. Also caps the CPU peak (fewer ONNX threads), not just the average. |
| `5` (min) | Barely-there; the backfill can take a long time. |

> Why would memory be busy at all? Right after a plugin update that **improves how memories are
> built** (e.g. capturing the user's satisfaction/mood, or a new embedding model), it **re-processes
> the existing history once** — re-digesting sessions and recomputing vectors. That's a normal,
> one-time catch-up; memory stays fully usable (BM25) meanwhile. This cap is how you make that
> catch-up gentler on the machine. Check the backlog with `/memory:status` or `memory_stats`.

User argument: `$ARGUMENTS` (expected: an integer 5–100, or empty to show the current cap).

Steps:
1. If `$ARGUMENTS` is empty: call `memory_stats` and report the current **Background load cap** line
   plus any indexing backlog, then the options above.
2. Otherwise parse an integer, **clamp to [5, 100]**, and write/merge
   `~/.claude-memory/config.json` (real path: `$USERPROFILE/.claude-memory/config.json`) with
   `{"loadPercent":<value>}` — **preserve any other keys** already present.
3. Tell the user:
   - run `/reload-plugins` to apply (the MCP server restarts and re-reads the cap);
   - this only changes the **pace** of background work — it never drops data; the backfill simply
     takes longer at a lower cap;
   - `100` removes the throttle entirely.
4. Note: the env var `MEMORY_LOAD_PERCENT` overrides the file. If the cap doesn't change after
   reload, check for it (`/memory:status`).
