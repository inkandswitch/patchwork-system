import { getType } from "@inkandswitch/patchwork-filesystem";
import { getRegistry } from "@inkandswitch/patchwork-plugins";

const cssURL = new URL("./styles.css", import.meta.url);
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = cssURL.href;
document.head.appendChild(link);

const LABEL = "Add to sidebar";

/**
 * Fired (bubbling, composed, cancelable) at the button's own element. A frame
 * that claims it calls preventDefault() and hands its work to
 * `detail.respondWith`. threepane listens for this.
 */
export const ADD_TO_SIDEBAR_EVENT = "patchwork:add-to-sidebar";

/**
 * Put `link` first in the folder. A doc that's already there is lifted to the
 * top, keeping its own name, rather than added twice. (threepane has the same
 * rule in src/account/addToSidebar.ts.)
 */
export function putAtTop(folder, link) {
  if (!folder.docs) folder.docs = [];
  const docs = folder.docs;
  const at = docs.findIndex((existing) => existing.url === link.url);
  if (at === 0) return;
  if (at > 0) {
    const { name, type } = docs[at];
    docs.splice(at, 1);
    docs.unshift({ url: link.url, name, type });
    return;
  }
  docs.unshift({ url: link.url, name: link.name, type: link.type });
}

/**
 * The account handle, wherever this host put it. Most hosts copy it onto
 * `window.accountDocHandle`; some (gaios) only have it on `window.patchwork`.
 */
function accountHandle() {
  return window.accountDocHandle ?? window.patchwork?.account;
}

/**
 * The page's own repo, not the one on the element: titlebar tools can sit
 * inside a draft overlay, whose repo would hand back a draft of the sidebar.
 */
function pageRepo(element) {
  return window.repo ?? window.patchwork?.repo ?? element.repo;
}

/** Resolves with pick(doc) once it's something. */
function when(handle, pick) {
  return new Promise((resolve) => {
    const check = () => {
      const doc = handle.doc();
      const picked = doc && pick(doc);
      if (!picked) return;
      handle.off("change", check);
      resolve(picked);
    };
    handle.on("change", check);
    check();
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export default function renderAddDocToSidebarButton(handle, element) {
  const wrapper = document.createElement("div");
  wrapper.className = "add-doc-to-sidebar";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = LABEL;
  wrapper.appendChild(button);

  // hidden until we know the doc's datatype (a doc link needs one)
  wrapper.style.display = "none";

  let docDatatypeId;
  let title;
  let loadingDatatype;
  let resetTimer;
  let disposed = false;

  // The doc the frame has open. The view's doc-url is the real one; the handle
  // may be a draft overlay presenting it.
  const docUrl = () =>
    element.closest?.("patchwork-view")?.getAttribute("doc-url") ??
    element.getAttribute?.("doc-url") ??
    handle.url;

  function update() {
    const doc = handle.doc();
    if (!doc) return;

    docDatatypeId = getType(doc);
    if (!docDatatypeId) {
      wrapper.style.display = "none";
      return;
    }

    const registry = getRegistry("patchwork:datatype");
    const loaded = registry.get(docDatatypeId);
    if (loaded && "module" in loaded) {
      title = loaded.module.getTitle(doc) || undefined;
    } else if (loadingDatatype !== docDatatypeId) {
      loadingDatatype = docDatatypeId;
      registry.load(docDatatypeId).then(() => {
        if (!disposed) update();
      });
    }

    wrapper.style.display = "";
  }

  function flash(text) {
    clearTimeout(resetTimer);
    button.textContent = text;
    resetTimer = setTimeout(() => {
      button.textContent = LABEL;
      button.disabled = false;
    }, 1500);
  }

  // Ask whatever frame we're in to do it (threepane answers). If nobody
  // claims the event, put it in the account's root folder ourselves.
  function askFrame(link) {
    let work;
    const event = new CustomEvent(ADD_TO_SIDEBAR_EVENT, {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: {
        ...link,
        respondWith(promise) {
          work = promise;
        },
      },
    });
    wrapper.dispatchEvent(event);
    if (!event.defaultPrevented) return undefined;
    return work ?? Promise.resolve();
  }

  async function addItOurselves(link) {
    const account = accountHandle();
    if (!account) throw new Error("no account handle on this page");
    const rootFolderUrl = await withTimeout(
      when(account, (doc) => doc.rootFolderUrl),
      5000,
      "account has no rootFolderUrl"
    );
    const rootFolder = await pageRepo(element).find(rootFolderUrl);
    rootFolder.change((folder) => putAtTop(folder, link));
  }

  async function onAddDocToSidebar() {
    const link = {
      url: docUrl(),
      name: title ?? "Untitled",
      type: docDatatypeId,
    };
    button.disabled = true;
    try {
      await (askFrame(link) ?? addItOurselves(link));
      flash("Added ✓");
    } catch (error) {
      console.error("[add-doc-to-sidebar] couldn't add to sidebar", error);
      flash("Couldn't add");
    }
  }

  button.addEventListener("click", onAddDocToSidebar);
  handle.on("change", update);
  update();

  element.appendChild(wrapper);

  return () => {
    disposed = true;
    clearTimeout(resetTimer);
    handle.off("change", update);
    button.removeEventListener("click", onAddDocToSidebar);
    wrapper.remove();
  };
}
