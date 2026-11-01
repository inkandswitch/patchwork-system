import * as A from "@automerge/automerge";
import { expect, test } from "vitest";
import { solo, peers, json } from "./peers.js";

test("text undo/redo", () => {
  const p = solo({ t: "" });
  p.change((d) => A.splice(d, ["t"], 0, 0, "hello"));
  p.clock.advance(1000);
  p.change((d) => A.splice(d, ["t"], 5, 0, " world"));
  expect(p.history.size).toBe(2);
  p.history.undo();
  expect(p.doc().t).toBe("hello");
  p.history.undo();
  expect(p.doc().t).toBe("");
  p.history.redo();
  expect(p.doc().t).toBe("hello");
  p.history.redo();
  expect(p.doc().t).toBe("hello world");
});

test("map and objects", () => {
  const p = solo<any>({ m: { a: 1 } });
  p.change((d) => {
    d.m.a = 2;
    d.m.o = { x: [1, 2] };
  });
  p.clock.advance(1000);
  p.change((d) => {
    delete d.m;
  });
  p.history.undo();
  expect(json(p.doc())).toEqual({ m: { a: 2, o: { x: [1, 2] } } });
  p.history.undo();
  expect(json(p.doc())).toEqual({ m: { a: 1 } });
  p.history.redo();
  p.history.redo();
  expect(json(p.doc())).toEqual({});
});

test("concurrent insertion inside deleted text", () => {
  const { alice, bob, sync } = peers({ t: "<hello world>" });
  alice.change((d) => A.splice(d, ["t"], 0, 13));
  bob.change((d) => A.splice(d, ["t"], 6, 0, "X"));
  sync();
  expect(alice.doc().t).toBe("X");
  alice.history.undo();
  expect(alice.doc().t).toBe("<helloX world>");
});
