/** Keeps asynchronous frame cryptography in wire order and bounds retained work. */
export class OrderedMeshQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;
  private bytes = 0;
  private closed = false;

  run<T>(operation: () => Promise<T>, bytes: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error('machine-session-closed'));
    if (this.count >= 512 || this.bytes + bytes > 2 * 1024 * 1024) {
      return Promise.reject(new Error('machine-frame-queue-full'));
    }
    this.count += 1;
    this.bytes += bytes;
    const work = this.tail
      .then(() => {
        if (this.closed) throw new Error('machine-session-closed');
        return operation();
      })
      .finally(() => {
        this.count -= 1;
        this.bytes -= bytes;
      });
    this.tail = work.catch(() => undefined);
    return work;
  }

  close(): void {
    this.closed = true;
  }
}
