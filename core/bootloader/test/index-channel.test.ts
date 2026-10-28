import { describe, it, expect, vi } from "vitest";
import {
  acceptIndexAnswer,
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

describe("postIndexAnswer", () => {
  it("retries a reply that skipped the service worker", async () => {
    const replies = [
      new Response("", { status: 404 }),
      new Response(null, { status: 204, headers: { "x-patchwork-index": "accepted" } }),
    ];
    const fetcher = vi.fn(async () => replies.shift()!);
    expect(await postIndexAnswer({ id: "1" }, fetcher as typeof fetch)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("gives up after 5 tries", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 404 }));
    expect(await postIndexAnswer({ id: "1" }, fetcher as typeof fetch)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
