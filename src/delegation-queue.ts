/**
 * A queue that runs one task at a time, in the order the tasks arrived.
 *
 * Built for the voice call's delegations. GPT-Live expects an answer to every
 * request it makes, and it can make one while the backend is still answering the
 * last — the caller interrupts, corrects themselves, or asks the next thing.
 * Dropping the new arrival left the caller listening to silence with nothing in
 * flight, which is the state this removes.
 *
 * It is kept out of the agent for the reason the login state machine is kept out
 * of the Durable Object: ordering, the length cap, and the guarantee that one
 * failed task cannot strand the tasks behind it are worth testing without a
 * socket, a session or a live model.
 */
export class DelegationQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  constructor(
    /** How many tasks may be waiting or running before `add` refuses. */
    private readonly cap: number,
    /** Where a task's failure goes; it is never allowed to break the chain. */
    private readonly onError: (error: unknown) => void,
  ) {}

  /** How many tasks are waiting or running. */
  get size(): number {
    return this.depth;
  }

  /**
   * Queues a task behind everything already queued.
   *
   * Returns false when the queue is at its cap: nothing was queued, so the
   * caller still owes this request an answer of its own.
   */
  add(task: () => Promise<void>): boolean {
    if (this.depth >= this.cap) return false;

    this.depth += 1;
    // The tail handed on is always fulfilled, so one task that throws cannot
    // leave the ones behind it waiting on a rejected promise for ever.
    this.tail = this.tail
      .then(task)
      .catch(this.onError)
      .then(() => {
        this.depth -= 1;
      });
    return true;
  }
}
