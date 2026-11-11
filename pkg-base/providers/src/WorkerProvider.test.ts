import { describe, it, expect, afterEach, vi } from "vitest";

// The provider resolves workers from the host plugin registry. Stub it before
// importing, so these tests exercise the provider's own logic (decline / claim /
// always-settle) without needing the real platform.
type Waiter = { id: string; resolve: (v: { module: unknown }) => void };
const registry = {
  plugins: new Map<string, unknown>(),
  waiters: [] as Waiter[],
  has(id: string) {
    return this.plugins.has(id);
  },
  async loadWhenReady(id: string): Promise<{ module: unknown }> {
    // Mirrors the real registry: waits for a late registration rather than
    // reporting the plugin missing.
    if (this.plugins.has(id)) return { module: this.plugins.get(id) };
    return new Promise((resolve) => {
      this.waiters.push({ id, resolve });
    });
  },
  register(id: string, spec: unknown) {
    this.plugins.set(id, spec);
    for (const w of this.waiters) {
      if (w.id === id) w.resolve({ module: spec });
    }
    this.waiters = this.waiters.filter((w) => w.id !== id);
  },
  reset() {
    this.plugins.clear();
    this.waiters = [];
  },
};

vi.mock("@inkandswitch/patchwork-plugins", () => ({
  getRegistry: () => registry,
}));

const { WorkerProvider } = await import("./WorkerProvider.js");

/** A minimal WorkerSpec whose worker is a stub — enough to exercise the provider,
 * which hands the spec to serveWorkerSpec rather than calling a run function. */
function fakeSpec(overrides: Record<string, unknown> = {}) {
  return {
    createWorker: () => ({
      onmessage: null,
      postMessage() {},
      terminate() {},
    }),
    handle() {},
    ...overrides,
  };
}

/** Dispatch a worker-channel subscribe and report what came back. */
function ask(el: HTMLElement, kind: string) {
  const channel = new MessageChannel();
  const replies: any[] = [];
  let reachedDocument = false;

  channel.port1.addEventListener("message", (e) => replies.push(e.data));
  channel.port1.start();

  // The provider listens at `document`, and stopPropagation() does not stop
  // other listeners on the SAME node — so a document-level sentinel always
  // fires. Read `cancelBubble` instead: it's the observable record of whether
  // something called stopPropagation() during this dispatch.
  let claimed = false;
  const sentinel = (e: Event) => {
    if ((e as CustomEvent).detail?.port !== channel.port2) return;
    reachedDocument = true;
    // Runs after the provider's listener (registered first), so this reflects
    // whether the provider claimed it.
    claimed = e.cancelBubble === true;
  };
  document.addEventListener("patchwork:subscribe", sentinel);
  el.dispatchEvent(
    new CustomEvent("patchwork:subscribe", {
      detail: { selector: { type: "patchwork:worker-channel", kind }, port: channel.port2 },
      bubbles: true,
      composed: true,
    })
  );
  document.removeEventListener("patchwork:subscribe", sentinel);

  return {
    replies,
    /** Did the provider decline (leave the event unclaimed for others)? */
    declined: () => reachedDocument && !claimed,
    settled: async () => {
      for (let i = 0; i < 50 && replies.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return replies[0];
    },
  };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((f) => f());
  cleanups = [];
  registry.reset();
});

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const el = document.createElement("div");
  host.appendChild(el);
  const dispose = WorkerProvider(host);
  cleanups.push(() => {
    dispose();
    host.remove();
  });
  return el;
}

describe("WorkerProvider", () => {
  it("declines a kind it cannot serve, leaving the event to bubble", async () => {
    // A provider that claimed unconditionally and only discovered there was no
    // worker afterwards would swallow the event from any other answerer.
    const el = mount();
    const asked = ask(el, "nobody");
    expect(asked.declined()).toBe(true);
    expect(asked.replies).toHaveLength(0);
  });

  it("claims and serves a registered kind, transferring the streams", async () => {
    registry.register("llm", fakeSpec());
    const el = mount();
    const asked = ask(el, "llm");

    expect(asked.declined()).toBe(false); // claimed synchronously
    const reply = await asked.settled();
    // The providers envelope, with the pair in `value` and the streams moved
    // (not cloned) by respond()'s transfer list.
    expect(reply.type).toBe("change");
    expect(reply.value.readable).toBeInstanceOf(ReadableStream);
    expect(reply.value.writable).toBeInstanceOf(WritableStream);
  });

  it("passes the mounted element to the spec, so a worker can resolve host context", async () => {
    let seen: any = null;
    registry.register(
      "llm",
      fakeSpec({
        open: (ctx: unknown) => {
          seen = ctx;
          return null;
        },
      })
    );
    const el = mount();
    // The provider serves synchronously; element reaches the spec via open(ctx).
    await ask(el, "llm").settled();
    // open runs eagerly inside serveWorkerSpec, before any frame.
    expect(seen?.element).toBeInstanceOf(HTMLElement);
  });

  it("refuses when the plugin does not resolve to a WorkerSpec", async () => {
    // A claimed subscription must always settle; a bad plugin settles with null.
    registry.register("llm", "not a spec");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = mount();
    const reply = await ask(el, "llm").settled();
    expect(reply).toMatchObject({ type: "change", value: null });
  });

  it("refuses a spec missing createWorker or handle", async () => {
    registry.register("llm", { handle: () => {} }); // no createWorker
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = mount();
    const reply = await ask(el, "llm").settled();
    expect(reply).toMatchObject({ type: "change", value: null });
  });

  // NOTE: there is deliberately no "serves a worker registered AFTER the request"
  // test. The synchronous `has(kind)` guard means an unregistered kind is
  // DECLINED, not queued — so late registration is unreachable by construction,
  // and `loadWhenReady`'s waiting branch only covers a plugin that is registered
  // but not yet loaded. A test that registers first and calls itself "late" would
  // assert a capability the provider does not have.
});
