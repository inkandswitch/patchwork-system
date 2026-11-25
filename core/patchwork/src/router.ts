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
export function docParamToUrl(
  docParam: string | null
): AutomergeUrl | undefined {
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
  const tabTitle = createTitle(repo, siteTitle);
  // The frame the root shows when the hash names none, picked at the first
  // route, so going Back past a `frame=` link puts it back.
  let homeFrameToolId: string | undefined;

  const route = async () => {
    const hash = window.location.hash.slice(1);

    // An older link shape is rewritten in place rather than pushed, so Back
    // steps over it instead of landing on a link that rewrites itself forward
    // again. The rewrite's hashchange routes the result.
    const rewritten = canonicalHash(hash);
    if (rewritten !== undefined) {
      location.replace(`#${rewritten}`);
      return;
    }

    const params = new URLSearchParams(hash);
    const docUrl = docParamToUrl(params.get("doc"));
    const frame = params.get("frame");

    homeFrameToolId ??=
      accountDocHandle.doc().frameToolId ??
      frameToolId ??
      registeredFrameToolId();
    const toolId = frame ?? homeFrameToolId;
    if (!toolId) {
      console.error("patchwork: no frame tool registered, nothing to mount");
      return;
    }
    const frameDocUrl = (frame && docUrl) || accountDocHandle.url;

    // The first call seeds the root view so it can mount; it's routed again
    // once mounted, when the frame can hear which document to open.
    const seeding = !rootElement.hasAttribute("tool-id");
    if (
      rootElement.getAttribute("tool-id") !== toolId ||
      rootElement.getAttribute("doc-url") !== frameDocUrl
    ) {
      rootElement.setAttribute("tool-id", toolId);
      rootElement.setAttribute("doc-url", frameDocUrl);
    }
    if (seeding) return;

    // No document in the hash (Back to the bare site, say), so none is open.
    // The frame clears its own selection on the same hashchange.
    if (!docUrl) {
      tabTitle.clear();
      return;
    }

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
  };

  rootElement.addEventListener("patchwork:open-document", (event) => {
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
      parseAutomergeUrl(prevDoc).documentId !==
        parseAutomergeUrl(url).documentId
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
    void tabTitle.follow(url, type);
  });

  window.addEventListener("hashchange", route);
  void route();

  return { route };
}

/**
 * The `#doc=` form of an older link shape — a big-patchwork
 * `<slug>--<documentId>` link, or a bare `automerge:<documentId>` URL — or
 * undefined when `hash` is neither.
 */
function canonicalHash(hash: string): string | undefined {
  const legacyDocId = BIG_PATCHWORK_HASH_REGEX.exec(hash)?.groups?.docId;
  if (legacyDocId && isValidDocumentId(legacyDocId)) {
    const doc = stringifyAutomergeUrl({
      documentId: legacyDocId as DocumentId,
    });
    return serializeHashParams(new URLSearchParams({ doc }));
  }
  if (isValidAutomergeUrl(hash as AutomergeUrl)) {
    return serializeHashParams(new URLSearchParams({ doc: hash }));
  }
  return undefined;
}

type TitledDoc = { "@patchwork"?: { type?: string } };

/**
 * The tab's title follows the open document: `"<doc title> | <site>"`, kept
 * current as the doc changes (a rename), or just the site's title when no
 * document is open, or the open one has no title (yet). Only the latest
 * navigation writes it: a slow lookup for a document that's no longer open is
 * dropped.
 */
function createTitle(repo: Repo, siteTitle: string) {
  let following: { url: AutomergeUrl; type?: string | null } | undefined;
  let stopFollowing: (() => void) | undefined;
  let navigation = 0;

  const show = (docTitle?: string) => {
    const next = docTitle ? `${docTitle} | ${siteTitle}` : siteTitle;
    if (document.title !== next) document.title = next;
  };

  const leave = () => {
    navigation++;
    stopFollowing?.();
    stopFollowing = undefined;
    following = undefined;
  };

  return {
    clear() {
      leave();
      show();
    },

    async follow(url: AutomergeUrl, type?: string | null) {
      // An open-document both bubbles here and comes back from the hashchange
      // it causes; the second is the same navigation.
      if (following?.url === url && following.type === type) return;
      const previous = following;
      leave();
      following = { url, type };
      const mine = navigation;
      const isCurrent = () => mine === navigation;

      // A tool switch or heads change keeps the title; another document
      // doesn't get to keep the previous one's while it loads.
      if (
        !previous ||
        parseAutomergeUrl(previous.url).documentId !==
          parseAutomergeUrl(url).documentId
      ) {
        show();
      }

      const failed = (error: unknown) => {
        if (!isCurrent()) return;
        // Forget it, so opening it again tries again.
        following = undefined;
        console.error(`patchwork: couldn't title ${url}`, error);
      };

      try {
        const handle = await repo.find<TitledDoc>(url);
        if (!isCurrent()) return;
        const docType = type || handle.doc()?.["@patchwork"]?.type;
        const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
        const title = async () => {
          const datatype = docType ? await registry.load(docType) : undefined;
          if (!isCurrent()) return;
          if (!datatype) {
            show();
            // Its package may still be loading: boot opens the first view
            // before every package is in.
            if (docType && !registry.has(docType)) {
              const off = registry.on("registered", (plugin) => {
                if (plugin.id !== docType) return;
                off();
                if (isCurrent()) title().catch(failed);
              });
              stopFollowing = off;
            }
            return;
          }
          const { getTitle } = datatype.module as DatatypeImplementation;
          const update = () => {
            try {
              show(getTitle(handle.doc()));
            } catch (error) {
              console.error(
                `patchwork: couldn't read the title of ${url}`,
                error
              );
            }
          };
          update();
          handle.on("change", update);
          stopFollowing = () => handle.off("change", update);
        };
        await title();
      } catch (error) {
        failed(error);
      }
    },
  };
}
