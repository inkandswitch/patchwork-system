/**
 * `IsolatedDocumentArea` — the isolation-mode document area, which mounts a `patchwork:component`
 * inside a sandboxed iframe with isolation root code.
 *
 * The host never builds or mounts the document subtree here. It mounts the
 * `patchwork-isolation` component (from the `@patchwork/isolation` module) via
 * `<patchwork-view component="patchwork-isolation">`. The boot spec rides on that element's DOM:
 * `root-component` / `automerge-allowlist` as attributes and `props` as an inert
 * `<script type="application/json">` child.
 * `mountIsolationRoot` is registered as the `threepane-isolation-root` `patchwork:component`
 * in index.tsx and is what the isolation iframe resolves and mounts. A spec change (attribute or
 * child) reboots the iframe.
 */

import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { createMemo } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { ToolSlot } from "../types";
import { render } from "solid-js/web";
import type { DocumentAreaInputs } from "./DocumentAreaRoot";
import { DocumentAreaRoot } from "./DocumentAreaRoot";
import { DEFAULT_SIDEBAR_WIDTH } from "../hooks";
import { ensureFrameStyles } from "../ensureFrameStyles";

export interface IsolatedDocumentAreaProps extends DocumentAreaInputs {
  /** Add to `rootUrls`  */
  contactUrl: AutomergeUrl | undefined;
}

export function IsolatedDocumentArea(props: IsolatedDocumentAreaProps) {
  // rootUrls: the docs the iframe is allowed to sync. The context-tool/tray
  // lanes contribute nothing here — they're always bare `patchwork:component`s
  // (registry-driven, no configured doc), resolved independently inside the
  // iframe's own registry.
  const rootUrls = createMemo<AutomergeUrl[]>(() => {
    const urls = new Set<AutomergeUrl>();
    const selected = props.selectedDocUrl();
    if (selected) urls.add(selected);
    if (props.contactUrl) urls.add(props.contactUrl);
    return [...urls];
  });

  // The props handed to the isolated root, serialized into the inert JSON child.
  // Structured-clone JSON only (no accessors/handles) — the iframe reads it back
  // in `mountIsolationRoot`.
  const propsJson = createMemo(() =>
    JSON.stringify({
      selectedDocUrl: props.selectedDocUrl(),
      selectedToolId: props.selectedToolId(),
      doctitleSlots: props.doctitleSlots(),
      isLeftCollapsed: props.isLeftCollapsed(),
      initialRightWidth: props.initialRightWidth(),
      initialRightCollapsed: props.initialRightCollapsed(),
    })
  );

  return (
    <patchwork-view
      component="patchwork-isolation"
      // The registered patchwork:component the iframe resolves and mounts inside
      // itself (its load() returns `mountIsolationRoot`). Registered in index.tsx.
      root-component="threepane-isolation-root"
      // `attr:` forces Solid to set a DOM *attribute* (not a JS property) for
      // this dynamic value. The isolation component reads it via
      // `getAttribute("automerge-allowlist")` and its MutationObserver watches
      // the attribute, so a property assignment would be invisible to it.
      attr:automerge-allowlist={rootUrls().join(",")}
      // patchwork:worker-channel lets isolated tools use workers, which run out
      // here under patchwork-worker-provider.
      shared-providers="patchwork:contact,patchwork:selected-doc,patchwork:worker-channel"
      // Host tools an isolated tool may open with patchwork:open-tool.
      shared-tools="llm-config-tray"
      style={{ display: "contents" }}
    >
      {/* Opaque props payload. The isolation component observes this
          script's text and streams changes to the iframe with no reboot. */}
      <script type="application/json" data-root-component-data>
        {propsJson()}
      </script>
    </patchwork-view>
  );
}

interface IsolationRootProps {
  selectedDocUrl?: AutomergeUrl;
  selectedToolId?: string;
  doctitleSlots?: ToolSlot[];
  isLeftCollapsed?: boolean;
  initialRightWidth?: number;
  initialRightCollapsed?: boolean;
}

/** Parse the isolation props from the inert JSON `<script>` child. */
function parseProps(script: HTMLScriptElement | null): IsolationRootProps {
  if (!script?.textContent) return {};
  try {
    return JSON.parse(script.textContent) as IsolationRootProps;
  } catch (err) {
    console.error("[threepane-isolation-root] bad props JSON:", err);
    return {};
  }
}

/**
 * Mount fn (`(element) => cleanup`) for the isolated document-area root, run
 * inside the iframe. Reads its props from the inert JSON `<script>` child the
 * iframe bootstrap appended.
 *
 * The isolation boundary pushes prop changes by rewriting that script's text, so we back the
 * props with a Solid store and re-`reconcile` it from a `MutationObserver` on
 * the script. `DocumentAreaRoot` reads reactive accessors, so a same-document
 * prop change (e.g. collapse toggle, tool reorder) updates in place. (A document
 * *change* still reboots the whole iframe — it flows through the structural
 * `automerge-allowlist` attribute, not through props.)
 */
export function mountIsolationRoot(element: HTMLElement): () => void {
  // Inject the threepane stylesheet into THIS realm (the iframe).
  ensureFrameStyles();

  const script = element.querySelector<HTMLScriptElement>(
    'script[type="application/json"]'
  );
  const [p, setP] = createStore<IsolationRootProps>(parseProps(script));

  // Re-read the store whenever the boundary rewrites the script's text.
  // `reconcile` diffs so only the changed fields update — DocumentAreaRoot's
  // subtrees that didn't change are not re-rendered.
  const observer = new MutationObserver(() => {
    setP(reconcile(parseProps(script)));
  });
  if (script) {
    observer.observe(script, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  // Wrap in a `.frame` like the PatchworkFrame host: the threepane stylesheet's
  // rules are authored nested under `.frame {`, so the document-area markup only
  // picks them up inside a `.frame` ancestor. The props <script> sibling is left
  // untouched. `render` mounts alongside it and its disposer tears the tree down.
  // Context-tool/tray content resolves against THIS realm's own registry (the
  // iframe registers the same plugin set as the host — see registry.start in
  // isolation/src/boot/iframe/main.ts) — nothing about those lanes travels
  // through these isolation props at all.
  const dispose = render(
    () => (
      <div class="frame">
        <DocumentAreaRoot
          selectedDocUrl={() => p.selectedDocUrl}
          selectedToolId={() => p.selectedToolId}
          doctitleSlots={() => p.doctitleSlots}
          isLeftCollapsed={() => p.isLeftCollapsed ?? false}
          initialRightWidth={() => p.initialRightWidth ?? DEFAULT_SIDEBAR_WIDTH}
          initialRightCollapsed={() => p.initialRightCollapsed ?? false}
        />
      </div>
    ),
    element
  );

  return () => {
    observer.disconnect();
    dispose();
  };
}
