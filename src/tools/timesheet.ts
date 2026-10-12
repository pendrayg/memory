import type { ToolDefinition } from './types.js';

/** "2h 05m" / "45m" / "0m". Rounds to the minute — production time is an estimate, not a stopwatch. */
function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}

const memoryTaskTime: ToolDefinition = {
  name: 'memory_task_time',
  description:
    'Estimates the production (active working) time spent on a task. Finds the sessions that worked on it (semantic + full-text search on the query — a ticket key, feature name, or keywords) and sums their active time (wall-clock minus idle gaps). Session-granularity: a session may mix several tasks, and sessions predating the feature have no timing.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Task identifier: ticket key, feature name, or keywords describing the work.',
      },
      project: { type: 'string', description: 'Limit to a project (directory basename). Optional.' },
      sessions: { type: 'number', description: 'Max sessions to consider (default 20).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args, { store, embedQuery, config }) => {
    const query = String(args.query ?? '').trim();
    if (!query) return '❌ `query` is required.';
    const project = args.project ? String(args.project) : undefined;
    const maxSessions = args.sessions ? Number(args.sessions) : 20;

    const embedding = store.vectorEnabled ? await embedQuery(query) : null;
    // Over-fetch candidates across all memory types, then collect the distinct sessions they belong
    // to, in relevance order, capped at maxSessions.
    const cand = store.search({
      query,
      project,
      limit: 120,
      embedding,
      satisfactionWeight: config.satisfactionWeight,
    });
    const sessionIds: string[] = [];
    const seen = new Set<string>();
    for (const d of cand) {
      if (d.session_id && !seen.has(d.session_id)) {
        seen.add(d.session_id);
        sessionIds.push(d.session_id);
      }
      if (sessionIds.length >= maxSessions) break;
    }
    if (sessionIds.length === 0) return `No session found for "${query}".`;

    const rows = store
      .productionForSessions(sessionIds)
      .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    const total = rows.reduce((s, r) => s + r.active_ms, 0);
    const untracked = rows.filter((r) => r.active_ms <= 0).length;

    const lines = rows.map((r) => {
      const date = (r.ts ?? '').slice(0, 10) || '?';
      const label = (r.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return `- ${date} \`${r.project ?? '?'}\` — **${fmtDuration(r.active_ms)}** · ${label}`;
    });

    return [
      `⏱️ **Production time for "${query}"**: **${fmtDuration(total)}** over ${rows.length} session(s)` +
        (untracked > 0 ? ` (${untracked} without timing)` : ''),
      '',
      ...lines,
      '',
      '_Estimate: active time = wall-clock minus idle gaps; session-granularity, a session may mix several tasks._',
    ].join('\n');
  },
};

export const timesheetTools: ToolDefinition[] = [memoryTaskTime];
