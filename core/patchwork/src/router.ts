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
import {
  type AccountDoc,
  type DatatypeDescription,
  type DatatypeImplementation,
  type ToolDescription,
  getRegistry,
} from "@inkandswitch/patchwork-plugins";

// Legacy big-patchwork hash shape: `<slug>--<documentId>[?…]`. The slug can
// contain characters we don't otherwise permit (e.g. `drawing-(branch-1)`), so
// anchor on the `--` before the base58 document id rather than a strict slug
// charset.
const BIG_PATCHWORK_HASH_REGEX =
  /^(?<title>[^=&?/#]*)--(?<docId>[1-9A-HJ-NP-Za-km-z]+)/;

// The `doc=` and `draft=` values are automerge URLs, kept literal rather than
// percent-encoded so links stay readable.
const RAW_HASH_KEYS = new Set(["doc", "draft"]);
// A stable order means re-serializing the same logical params is
// byte-identical, avoiding spurious `hashchange` round-trips.
const HASH_KEY_ORDER = ["doc", "tool", "type", "title", "frame", "draft"];

function serializeHashParams(params: URLSearchParams): string {
  const keys = [...HASH_KEY_ORDER, ...params.keys()];
  const parts: string[] = [];
  const emitted = new Set<string>();
  for (const key of keys) {
    if (emitted.has(key)) continue;
    const value = params.get(key);
    if (!value) continue;
    emitted.add(key);
    parts.push(
      `${key}=${RAW_HASH_KEYS.has(key) ? value : encodeURIComponent(value)}`
    );
  }
  return parts.join("&");
}

/**
 * Coerce a `doc=` hash param to a full automerge URL. Accepts a full URL
 * (`automerge:<id>[#heads]`) or a bare document id, for older links.
 */
export function docParamToUrl(docParam: string | null): AutomergeUrl | undefined {
  if (!docParam) return undefined;
  if (isValidAutomergeUrl(docParam as AutomergeUrl)) {
    return docParam as AutomergeUrl;
  }
  const documentId = docParam.replace(/^automerge:/, "");
  if (!isValidDocumentId(documentId)) return undefined;
  return stringifyAutomergeUrl({ documentId: documentId as DocumentId });
}

export interface RouterParams {
  rootElement: HTMLElement;
  repo: Repo;
  accountDocHandle: DocHandle<AccountDoc>;
  siteName: string;
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
  siteName,
}: RouterParams): Router {
  const route = async () => {
    // The first call seeds the root view's tool/doc so it can mount; later
    // calls reconcile the mounted view with the hash.
    if (!rootElement.hasAttribute("tool-id")) {
      const params = new URLSearchParams(location.hash.slice(1));
      const frame = params.get("frame");
      const toolId =
        frame ?? accountDocHandle.doc().frameToolId ?? registeredFrameToolId();
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

    const params = new URLSearchParams(hash);
    const docUrl = docParamToUrl(params.get("doc"));
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

    if (docUrl) {
      rootElement.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: {
            url: docUrl,
            toolId: params.get("tool"),
            title: params.get("title"),
            type: params.get("type"),
          },
        })
      );
    }
  };

  rootElement.addEventListener("patchwork:open-document", async (event) => {
    const { url, toolId, type, title } = event.detail as {
      url: AutomergeUrl;
      toolId?: string;
      type?: string;
      title?: string;
    };

    const params = new URLSearchParams(window.location.hash.slice(1));
    // `doc` is the full automerge URL, so heads live inside it and the separate
    // `heads=` param is gone.
    params.delete("heads");
    // `draft` is doc-scoped (owned by the drafts plugin, opaque here):
    // navigating to a different document invalidates the selection, while
    // same-doc navigation (tool switches, heads changes) keeps it.
    const prevDoc = docParamToUrl(params.get("doc"));
    if (
      prevDoc &&
      parseAutomergeUrl(prevDoc).documentId !== parseAutomergeUrl(url).documentId
    ) {
      params.delete("draft");
    }
    params.set("doc", url);
    for (const [key, value] of [
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
      if (docTitle) document.title = `${docTitle} | ${siteName}`;
    } catch (e) {
      console.error("Failed to update document title", e);
    }
  });

  window.addEventListener("hashchange", route);
  void route();

  return { route };
}
