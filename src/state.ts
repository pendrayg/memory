import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { MemoryConfig } from './config.js';

/** State accumulated per session across hook invocations (separate processes). */
export interface SessionState {
  promptNumber: number;
  obsSeq: number;
  turnSeq: number;
  lines: number; // transcript lines already processed (Stop cursor)
  prompts: string[];
  filesModified: string[];
  filesRead: string[];
  tools: string[];
  project?: string;
  branch?: string;
  cwd?: string;
  startedAt: string;
  /** mem_ids already injected into this session's context (SessionStart + auto-recall) → dedup. */
  injected: string[];
  /** Accumulated production (active) time in ms — sum of idle-capped gaps between activity events. */
  activeMs: number;
  /** Epoch (ms) of the last activity event; 0 = none yet. Drives the gap in markActivity. */
  lastActivityEpoch: number;
}

function defaultState(): SessionState {
  return {
    promptNumber: 0,
    obsSeq: 0,
    turnSeq: 0,
    lines: 0,
    prompts: [],
    filesModified: [],
    filesRead: [],
    tools: [],
    startedAt: new Date().toISOString(),
    injected: [],
    activeMs: 0,
    lastActivityEpoch: 0,
  };
}

function stateDir(cfg: MemoryConfig): string {
  return path.join(cfg.dataDir, 'state');
}

function statePath(cfg: MemoryConfig, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(stateDir(cfg), `${safe}.json`);
}

export function loadState(cfg: MemoryConfig, sessionId: string): SessionState {
  try {
    const raw = readFileSync(statePath(cfg, sessionId), 'utf8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function saveState(cfg: MemoryConfig, sessionId: string, state: SessionState): void {
  mkdirSync(stateDir(cfg), { recursive: true });
  writeFileSync(statePath(cfg, sessionId), JSON.stringify(state), 'utf8');
}

export function clearState(cfg: MemoryConfig, sessionId: string): void {
  try {
    rmSync(statePath(cfg, sessionId));
  } catch {
    /* already absent */
  }
}
