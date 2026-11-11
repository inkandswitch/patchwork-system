import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type { RepoProviderElement } from "@inkandswitch/patchwork-providers";
import {
  getSuggestedImportUrl,
  getType,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import { getFallbackTool, getRegistry } from "@inkandswitch/patchwork-plugins";
import type { Accessor } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  Finding,
  InvalidUrlCard,
  NoToolCard,
  NotSharedCard,
  ToolFailedCard,
  UnavailableCard,
} from "./DocumentCards";
import { canOpen, cardText, onKeyhiveOps, pageHive } from "./keyhiveAccess";

// how often a doc that isn't shared is checked again, besides on keyhive ops
const RECHECK_NOT_SHARED_MS = 5_000;

interface MainDocumentViewProps {
  viewKey: Accessor<string | undefined>;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  toolId: Accessor<string | undefined>;
  // Stable container ref so callers can observe the view's bubbling
  // `patchwork:mounted` / `patchwork:no-tool` events (see useMainDocMounted).
  ref?: (el: HTMLDivElement) => void;
}

/**
 * Renders the main document view with proper keying for remounting
 */
export function MainDocumentView({
  viewKey,
  selectedDocUrl,
  toolId,
  ref,
}: MainDocumentViewProps) {
  let container!: HTMLDivElement;
  // the repo of the nearest `<repo-provider>`, to look at the doc before
  // showing it: undefined until mounted, null when there's none
  const [repo, setRepo] = createSignal<Repo | null>();
  onMount(() => {
    setRepo(
      container.closest<RepoProviderElement>("repo-provider")?.repo ?? null
    );
  });

  return (
    <div
      class="document-view"
      ref={(el) => {
        container = el;
        ref?.(el);
      }}
    >
      <Show when={repo() !== undefined && viewKey()} keyed>
        {(_key) => (
          <Show
            when={repo()}
            // no repo to look with: leave it all to patchwork-view
            fallback={
              <patchwork-view doc-url={selectedDocUrl()!} tool-id={toolId()} />
            }
          >
            {(r) => (
              <DocumentView url={selectedDocUrl()!} toolId={toolId} repo={r()} />
            )}
          </Show>
        )}
      </Show>
      {!selectedDocUrl() && (
        <div class="placeholder">Select a document in the sidebar</div>
      )}
    </div>
  );
}

// what we know about the doc: still looking, couldn't get it, its url isn't
// one, or here it is
type Lookup =
  | { state: "finding" }
  | { state: "unavailable" }
  | { state: "invalid" }
  | { state: "ready"; doc: HasPatchworkMetadata };

/**
 * Finds the doc before handing it to `<patchwork-view>`, so that when it can't
 * be had, or nothing here can open it, we say so in words instead of a `:(`.
 * Everything else (no datatype at all, a tool that throws) is still
 * patchwork-view's to report.
 */
