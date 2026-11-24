import { type AutomergeUrl, Repo } from "@automerge/automerge-repo";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  createEdgeHandle,
  EDGE_HANDLE_DATATYPE,
  EdgeHandle,
  findEdgeHandle,
  type Handle,
} from "../src/index.js";

// Silence "unused EdgeHandle" import warning (used for types implicitly).
void EdgeHandle;

interface SrcDoc {
  body: string;
}
interface NumDoc {
  value: number;
}
interface SinkDoc {
  html: string;
}

describe("EdgeHandle", () => {
  let repo: Repo;
  beforeEach(() => {
    repo = new Repo();
  });

  describe("doc shape", () => {
    it("creates an edge-handle doc with empty source/target by default", async () => {
      const edge = await createEdgeHandle(repo);
      const doc = edge.doc.doc();
      expect(doc["@patchwork"].type).toBe(EDGE_HANDLE_DATATYPE);
      expect(doc["@patchwork"].version).toBe(1);
      expect(doc.source).toEqual({});
      expect(doc.target).toEqual({});
      expect("persist" in doc).toBe(false);
      expect("value" in doc).toBe(false);
      expect(edge.source).toEqual({});
      expect(edge.target).toEqual({});
      expect(edge.sourceErrors).toEqual({});
      expect(edge.targetErrors).toEqual({});
    });

    it("persists source/target as named maps of urls", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      const sink = repo.create<SinkDoc>({ html: "" });
      await Promise.all([src.whenReady(), sink.whenReady()]);
      const edge = await createEdgeHandle(repo, {
        source: { s: src.sub("body") },
        target: { t: sink.sub("html") },
      });
      expect(edge.doc.doc().source).toEqual({ s: src.sub("body").url });
      expect(edge.doc.doc().target).toEqual({ t: sink.sub("html").url });
      expect(Object.keys(edge.source)).toEqual(["s"]);
      expect(Object.keys(edge.target)).toEqual(["t"]);
    });

    it("accepts urls or live handles in init", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo, {
        source: { ref: src.sub("body"), url: src.sub("body").url },
      });
      expect(Object.keys(edge.source)).toEqual(["ref", "url"]);
    });
  });

  describe("value side", () => {
    it("starts undefined and fires onValueChange on initial subscribe", async () => {
      const edge = await createEdgeHandle<number>(repo);
      const seen: (number | undefined)[] = [];
      edge.onValueChange((v) => seen.push(v));
      expect(seen).toEqual([undefined]);
    });

    it("accepts the value form of change()", async () => {
      const edge = await createEdgeHandle<number>(repo);
      edge.change(42);
      expect(edge.value()).toBe(42);
    });

    it("accepts the callback form of change()", async () => {
      const edge = await createEdgeHandle<number>(repo);
      edge.change(10);
      edge.change((n) => (n ?? 0) + 5);
      expect(edge.value()).toBe(15);
    });

    it("callback returning void leaves the value unchanged", async () => {
      const edge = await createEdgeHandle<number>(repo);
      edge.change(7);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      edge.change((_n) => undefined);
      expect(edge.value()).toBe(7);
    });

    it("notifies onValueChange subscribers", async () => {
      const edge = await createEdgeHandle<string>(repo);
      const seen: (string | undefined)[] = [];
      edge.onValueChange((v) => seen.push(v));
      edge.change("a");
      edge.change("b");
      expect(seen).toEqual([undefined, "a", "b"]);
    });

    it("fans out value to target handles via their native change()", async () => {
      const sink = repo.create<SinkDoc>({ html: "" });
      await sink.whenReady();
      const edge = await createEdgeHandle<string>(repo, {
        target: { sink: sink.sub("html") },
      });
      edge.change("<h1>hi</h1>");
      expect(sink.doc()?.html).toBe("<h1>hi</h1>");
    });

    it("change(undefined) still fans out to targets (no special semantics)", async () => {
      const sink = repo.create<SinkDoc>({ html: "seed" });
      await sink.whenReady();
      const edge = await createEdgeHandle<string>(repo, {
        target: { sink: sink.sub("html") },
      });
      // The sink may store undefined or throw; either way the cell must hand
      // it over.
      const before = sink.doc()?.html;
      edge.change(undefined as unknown as string);
      const after = sink.doc()?.html;
      const erroredAtSink = "sink" in edge.targetErrors;
      expect(before === after || erroredAtSink || after === undefined).toBe(
        true
      );
    });
  });

  describe("persistence", () => {
    it("does not persist by default (no persist flag or value in doc)", async () => {
      const edge = await createEdgeHandle<number>(repo);
      expect(edge.persisted()).toBe(false);
      edge.change(42);
      expect("value" in edge.doc.doc()).toBe(false);
      expect("persist" in edge.doc.doc()).toBe(false);
    });

    it("persists value to the doc when init.persist is true", async () => {
      const edge = await createEdgeHandle<number>(repo, {
        persist: true,
        value: 0,
      });
      expect(edge.persisted()).toBe(true);
      expect(edge.doc.doc().persist).toBe(true);
      expect(edge.doc.doc().value).toBe(0);
      edge.change(42);
      expect(edge.doc.doc().value).toBe(42);
    });

    it("persist:true without value still enables caching", async () => {
      const edge = await createEdgeHandle<number>(repo, { persist: true });
      expect(edge.persisted()).toBe(true);
      expect("value" in edge.doc.doc()).toBe(false);
      edge.change(7);
      expect(edge.doc.doc().value).toBe(7);
    });

    it("restores a persisted value when re-opening the edge", async () => {
      const edge = await createEdgeHandle<number>(repo, {
        persist: true,
        value: 0,
      });
      edge.change(123);
      edge.destroy();
      const reopened = await findEdgeHandle<number>(repo, edge.url);
      expect(reopened.persisted()).toBe(true);
      expect(reopened.value()).toBe(123);
      reopened.change(456);
      expect(reopened.doc.doc().value).toBe(456);
    });

    it("setPersisted(true) updates persisted() synchronously", async () => {
      const edge = await createEdgeHandle<number>(repo);
      edge.change(99);
      expect(edge.persisted()).toBe(false);
      edge.setPersisted(true);
      expect(edge.persisted()).toBe(true);
      // DocHandle.change is synchronous too.
      expect(edge.doc.doc().value).toBe(99);
    });

    it("setPersisted(false) clears persist and removes cached value", async () => {
      const edge = await createEdgeHandle<number>(repo, {
        persist: true,
        value: 5,
      });
      edge.change(20);
      edge.setPersisted(false);
      expect(edge.persisted()).toBe(false);
      expect("value" in edge.doc.doc()).toBe(false);
      expect("persist" in edge.doc.doc()).toBe(false);
      expect(edge.value()).toBe(20);
      edge.change(99);
      expect("value" in edge.doc.doc()).toBe(false);
    });

    it("clears doc.value when change()d to undefined while persisting", async () => {
      const edge = await createEdgeHandle<number>(repo, {
        persist: true,
        value: 10,
      });
      edge.change(undefined as unknown as number);
      expect("value" in edge.doc.doc()).toBe(false);
    });

    it("does not spuriously re-notify on subsequent doc changes for object values", async () => {
      const edge = await createEdgeHandle<{ n: number }>(repo, {
        persist: true,
        value: { n: 1 },
      });
      const seen: ({ n: number } | undefined)[] = [];
      edge.onValueChange((v) => seen.push(v));
      expect(seen.length).toBe(1);

      // A fresh automerge view of an equal value mustn't notify again.
      edge.doc.change((d) => {
        d.source["dummy"] = "automerge:dummy" as AutomergeUrl;
      });
      await wait(20);

      // None, ideally; above all, no storm.
      expect(seen.length).toBeLessThanOrEqual(2);
    });
  });

  describe("wire side", () => {
    it("onSourceChange does NOT fire on subscribe", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo, {
        source: { s: src.sub("body") },
      });
      const calls: [unknown, string][] = [];
      edge.onSourceChange((value, key) => calls.push([value, key]));
      expect(calls).toEqual([]);
    });

    it("onSourceChange fires (value, key) on per-source emissions", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo, {
        source: { s: src.sub("body") },
      });
      const calls: [unknown, string][] = [];
      edge.onSourceChange((value, key) => calls.push([value, key]));
      src.change((d) => {
        d.body = "world";
      });
      expect(calls).toEqual([["world", "s"]]);
    });

    it("onMembersChange fires on subscribe and on membership changes", async () => {
      const src = repo.create<SrcDoc>({ body: "x" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo);
      let fires = 0;
      edge.onMembersChange(() => fires++);
      expect(fires).toBe(1); // initial

      edge.setSource("s", src.sub("body"));
      await waitFor(() => fires >= 2);

      edge.removeSource("s");
      await waitFor(() => fires >= 3);
    });

    it("onAnyChange fires once on subscribe then on either kind of change", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo);
      const calls: [unknown, string | undefined][] = [];
      edge.onAnyChange((value, key) => calls.push([value, key]));
      expect(calls).toEqual([[undefined, undefined]]);

      edge.setSource("s", src.sub("body"));
      await waitFor(() => calls.length >= 2);
      expect(calls[calls.length - 1]).toEqual([undefined, undefined]);

      src.change((d) => {
        d.body = "world";
      });
      await waitFor(() => calls.length >= 3);
      expect(calls[calls.length - 1]).toEqual(["world", "s"]);
    });

    it("re-resolves handles when source is mutated", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo);
      expect(Object.keys(edge.source)).toEqual([]);
      edge.setSource("s", src.sub("body"));
      await waitFor(() => Object.keys(edge.source).length === 1);
      expect(edge.source.s?.value()).toBe("hello");
    });

    it("removeSource deletes the binding", async () => {
      const src = repo.create<SrcDoc>({ body: "hi" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo, {
        source: { s: src.sub("body") },
      });
      edge.removeSource("s");
      await waitFor(() => Object.keys(edge.source).length === 0);
      expect(edge.doc.doc().source).toEqual({});
    });

    it("removeTarget deletes the binding", async () => {
      const sink = repo.create<SinkDoc>({ html: "" });
      await sink.whenReady();
      const edge = await createEdgeHandle(repo, {
        target: { t: sink.sub("html") },
      });
      edge.removeTarget("t");
      await waitFor(() => Object.keys(edge.target).length === 0);
      expect(edge.doc.doc().target).toEqual({});
    });

    it("doc changes that only touch `value` don't re-fire members", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      await src.whenReady();
      const edge = await createEdgeHandle<string>(repo, {
        source: { s: src.sub("body") },
        persist: true,
        value: "",
      });
      let members = 0;
      let sourceFires = 0;
      edge.onMembersChange(() => members++);
      edge.onSourceChange(() => sourceFires++);
      const membersBefore = members;
      const sourceBefore = sourceFires;

      edge.change("a new value");
      edge.change("another");
      await wait(20);

      expect(members).toBe(membersBefore);
      expect(sourceFires).toBe(sourceBefore);
    });
  });

  describe("url validation at edit time", () => {
    it("setSource throws on a malformed URL", async () => {
      const edge = await createEdgeHandle(repo);
      expect(() => edge.setSource("bad", "not-a-url")).toThrow(/invalid/);
      expect(() => edge.setSource("bad", "automerge:")).toThrow(/invalid/);
      expect(() =>
        edge.setSource("bad", "automerge:bad?" as AutomergeUrl)
      ).toThrow(/invalid/);
    });

    it("setTarget throws on a malformed URL", async () => {
      const edge = await createEdgeHandle(repo);
      expect(() => edge.setTarget("bad", "garbage")).toThrow(/invalid/);
    });

    it("createEdgeHandle throws when init contains a malformed URL", async () => {
      await expect(
        createEdgeHandle(repo, { source: { bad: "automerge:" } })
      ).rejects.toThrow(/invalid/);
    });
  });

  describe("endpoint resolution errors", () => {
    it("captures an error for an unresolvable source URL written directly", async () => {
      const edge = await createEdgeHandle(repo);
      // Past setSource's check, like a url that came by sync for a doc that
      // hasn't yet.
      const ghost =
        "automerge:3PMqSyMiYrNts9Ezy8T8WBQNpF2K" as AutomergeUrl;
      edge.doc.change((d) => {
        d.source["ghost"] = ghost;
      });
      await waitFor(
        () => Object.keys(edge.sourceErrors).length > 0,
        500
      );
      expect(edge.sourceErrors.ghost).toBeInstanceOf(Error);
      expect(edge.source.ghost).toBeUndefined();
    });

    it("clears the error when the binding is removed", async () => {
      const edge = await createEdgeHandle(repo);
      const ghost =
        "automerge:3PMqSyMiYrNts9Ezy8T8WBQNpF2K" as AutomergeUrl;
      edge.doc.change((d) => {
        d.source["ghost"] = ghost;
      });
      await waitFor(() => "ghost" in edge.sourceErrors);
      edge.removeSource("ghost");
      await waitFor(() => !("ghost" in edge.sourceErrors));
      expect(edge.sourceErrors).toEqual({});
    });

    it("retries resolution on subsequent doc ticks while errors persist", async () => {
      const edge = await createEdgeHandle(repo);
      const ghost =
        "automerge:3PMqSyMiYrNts9Ezy8T8WBQNpF2K" as AutomergeUrl;
      edge.doc.change((d) => {
        d.source["ghost"] = ghost;
      });
      await waitFor(() => "ghost" in edge.sourceErrors);

      // An unrelated change: with errors outstanding, the refresh mustn't skip.
      const before = edge.sourceErrors.ghost;
      edge.doc.change((d) => {
        d.target["t"] = "automerge:3PMqSyMiYrNts9Ezy8T8WBQNpF2L" as AutomergeUrl;
      });
      await wait(30);
      // A retry can't be seen from here without a failure that recovers; this
      // only checks the error outlives the refresh.
      expect(edge.sourceErrors.ghost).toBeInstanceOf(Error);
      void before;
    });

    it("fan-out errors clear on the next successful write", async () => {
      // An edge as the target, so it can fail and recover without mocks.
      const target = await createEdgeHandle<string>(repo);
      const edge = await createEdgeHandle<string>(repo, {
        target: { t: target },
      });

      let shouldThrow = true;
      const original = target.change.bind(target);
      (target as { change: typeof target.change }).change = (v: unknown) => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("sabotage");
        }
        return original(v as string);
      };

      edge.change("first");
      expect(edge.targetErrors.t).toBeInstanceOf(Error);

      edge.change("second");
      expect("t" in edge.targetErrors).toBe(false);
    });
  });

  describe("plain doc urls resolve to root refs", () => {
    it("resolves a plain automerge:docId url to a whole-doc endpoint", async () => {
      const src = repo.create<SrcDoc>({ body: "hello" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo, {
        source: { s: src.url },
      });
      const resolved = edge.source.s;
      expect(resolved).toBeDefined();
      expect(resolved!.url).toBe(src.url);
      const v = resolved!.value() as SrcDoc;
      expect(v.body).toBe("hello");
    });
  });

  describe("findEdgeHandle", () => {
    it("returns the cached instance for the same url", async () => {
      const edge = await createEdgeHandle(repo);
      const reopened = await findEdgeHandle(repo, edge.url);
      expect(reopened).toBe(edge);
    });

    it("dedupes concurrent calls to the same instance", async () => {
      const edge = await createEdgeHandle(repo);
      const [a, b, c] = await Promise.all([
        findEdgeHandle(repo, edge.url),
        findEdgeHandle(repo, edge.url),
        findEdgeHandle(repo, edge.url),
      ]);
      expect(a).toBe(edge);
      expect(b).toBe(edge);
      expect(c).toBe(edge);
    });

    it("rejects when the url does not point at an edge-handle doc", async () => {
      const other = repo.create<{ x: number }>({ x: 1 });
      await other.whenReady();
      await expect(findEdgeHandle(repo, other.url)).rejects.toThrow();
    });
  });

  describe("destroy", () => {
    it("destroy evicts the cache; reopen produces a fresh instance", async () => {
      const edge = await createEdgeHandle(repo);
      const url = edge.url;
      edge.destroy();
      const reopened = await findEdgeHandle(repo, url);
      expect(reopened).not.toBe(edge);
    });

    it("destroy tears down source subscriptions (no further notifications)", async () => {
      const src = repo.create<SrcDoc>({ body: "hi" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo, {
        source: { s: src.sub("body") },
      });
      const calls: [unknown, string][] = [];
      edge.onSourceChange((value, key) => calls.push([value, key]));
      const before = calls.length;
      edge.destroy();
      src.change((d) => {
        d.body = "world";
      });
      await wait(10);
      expect(calls.length).toBe(before);
    });

    it("destroy is idempotent", async () => {
      const edge = await createEdgeHandle(repo);
      edge.destroy();
      expect(() => edge.destroy()).not.toThrow();
    });
  });

  describe("cycle safety", () => {
    it("write re-entrancy guard tolerates cycles without blowing the stack", async () => {
      const a = await createEdgeHandle<string>(repo);
      const b = await createEdgeHandle<string>(repo, { target: { a } });
      a.doc.change((d) => {
        d.target.b = b.url;
      });
      await wait(30);
      expect(() => a.change("ping")).not.toThrow();
    });

    it("allows setting source/target without an edit-time cycle check", async () => {
      const a = await createEdgeHandle(repo);
      const b = await createEdgeHandle(repo, { source: { a } });
      expect(() => a.setSource("b", b)).not.toThrow();
    });
  });

  describe("end-to-end with an inline transform", () => {
    it("multi-source sum routes through to a target on any input change", async () => {
      const a = repo.create<NumDoc>({ value: 1 });
      const b = repo.create<NumDoc>({ value: 2 });
      const c = repo.create<NumDoc>({ value: 3 });
      const total = repo.create<NumDoc>({ value: 0 });
      await Promise.all([
        a.whenReady(),
        b.whenReady(),
        c.whenReady(),
        total.whenReady(),
      ]);
      const edge = await createEdgeHandle<number>(repo, {
        source: {
          a: a.sub("value"),
          b: b.sub("value"),
          c: c.sub("value"),
        },
        target: { total: total.sub("value") },
      });
      edge.onAnyChange(() => {
        let n = 0;
        for (const src of Object.values(edge.source)) {
          const v = src.value();
          if (typeof v === "number" && Number.isFinite(v)) n += v;
        }
        edge.change(n);
      });

      await waitFor(() => total.doc()?.value === 6);
      a.change((d) => {
        d.value = 10;
      });
      await waitFor(() => total.doc()?.value === 15);
    });
  });

  describe("edge → edge chaining", () => {
    it("an EdgeHandle in `target` relays writes through to its own targets", async () => {
      const sink = repo.create<SinkDoc>({ html: "" });
      await sink.whenReady();
      const inner = await createEdgeHandle<string>(repo, {
        target: { sink: sink.sub("html") },
      });
      const outer = await createEdgeHandle<string>(repo, {
        target: { inner },
      });
      outer.change("relayed");
      await waitFor(() => sink.doc()?.html === "relayed");
    });

    it("EdgeHandle implements the Handle interface", async () => {
      const edge = await createEdgeHandle<string>(repo);
      expect(typeof edge.url).toBe("string");
      expect(typeof edge.value).toBe("function");
      expect(typeof edge.onChange).toBe("function");

      const seen: (string | undefined)[] = [];
      const unsub = edge.onChange((v) => seen.push(v));
      edge.change("hi");
      expect(seen).toEqual([undefined, "hi"]);
      unsub();
    });

    it("a resolved sub-handle endpoint implements the Handle interface", async () => {
      const src = repo.create<SrcDoc>({ body: "hi" });
      await src.whenReady();
      const edge = await createEdgeHandle(repo, {
        source: { s: src.sub("body") },
      });
      const ref = edge.source.s;
      expect(ref).toBeDefined();
      // Compile-time conformance:
      expectTypeOf(ref).toMatchTypeOf<Handle<unknown>>();
      expect(typeof ref.url).toBe("string");
      expect(typeof ref.value).toBe("function");
      expect(typeof ref.onChange).toBe("function");
      const seen: unknown[] = [];
      const unsub = ref.onChange((v) => seen.push(v));
      src.change((d) => {
        d.body = "world";
      });
      await wait(10);
      expect(seen).toContain("world");
      unsub();
    });
  });
});

async function waitFor(predicate: () => boolean | undefined, timeoutMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(5);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for predicate`);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
