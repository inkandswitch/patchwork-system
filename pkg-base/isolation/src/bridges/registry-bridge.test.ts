/**
 * Behavior lock for the registry bridge's `registry--` marker codec and the
 * resource bridge's `classify` allowlist — the security-critical pieces of the
 * isolation URL layer.
 *
 * Covers: the bidirectional mapping between real package locations (automerge
 * document IDs and external URLs) and opaque `registry--<name>` markers; the
 * baked-dependency rewrite round-trip; and the allowlist that admits only
 * platform/registry requests, blocking smuggled automerge IDs and path-traversal
 * escapes.
 *
 * The codec reads `window.location.origin`; we stub it to a fixed host so tests
 * stay pure (no DOM environment needed, matching the sibling `file` package).
 * Automerge URL fixtures are generated with `generateAutomergeUrl()` so they are
 * real, valid IDs (hand-written strings fail `isValidAutomergeUrl`).
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  generateAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";
import {
  getImportableUrlFromAutomergeUrl,
} from "@inkandswitch/patchwork-filesystem";
import {
  PackagesUrlMapper,
  resolvePackageRequest,
  rewriteServedSource,
  splitFirstSegment,
} from "./registry-bridge.js";
import { classify } from "./resource-bridge.js";

const HOST = "https://host.example";

// The codec resolves relative URLs and prefixes against window.location.origin.
// Stub a fixed host so the assertions are deterministic. document.baseURI backs
// getImportableUrlFromAutomergeUrl (via patchwork-filesystem), so stub that too.
beforeAll(() => {
  vi.stubGlobal("window", { location: { origin: HOST } });
  vi.stubGlobal("document", { baseURI: HOST + "/" });
});

// Fresh, valid automerge URLs per suite — real IDs, not hand-written strings.
let AM_A: AutomergeUrl;
let AM_B: AutomergeUrl;
let HEADS: string;
beforeAll(() => {
  AM_A = generateAutomergeUrl();
  AM_B = generateAutomergeUrl();
  // A heads suffix is a base58-ish token; its exact value is opaque to the codec.
  HEADS = "26oUrk4Jj3kBUbJjGEr1SuQLskBBxxihaWGWL4g7jTPvwM9TM3";
});

describe("splitFirstSegment", () => {
  it("returns the decoded first segment and the raw rest", () => {
    expect(splitFirstSegment(`${HOST}/registry--@scope--x/dist/index.js`)).toEqual(
      { first: "registry--@scope--x", rest: "dist/index.js" }
    );
  });

  it("decodes the first segment (percent-encoding)", () => {
    expect(
      splitFirstSegment(`${HOST}/registry--%40scope--x%2523h/dist/a.js`).first
    ).toBe("registry--@scope--x%23h");
  });

  it("normalizes `..` before splitting (traversal-safe)", () => {
    // /assets/../<id>/x → /<id>/x, so `first` is the escaped segment, not `assets`.
    expect(
      splitFirstSegment(`${HOST}/assets/../${encodeURIComponent(AM_A)}/x.js`).first
    ).toBe(AM_A);
  });

  it("handles a single-segment path (no rest)", () => {
    expect(splitFirstSegment(`${HOST}/packages`)).toEqual({
      first: "packages",
      rest: "",
    });
  });
});

describe("PackagesUrlMapper.encodeSegment (automerge → marker)", () => {
  it("maps a bare automerge URL to a sanitized bare marker segment", () => {
    const mapper = new PackagesUrlMapper();
    expect(mapper.encodeSegment(AM_A, "@patchwork/folder")).toBe(
      "registry--@patchwork--folder"
    );
  });

  it("reuses the same marker name for a repeated automerge base", () => {
    const mapper = new PackagesUrlMapper();
    const a = mapper.encodeSegment(AM_A, "@scope/x");
    const b = mapper.encodeSegment(AM_A, "@scope/x");
    expect(a).toBe("registry--@scope--x");
    expect(b).toBe("registry--@scope--x");
  });

  it("carries a heads suffix as a %23-encoded version", () => {
    const mapper = new PackagesUrlMapper();
    const out = mapper.encodeSegment(`${AM_A}#${HEADS}`, "@scope/x");
    expect(out).toBe(`registry--@scope--x%23${HEADS}`);
  });

  it("falls back to an unknown-N name when none is provided", () => {
    const mapper = new PackagesUrlMapper();
    expect(mapper.encodeSegment(AM_A)).toMatch(/^registry--unknown-\d+$/);
  });

  it("returns null for a non-automerge input", () => {
    const mapper = new PackagesUrlMapper();
    expect(mapper.encodeSegment("not-an-automerge-url")).toBeNull();
  });
});

describe("PackagesUrlMapper.isRegisteredDependency", () => {
  it("is false before registration and true after", () => {
    const mapper = new PackagesUrlMapper();
    expect(mapper.isRegisteredDependency(AM_A)).toBe(false);
    mapper.encodeSegment(AM_A, "@scope/x");
    expect(mapper.isRegisteredDependency(AM_A)).toBe(true);
  });
});

describe("PackagesUrlMapper.resolveMarker (reverse mapping)", () => {
  it("restores the URL-encoded automerge segment for a registered marker", () => {
    const mapper = new PackagesUrlMapper();
    mapper.encodeSegment(AM_A, "@scope/x");
    const back = mapper.resolveMarker("registry--@scope--x/dist/index.js");
    expect(back).toBe(`${encodeURIComponent(AM_A)}/dist/index.js`);
  });

  it("restores heads from the %23 suffix", () => {
    const mapper = new PackagesUrlMapper();
    mapper.encodeSegment(`${AM_A}#${HEADS}`, "@scope/x");
    const back = mapper.resolveMarker(
      `registry--@scope--x%23${HEADS}/dist/index.js`
    );
    expect(back).toBe(
      `${encodeURIComponent(`${AM_A}#${HEADS}`)}/dist/index.js`
    );
  });

  it("restores heads and a deep subpath together (keyed rebuild)", () => {
    const mapper = new PackagesUrlMapper();
    mapper.encodeSegment(`${AM_A}#${HEADS}`, "@scope/x");
    const back = mapper.resolveMarker(
      `registry--@scope--x%23${HEADS}/dist/assets/deep/chunk.js`
    );
    expect(back).toBe(
      `${encodeURIComponent(`${AM_A}#${HEADS}`)}/dist/assets/deep/chunk.js`
    );
  });

  it("returns null when no known marker segment is present", () => {
    const mapper = new PackagesUrlMapper();
    expect(
      mapper.resolveMarker("registry--@unknown--y/dist/index.js")
    ).toBeNull();
  });
});

describe("PackagesUrlMapper external (statically-hosted) mapping", () => {
  const EXT_ENTRY = "https://netlify.example/tool/dist/index.js";

  it("maps an external entry URL to a host-origin marker URL (location hidden)", () => {
    const mapper = new PackagesUrlMapper();
    const out = mapper.encodeExternal(EXT_ENTRY, "my-tool");
    expect(out).toBe(`${HOST}/registry--my-tool/dist/index.js`);
    // The external location must not appear in what crosses to the iframe.
    expect(out).not.toContain("netlify.example");
  });

  it("round-trips a marker chunk request back to the external URL", async () => {
    const mapper = new PackagesUrlMapper();
    mapper.encodeExternal(EXT_ENTRY, "my-tool");
    // A code-split chunk request under the marker (host-origin-prefixed).
    const chunkReq = `${HOST}/registry--my-tool/dist/assets/chunk.js`;
    const resolved = await resolvePackageRequest(chunkReq, mapper);
    expect(resolved).toBe(
      "https://netlify.example/tool/dist/assets/chunk.js"
    );
  });

  it("resolves the entry itself back to the external entry URL", async () => {
    const mapper = new PackagesUrlMapper();
    mapper.encodeExternal(EXT_ENTRY, "my-tool");
    const resolved = await resolvePackageRequest(
      `${HOST}/registry--my-tool/dist/index.js`,
      mapper
    );
    expect(resolved).toBe(EXT_ENTRY);
  });

  it("classifies the external marker request as registry", () => {
    const mapper = new PackagesUrlMapper();
    const out = mapper.encodeExternal(EXT_ENTRY, "my-tool");
    expect(classify(out)).toBe("registry");
  });

  it("shares ONE marker across a multi-plugin external package (keyed by package name)", () => {
    // A single external package exporting multiple plugins registers each plugin's
    // entry — the SAME package name + root — via encodeExternal. All must collapse
    // to one marker (one download/cache entry), and a chunk request under that
    // marker must round-trip back to the shared external root. This is the
    // regression that keying by plugin id (distinct per plugin) produced.
    const mapper = new PackagesUrlMapper();
    const entryA = "https://netlify.example/threepane/dist/index.js";
    const entryB = "https://netlify.example/threepane/dist/other.js";

    const markerA = mapper.encodeExternal(entryA, "threepane");
    const markerB = mapper.encodeExternal(entryB, "threepane");

    // Both entries map under the one package marker.
    expect(markerA).toBe(`${HOST}/registry--threepane/dist/index.js`);
    expect(markerB).toBe(`${HOST}/registry--threepane/dist/other.js`);

    // A code-split chunk request under the shared marker resolves back to the one
    // external root (proving a single registration serves all the package's
    // modules, not a per-plugin alias).
    expect(
      mapper.resolveMarker("registry--threepane/dist/assets/c.js")
    ).toBe("https://netlify.example/threepane/dist/assets/c.js");
  });
});

describe("smuggling rejection (allowlist replaces the raw-automerge scan)", () => {
  // `classify` blocks anything that isn't platform/registry, so a raw automerge
  // document ID smuggled into a host-origin request must not be served.
  it("blocks a raw automerge document ID in a host-origin path", () => {
    expect(classify(`${HOST}/${encodeURIComponent(AM_A)}/index.js`)).toBe(
      "blocked"
    );
  });

  it("blocks a heads-pinned raw automerge ID", () => {
    expect(
      classify(`${HOST}/${encodeURIComponent(`${AM_A}#${HEADS}`)}/index.js`)
    ).toBe("blocked");
  });

  it("admits a marker URL (registry) and platform/external URLs", () => {
    expect(classify(`${HOST}/registry--@scope--x/dist/index.js`)).toBe(
      "registry"
    );
    expect(
      classify(`${HOST}/registry--@scope--x%23${HEADS}/dist/index.js`)
    ).toBe("registry");
    expect(classify(`${HOST}/packages/solid-js.js`)).toBe("platform");
    expect(classify("https://netlify.example/tool/dist/index.js")).toBe(
      "registry"
    );
  });
});

describe("resolvePackageRequest", () => {
  it("resolves a host-origin-prefixed marker chunk back to the real automerge path", async () => {
    const mapper = new PackagesUrlMapper();
    mapper.encodeSegment(AM_A, "@scope/x");
    const chunk = `${HOST}/registry--@scope--x/dist/assets/chunk.js`;
    const out = await resolvePackageRequest(chunk, mapper);
    expect(out).toBe(`${encodeURIComponent(AM_A)}/dist/assets/chunk.js`);
  });

  it("passes a non-automerge, non-marker URL through unchanged", async () => {
    const mapper = new PackagesUrlMapper();
    const plain = "https://netlify.example/tool/dist/index.js";
    expect(await resolvePackageRequest(plain, mapper)).toBe(plain);
  });

  it("passes a bare automerge URL through unchanged (not a marker)", async () => {
    const mapper = new PackagesUrlMapper();
    // A bare `automerge:` URL is not a `registry--` marker, so the request-path
    // resolver leaves it untouched. In production such a request never reaches
    // here — `classify` blocks it as a raw automerge ID first. (Entry-point
    // resolution of a bare automerge URL is a registration-time concern handled
    // by `mapper.resolvePackage`, not request resolution.)
    expect(await resolvePackageRequest(AM_A, mapper)).toBe(AM_A);
  });
});

describe("dependency round-trip (rewrite → runtime-encode → resolve)", () => {
  it("a rewritten bare marker dep round-trips back to the real automerge path", async () => {
    const mapper = new PackagesUrlMapper();
    // Registration: the consuming package (marker `registry--consumer`) declared
    // AM_B#HEADS as a dependency, so its dep marker is registered and the package
    // is recorded as needing source rewriting.
    mapper.encodeSegment(`${AM_B}#${HEADS}`, "@chee/patchwork-llm");
    mapper.markPackageHasDeps(mapper.markerNameFor("consumer"));

    // Serve-time: a consumer module (requested under its `registry--consumer`
    // marker) has its baked dep literal rewritten to a bare marker segment.
    const source = `const dep = getImportableUrlFromAutomergeUrl("${AM_B}#${HEADS}")`;
    const consumerReq = `${HOST}/registry--consumer/dist/index.js`;
    const rewritten = rewriteServedSource(source, consumerReq, mapper);
    const bareMarker = `registry--@chee--patchwork-llm%23${HEADS}`;
    expect(rewritten).toContain(bareMarker);

    // Runtime: the tool calls getImportableUrlFromAutomergeUrl on the bare marker,
    // which percent-encodes it into a request path. patchwork-filesystem returns
    // an origin-*relative* URL (`/<encoded>/subpath`); the browser resolves it
    // against the iframe base, so by the time it reaches the host fetch proxy it
    // is host-origin-prefixed. The marker has no internal `/`, so it stays one
    // segment. Model that resolution explicitly.
    const relative = getImportableUrlFromAutomergeUrl(
      bareMarker as AutomergeUrl,
      "dist/index.js"
    );
    const requestUrl = new URL(relative, HOST + "/").href;
    // The first path segment is the percent-encoded bare marker.
    expect(requestUrl).toContain(encodeURIComponent(bareMarker));

    // Resolve: the host decodes that request back to the real automerge path.
    const resolved = await resolvePackageRequest(requestUrl, mapper);
    expect(resolved).toBe(
      `${encodeURIComponent(`${AM_B}#${HEADS}`)}/dist/index.js`
    );
  });

  it("rewrites a consumer served under a heads-pinned marker", () => {
    const mapper = new PackagesUrlMapper();
    mapper.encodeSegment(`${AM_B}#${HEADS}`, "@chee/patchwork-llm");
    mapper.markPackageHasDeps(mapper.markerNameFor("@patchwork/chat-llm"));

    const source = `const dep = getImportableUrlFromAutomergeUrl("${AM_B}#${HEADS}")`;
    const consumerReq = `${HOST}/registry--@patchwork--chat-llm%23${HEADS}/dist/index.js`;
    const rewritten = rewriteServedSource(source, consumerReq, mapper);
    expect(rewritten).toContain(`registry--@chee--patchwork-llm%23${HEADS}`);
    expect(rewritten).not.toContain(AM_B);
  });

  it("skips the rewrite for a package not recorded as having automerge deps", () => {
    const mapper = new PackagesUrlMapper();
    // A registered dep exists globally, but THIS package (`registry--other`) was
    // never marked as declaring automerge deps → its served source is untouched,
    // with no source scan.
    mapper.encodeSegment(`${AM_B}#${HEADS}`, "@chee/patchwork-llm");
    const source = `const dep = getImportableUrlFromAutomergeUrl("${AM_B}#${HEADS}")`;
    const otherReq = `${HOST}/registry--other/dist/index.js`;
    expect(rewriteServedSource(source, otherReq, mapper)).toBe(source);
  });

  it("leaves an unregistered automerge literal untouched (so the allowlist blocks it)", () => {
    const mapper = new PackagesUrlMapper();
    // The consuming package needs rewriting, but AM_A was never registered as a
    // dependency — so its literal is left raw even during a rewrite.
    mapper.markPackageHasDeps(mapper.markerNameFor("consumer"));
    const source = `const x = "${AM_A}"`;
    const consumerReq = `${HOST}/registry--consumer/dist/index.js`;
    expect(rewriteServedSource(source, consumerReq, mapper)).toBe(source);
    // And such a raw literal, if requested, is blocked by the allowlist (its
    // request is a raw automerge path, neither a marker nor a platform prefix).
    expect(classify(`${HOST}/${encodeURIComponent(AM_A)}/x.js`)).toBe(
      "blocked"
    );
  });
});

describe("classify (allowlist)", () => {
  it("classifies a marker chunk/entry URL as registry", () => {
    expect(classify(`${HOST}/registry--@scope--x/dist/index.js`)).toBe(
      "registry"
    );
    expect(classify(`${HOST}/registry--@scope--x/dist/assets/chunk.js`)).toBe(
      "registry"
    );
  });

  it("classifies the percent-encoded baked-dep marker form as registry", () => {
    // getImportableUrlFromAutomergeUrl encodes the bare marker into one segment
    // (@→%40, #→%2523 after the extra encode); it has no internal slash.
    const bareMarker = `registry--@chee--x%23${HEADS}`;
    const relative = getImportableUrlFromAutomergeUrl(
      bareMarker as AutomergeUrl,
      "dist/index.js"
    );
    const requestUrl = new URL(relative, HOST + "/").href;
    expect(classify(requestUrl)).toBe("registry");
  });

  it("classifies heads-pinned markers as registry", () => {
    expect(
      classify(`${HOST}/registry--@scope--x%23${HEADS}/dist/index.js`)
    ).toBe("registry");
  });

  it("classifies platform prefixes as platform", () => {
    expect(classify(`${HOST}/packages/solid-js.js`)).toBe("platform");
    expect(classify(`${HOST}/assets/chunk-abc.js`)).toBe("platform");
    expect(classify(`${HOST}/packages/@automerge/automerge-repo/slim.js`)).toBe(
      "platform"
    );
  });

  it("classifies non-host-origin (external tool) URLs as registry", () => {
    expect(classify("https://netlify.example/tool/dist/index.js")).toBe(
      "registry"
    );
  });

  it("blocks a raw automerge document ID in a host-origin path", () => {
    expect(
      classify(`${HOST}/${encodeURIComponent(AM_A)}/index.js`)
    ).toBe("blocked");
  });

  it("blocks an unsanctioned host-origin path", () => {
    expect(classify(`${HOST}/secret/thing.js`)).toBe("blocked");
    expect(classify(`${HOST}/`)).toBe("blocked");
  });

  // ── Path traversal (security-critical): classify against the NORMALIZED path ──

  it("blocks literal-`..` traversal out of a platform prefix", () => {
    // new URL normalizes `..` before we inspect: /assets/../automerge:…/x
    // → pathname /automerge:…/x → first segment is the smuggled ID → blocked.
    expect(
      classify(`${HOST}/assets/../${encodeURIComponent(AM_A)}/x.js`)
    ).toBe("blocked");
  });

  it("blocks deep `subdir/../../` traversal out of a platform prefix", () => {
    expect(
      classify(`${HOST}/assets/a/../../${encodeURIComponent(AM_A)}/x.js`)
    ).toBe("blocked");
  });

  it("blocks literal-`..` traversal out of a marker segment", () => {
    expect(
      classify(`${HOST}/registry--@scope--x/../${encodeURIComponent(AM_A)}/x.js`)
    ).toBe("blocked");
  });

  it("blocks an encoded-slash traversal whose decoded segment contains `/`", () => {
    // %2F is not normalized by the URL parser, so the first segment stays
    // `registry--@x%2F..%2Fautomerge:…`; decoding reveals an internal `/`, which
    // a legit single-segment marker never has → blocked.
    const seg = `registry--@x%2F..%2F${encodeURIComponent(AM_A)}`;
    expect(classify(`${HOST}/${seg}/x.js`)).toBe("blocked");
  });
});

describe("PackagesUrlMapper.resolvePackage (one package.json read per package)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // Re-stub the window/document the codec needs (unstub cleared them).
    vi.stubGlobal("window", { location: { origin: HOST } });
    vi.stubGlobal("document", { baseURI: HOST + "/" });
  });

  // Build a fetch stub returning the given package.json body for any request,
  // counting calls so we can assert one-read-per-package.
  function stubFetchReturning(pkgJson: unknown) {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => pkgJson,
    }));
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  it("reads package.json once per package across repeated resolve calls (automerge)", async () => {
    const fetchSpy = stubFetchReturning({
      name: "@scope/tool",
      exports: "./dist/index.js",
    });
    const mapper = new PackagesUrlMapper();

    // Two plugins of one package resolve the same importUrl (as boot does for a
    // multi-plugin package) — the memo must collapse to a single fetch.
    const a = await mapper.resolvePackage(AM_A);
    const b = await mapper.resolvePackage(AM_A);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a?.packageName).toBe("@scope/tool");
    expect(a).toEqual(b);
    expect(a?.hasAutomergeDeps).toBe(false);
  });

  it("registers automerge deps from the same read and reports hasAutomergeDeps", async () => {
    stubFetchReturning({
      name: "@scope/tool",
      exports: "./dist/index.js",
      dependencies: {
        "@chee/patchwork-llm": `${AM_B}#${HEADS}`,
        "solid-js": "^1.9.0",
      },
    });
    const mapper = new PackagesUrlMapper();
    const resolved = await mapper.resolvePackage(AM_A);

    expect(resolved?.hasAutomergeDeps).toBe(true);
    // The automerge dep was registered → its marker round-trips back.
    expect(
      mapper.resolveMarker(
        `registry--@chee--patchwork-llm%23${HEADS}/dist/index.js`
      )
    ).toBe(`${encodeURIComponent(`${AM_B}#${HEADS}`)}/dist/index.js`);
  });

  it("external: reads package.json for name + deps (best-effort)", async () => {
    stubFetchReturning({ name: "my-tool" });
    const mapper = new PackagesUrlMapper();
    const resolved = await mapper.resolvePackage(
      "https://netlify.example/my-tool/dist/index.js"
    );
    expect(resolved?.entryUrl).toBe(
      "https://netlify.example/my-tool/dist/index.js"
    );
    expect(resolved?.packageName).toBe("my-tool");
    expect(resolved?.hasAutomergeDeps).toBe(false);
  });

  it("external directory importUrl: resolves the entry from package.json", async () => {
    // A manifest importUrl can be a package *directory* (`.../tools/threepane/`).
    // resolvePackage must fetch package.json and resolve the entry, so the marker
    // carries the real subpath (`dist/index.js`), not an empty one.
    stubFetchReturning({ name: "threepane", exports: "./dist/index.js" });
    const mapper = new PackagesUrlMapper();
    const resolved = await mapper.resolvePackage(
      "https://netlify.example/tools/threepane/"
    );
    expect(resolved?.hosting).toBe("external");
    if (resolved?.hosting !== "external") throw new Error("unreachable");
    expect(resolved.entryUrl).toBe(
      "https://netlify.example/tools/threepane/dist/index.js"
    );

    // And the produced marker has the right subpath (not the empty-subpath bug).
    const importUrl = mapper.encodeExternal(
      resolved.entryUrl,
      resolved.packageName ?? "fallback-id"
    );
    expect(importUrl).toBe(`${HOST}/registry--threepane/dist/index.js`);
    // Round-trips back to the real external entry.
    expect(await resolvePackageRequest(importUrl, mapper)).toBe(
      "https://netlify.example/tools/threepane/dist/index.js"
    );
  });

  it("external directory importUrl with `main` fallback resolves the entry", async () => {
    stubFetchReturning({ name: "threepane", main: "./dist/index.js" });
    const mapper = new PackagesUrlMapper();
    const resolved = await mapper.resolvePackage(
      "https://netlify.example/tools/threepane/"
    );
    if (resolved?.hosting !== "external") throw new Error("unreachable");
    expect(resolved.entryUrl).toBe(
      "https://netlify.example/tools/threepane/dist/index.js"
    );
  });

  it("absent package.json (automerge) → undefined (registration falls back)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" }))
    );
    const mapper = new PackagesUrlMapper();
    expect(await mapper.resolvePackage(AM_A)).toBeUndefined();
  });

  // Byte-identical importUrl guard: rebuild the registration marker URL exactly as
  // `processRegistryPlugin` does from `resolvePackage`, and assert the produced
  // string — so the resolve+encode split can't drift from the marker format.
  it("automerge: marker importUrl is <origin>/registry--<name>/<subpath>", async () => {
    stubFetchReturning({ name: "@scope/tool", exports: "./dist/index.js" });
    const mapper = new PackagesUrlMapper();
    const resolved = await mapper.resolvePackage(AM_A);
    expect(resolved?.hosting).toBe("automerge");
    if (resolved?.hosting !== "automerge") throw new Error("unreachable");

    const name = resolved.packageName ?? "fallback-id";
    const marker = mapper.encodeSegment(resolved.automergeUrl, name);
    const importUrl = `${HOST}/${marker}/${resolved.subpath}`;
    expect(importUrl).toBe(`${HOST}/registry--@scope--tool/dist/index.js`);
    // And it round-trips: the iframe's request for that marker resolves back to
    // the real automerge path.
    expect(await resolvePackageRequest(importUrl, mapper)).toBe(
      `${encodeURIComponent(AM_A)}/dist/index.js`
    );
  });

  it("external: marker importUrl hides the netlify origin", async () => {
    stubFetchReturning({ name: "my-tool" });
    const mapper = new PackagesUrlMapper();
    const resolved = await mapper.resolvePackage(
      "https://netlify.example/my-tool/dist/index.js"
    );
    expect(resolved?.hosting).toBe("external");
    if (resolved?.hosting !== "external") throw new Error("unreachable");

    const importUrl = mapper.encodeExternal(
      resolved.entryUrl,
      resolved.packageName ?? "fallback-id"
    );
    expect(importUrl).toBe(`${HOST}/registry--my-tool/dist/index.js`);
    expect(importUrl).not.toContain("netlify.example");
  });
});
