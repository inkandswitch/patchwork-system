# Tool Isolation Architecture

> **Vendored from patchwork-next core — not updated for the custom-element →
> component migration.** This doc describes the core `<patchwork-isolation>`
> **custom element** and its imperative `configure(spec)` API. In the
> `@patchwork/isolation` package that surface is replaced by the
> `patchwork-isolation` **`patchwork:component`**, driven by DOM attributes
> (`root-component`, `automerge-allowlist`, `shared-providers`) plus an inert
> props `<script>` child — see the package [`README.md`](./README.md). Also, the
> root's **props** are no longer part of the boot spec: the boundary treats them
> as an opaque string it ferries (never parsing), and prop changes stream into
> the running iframe (`payload-update`) without a reboot, rather than being a
> spec field that reboots. The threat model, boundary design, and security
> guarantees below are unchanged and still apply; only the mount/drive mechanism
> and the props channel differ.

## Threat model

Our chief concern is mischievous or malicious tool authors. We want users to be able to safely run third-party tools in their patchwork.

The attacker is a tool author who publishes a tool that users install. The attacker does not control the Patchwork host application or the sync server. The tool is standard JavaScript — it can do anything JavaScript can do within whatever execution context it's given.

We want to prevent one attack:

1. **Unauthorized data access.** A tool must not access data that wasn't handed to it by the user. This includes all keyhive keys as well as documents belonging to other tools — accessing those could allow a malicious tool to damage the user's environment (for example, by modifying another tool's source code).

**Trust boundary.** The Patchwork host application and its built-in code are trusted. Third-party tool code is untrusted. The `<patchwork-isolation>` element mounts an isolated **root component** inside a sandboxed iframe. The host hands it only a serializable boot spec (data) — never a live DOM subtree — so no tool code is ever inserted into the host DOM and untrusted code runs only inside the iframe, from its first instruction. The iframe resolves the named root against its own registry and mounts it, and the root builds the isolated subtree inside the iframe.

Which parts of the UI end up inside the boundary is a choice of the frame configuration, not a property of the element. In the default frame layout, for example, the document toolbar and main work area run inside the boundary, and only the sidebar and system tray run outside it in the host.

**No server enforcement.** Patchwork is local-first. There is no server mediating tool access to documents. All isolation must happen in the browser, using the browser's own security primitives.

## Out of scope

- Preventing data exfiltration (sending data to external servers).
- Granular capability-based or tool-specific access control. In this architecture, we are aiming for a simple implementation that can handle a small number of critical guarantees with minimal disruption to the existing system.

## Architecture overview

```
 HOST (trusted)                           IFRAME (untrusted, opaque origin)
┌──────────────────────────────────────┐  ┌────────────────────────────────────┐
│                                      │  │                                    │
│  Isolation Element                   │  │  ┌──────────────────────────────┐  │
│  ┌────────────────────────────────┐  │  │  │ <repo-provider>              │  │
│  │ configure(bootSpec) — boots &  │  │  │  │  answers repo:handle-        │  │
│  │ manages the iframe. The spec   │  │  │  │  descriptor subscriptions    │  │
│  │ is DATA ONLY (no live DOM):    │  │  │  │  ┌────────────────────────┐  │  │
│  │ - rootComponentId              │  │  │  │  │ Root <patchwork-view   │  │  │
│  │ - props     (JSON only)        │  │  │  │  │  component=rootId>      │  │  │
│  │ - rootUrls  (allowlist seeds)  │  │  │  │  │  + props via inert     │  │  │
│  └────────────────────────────────┘  │  │  │  │  <script json>         │  │  │
│                                      │  │  │  ├────────────────────────┤  │  │
│  ┌────────────────────────────────┐  │  │  │  │ Root builds subtree:   │  │  │
│  │ Intermediary Repo (ephemeral)  │  │  │  │  │ - local providers      │  │  │
│  │                                │  │  │  │  │ - tool views           │  │  │
│  │ ┌──────────────────────────┐   │  │  │  │  └────────────────────────┘  │  │
│  │ │ Allowlist                │   │  │  │  └──────────────────────────────┘  │
│  │ │ - rootUrls + transitive  │   │  │  │                                    │
│  │ │ - contact URL            │   │  │  │                                    │
│  │ │ - unknown: prompt *      │   │  │  │                                    │
│  │ │ - user-approved          │   │  │  │                                    │
│  │ ├──────────────────────────┤   │  │  │                                    │
│  │ │ Denylist                 │   │  │  │  ┌──────────────────────────────┐  │
│  │ │ - account doc            │   │  │  │  │ In-memory Repo               │  │
│  │ │ - module settings        │   │  │  │  │ (no keyhive, no storage)     │  │
│  │ │ - tool source code       │   │  │  │  └──────────┬───────────────────┘  │
│  │ │ - plugin import URLs     │   │  │  │             │                      │
│  │ │ (takes precedence)       │   │  │  │  ┌──────────┴───────────────────┐  │
│  │ └──────────────────────────┘   │  │  │  │ Module Loader                │  │
│  │                                │  │  │  │ (es-module-shims source hook)│  │
│  │ Signs "signable" commits       │  │  │  │ - all imports via RPC        │  │
│  │ with isolation identity        │  │  │  │ - sees registry-- markers    │  │
│  └───────────────┬────────────────┘  │  │  └──────────────────────────────┘  │
│                  │                   │  │                                    │
│  ┌───────────────┴───────────────┐   │  │  ┌──────────────────────────────┐  │
│  │ Keyhive Isolation Identity    │   │  │  │ Fetch Proxy                  │  │
│  │ - attenuated access           │   │  │  │ - host-origin fetch() → RPC  │  │
│  │ - no account/settings/plugins │   │  │  │ - <link> interception        │  │
│  └───────────────────────────────┘   │  │  └──────────────────────────────┘  │
│                                      │  │                                    │
│  ┌────────────────────────────────┐  │  │  ┌──────────────────────────────┐  │
│  │ Resource Bridge (RPC)          │  │  │  │ Package Registry             │  │
│  │ - fetch-package: marker → real │  │  │  │ - pre-populated (markers)    │  │
│  │   location, return src         │  │  │  │ - lazy-loads implementations │  │
│  │ - fetch-resource: resolve &    │  │  │  │ - push updates from host     │  │
│  │   return host-origin assets    │  │  │  └──────────────────────────────┘  │
│  │ - PackagesUrlMapper (marker ↔  │  │  │                                    │
│  │   location bidirectional)      │  │  │                                    │
│  ├────────────────────────────────┤  │  │                                    │
│  │ Providers Bridge               │  │  │                                    │
│  │ - host-side allowlist:         │  │  │                                    │
│  │   patchwork:contact,           │  │  │                                    │
│  │   patchwork:selected-doc       │  │  │                                    │
│  │ - value filter: checks URLs    │  │  │                                    │
│  │   against repo allowlist       │  │  │                                    │
│  │ - all other types rejected     │  │  │                                    │
│  └────────────────────────────────┘  │  │                                    │
│                                      │  │                                    │
└──────────────────┬───────────────────┘  └──────────────────┬─────────────────┘
                   │                                         │
                   │   ┌─────────────────────────────────┐   │
                   │   │       RPC (MessagePort)         │   │
                   ├───┤  - fetch-package (module src)   ├───┤
                   │   │  - fetch-resource (assets)      │   │
                   │   │  - registry operations          │   │
                   │   │  - navigation/access requests   │   │
                   │   │  - providers-bridge (subscribe) │   │
                   │   ├─────────────────────────────────┤   │
                   │   │  Automerge Sync (MessagePort)   │   │
                   └───┤  - document data flow           ├───┘
                       │  - allowlist/denylist enforced  │
                       │  - "signed or signable" filter  │
                       │  - unsigned in → signed out     │
                       └─────────────────────────────────┘

* unknown: prompt — documents not in the host repo are not auto-allowlisted;
  the user is prompted via window.confirm — see the Allowlist section.
```

> **Not yet implemented (future / Keyhive):** the "Keyhive Isolation Identity" box, the "Signs 'signable' commits with isolation identity" line, and the sync-channel "'signed or signable' filter" / "unsigned in → signed out" notes describe the Keyhive-enabled design. Today the intermediary holds no isolation identity and signs nothing, and edits flow through unsigned. See [Security without Keyhive](#security-without-keyhive).

## Security considerations

**A key security invariant is controlling which automerge URLs or document IDs the isolated context is able to learn about.**

With this design, Keyhive provides three main guarantees. _(These describe the Keyhive-enabled design, which is **not yet implemented** — see [Keyhive integration (future)](#keyhive-integration-future). For the posture as it stands today, see [Security without Keyhive](#security-without-keyhive).)_

- Tools will not be able to exfiltrate document **access**: because access is cryptographically key-gated and no keys cross the boundary, a tool cannot delegate the capability to read a document to anyone else. (It can still exfiltrate document _data_ it was given, and still access/edit allowlisted documents while running in Patchwork.)
- Keyhive protects a small and critical set of documents (account doc, module settings, plugin source code) from ever being accessed by the tool.
- If the isolation identity behaves badly, access can be revoked without the user losing their entire device identity. However, we don't currently have anything in place to trace the source of bad edits to particular tools effectively.

Because we use a shared Keyhive isolation identity for all isolated contexts, the isolation identity has access to all user documents which are outside of the critical protected set. These documents are vulnerable if a user doesn't want particular tools to access them. (The protected set could be expanded and user-specific, but there will likely be cases where a user wants only a subset of their tools to have access.)

Given the transitive allowlist population which we use for the sake of reasonable UX, it should be assumed that once a tool discovers an automerge URL, it will be able to access and modify that document (because it could write it into an allowed document and then get access on a future load). These documents can be best protected by preventing the tool from learning their URLs. (Though as a final fallback, the isolation identity can be revoked.)

Each component described below should be evaluated in terms of whether it leaks document IDs to the iframe or provides a channel through which the iframe could discover them.

### Security without Keyhive

The Keyhive pieces above are **not yet implemented** (see [Keyhive integration (future)](#keyhive-integration-future)). Today the intermediary is a plain repo enforcing the allowlist/denylist in JavaScript, syncing under the user's full device identity, with no encryption in the boundary.

**The in-scope guarantee still holds.** Preventing _unauthorized data access_ depends only on controlling which document IDs the tool can learn — and the mechanisms that do this (the opaque-origin sandbox, the allowlist/denylist gate, the `registry--` marker scheme + the `classify` request allowlist, the providers value filter, the no-auto-allowlist prompt) are all pure browser/JavaScript and need nothing from Keyhive. A tool still cannot reach documents the user didn't give it.

**But protection is weaker, because nothing is encrypted — an ID _is_ access.** Two consequences:

- For documents the user _did_ authorize (out of scope either way): with Keyhive a tool could exfiltrate the data but not _access_ (access is key-gated and non-delegable); without Keyhive it can exfiltrate both, since leaking the URL is enough to grant access.
- There is no cryptographic backstop for the in-scope boundary: any sandbox escape, `access()` bug, or denylist gap that leaks an ID _is_ a grant of access, with no second line of defense, no attenuated identity (a bypass reaches everything the device can read, including the protected set), no revocation, and no signed/attributed edits.

In short, without Keyhive the design is **policy enforcement over which IDs leak, not a cryptographic access guarantee** — adequate against a buggy or moderately adversarial tool, but the depth Keyhive adds (encrypted protected set, attenuated identity, non-delegable access, revocation) is absent.

## Components

### Sandboxed iframe (opaque origin)

The primary isolation boundary. Tool code runs inside an `<iframe sandbox="allow-scripts">` without `allow-same-origin`. This gives the iframe an opaque origin — the browser's same-origin policy prevents it from accessing the host's DOM, cookies, localStorage, IndexedDB, or service workers.

**Why this is needed:** Without origin isolation, a tool could read or modify any data accessible to the host page. The opaque-origin sandbox is the strongest isolation primitive browsers provide and is the foundation all other mechanisms build on.

### Isolation element

A host-side custom element (`<patchwork-isolation>`) that manages the boundary between trusted host code and untrusted tool code: setting up the iframe, establishing communication channels, and enforcing access control. It renders nothing on its own and never inspects its light DOM. The host drives it through one imperative method:

```ts
element.configure(spec: IsolationBootSpec)
```

The spec is **data only** — no live DOM, no functions, no handles:

- `rootComponentId` — the `patchwork:component` id to mount as the isolated root.
- `props` — structured-clone JSON handed to the root (no accessors, callbacks, DOM nodes, or handles).
- `rootUrls` — documents to seed the sync allowlist with, computed from host state.

**Why a boot spec instead of a live subtree.** Custom elements upgrade synchronously the instant they enter a live document, so any tool-bearing element the host constructed would begin executing tool code in the trusted host realm before it could be moved behind the sandbox. Handing the element only data removes that window entirely: nothing tool-bearing is ever inserted into host DOM, the iframe resolves `rootComponentId` against its **own** registry and mounts it there, and the root reads `props` from an inert `<script type="application/json">` child. Tool code runs only inside the iframe, from its first instruction.

`configure()` boots exactly one iframe. Any later call with a different spec fully tears down the running iframe and boots a fresh one from the new spec — no prop diffing, no in-place re-pointing (a byte-identical spec is a no-op). A spec set while the element is disconnected is stored and applied on connect.

**Theme-matched first paint.** The iframe is a separate document that would otherwise paint white until the theming tool boots inside it. To avoid that flash, the host reads its own current appearance (`readHostAppearance`) and bakes it into the iframe's static `srcdoc`, so the iframe's first frame already matches. This read is deliberately **tool-agnostic** — it does not depend on the theming tool's CSS variables, attribute conventions, or palette (the theming tool is swappable, and the platform must not couple to it). It reads only resolved browser values: the host's actual painted background (found by walking up from the isolation element to the first ancestor with a non-transparent computed `backgroundColor`, whatever produced it) and the resolved `color-scheme` (a CSS standard property). The real theme is then applied to the iframe's content as normal when the theming tool boots inside it; because the first paint already matched, there is no visible transition. (The native `window.confirm()` access/navigation prompts are browser chrome and cannot be themed.)

### Intermediary Repo & document allowlist/denylist

An ephemeral host-side Automerge repo (in-memory, no storage) that sits between the host's main repo and the iframe's repo. It enforces which documents can sync to the iframe using two mechanisms:

- **Allowlist** — documents the tool is permitted to access.
- **Denylist** — documents that are never permitted to cross the isolation boundary. The denylist takes precedence over the allowlist.

Access is enforced via `shareConfig.access()` on the intermediary repo's network adapter, which gates every document sync request.

**Why this is needed:** The opaque-origin iframe prevents tools from accessing host-side storage, but tools still receive documents via Automerge sync. Without the allowlist/denylist, a tool could call `repo.find()` with any document URL and receive it. The intermediary repo ensures tools only see documents the user has authorized.

#### Default assumptions: plugin code vs. documents

We consider all _code_ from the patchwork plugin registries to be authorized by default, but access to all plugin _documents_ to be unauthorized. In other words:

- **Code is freely available.** Tool source code is loaded into the iframe via the host-mediated module loader and `registry--` marker scheme (see below). Any plugin registered in the host's registries can be imported. This is necessary for many tools to function — they need to load their own code and the code of plugins they use inside.
- **Documents are restricted by default.** A tool only receives documents that have been explicitly allowlisted. The tool cannot discover or access arbitrary documents just because it knows (or guesses) their URLs.

This asymmetry reflects the threat model: code is published by tool authors and is the same for all users, so exposing it to other tools reveals no user data. Documents contain user data and must be individually authorized.

#### Denylist

The denylist is a shared singleton, populated eagerly at boot and extended dynamically. It blocks sensitive system documents from ever syncing to the iframe, regardless of whether they appear in document content or are requested by the tool. **Population is awaited before the allowlist is seeded or the intermediary repo is created** (`SyncDenylist.whenReady()`), so a protected document can never be allowlisted/synced during the population window. As a further backstop, the intermediary's `access()`/`announce()` fail closed to the iframe while the denylist is not yet ready. Denylisted document categories:

1. **Account document** — the user's account doc (`window.accountDocHandle`).
2. **Module settings documents** — every `ModuleSettingsDoc` URL the user has: those loaded in `window.patchwork.packages` **and** the user's own `moduleSettingsUrl` read directly from the account doc (the bootloader wires the latter into the watcher only lazily, so reading the account doc catches it regardless of timing).
3. **Tool/package source code** — for each module settings doc, all referenced module entries (branches docs, folder docs, and their children) are transitively denylisted.
4. **All plugin import URLs** — as a catch-all, every `importUrl` from every plugin registry is denylisted along with its transitive module entries.

The denylist also watches plugin registries for new registrations (denylisting their source code as it appears) and the account doc for a late-arriving `moduleSettingsUrl` (denylisting the user's settings doc and its tool source when it first appears).

**Dynamic denylist expansion.** Sensitive docs that the eager pass didn't reach (e.g. ones referenced deep in user content) are caught lazily: before a URL is added to the allowlist it goes through `denylistIfSensitive`, the single classifier shared with the boot-time pass. It recognizes a sensitive doc by, cheapest first: (1) already on the denylist — an O(1) lookup that, after the eager pass, catches the account doc, all module-settings docs, and all tool-source folder/branches docs; (2) the account doc by identity; (3) a module-settings doc by membership in the user's settings set; (4) a `branches` or `patchwork:module-settings` doc by `@patchwork.type`. A matched doc is denylisted (with its children) instead of allowlisted. Note that a plain tool-source folder doc has no distinguishing type and is structurally identical to a user-content folder — it is recognized only by provenance (it was reached from a module-settings doc during a denylist walk, so it is already on the denylist via mechanism 1), never by shape, so the user's own content folders are never wrongly blocked.

#### Allowlist

The allowlist is seeded from the boot spec's `rootUrls`. It is expanded through two mechanisms:

1. **Transitive discovery.** Each root document's content is scanned for embedded automerge URLs (recursively walking objects, arrays, and strings). All discovered URLs are added to the allowlist (unless denylisted). This reflects the assumption that if the user opened a document, its referenced children are authorized for the tool rendering it.

2. **User approval.** When the iframe requests a document that is not on the allowlist, the user is prompted via `window.confirm()` and can approve access explicitly. If the document is one the host repo already knows about, the allowlist is first refreshed (re-scanning all root documents for new URLs, e.g. a reference the user just typed) and the prompt is skipped if it now matches. Documents the host has never seen (newly created by the iframe, added by a collaborator, or embedded in the tool) skip that refresh — a root re-scan cannot surface a document the host has never seen — and prompt directly. Unknown documents are **not** auto-allowlisted; this prevents a tool from silently gaining access to any URL it constructs, at the cost of prompting for documents the iframe itself just created. Once the Author ID API is available, documents created by the iframe's own author ID will be auto-allowlisted while other unknown documents continue to prompt. _(See "Waiting on automerge/keyhive teams" below.)_

### Keyhive integration (future)

> **Not yet implemented.** None of this section is wired into the isolation boundary today: the intermediary repo is a plain Automerge `Repo` running with the user's full device identity, and the iframe repo has no keyhive. These are the guarantees the design will gain once Keyhive (and the supporting Automerge APIs) land — see "Waiting on automerge/keyhive teams". For the security posture as it stands today, see [Security without Keyhive](#security-without-keyhive) above.

Keyhive adds cryptographic identity and access control to the system. Three aspects are relevant to isolation:

**1. Isolation identity.** A separate keyhive identity with attenuated access, used at the intermediary repo instead of the user's primary device identity. This identity has access only to user documents — not the account document, module settings, or tool packages. This strengthens guarantees (even a compromised intermediary repo can't access sensitive documents) and protects the user's device keys from exposure.

**2. No keyhive inside the iframe.** The iframe repo does not use keyhive and receives no keys. This is deliberate: we do not want tools or their authors to be able to delegate access to documents, and since we are not protecting against exfiltration, there is no benefit to signing edits inside the iframe.

**3. Unsigned edits signed at the intermediary.** Tools in the iframe make unsigned edits to documents. These edits flow back to the intermediary repo over the sync connection. The bridge is configured to only accept "signed or signable" commits — it signs signable commits with the isolation identity's author ID and drops anything that is mis-attributed. This ensures all changes that enter the main document graph are properly signed, even though the tool never had keys. _(Not yet implemented: today the sync connection is a plain network adapter with no signed-or-signable filter, so tool edits flow through unsigned and are not dropped.)_

**Why this is needed:** Keyhive requires all changes to be signed before they are accepted into the document graph. Without the unsigned→signed bridge, tool edits would be dropped. The isolation identity adds defense-in-depth by limiting what the intermediary repo itself can access.

### Module loader & host-mediated fetch proxy

The iframe's opaque origin prevents it from making same-origin requests to the host — the browser blocks these by default. However, tools need to load JavaScript modules and static resources (CSS, images, etc.) to function. To make this possible, the isolation system introduces two proxy channels that selectively bridge the gap:

1. **Module imports** (`fetch-package` RPC) — every ES module import goes through the `es-module-shims` source hook, which sends the URL to the host. The host resolves `registry--` marker URLs (see below) back to their real location — an automerge path or an external URL — via the `PackagesUrlMapper`, passes platform (import-map) URLs through, and blocks everything else. The source text and resolved URL are returned to the iframe.

2. **Resource fetches** (`fetch-resource` RPC) — the iframe installs a `fetch()` override that intercepts all requests to host-origin URLs and forwards them to the host via RPC. The host resolves the URL and returns the response body and content type. Non-host-origin fetches pass through to the browser's native `fetch`.

Additionally, host-origin `<link>` elements are intercepted **synchronously at insertion time** by patching `Node.prototype.appendChild`/`insertBefore`. A MutationObserver is too late: native `<link>` elements make direct browser requests (which CORS-fail from the opaque origin) the instant the element is inserted — before any async observer callback can run — so the node must be handled before it enters the DOM. Two `rel` types are intercepted (both produced by tool/bundler code such as Vite's `__vitePreload` or the theming tool's `ensureThemeLink`):

- **`rel="stylesheet"`** — a `<style>` element is substituted in the link's place and its content fetched through the proxy; the `<link>` itself never enters the DOM, so no native request is made. The original link → substituted `<style>` is tracked in a `WeakMap` (with patched `removeChild`/`Element.remove`) so a later link removal (e.g. theme deregistration) also removes the `<style>`.
- **`rel="modulepreload"`** — flipped to `rel="modulepreload-shim"`. The browser ignores the unknown rel (no native fetch), while es-module-shims honors it and preloads the chunk through its source hook (and thus the `fetch-package` RPC). The chunk also loads via the dynamic `import()` (which es-module-shims rewrites to `importShim` in shim mode); the shim preload just warms its cache in parallel.

Both substitutions route the actual fetch through the `fetch()` override → `fetch-resource` RPC, so the host-side allowlist still applies — a stylesheet href that isn't a platform asset or a `registry--` marker (e.g. one carrying a raw automerge URL) is blocked like any other request (it will fail to load rather than CORS-error).

**Security consideration:** These proxies re-open a channel that the opaque origin otherwise closes. Bundled non-automerge assets (host-origin JS, CSS, images, etc.) are not sensitive — they are the same for all users and do not contain user data, so serving them freely is fine. However, requests that resolve to automerge document URLs are sensitive: a tool could construct URLs that reach the service worker and load arbitrary automerge documents as source text. The host-side proxy is an **allowlist**: both `fetch-package` and `fetch-resource` classify every incoming request _before_ resolution and serve only two kinds — `platform` (import-map runtime code, under the fixed `/packages/` and `/assets/` path prefixes) and `registry` (tool code behind an opaque `registry--` marker; see below). Everything else — a raw automerge URL, a path-traversal escape, any unsanctioned host-origin path — is blocked. The only automerge-backed fetches that proceed are those the `PackagesUrlMapper` itself produces by translating a known `registry--` marker back to its real location — i.e. packages the isolation boundary registered.

The classifier matches prefixes on the **normalized** URL pathname (`new URL(url).pathname`, which resolves `..`/`.` segments before inspection), so a traversal like `<origin>/assets/../<encoded-automerge-id>/x` — which normalizes to a raw automerge path — is blocked rather than mistaken for a platform asset. The fixed `/packages/` and `/assets/` prefixes are safe because the service worker only treats a request as a document handoff when its whole decoded pathname parses as an absolute URL, which requires the encoded automerge URL to be the **first** path segment; anything under `/packages/`, `/assets/`, or `registry--…` has a non-scheme first segment and can never resolve to a document.

### `registry--` marker URLs

Tool code inside the iframe never sees the real location of plugin source code — neither automerge document IDs nor external (e.g. netlify) URLs. Instead, plugin import URLs are mapped to an opaque `registry--<name>` marker before being sent to the iframe. For example, a plugin's automerge URL like `automerge:3Dz.../dist/index.js` becomes `registry--@patchwork--codemirror-base/dist/index.js`, and a statically-hosted `https://tools.example/codemirror/dist/index.js` becomes `registry--codemirror/dist/index.js`. **The location of tool code never crosses the boundary.**

The `PackagesUrlMapper` maintains a bidirectional mapping between real locations and marker names. When the iframe requests a `registry--` marker URL via the module loader, the host converts it back to the real location — an automerge path (fetched via the service worker) or an external URL (fetched directly) — fetches the source, and returns it.

This serves two purposes:

1. **Prevents location leakage.** Automerge URLs are valid document identifiers — if a tool learned them, it could attempt to request those documents via `repo.find()` on the Automerge sync channel, bypassing the fetch proxy entirely. External URLs would likewise reveal where tool code lives. The marker hides both so that tools cannot learn a package's real location in the first place.
2. **Provides hierarchical URLs.** Marker URLs (`registry--<name>/path`) support relative import resolution, which bare automerge URLs do not.

The marker is a **single path segment** — the literal prefix `registry--` fused to the sanitized package name — not a URL scheme and not a `registry/<name>` two-segment path. Single-segment is required because a baked-dependency URL is percent-encoded by the runtime resolver into one path segment; a marker with no internal `/` survives that encoding as one segment, so both code-split chunk requests and baked-dependency requests present the marker as the first path segment and resolve uniformly. Heads hashes (pinning to specific document versions) are preserved as a URL-encoded suffix on the marker segment (e.g., `registry--@patchwork--folder%23headsHash`).

Resolved module URLs returned to the iframe are prefixed with the host origin (e.g., `https://host/registry--@scope--name/dist/index.js`) so that relative imports in code-split packages resolve correctly.

### Worker channel

Some tools need a Web Worker (e.g. a model-inference worker). Rather than construct one _inside_ the boundary — where the opaque `null` origin blocks cross-origin worker scripts and a same-origin blob worker has none of the iframe's module-loading machinery — the worker runs in the **host realm** and only its stream pair crosses the boundary. This is the same generic transport (`@grjte/patchwork-worker`) a tool uses outside isolation, so the tool's code is identical in and out of the sandbox.

The mechanism is an ordinary provider subscription whose answered value happens to carry transferred streams:

1. A tool inside the iframe calls `connectWorker(kind, request)` (`@grjte/patchwork-worker/connect.js`, the only file it loads). That dispatches a `patchwork:subscribe` for `{type: "patchwork:worker-channel", kind, request}`.
2. The providers bridge relays that subscription across the boundary (see below), where the host-realm **worker provider** (`patchwork-worker-provider`, shipped by the `providers` package and mounted by the frame) answers it. The provider resolves `kind` from the `patchwork:worker` plugin registry, `serveWorkerSpec` constructs **one dedicated worker for that connection** in the host realm, and the provider answers with the `{readable, writable}` stream pair — naming both streams in `accept()`'s transfer list so they are _moved_, not cloned.
3. The bridge transfers the pair back into the iframe (the transferables are re-derived on each hop; `providers-bridge.ts` `transferablesIn` host-side and the iframe half's inline copy). The tool reads/writes frames over the pair exactly as it would host-side.

**Why this preserves the boundary.** The worker runs in the host realm, but the iframe never gets a handle on it — only the two stream endpoints. Everything the worker resolves (its config, and any secrets such as an API key) stays host-side and never enters a frame or crosses into the sandbox; only request/response frames flow over the streams. The worker is created and terminated with the connection (no sharing, no reuse), so an isolated tool cannot reach another tool's worker: each subscription carries its own `MessagePort` and is relayed under its own id, and the tool receives only the streams for the `kind` it connected to.

**Gating.** The gate is the subscription **type** (`patchwork:worker-channel`), not the worker `kind` nested in the selector — opting in via `shared-providers` opts into every registered kind. Scoping comes from the transport instead (one worker, one connection, one id per request), not from a per-kind allowlist.

### Package registry in iframe

At boot, the host pre-populates the iframe's plugin registries with metadata for all available plugins (with import URLs already mapped to `registry--` marker URLs). Plugins are registered as lazy-loading entries — their implementations are only fetched (via the module loader) when actually used. The host watches registries for new registrations and pushes updates to the iframe with mapped URLs.

**Why this is needed:** Tools use plugin registries to discover and load other tools (e.g., to render embedded content). Without pre-population, the iframe would need direct access to the host's registries. Lazy-loading ensures only the plugins a tool actually uses are loaded into the iframe.

### Repo provider in iframe

The iframe registers a `<repo-provider>` custom element and mounts the root `<patchwork-view component=...>` inside it. This mirrors the host bootloader pattern — `<repo-provider>` answers `repo:handle-descriptor` subscriptions with an identity response (no remapping), which is required by `OverlayRepo.find()`. Without it, every `patchwork-view` in legacy mode (with `doc-url`) would hang forever waiting for a descriptor response.

The root is an ordinary `patchwork:component`, so mounting it through `patchwork-view`'s normal component path reuses the existing machinery the in-iframe root needs anyway: lazy module loading from the registry (including plugins that haven't loaded yet, which arrive both in the initial registry and via live RPC pushes), hot-reload on a newer `importUrl`, and the mount/unmount lifecycle events that in-iframe provider-readiness gates rely on.

### Providers bridge

DOM events do not cross iframe boundaries, so provider subscriptions (`patchwork:subscribe` events) from tools inside the iframe cannot reach host-side providers. The providers bridge relays a configurable set of subscription types across the boundary via RPC.

**Two-tier allowlist:**

1. **`ALLOWED_PROVIDERS` (hard allowlist)** — a set of provider types that have been analyzed for security implications and are safe to bridge: `patchwork:contact`, `patchwork:selected-doc`, `patchwork:current-theme`, and `patchwork:worker-channel`. New types require independent security analysis before being added. Any type not in this set is rejected with a console warning.

2. **`shared-providers` attribute (per-instance)** — the isolation `<patchwork-view>` element reads a `shared-providers` attribute (comma-separated list of provider types). The effective bridged set is the intersection of this attribute and `ALLOWED_PROVIDERS`. No providers are bridged by default — the host must opt in.

**Analyzed types:**

- **`patchwork:contact`** — returns the user's contact document URL. Leaks minimal information (the user's own contact doc), and will only be bridged when the host opts in via `shared-providers`. Used by tools such as comments-view and codemirror-base to tag comments with the current user.
- **`patchwork:selected-doc`** — returns the currently selected document URLs. Used by history-view to know which document to show history for. Values are silently filtered to only include URLs already on the document allowlist (no prompting) — the semantic is "which of my allowlisted documents is selected," not "give me access to the selected document."
- **`patchwork:current-theme`** — returns the active theme id (a plain string). Carries no automerge URLs or user identity, so relaying it into the iframe is safe; lets isolated tools (e.g. the titlebar theme tool) mirror the host's active theme.
- **`patchwork:worker-channel`** — opens a worker connection: the host runs the worker and transfers its `{readable, writable}` stream pair in. The worker, and any config or secrets it resolves, never leave the host — only the streams cross. See "Worker channel" above; the gate is the type, and scoping comes from the transport (one worker per connection, per-request ids), not a per-`kind` allowlist.

**All other subscription types are rejected.** Bridging additional providers could leak document URLs or other sensitive information to the isolated context.

**Value filter:** Before relaying values to the iframe, the bridge checks them for automerge URLs. For `patchwork:selected-doc`, non-allowlisted URLs are silently dropped (avoids spurious prompts during navigation when the iframe is about to be torn down and recreated). For other types, unknown URLs trigger a refresh of the allowlist and a user prompt via `window.confirm()` if still unknown.

### Drag-and-drop bridge

Users drag documents out of the sidebar and drop them into an open document (e.g. a markdown file) to embed a reference. When the target document runs inside the isolation boundary, native drag-and-drop can't deliver the drop: the iframe is cross-origin (opaque origin), so when a host-initiated drag moves over it the browser routes the drag events *into the iframe's document* but fires `drop` with an **empty** `DataTransfer` — the custom patchwork drag types are blocked cross-origin (Chromium #251718, FilePond #218). The tool's own drop handler inside the iframe therefore never sees the payload, and the host's listeners on the `<iframe>` element don't fire over the content region either.

The drag-and-drop bridge relays the drop across the boundary, analogous to the navigation and providers bridges — but in the **host → iframe** direction, which changes the security question. Navigation is a tool *asking* the host to open a document it already knows; a drop is the host *disclosing* document URLs into untrusted tool code. Since **a key invariant is controlling which automerge URLs the isolated context can learn**, disclosure here is deliberately scoped.

**Mechanism (host-owned overlay).** While a patchwork document drag is active over the host page, the host raises a transparent overlay element on top of the iframe. Because the overlay is plain host DOM, the host receives `dragover`/`drop` with the full (same-origin) `DataTransfer`. The overlay exists **only** while a drag is in progress (raised on the host document's `dragenter`, torn down on drop or when the drag leaves), so it never interferes with normal pointer input. The host does not depend on the drag source signalling it — any patchwork document drag entering the host document raises the overlay, keeping the platform decoupled from the sidebar.

On drop, the host parses the dragged documents, gates them, and posts only the surviving set into the iframe over the RPC port (`{ type: "drop", formats, x, y }`, with iframe-local coordinates). Inside the iframe, the drop consumer reconstructs a `DataTransfer` and re-dispatches a synthetic `dragover`+`drop` at the drop point via `elementFromPoint`, so the tool's **unmodified** drop handler consumes it. This is tool-agnostic: the bridge forwards the standard patchwork drag MIME convention, not anything specific to one tool.

**Disclosure control (why this is safe):**

- **Only the patchwork document-drag MIME types are read** (`text/x-patchwork-dnd`, `text/x-patchwork-urls`, `text/uri-list`, `text/plain`); arbitrary drag data is never forwarded.
- **Every dragged URL is gated before it crosses**, via the shared `allowlistUrlUnlessSensitive` (the same denylist-then-allowlist step used by the content scan). A URL that resolves to a sensitive document (account doc, module settings, tool source) is **denylisted and withheld** — it never reaches the iframe, even as text. The forwarded payload is *rebuilt from the surviving set*, not passed through, so a withheld URL leaves no residue.
- **Surviving URLs are allowlisted silently, without a prompt.** The drag is the user's own deliberate gesture directed at this specific tool — the same authorization signal as opening a document — so the referenced docs are made syncable and the embed renders without a redundant access prompt.
- **Always a copy, never a move.** The host-side move-vs-link identity check (`isSameDragOriginView`) is reference equality within one realm and cannot span the boundary; a cross-realm drop is inherently cross-view, which is correctly an add-link. Embedding a reference is the right semantic anyway.

**Out of scope (v1):** OS file drops (Finder → an isolated document). Files *can* cross into the iframe, but importing one means creating a new document in the iframe repo and allowlisting it — a separate path from disclosing existing document URLs. The existing in-iframe file-import handler is unaffected for the non-isolated case; a bridged OS-file path is a straightforward follow-up.

### Unsafe modal

System tools (account picker, frame configurator, module settings manager) need full access to the host repo and sensitive documents (account doc, module settings) that are denylisted from the iframe. These tools open in a host-side lightbox modal via the `patchwork-unsafe-modal` component, which intercepts `patchwork:open-unsafe-modal` events bubbling up from descendants.

The modal renders a `<patchwork-view>` in the host DOM (outside the isolation boundary) so the tool has full access to the host repo. The sideboard footer buttons dispatch `patchwork:open-unsafe-modal` instead of `patchwork:open-document` for these system tools.

## Pending work

### TODOs

- [ ] **Security audits.** Run this implementation through security review and adversarial testing.
- [ ] make updates below after Automerge API changes and Keyhive land

### Waiting on automerge/keyhive teams

These are API changes being developed by the automerge and keyhive teams. The isolation architecture depends on them but cannot implement them until they ship.

- **Author ID API.** Configure an author ID on the iframe's Repo so that edits made by tools are correctly attributed. The iframe repo will be configured with the isolation identity's author ID. (Not yet available on main.) Once available, improve the unknown-document handling in `onAccessRequest`:
  - When the intermediary encounters an unknown document whose author matches the iframe's assigned author ID, auto-allowlist it (the iframe created it) instead of prompting.
  - For unknown documents with a different author, keep prompting the user.
  - Today, _all_ unknown documents prompt the user (the blanket auto-allowlist workaround has been removed); this change would restore silent access for the iframe's own creations only.
- **"Signed or signable" bridge config.** Configure the bridge connection (NetworkAdapter or similar) between the intermediary repo and the iframe repo to only accept signed or signable commits from the iframe direction. Signable commits are signed with the isolation identity; mis-attributed commits are dropped. (Not yet available.)

### Tracked separately

These are known issues that will be fixed independently. They are no longer open problems for this isolation design.

- **Don't create tool URL vulnerabilities via `suggestedImportUrl`.** The `@patchwork.suggestedImportUrl` field currently syncs raw automerge URLs, potentially leaking document IDs to tools.
- **Isolate datatypes from main thread.** Tool datatypes (like `import`) currently run on the main thread with full privileges.
- **Isolate metadata loading for plugins.** Plugin metadata loading currently uses `import` on the main thread, which runs tool entry modules in the host context.
