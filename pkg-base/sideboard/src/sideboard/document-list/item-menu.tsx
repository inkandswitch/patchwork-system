import { Menu, MenuItem, SubMenu } from "../popmenu.tsx";
import { For, Show } from "solid-js";
import {
  parseAutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import {
  useSupportedToolsForType,
  useFilteredDatatypes,
} from "../lib/solid-plugins";
import { dragstack, clearDragstack } from "../dnd/dnd.ts";
import { removeItemsByUrl } from "../dnd/operations.ts";
import { menuTarget, setMenuTarget, type MenuTarget } from "../state.ts";

/**
 * The one context menu shared by every row in a panel. A row opens it by
 * setting `menuTarget` (see item.tsx); the menu is anchored at the pointer
 * position it was opened from and its contents are built for that row.
 */
export function ItemMenu(props: {
  repo: Repo;
  rootFolderHandle: DocHandle<FolderDoc>;
  element: PatchworkViewElement;
}) {
  const target = () => {
    const t = menuTarget();
    return t && props.element.contains(t.element) ? t : null;
  };

  // Close the target this menu was opened for, not target(): by now the row
  // may have been removed (that's what Remove does), so it's no longer inside
  // props.element and target() would say there's nothing to close.
  function close(t: MenuTarget) {
    if (menuTarget() === t) setMenuTarget(null);
    if (t.element.isConnected) t.element.focus({ preventScroll: true });
  }

  return (
    <Show when={target()} keyed>
      {(t) => (
        <Menu
          anchor={{ x: t.x, y: t.y }}
          placement="right-start"
          onClose={() => close(t)}
        >
          <MenuItems
            target={t}
            repo={props.repo}
            rootFolderHandle={props.rootFolderHandle}
          />
        </Menu>
      )}
    </Show>
  );
}

function MenuItems(props: {
  target: MenuTarget;
  repo: Repo;
  rootFolderHandle: DocHandle<FolderDoc>;
}) {
  const t = props.target;
  const tools = useSupportedToolsForType(t.type);
  const datatypes = useFilteredDatatypes((item) => !item.unlisted);
  const multi = () => dragstack.has(t.id) && dragstack.size > 1;
  const patchworkUrl = () =>
    `${location.protocol}//${location.host}/#doc=${parseAutomergeUrl(t.url).documentId}`;

  // Remove from the context menu. When this item is part of a multi-selection
  // (cmd-click or cmd-drag marquee), remove the whole selection — with a
  // confirmation prompt, since removing several at once is easy to fat-finger.
  // A lone item removes without a prompt.
  async function handleRemove() {
    if (!multi()) {
      t.remove();
      return;
    }
    const urls = [...dragstack.values()].map((item) => item.url);
    if (!confirm(`Remove ${urls.length} items from the sidebar?`)) return;
    clearDragstack();
    await removeItemsByUrl(props.repo, props.rootFolderHandle, urls);
  }

  return (
    <>
      <Show when={t.createInside}>
        <SubMenu label="Create">
          <For each={datatypes}>
            {(datatype) => (
              <MenuItem onSelect={() => t.createInside!(datatype)}>
                {datatype.name}
              </MenuItem>
            )}
          </For>
        </SubMenu>
      </Show>
      <Show when={tools.length}>
        <SubMenu label="Open with...">
          <For each={tools}>
            {(tool) => (
              <MenuItem onSelect={() => t.openWith(tool.id)}>
                {tool.name}
              </MenuItem>
            )}
          </For>
        </SubMenu>
      </Show>
      <SubMenu label="Copy">
        <MenuItem onSelect={() => navigator.clipboard.writeText(t.url)}>
          Automerge url
        </MenuItem>
        <MenuItem
          onSelect={() => navigator.clipboard.writeText(patchworkUrl())}
        >
          Patchwork url
        </MenuItem>
        <Show when={tools.length}>
          <SubMenu label="Patchwork url with...">
            <For each={tools}>
              {(tool) => (
                <MenuItem
                  onSelect={() =>
                    navigator.clipboard.writeText(
                      `${patchworkUrl()}&tool=${tool.id}`
                    )
                  }
                >
                  {tool.name}
                </MenuItem>
              )}
            </For>
          </SubMenu>
        </Show>
      </SubMenu>
      <MenuItem onSelect={() => t.startRenaming()}>Rename</MenuItem>
      <MenuItem onSelect={handleRemove}>
        {multi() ? `Remove ${dragstack.size} items` : "Remove"}
      </MenuItem>
    </>
  );
}
