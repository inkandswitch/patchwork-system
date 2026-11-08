// Stand-ins for the browser's SharedWorker and Web Locks, driven by hand so a
// test decides exactly when a worker speaks, closes or dies.

export class FakePort extends EventTarget {
  /** What the tab has posted to this worker. */
  sent: any[] = [];
  closed = false;
  start() {}
  postMessage(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  /** Dispatch to the tab's listeners, as the worker posting would. */
  receive(data: unknown) {
    const event = new Event("message");
    (event as any).data = data;
    this.dispatchEvent(event);
  }
  /** Chromium's `close` on a port whose worker was terminated. */
  fireClose() {
    this.dispatchEvent(new Event("close"));
  }
}

export class FakeSharedWorker extends EventTarget {
  static instances: FakeSharedWorker[] = [];
  port = new FakePort();
  constructor(
    readonly path: string,
    readonly options: unknown
  ) {
    super();
    FakeSharedWorker.instances.push(this);
  }
  /** Posts that aren't the handshake. */
  get posted() {
    return this.port.sent.filter(
      (m) => m?.type !== "debug" && m?.type !== "hello"
    );
  }
}

export function fakeLocks() {
  const waiting = new Map<string, Array<() => void>>();
  return {
    request(name: string, _options: unknown, callback: () => void) {
      const list = waiting.get(name) ?? [];
      list.push(callback);
      waiting.set(name, list);
      return new Promise(() => {});
    },
    /** The holder went: everything waiting on `name` is granted it. */
    release(name: string) {
      for (const callback of waiting.get(name) ?? []) callback();
      waiting.delete(name);
    },
    waiters: (name: string) => waiting.get(name)?.length ?? 0,
  };
}
