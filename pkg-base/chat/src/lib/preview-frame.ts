// Draft-aware preview iframes for the in-chat toolmaking flow.
//
// When the chat is open on a draft (a copy-on-write branch — see the drafts
// plugin in patchwork-base), tool source edits land in per-draft *clones*, not
// the originals. A normal preview iframe (`/#doc=…&frame=…`) boots a fresh host
// runtime with no draft overlay, so it resolves the originals and shows Main's
// source. To preview drafted source we self-bootstrap the iframe: fetch the
// host page, wrap its `#root` view in the draft overlay provider pointed at the
// active draft, and inject the routing hash. The iframe then forks the tool
// folder + source into the same draft clones the chat is editing.

const OVERLAY_PROVIDER_SELECTOR =
	'patchwork-view[component="patchwork-draft-overlay-provider"]'

/**
 * The automerge URL of the draft the chat is currently scoped to, or "" for
 * Main. Read straight off the overlay provider the frame mounts as an ancestor
 * of the tool — no extra dependency or subscription needed. The provider
 * mirrors its live selection onto `draft-url` (it follows the draft list
 * itself); `url` is the seed
 * attribute for self-bootstrapped frames. Returns "" if the host has no
 * drafts overlay (drafts plugin absent) so callers fall back to the plain
 * preview path.
 */
export function getActiveDraftUrl(element: HTMLElement): string {
	const provider = element.closest(OVERLAY_PROVIDER_SELECTOR)
	if (!provider) return ""
	return (
		provider.getAttribute("draft-url")?.trim() ||
		provider.getAttribute("url")?.trim() ||
		""
	)
}

function docIdFromUrl(url: string): string {
	return url.replace(/^automerge:/, "")
}

/** The plain (Main) preview URL. */
export function buildPreviewSrc(dl: {
	url: string
	name?: string
	type?: string
	pin?: unknown
}): string {
	const params = new URLSearchParams()
	params.set("doc", docIdFromUrl(dl.url))
	if (dl.name) params.set("title", dl.name)
	if (dl.type) params.set("type", dl.type)
	if (typeof dl.pin === "string" && dl.pin) params.set("frame", dl.pin)
	return "/#" + params.toString()
}

/**
 * Build a self-bootstrapping preview document that boots the host runtime with
 * the draft overlay mounted around `#root`. Returns an HTML string for
 * `iframe.srcdoc`. Fetches the live host page so the script/entry and asset
 * URLs are exactly what the site serves (works in both dev and prod).
 */
export async function buildPreviewSrcdoc(
	dl: {url: string; name?: string; type?: string; pin?: unknown},
	draftUrl: string
): Promise<string> {
	const html = await fetch("/", {cache: "no-store"}).then((r) => r.text())
	const parsed = new DOMParser().parseFromString(html, "text/html")
	const root = parsed.getElementById("root")
	if (!root) throw new Error("[Chat] host page has no #root to wrap")

	// A srcdoc document's location is about:srcdoc (origin "null"), which is an
	// invalid base for URL resolution. Pin an explicit <base> at the host origin
	// so relative/service-worker URLs (module loading) resolve correctly.
	const base = parsed.createElement("base")
	base.setAttribute("href", location.origin + "/")
	parsed.head.prepend(base)

	// Wrap the root view in the draft overlay provider so the previewed doc and
	// its tool source resolve to this draft's clones.
	const overlay = parsed.createElement("patchwork-view")
	overlay.setAttribute("component", "patchwork-draft-overlay-provider")
	overlay.setAttribute("url", draftUrl)
	root.replaceWith(overlay)
	overlay.appendChild(root)

	// Before the deferred module entry runs (classic inline scripts execute
	// during parse, ahead of modules), do three things:
	//  1. Share this tab's repo with the preview by setting it on its
	//     window. The bootloader reuses an existing window.repo instead of making
	//     a fresh one, so the preview resolves the same documents we see — incl.
	//     the draft's clones, which live in this tab's repo and a separate
	//     realm-local repo couldn't reach.
	//  2. Install the descriptor-lift shim (DESCRIPTOR_LIFT_SHIM) so the draft
	//     overlay actually gets to remap, instead of being shadowed by the
	//     bootloader's <repo-provider>. See that constant for the full why.
	//  3. Set the routing hash so primeRootElement points #root at our doc+tool.
	const params = new URLSearchParams()
	params.set("doc", docIdFromUrl(dl.url))
	if (dl.name) params.set("title", dl.name)
	if (dl.type) params.set("type", dl.type)
	if (typeof dl.pin === "string" && dl.pin) params.set("frame", dl.pin)
	const bootScript = parsed.createElement("script")
	bootScript.textContent =
		"try{window.repo=parent.repo;}catch(e){}" +
		DESCRIPTOR_LIFT_SHIM +
		"location.hash=" +
		JSON.stringify(params.toString())
	parsed.body.prepend(bootScript)

	return "<!doctype html>\n" + parsed.documentElement.outerHTML
}

