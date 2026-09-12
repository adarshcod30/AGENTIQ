/**
 * A tiny in-process job queue.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §11. An assessment runs for minutes, far longer
 * than an HTTP request should hold a connection, so the route enqueues a job and
 * returns immediately while a worker runs it. This is deliberately in-process:
 * local mode has one server, and a durable broker (Redis/BullMQ) is the SaaS
 * upgrade the plan calls out, not a local-mode need.
 *
 * Concurrency is bounded so a burst of assessments does not start a dozen apps
 * and scans at once. Because assessment state is persisted per phase, a job that
 * dies with the process is resumed by re-triggering it, not lost.
 */
export class JobQueue {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = concurrency;
    this.active = 0;
    this.pending = [];
  }

  /** Schedules `fn`; resolves with its result when it eventually runs. */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const { fn, resolve, reject } = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { this.active -= 1; this.#drain(); });
    }
  }

  get depth() {
    return this.pending.length;
  }
}

/** The shared queue for assessment jobs. */
export const assessmentQueue = new JobQueue({ concurrency: 2 });

/** A separate queue for GitHub clone jobs, so clones and assessments do not
 *  compete for the same slots. */
export const cloneQueue = new JobQueue({ concurrency: 2 });