function DocumentView(props: {
  url: AutomergeUrl;
  toolId: Accessor<string | undefined>;
  repo: Repo;
}) {
  const tools = getRegistry("patchwork:tool");
  const [toolsChanged, setToolsChanged] = createSignal(0);
  onCleanup(
    tools.on("changed", () => {
      setToolsChanged((n) => n + 1);
    })
  );

  const [lookup, setLookup] = createSignal<Lookup>({ state: "finding" });
  // a "*" tool the reader asked to open this with anyway
  const [peekWith, setPeekWith] = createSignal<string>();
  // the tool that was asked for. patchwork-view is told only this, so it still
  // picks (and later upgrades) its own fallback when none was
  const asked = () => props.toolId() ?? peekWith();

  // whether the patchwork-view underneath has mounted a tool. it keeps trying
  // with a doc it couldn't get (a keyhive sync can grant access), so when it
  // gets there first, that's as good as us finding it
  const [mounted, setMounted] = createSignal(false);
  // bumped to give patchwork-view a fresh start: when we find a doc it gave up
  // on, it has no handle to look at and won't go looking again by itself
  const [attempt, setAttempt] = createSignal(0);

  let disposed = false;
  onCleanup(() => (disposed = true));

  async function find() {
    try {
      const handle = await props.repo.find<HasPatchworkMetadata>(props.url);
      if (disposed) return;
      const wasUnavailable = lookup().state === "unavailable";
      setLookup({ state: "ready", doc: handle.doc() });
      if (wasUnavailable && !mounted()) setAttempt((n) => n + 1);
    } catch (error) {
      if (disposed) return;
      // a url the repo can't even parse won't turn up however long we wait
      const invalid = isInvalidUrlError(error);
      setLookup({ state: invalid ? "invalid" : "unavailable" });
      if (!invalid) setMisses((n) => n + 1);
    }
  }

  // how many times in a row we've come up empty, which spaces out the asking
  const [misses, setMisses] = createSignal(0);

  // an unavailable doc can still turn up: a peer connects and has it, or the
  // sender finishes syncing. the repo's progress says when, so look again then
  let progress: Progress | undefined;
  let unwatch: (() => void) | undefined;
  function watch() {
    unwatch?.();
    progress = findProgress(props.repo, props.url);
    unwatch = progress?.subscribe((p) => {
      if (p.state === "ready" && lookup().state === "unavailable") void find();
    });
  }
  onCleanup(() => unwatch?.());

  void find();
  watch();

  // asking again: once the repo has settled on "unavailable", `find` answers
  // from that verdict without asking anyone. so first have it ask the sync
  // server afresh (the round starts a macrotask later), then look a moment
  // after. resyncing, rather than deleting the stale handle, matters under a
  // remapping provider: its `delete` goes to the base repo with the url we
  // were given, which there may be another doc's. the card stays up while
  // we ask, rather than flickering away and back
  function askAgain() {
    const repo = props.repo as Repo & {
      resyncSubduction?: (documentId: DocumentId) => void;
    };
    if (typeof repo.resyncSubduction !== "function") return;
    try {
      repo.resyncSubduction(parseAutomergeUrl(props.url).documentId);
    } catch {}
  }
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(retryTimer));
  function retry(after = 1_000) {
    askAgain();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void find(), after);
  }

  // and ask again by ourselves, every so often, for as long as the card is up.
  // nothing else would notice a sender who finishes syncing while we sit here
  // connected: the server doesn't tell us about a doc we already gave up on.
  // 3s, 6s, 12s, then every 30s
  createEffect(() => {
    const n = misses();
    if (n === 0 || lookup().state !== "unavailable" || mounted()) return;
    retry(Math.min(30_000, 3_000 * 2 ** (n - 1)));
    onCleanup(() => clearTimeout(retryTimer));
  });

  const view = createMemo(() => {
    toolsChanged();
    const found = lookup();
    if (found.state !== "ready") return found;
    const doc = found.doc;
    const type = doc ? getType(doc) : undefined;
    // no datatype at all: patchwork-view says what's wrong with it
    if (!type) return { state: "open" as const, toolId: undefined };

    let id = asked();
    let anything: { id: string; name: string } | undefined;
    if (!id) {
      const fallback = safely(() => getFallbackTool(doc));
      // a "*" tool (raw, inspector) will open anything, but it isn't this
      // datatype's tool: offer it rather than open the doc's insides unasked
      if (fallback && opensOnlyAsAnything(fallback.supportedDatatypes, type))
        anything = { id: fallback.id, name: fallback.name };
      else if (fallback) id = fallback.id;
    }
    if (id && tools.get(id)) return { state: "open" as const, toolId: id };
    return {
      state: "no-tool" as const,
      type,
      suggestion: getSuggestedImportUrl(doc),
      anything,
    };
  });

  const state = createMemo(() => view().state);

  // the tool the doc opens with, once it's known
  const openTool = createMemo(() => {
    const v = view();
    return v.state === "open" ? v.toolId : undefined;
  });
  // a tool whose code fails to load leaves patchwork-view on its loading dot
  // for good, so it's loaded here too, and a failure gets a card instead
  const [toolError, setToolError] = createSignal<{
    id: string;
    message: string;
  }>();
  async function loadTool(id: string): Promise<boolean> {
    try {
      await tools.load(id);
      if (openTool() === id) setToolError(undefined);
      return true;
    } catch (error) {
      if (openTool() === id) {
        setToolError({
          id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
  }
  createEffect(() => {
    const id = openTool();
    setToolError(undefined);
    if (id) void loadTool(id);
  });
  // a doc that's here but not shared with this identity: patchwork-view's
  // gate holds the tool back and the pane stays blank, so say so. checked
  // again whenever keyhive takes in ops, so a share that lands clears it
  const hive = pageHive();
  const [shared, setShared] = createSignal<boolean>();
  createEffect(() => {
    if (!hive || state() !== "open") {
      setShared(undefined);
      return;
    }
    const url = props.url;
    let live = true;
    const check = () =>
      void canOpen(hive, url).then((open) => {
        if (live) setShared(open);
      });
    check();
    const off = onKeyhiveOps(hive, check);
    // a doc going public isn't an op this identity's keyhive hears of, so
    // while it says no, look again now and then too
    const poll = setInterval(() => {
      if (shared() === false) check();
    }, RECHECK_NOT_SHARED_MS);
    onCleanup(() => {
      live = false;
      off();
      clearInterval(poll);
    });
  });

  // the registry forgets a failed load, so this asks again; patchwork-view
  // gave up on it, so it gets a fresh start once the tool is here
  async function retryTool() {
    const id = toolError()?.id;
    if (id && (await loadTool(id))) setAttempt((n) => n + 1);
  }
  const noTool = createMemo(() => {
    const v = view();
    return v.state === "no-tool" ? v : undefined;
  });

  return (
    <div
      class="doc-stack"
      ref={(el) => {
        const onMounted = (event: Event) => {
          const detail = (event as CustomEvent<{ url?: string }>).detail;
          if (detail?.url && detail.url !== props.url) return;
          setMounted(true);
          // it got the doc we couldn't: look again, to drop the card
          if (lookup().state === "unavailable") void find();
        };
        el.addEventListener("patchwork:mounted", onMounted);
        onCleanup(() => el.removeEventListener("patchwork:mounted", onMounted));
      }}
    >
      {/* the view stays put from unavailable through to open, so whatever it
          was doing to recover carries on. not keyed on the view memo (a new
          object on every registry change): it follows tool-id by itself */}
      <Show
        when={(state() === "open" && !toolError()) || state() === "unavailable"}
      >
        <Show when={attempt() + 1} keyed>
          {(_attempt) => (
            <patchwork-view doc-url={props.url} tool-id={asked()} />
          )}
        </Show>
      </Show>
      <Show when={state() === "finding"}>
        <Finding />
      </Show>
      <Show when={state() === "open" && shared() === false}>
        <NotSharedCard url={props.url} card={hive && cardText(hive)} />
      </Show>
      <Show when={toolError()}>
        {(failed) => (
          <ToolFailedCard
            url={props.url}
            name={tools.get(failed().id)?.name ?? failed().id}
            error={failed().message}
            onRetry={retryTool}
          />
        )}
      </Show>
      <Show when={state() === "invalid"}>
        <InvalidUrlCard url={props.url} />
      </Show>
      <Show when={state() === "unavailable" && !mounted()}>
        <UnavailableCard url={props.url} repo={props.repo} onRetry={retry} />
      </Show>
      <Show when={noTool()}>
        {(v) => (
          <NoToolCard
            url={props.url}
            type={v().type}
            suggestion={v().suggestion}
            anything={v().anything}
            onPeek={setPeekWith}
            repo={props.repo}
          />
        )}
      </Show>
    </div>
  );
}

// the repo's live progress for a doc, where the repo has one (a remapping
// overlay or an older repo might not)
type Progress = {
  peek(): { state: string };
  subscribe(cb: (p: { state: string }) => void): () => void;
};
function findProgress(repo: Repo, url: AutomergeUrl): Progress | undefined {
  const withProgress = (
    repo as unknown as { findWithProgress?: (url: AutomergeUrl) => Progress }
  ).findWithProgress;
  if (typeof withProgress !== "function") return undefined;
  return safely(() => {
    const p = withProgress.call(repo, url);
    return typeof p?.subscribe === "function" && typeof p?.peek === "function"
      ? p
      : undefined;
  });
}

// the repo says so when it can't parse a url: "Invalid AutomergeUrl: …" from
// interpretAsDocumentId, "Invalid document URL: …" from parseAutomergeUrl.
// we go by what the repo says rather than checking the url ourselves, so a
// form the host's repo accepts is never turned away here
function isInvalidUrlError(error: unknown): boolean {
  const message = (error as Error)?.message ?? String(error);
  return /invalid (automergeurl|document url|documentid|document id)/i.test(message);
}

// whether a tool takes `type` only because it takes "*"
function opensOnlyAsAnything(
  supported: "*" | string[] | undefined,
  type: string
): boolean {
  const list = supported === "*" ? ["*"] : (supported ?? []);
  return list.includes("*") && !list.includes(type);
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
