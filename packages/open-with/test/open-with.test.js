// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import openWith from "../open-with.js";
import { host } from "./host.js";

const DOC = "automerge:doc";

const entry = (key, version, more = {}) => ({
  key,
  version,
  importUrl: key,
  addedAt: 1,
  addedBy: [{ by: "package-list", entry: key }],
  packageJson: { name: key, version: "1.0.0" },
  ...more,
});

const listed = entry("automerge:listed", "h1", { importUrl: "automerge:listed#h1" });
const dev = entry("https://dev.test/md/", "f00d", {
  base: "https://dev.test/md/",
  addedBy: [{ by: "package-url" }],
});

let element;
let opened;
let dispose;

const buttons = (text, within = element) =>
  [...within.querySelectorAll("button")].filter((b) => b.textContent === text);

beforeEach(async () => {
  host.tools = [
    { id: "md", name: "Markdown", supportedDatatypes: ["markdown"], package: listed },
    { id: "md", name: "Markdown", supportedDatatypes: ["markdown"], package: dev },
  ];
  host.selected = [DOC];
  globalThis.patchwork = {
    packages: {
      listsWith: (listedAs) =>
        listedAs === listed.key ? [{ name: "user", url: "automerge:list" }] : [],
    },
  };
  const repo = {
    async find(url) {
      if (url === DOC) {
        return { doc: () => ({ "@patchwork": { type: "markdown" } }), on() {}, off() {} };
      }
      return { history: () => [["h1"], ["h2"]] };
    },
  };
  element = document.createElement("div");
  document.body.append(element);
  opened = [];
  element.addEventListener("patchwork:open-document", (e) => opened.push(e.detail));
  dispose = openWith(element, repo);
  await vi.waitFor(() => expect(element.querySelector(".tool")).not.toBeNull());
});

afterEach(() => {
  dispose();
  element.remove();
  delete globalThis.patchwork;
  vi.unstubAllGlobals();
});

it("lists a tool once, with each package it comes from and the lists that have it", () => {
  expect(element.querySelectorAll(".tool")).toHaveLength(1);
  expect(element.querySelectorAll(".package")).toHaveLength(2);
  const first = element.querySelector(".package");
  expect(first.textContent).toContain("user");
  expect(first.textContent).toContain("automerge:list");

  buttons("Open", element.querySelector(".tool > .row"))[0].click();
  expect(opened.at(-1)).toEqual({ url: DOC, toolId: "md", packageUrl: undefined });
});

it("opens with a package, following its newest version", () => {
  buttons("Open", element.querySelector(".package"))[0].click();
  expect(opened.at(-1)).toEqual({ url: DOC, toolId: "md", packageUrl: "automerge:listed" });
});

it("opens with a version it has seen, or any heads of an automerge package", async () => {
  buttons("Open version…")[0].click();
  await vi.waitFor(() => expect(element.textContent).toContain("seen here"));
  buttons("Show every heads")[0].click();
  await vi.waitFor(() => expect(element.textContent).toContain("every heads"));

  const rows = [...element.querySelectorAll(".versions .row")];
  // the one seen, then the heads, newest first
  expect(rows.map((row) => row.querySelector("code").textContent)).toEqual(["h1", "h2", "h1"]);
  buttons("Open", rows[1])[0].click();
  expect(opened.at(-1).packageUrl).toBe("automerge:listed#h2");
});

it("checks an http package for a new package.json", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  buttons("Check for updates")[0].click();
  await vi.waitFor(() => expect(buttons("Reload page")).toHaveLength(1));
  expect(fetch).toHaveBeenCalledWith(new URL("https://dev.test/md/package.json"), {
    cache: "no-cache",
  });
});
