import { describe, it, expect, vi } from "vitest";
import {
  acceptIndexAnswer,
  indexChannelProbe,
  isAutomergeWorker,
  postIndexAnswer,
} from "../src/index-channel.js";

const o = "https://p.test";
const worker = { type: "sharedworker", url: `${o}/automerge-protocol-handler-worker.js` } as const;

describe("isAutomergeWorker", () => {
  it.each([
    [worker, true],
    [{ type: "sharedworker", url: `${o}/automerge-protocol-handler-worker.js?x=1` }, true],
    // what any page can start from the same url: a dedicated worker
    [{ type: "worker", url: `${o}/automerge-protocol-handler-worker.js` }, false],
    [{ type: "window", url: `${o}/` }, false],
    [{ type: "sharedworker", url: `${o}/@/acct@h/evil.js` }, false],
    [{ type: "sharedworker", url: `https://evil.test/automerge-protocol-handler-worker.js` }, false],
    [undefined, false],
  ])("%j → %s", (client, ok) => {
    expect(isAutomergeWorker(client as any, o)).toBe(ok);
  });
});

const answerRequest = (body: unknown) =>
  new Request(`${o}/@/.index`, { method: "POST", body: JSON.stringify(body) });

describe("acceptIndexAnswer", () => {
  it("refuses a window with 403 and hands nothing on", async () => {
    const onAnswer = vi.fn();
    const response = await acceptIndexAnswer(
      answerRequest({ id: "1" }),
      { type: "window", url: `${o}/` },
      o,
      onAnswer
    );
    expect(response.status).toBe(403);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("accepts the worker with 204 and the header", async () => {
    const onAnswer = vi.fn();
    const answer = { id: "1", manifest: { prefix: "a@h", entries: {} } };
    const response = await acceptIndexAnswer(answerRequest(answer), worker, o, onAnswer);
    expect(response.status).toBe(204);
    expect(response.headers.get("x-patchwork-index")).toBe("accepted");
    expect(onAnswer).toHaveBeenCalledWith(answer);
  });

  it("refuses a body that isn't an answer", async () => {
    const onAnswer = vi.fn();
    const response = await acceptIndexAnswer(answerRequest("nope"), worker, o, onAnswer);
    expect(response.status).toBe(400);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("indexChannelProbe", () => {
  it("says the service worker is there, and takes nothing", () => {
    const response = indexChannelProbe();
    expect(response.status).toBe(405);
    expect(response.headers.get("x-patchwork-index")).toBe("present");
  });
});

const present = () =>
  new Response(null, { status: 405, headers: { "x-patchwork-index": "present" } });
const accepted = () =>
  new Response(null, { status: 204, headers: { "x-patchwork-index": "accepted" } });

describe("postIndexAnswer", () => {
  it("probes before posting, so an answer never reaches the network", async () => {
    const replies = [new Response("", { status: 404 }), present(), accepted()];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => replies.shift()!);
    expect(await postIndexAnswer({ id: "1" }, fetcher as typeof fetch)).toBe(true);
    expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "GET",
      "GET",
      "POST",
    ]);
  });

  it("never posts when the probe never reaches the service worker", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("", { status: 404 }));
    expect(await postIndexAnswer({ id: "1" }, fetcher as typeof fetch)).toBe(false);
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("probes once per fetcher, then retries a post that didn't get through", async () => {
    const replies = [present(), new Response("", { status: 404 }), accepted(), accepted()];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => replies.shift()!);
    expect(await postIndexAnswer({ id: "1" }, fetcher as typeof fetch)).toBe(true);
    expect(await postIndexAnswer({ id: "2" }, fetcher as typeof fetch)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
