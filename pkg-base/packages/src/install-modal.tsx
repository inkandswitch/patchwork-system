// "Install a package": paste a URL, see what it would add, add it to your list.
// The preview imports the package to read its real plugin list (see
// discover-plugins.ts for which thread that runs on).

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import {
  bareModuleUrl,
  isAutomergeUrl,
  isInstallableUrl,
  moduleKey,
} from "./origin.ts";
import { discoverHttpPlugins, discoverPlugins } from "./discover-plugins.ts";
import {
  packageDisplayName,
  resolvePackageInfo,
  resolvePackageMeta,
  type PkgInfo,
  type PkgMeta,
  type PluginLite,
} from "./pkg-meta.ts";
import { DeclaredPluginRow } from "./bits.tsx";

interface PackagePreview {
  meta: PkgMeta;
  plugins: PluginLite[] | null;
  error?: string;
}

// Preview what a URL would install. Automerge folder-docs go through the host
// worker; http(s) bundles are imported directly (see discoverHttpPlugins) —
// either way we read the module's real exported plugin descriptors, plus the
// package.json for name/version.
async function previewPackage(url: string): Promise<PackagePreview> {
  if (isAutomergeUrl(url)) {
    const bare = bareModuleUrl(url);
    const [pluginsResult, meta] = await Promise.all([
      discoverPlugins(bare).then(
        (plugins) => ({ plugins }) as const,
        (e) =>
          ({
            error: e instanceof Error ? e.message : "Couldn't read the package.",
          }) as const
      ),
      resolvePackageMeta(bare).catch(() => ({}) as PkgMeta),
    ]);
    return {
      meta,
      plugins: "plugins" in pluginsResult ? pluginsResult.plugins : null,
      error: "error" in pluginsResult ? pluginsResult.error : undefined,
    };
  }
  // http(s): import the entry module for real descriptors (mirrors the automerge
  // worker path); read package.json in parallel for name/version and as a
  // declared-plugins fallback when the import returns none or fails.
  const [pluginsResult, info] = await Promise.all([
    discoverHttpPlugins(url).then(
      (plugins) => ({ plugins }) as const,
      (e) =>
        ({
          error: e instanceof Error ? e.message : "Couldn't import the package.",
        }) as const
    ),
    resolvePackageInfo(url).catch(
      () => ({ meta: {}, plugins: null }) as PkgInfo
    ),
  ]);
  const imported = "plugins" in pluginsResult ? pluginsResult.plugins : null;
  const declared = info.plugins;
  return {
    meta: info.meta,
    plugins: imported && imported.length ? imported : declared,
    // Only surface the import failure when there are no declared plugins to
    // show in its place.
    error:
      "error" in pluginsResult && !(declared && declared.length)
        ? pluginsResult.error
        : undefined,
  };
}

export function InstallModal(props: {
  /** What's in the box when it opens (a pasted URL, or ""). */
  initialUrl: string;
  /** Module keys already in the list you're viewing. */
  installedKeys: Set<string>;
  /** Add this URL to the list. The modal closes itself afterwards. */
  onAdd: (url: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [url, setUrl] = createSignal(props.initialUrl);
  const [busy, setBusy] = createSignal(false);
  const [plugins, setPlugins] = createSignal<PluginLite[] | null>(null);
  const [meta, setMeta] = createSignal<PkgMeta | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const target = createMemo(() => url().trim());
  const valid = createMemo(() => isInstallableUrl(target()));
  const alreadyInstalled = createMemo(() => {
    const key = moduleKey(target());
    return !!key && props.installedKeys.has(key);
  });

  const resetPreview = () => {
    setBusy(false);
    setPlugins(null);
    setMeta(null);
    setError(null);
  };

  // Preview the URL (debounced). Best-effort — a preview failure never blocks
  // installing a URL the user trusts.
  let previewToken = 0;
  // Closing unmounts us; bump the token so a preview still in flight can't
  // write into a modal that's gone.
  onCleanup(() => previewToken++);
  createEffect(() => {
    const raw = target();
    resetPreview();
    if (!raw) return;
    if (!valid()) {
      setError("That doesn't look like an automerge: or https:// URL.");
      return;
    }
    const token = ++previewToken;
    setBusy(true);
    const timer = setTimeout(() => {
      void previewPackage(raw).then((res) => {
        if (token !== previewToken) return; // a newer input superseded this
        setBusy(false);
        setMeta(res.meta);
        setPlugins(res.plugins);
        if (res.error) setError(res.error);
      });
    }, 350);
    onCleanup(() => clearTimeout(timer));
  });

  const add = () => {
    if (!valid()) return;
    if (!alreadyInstalled()) props.onAdd(target());
    props.onClose();
  };

  return (
    <div
      class="pw-modal"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="pw-install">
        <header class="pw-install__head">
          <h2 class="pw-install__title">Install a package</h2>
          <button class="pw-install__close" title="Close" onClick={props.onClose}>
            ×
          </button>
        </header>
        <p class="pw-install__blurb">
          Paste an <code>automerge:</code> or <code>https://</code> URL to add
          it to your package list.
        </p>
        <input
          ref={(el) => setTimeout(() => el.focus(), 0)}
          class="pw-install__input"
          type="text"
          spellcheck={false}
          autocomplete="off"
          placeholder="automerge:… or https://…"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid() && !alreadyInstalled()) {
              e.preventDefault();
              add();
            }
          }}
        />

        <Show when={target()}>
          <div class="pw-install__preview">
            <Show when={error()}>
              <div class="pw-install__error">{error()}</div>
            </Show>
            <Show when={busy()}>
              <div class="pw-install__loading">Reading package…</div>
            </Show>
            <Show when={valid() && (meta() || plugins())}>
              <div class="pw-install__card">
                <div class="pw-install__card-head">
                  <h3 class="pw-install__pkg">
                    {meta()?.title ||
                      meta()?.name ||
                      packageDisplayName(
                        bareModuleUrl(target()),
                        meta() ?? undefined
                      )}
                  </h3>
                  <Show when={meta()?.version}>
                    <span class="pw-install__version">v{meta()!.version}</span>
                  </Show>
                </div>
                <Show
                  when={plugins() && plugins()!.length > 0}
                  fallback={
                    <Show when={!busy() && !error()}>
                      <div class="pw-install__none">
                        {plugins()
                          ? "No plugins reported by this package."
                          : "Couldn't read this package's plugin list — you can still install it."}
                      </div>
                    </Show>
                  }
                >
                  <ul class="pw-install__plugins">
                    <For each={plugins()!}>
                      {(p) => <DeclaredPluginRow plugin={p} />}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        <footer class="pw-install__foot">
          <Show when={alreadyInstalled()}>
            <span class="pw-install__already">Already in your package list</span>
          </Show>
          <button class="pw-install__cancel" onClick={props.onClose}>
            Cancel
          </button>
          <button
            class="pw-install__add"
            disabled={!valid() || alreadyInstalled()}
            onClick={add}
          >
            Add to my package list
          </button>
        </footer>
      </div>
    </div>
  );
}
