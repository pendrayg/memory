import { log } from './log.js';

/**
 * Template Method base for the transformers.js model hosts (embedder + cross-encoder reranker).
 *
 * `load()` is the invariant skeleton shared by both: import the runtime, point it at the cache,
 * cap the ONNX threads, then try `build(device, dtype)` + `warmup()` and — on any failure — fall
 * back to cpu/fp32. The promise guard makes the load happen exactly once per process (concurrent
 * callers share the in-flight promise; a hard failure latches so we never retry a broken model).
 *
 * Subclasses fill the varying steps:
 *   - sessionOptions(threads)  — ONNX session tuning (embedder adds executionMode/graphOpt).
 *   - beforeAttempts(tf, …)    — one-time pre-load logging / status / tokenizer load.
 *   - build(tf, device, dtype) — construct the model (pipeline vs sequence-classification).
 *   - warmup(model)            — a tiny inference that surfaces a GPU EP that loads but can't run.
 *   - afterLoad() / onLoadError(msg) — success / failure logging + status side-effects.
 *
 * Encapsulates the load state (model / loading / failed / effective device) that used to live in
 * module-level globals.
 */
export abstract class ModelHost<TModel> {
  protected model: TModel | null = null;
  private loading: Promise<TModel | null> | null = null;
  private failed = false;
  /** Effective device after load ('cpu' or a GPU EP); '' until loaded. For status reporting. */
  protected effectiveDevice = '';

  constructor(
    protected readonly cacheDir: string,
    protected readonly device: string,
    protected readonly dtype: string,
    protected readonly threads: number,
    protected readonly dataDir: string,
    /** Log prefix tag: 'embed' | 'rerank'. */
    protected readonly tag: string,
  ) {}

  /** True if the model is ALREADY loaded — never triggers a (blocking) load. For status reporting. */
  loaded(): boolean {
    return this.model !== null;
  }

  /** Effective device after load ('cpu' or a GPU EP); '' if not loaded yet. */
  deviceUsed(): string {
    return this.effectiveDevice;
  }

  /**
   * Frees the loaded model and resets to the unloaded state. Called when this process stops being the
   * leader: an ex-leader would otherwise pin its ONNX session (~2 GB for e5-large) for the lifetime of
   * the process, so with leadership flapping across sessions RAM piles up (observed: several GB).
   *
   * transformers.js pipelines/models expose `dispose()` which releases the underlying ONNX session;
   * we call it best-effort (it may be absent on some model kinds/versions). Resetting the load-state
   * fields lets a later `load()` transparently re-load if this process becomes leader again.
   */
  dispose(): void {
    try {
      (this.model as any)?.dispose?.();
    } catch {
      /* best-effort: never let teardown throw */
    }
    this.model = null;
    this.loading = null;
    this.failed = false;
    this.effectiveDevice = '';
    try {
      log(this.dataDir, `[${this.tag}] model disposed`);
    } catch {
      /* best-effort logging */
    }
  }

  /** Loads the model once (shared promise) and returns it, or null if unavailable. */
  protected async load(): Promise<TModel | null> {
    if (this.model) return this.model;
    if (this.failed) return null;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        // Specifier as a variable: keeps the import resolvable at runtime from node_modules.
        const mod = '@huggingface/transformers';
        const tf: any = await import(mod);
        tf.env.cacheDir = this.cacheDir;
        tf.env.allowRemoteModels = true;
        // Tier-derived thread budget: each inference may use up to this many cores, no more. Both
        // backends covered: onnxruntime-node reads `onnx.numThreads`; wasm reads `onnx.wasm.numThreads`.
        const threads = Math.max(1, this.threads || 1);
        try {
          tf.env.backends.onnx.numThreads = threads;
          if (tf.env.backends.onnx.wasm) tf.env.backends.onnx.wasm.numThreads = threads;
        } catch {
          /* best-effort: older builds may not expose the backend tree */
        }
        const session_options = this.sessionOptions(threads);
        const dtype = this.dtype || 'q8';
        await this.beforeAttempts(tf, threads, dtype);

        // Load + a warmup inference. The warmup surfaces a GPU EP that loads but can't actually run
        // the graph at startup (rather than silently returning null vectors later).
        const attempt = async (device: string, dt: string): Promise<TModel> => {
          const m = await this.build(tf, device, dt, session_options);
          await this.warmup(m);
          return m;
        };
        let m: TModel;
        try {
          m = await attempt(this.device, dtype);
          this.effectiveDevice = this.device && this.device !== 'cpu' ? this.device : 'cpu';
        } catch (e) {
          // GPU EP missing/unusable, or the quantized variant absent → fall back to CPU + fp32.
          log(
            this.dataDir,
            `[${this.tag}] device=${this.device || 'cpu'}/dtype=${dtype} failed (${e instanceof Error ? e.message : String(e)}); falling back to cpu/fp32`,
          );
          m = await attempt('cpu', 'fp32');
          this.effectiveDevice = 'cpu';
        }
        this.model = m;
        await this.afterLoad();
        return m;
      } catch (err) {
        this.failed = true;
        const message = err instanceof Error ? err.message : String(err);
        await this.onLoadError(message);
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  // --- Varying steps (defaults are no-ops; subclasses override what they need) ---

  /** ONNX session tuning. Default: single-pool sequential. */
  protected sessionOptions(threads: number): Record<string, unknown> {
    return { intraOpNumThreads: threads, interOpNumThreads: 1 };
  }

  /** One-time pre-load step (logging, status writes, tokenizer load). */
  protected async beforeAttempts(_tf: any, _threads: number, _dtype: string): Promise<void> {}

  /** Construct the model on the given device/dtype. */
  protected abstract build(
    tf: any,
    device: string,
    dtype: string,
    sessionOptions: Record<string, unknown>,
  ): Promise<TModel>;

  /** A tiny inference to surface a GPU EP that loads but can't run the graph. */
  protected abstract warmup(model: TModel): Promise<void>;

  /** Success side-effects (final logging, status idle). */
  protected async afterLoad(): Promise<void> {}

  /** Failure side-effects (logging, status idle, stderr). */
  protected async onLoadError(_message: string): Promise<void> {}
}