// Why this shim exists (and why it's a workaround, not the real fix):
//
// `element.repo` is an OverlayRepo. On `find` it doesn't fork anything itself —
// it dispatches a bubbling `repo:handle-descriptor` subscription and uses the
// *nearest* answering ancestor's `{ url, cloneUrl? }` to decide whether to read
// the original or a draft clone. The draft overlay provider answers with a
// `cloneUrl`; the root `<repo-provider>` is a fallback that answers `{ url }`
// (no clone).
//
// In a normal host the draft overlay is mounted as a *descendant* of the
// repo-provider, so it's nearer and wins. But here the bootloader unconditionally
// re-parents `#root` with its own `<repo-provider>` as the DIRECT parent
// (bootPatchworkSite: insertBefore(repoProvider, rootElement)), which lands it
// INSIDE our overlay wrapper → chain becomes `overlay > repo-provider > #root`.
// repo-provider is now nearer than the overlay, intercepts every descriptor
// request first, and answers "no clone" → the preview resolves originals and
// shows Main's source, never the draft edits.
//
// The clean fix belongs in patchwork-next (the bootloader should sit
// repo-provider ABOVE any pre-existing remapper wrapper) — see
// docs/draft-preview-overlay.md. Until then this shim, injected as a classic
// inline script that runs before the module entry, intercepts the descriptor
// subscription in the CAPTURE phase (which runs top-down, before repo-provider's
// bubble-phase listener), stops it, and "lifts" the same request by re-dispatching
// it FROM the overlay element (which is above repo-provider, so repo-provider is
// out of the bubble path). The overlay's clone answer is forwarded back to the
// original port. A timeout falls back to the original url so `find` never hangs
// if the overlay provider isn't mounted.
const DESCRIPTOR_LIFT_SHIM = `(function(){
  var TYPE = "repo:handle-descriptor";
  var SEL = 'patchwork-view[component="patchwork-draft-overlay-provider"]';
  function answer(port, value){ try{ port.postMessage({type:"change", value:value}); }catch(e){} }
  function lift(ev){
    var sel = ev.detail.selector, origPort = ev.detail.port;
    var overlay = document.querySelector(SEL);
    if(!overlay){ answer(origPort, {url: sel.url}); return; } // no overlay → behave like the fallback
    var mc = new MessageChannel(), done = false;
    function settle(value){ if(done) return; done = true; answer(origPort, value);
      try{ mc.port1.postMessage({type:"unsubscribe"}); }catch(e){} try{ mc.port2.close(); }catch(e){} }
    mc.port2.onmessage = function(m){ if(m.data && m.data.type==="change") settle(m.data.value); };
    mc.port2.start();
    // Re-dispatch FROM the overlay so the event bubbles up past it (repo-provider
    // is a descendant of the overlay, so it's not in this bubble path). __lifted
    // keeps our own capture listener from re-intercepting it.
    overlay.dispatchEvent(new CustomEvent("patchwork:subscribe", {
      detail: {selector: sel, port: mc.port1, __lifted: true}, bubbles: true, composed: true
    }));
    setTimeout(function(){ settle({url: sel.url}); }, 5000); // overlay never answered → fall back
  }
  document.addEventListener("patchwork:subscribe", function(e){
    if(!e.detail || !e.detail.selector || e.detail.selector.type !== TYPE) return;
    if(e.detail.__lifted) return;            // don't intercept our own lifted request
    e.stopImmediatePropagation();            // keep it away from <repo-provider>
    lift(e);
  }, true);                                  // CAPTURE: runs before repo-provider's bubble listener
})();`

/** Reload a preview iframe, handling both `src` and `srcdoc` modes. */
export function reloadPreviewIframe(iframe: HTMLIFrameElement): void {
	try {
		iframe.contentWindow?.location.reload()
		return
	} catch {
		// Cross-origin or detached — fall back to re-assigning the source.
	}
	try {
		if (iframe.srcdoc) iframe.srcdoc = iframe.srcdoc
		else iframe.src = iframe.src
	} catch {}
}
