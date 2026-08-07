import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { refreshLeadership, releaseLeadership } from './leader.js';
import { log } from './log.js';

const HEARTBEAT_MS = 30_000;

/**
 * Observer over the single-leader election (see {@link refreshLeadership}). Owns the lock heartbeat
 * and the lock-file watch, and emits one of two events on every transition so subscribers
 * (the embed service, the background loops, the executor swap) react without polling `amLeader`:
 *   - `becameLeader`   — this process just acquired leadership (startup or failover).
 *   - `lostLeadership` — this process is no longer the leader (rare for a healthy process).
 *
 * Replaces the inline `syncLeadership()` tangle that used to live in server.ts.
 */
export class LeaderCoordinator extends EventEmitter {
  private leader = false;
  /** Extra fields published into the lock (the leader's loopback endpoint). */
  private extra: Record<string, unknown> = {};
  private heartbeat?: ReturnType<typeof setInterval>;
  private watcher?: ReturnType<typeof watch>;
  private watchT?: ReturnType<typeof setTimeout>;
  private releasing = false;

  constructor(private readonly dataDir: string) {
    super();
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** Publishes the leader's loopback endpoint into the lock (re-refreshes immediately). */
  publishEndpoint(port: number, token: string): void {
    this.extra = { port, token };
    this.sync();
  }

  /**
   * Acquires/renews the lock once and emits a transition event if leadership changed. Safe to call
   * repeatedly (heartbeat + fs.watch). A tiny two-leaders race is harmless (writes are idempotent).
   */
  sync(): void {
    const was = this.leader;
    this.leader = refreshLeadership(this.dataDir, this.extra);
    if (this.leader !== was) {
      log(this.dataDir, `[server] leadership → ${this.leader}`);
      this.emit(this.leader ? 'becameLeader' : 'lostLeadership');
    }
  }

  /**
   * First sync + heartbeat + near-instant failover watch. When the leader releases the lock, a
   * follower re-checks immediately instead of waiting for its 30 s heartbeat (only followers react;
   * a leader ignores its own writes). Heartbeat remains the fallback if fs.watch is unsupported.
   */
  start(): void {
    this.sync();
    this.heartbeat = setInterval(() => this.sync(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    try {
      this.watcher = watch(this.dataDir, (_event, filename) => {
        if (!this.leader && filename && String(filename).includes('worker.lock')) {
          clearTimeout(this.watchT);
          // Jitter (200–500 ms) so N followers don't all pounce on the same millisecond when the lock
          // disappears (leader release). Combined with the O_EXCL acquire in refreshLeadership this
          // still yields a single winner, but spreading the attempts avoids a burst of EEXIST churn
          // and the thundering-herd wakeups that used to make leadership flap every 1–3 minutes.
          const delay = 200 + Math.floor(Math.random() * 300);
          this.watchT = setTimeout(() => this.sync(), delay);
        }
      });
      this.watcher.unref?.();
    } catch {
      /* fs.watch unsupported → heartbeat covers failover */
    }
  }

  /**
   * Releases leadership if held (called on exit/session close) so a sibling takes over on its next
   * heartbeat instead of waiting out the stale timeout. Idempotent.
   */
  release(): void {
    if (this.releasing) return;
    this.releasing = true;
    if (this.leader) {
      releaseLeadership(this.dataDir);
      log(this.dataDir, `[server] released leadership on exit (pid ${process.pid})`);
    }
  }
}
