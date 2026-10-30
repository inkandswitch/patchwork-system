import {
  isValidAutomergeUrl,
  isValidDocumentId,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type Repo,
} from "@automerge/vanillajs/slim";
import { openDocument } from "@inkandswitch/patchwork-elements";
import { idhash, resolveLivePath } from "@inkandswitch/patchwork-filesystem";
import {
  docParamToUrl,
  parseHashParams,
  serializeHashParams,
} from "./hash-params.js";
import {
  type AccountDoc,
  type DatatypeDescription,
  type DatatypeImplementation,
  type ToolDescription,
  getRegistry,
  packagePathProviders,
} from "@inkandswitch/patchwork-plugins";

// Legacy big-patchwork hash shape: `<slug>--<documentId>[?…]`. The slug can
// contain characters we don't otherwise permit (e.g. `drawing-(branch-1)`), so
// anchor on the `--` before the base58 document id rather than a strict slug
// charset.
const BIG_PATCHWORK_HASH_REGEX =
  /^(?<title>[^=&?/#]*)--(?<docId>[1-9A-HJ-NP-Za-km-z]+)/;

export { docParamToUrl } from "./hash-params.js";

export interface RouterParams {
  rootElement: HTMLElement;
  repo: Repo;
  accountDocHandle: DocHandle<AccountDoc>;
  siteTitle: string;
  frameToolId?: string;
}

export interface Router {
  /** Apply `location.hash` to the view. */
  route(): Promise<void>;
}

function registeredFrameToolId(): string | undefined {
  return getRegistry<ToolDescription>("patchwork:tool")
    .filter((tool) => !!tool.tags?.includes("frame-tool") && !tool.unlisted)
    .at(0)?.id;
}

export function createRouter({
  rootElement,
  repo,
  accountDocHandle,
  siteTitle,
  frameToolId,
}: RouterParams): Router {
  // A path in the hash resolves only under this site's own account.
  const accounts = idhash(accountDocHandle.documentId).then(
    (acctHash) => new Map([[acctHash, accountDocHandle.url]])
  );
  const resolvePathParam = async (path: string) => {
    try {
      // Package code runs here, so paths go through the providers packages register.
      return await resolveLivePath(repo, path, {
        accounts: await accounts,
        providers: packagePathProviders,
      });
    } catch {
      return undefined; // a path that doesn't parse names nothing
    }
  };
  // The document, and the part of it (`automerge:<id>/<path>`), without heads.
  const named = (url: string) => url.split("#")[0];
  /**
   * Take `path=` out of the hash, if it and `doc=` are still the ones that were
   * checked: a check that resolves after a navigation is about the old one.
   */
  const dropPath = (path: string, docUrl: AutomergeUrl, reason: string) => {
    const params = parseHashParams(window.location.hash.slice(1));
    if (params.get("path") !== path) return;
    const doc = docParamToUrl(params.get("doc"));
    if (!doc || named(doc) !== named(docUrl)) return;
    console.warn(`patchwork: dropping path=${path} from the URL: ${reason}`);
    params.delete("path");
    window.location.hash = serializeHashParams(params);
  };
  /**
   * `doc=` says what is open; when `path=` names something else, `doc=` wins.
   * A path that doesn't resolve stays: it may name something not synced yet.
   */
  const checkPath = async (docUrl: AutomergeUrl, path: string) => {
    const handle = await resolvePathParam(path);
    if (!handle) {
      console.warn(`patchwork: path=${path} doesn't resolve here (yet)`);
      return;
    }
    if (named(handle.url) !== named(docUrl)) {
      dropPath(path, docUrl, `it names ${handle.url}, not ${docUrl}`);
    }
  };

  const route = async () => {
    // The first call seeds the root view's tool/doc so it can mount; later
    // calls reconcile the mounted view with the hash.
    if (!rootElement.hasAttribute("tool-id")) {
      const params = parseHashParams(location.hash.slice(1));
      const frame = params.get("frame");
      const toolId =
        frame ??
        accountDocHandle.doc().frameToolId ??
        frameToolId ??
        registeredFrameToolId();
      if (!toolId) {
        console.error("patchwork: no frame tool registered, nothing to mount");
        return;
      }
      rootElement.setAttribute("tool-id", toolId);
      rootElement.setAttribute(
        "doc-url",
        (frame && docParamToUrl(params.get("doc"))) || accountDocHandle.url
      );
      return;
    }

    const hash = window.location.hash.slice(1);

    // Legacy big-patchwork link: normalize to `#doc=automerge:<docId>` and let
    // routing re-run on the resulting hashchange.
    const legacyDocId = BIG_PATCHWORK_HASH_REGEX.exec(hash)?.groups?.docId;
    if (legacyDocId && isValidDocumentId(legacyDocId)) {
      window.location.hash = serializeHashParams(
        new URLSearchParams({
          doc: stringifyAutomergeUrl({ documentId: legacyDocId as DocumentId }),
        })
      );
      return;
    }

    // Bare automerge URL: /#automerge:<documentId>
    if (isValidAutomergeUrl(hash as AutomergeUrl)) {
      window.location.hash = "";
      openDocument(rootElement, hash as AutomergeUrl);
      return;
    }

    const params = parseHashParams(hash);
    const docUrl = docParamToUrl(params.get("doc"));
    const path = params.get("path") ?? undefined;
    const frame = params.get("frame");

    if (frame) {
      const frameDocUrl = docUrl ?? accountDocHandle.url;
      if (
        rootElement.getAttribute("tool-id") !== frame ||
        rootElement.getAttribute("doc-url") !== frameDocUrl
      ) {
        rootElement.setAttribute("tool-id", frame);
        rootElement.setAttribute("doc-url", frameDocUrl);
      }
    }

    const open = (url: AutomergeUrl) =>
      rootElement.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: {
            url,
            toolId: params.get("tool"),
            title: params.get("title"),
            type: params.get("type"),
            path,
          },
        })
      );

    if (docUrl) {
      open(docUrl);
      if (path) void checkPath(docUrl, path);
    } else if (path) {
      // Just a path: open what it names, unless the hash has moved on while
      // it was walked. One that doesn't resolve is left in the address bar,
      // to be fixed or retried.
      await openPath(path, open, true);
    }
  };

  // A path-only hash that didn't resolve may go through a datatype whose
  // package hasn't registered its path provider yet (on a cold boot, say).
  // It's walked again whenever path providers change, until it resolves or
  // the hash moves on.
  let stopRetrying: (() => void) | undefined;
  const pathOnly = (path: string) => {
    const now = parseHashParams(window.location.hash.slice(1));
    return now.get("path") === path && !now.get("doc");
  };
  async function openPath(
    path: string,
    open: (url: AutomergeUrl) => void,
    first: boolean
  ) {
    const handle = await resolvePathParam(path);
    if (!pathOnly(path)) return;
    if (handle) {
      stopRetrying?.();
      open(handle.url);
      return;
    }
    if (!first) return;
    console.warn(`patchwork: path=${path} doesn't resolve here (yet); opening nothing`);
    stopRetrying?.();
    const stop = () => {
      off();
      if (stopRetrying === stop) stopRetrying = undefined;
    };
    // Runs inside whoever registered a plugin, so it mustn't throw at them.
    const off = getRegistry("patchwork:path-provider").on("changed", () => {
      try {
        if (pathOnly(path)) void openPath(path, open, false).catch(stop);
        else stop();
      } catch {
        stop();
      }
    });
    stopRetrying = stop;
    stopRetrying = off;
  }

  rootElement.addEventListener("patchwork:open-document", async (event) => {
    const { url, toolId, type, title, path } = event.detail as {
      url: AutomergeUrl;
      toolId?: string;
      type?: string;
      title?: string;
      path?: string;
    };

    const params = parseHashParams(window.location.hash.slice(1));
    // `doc` is the full automerge URL, so heads live inside it and the separate
    // `heads=` param is gone.
    params.delete("heads");
    // `draft` is doc-scoped (owned by the drafts plugin, opaque here):
    // navigating to a different document invalidates the selection, while
    // same-doc navigation (tool switches, heads changes) keeps it.
    const prevDoc = docParamToUrl(params.get("doc"));
    const sameDoc =
      !!prevDoc &&
      parseAutomergeUrl(prevDoc).documentId === parseAutomergeUrl(url).documentId;
    if (prevDoc && !sameDoc) params.delete("draft");
    // Where the doc was opened from survives a tool switch or heads change on
    // the same doc, as `draft` does.
    // Only on the same part of it, though: another sub-document is elsewhere.
    const samePart = !!prevDoc && named(prevDoc) === named(url);
    const keptPath = !path && samePart ? params.get("path") ?? undefined : path;
    params.set("doc", url);
    for (const [key, value] of [
      ["path", keptPath],
      ["tool", toolId],
      ["title", title],
      ["type", type],
    ] as const) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    window.location.hash = serializeHashParams(params);

    try {
      const docHandle = await repo.find<{ "@patchwork"?: { type?: string } }>(
        url
      );
      const doc = docHandle.doc();
      const docType = type || doc?.["@patchwork"]?.type;
      if (!docType) return;
      const datatype =
        await getRegistry<DatatypeDescription>("patchwork:datatype").load(
          docType
        );
      if (!datatype) return;
      const docTitle = (datatype.module as DatatypeImplementation).getTitle(
        doc
      );
      if (docTitle) document.title = `${docTitle} | ${siteTitle}`;
    } catch (e) {
      console.error("Failed to update document title", e);
    }
  });

  window.addEventListener("hashchange", route);
  void route();

  return { route };
}
