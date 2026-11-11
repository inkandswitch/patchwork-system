import {
  createSignal,
  createMemo,
  createEffect,
  onCleanup,
  Show,
} from "solid-js";
import { render } from "solid-js/web";
import {
  useDocument,
  makeDocumentProjection,
  RepoContext,
} from "solid-automerge";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";
import { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem/dist/metadata";
import {
  ContactDoc,
  RegisteredContactDoc,
  TinyPatchworkLayoutDoc,
} from "../types";
import {
  automergeUrlToAccountToken,
  accountTokenToAutomergeUrl,
} from "./tokens";
import {
  AvatarCropper,
  type Crop,
  Button,
  ColorPopup,
  PresenceCursor,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/index";
import { generateColorFromString, getRandomUserColor } from "../user-colors";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": {
        "doc-url"?: string;
        "tool-id"?: string;
        style?: string | JSX.CSSProperties;
      };
    }
  }
}

const ACCOUNT_URL_STORAGE_KEY = "tinyPatchworkAccountUrl";

enum AccountPickerTab {
  LogIn = "logIn",
  SignUp = "signUp",
}

type AccountTokenToLoginStatus = null | "valid" | "malformed" | "not-found" | "loading";

export interface PatchworkToolProps<T> {
  handle: DocHandle<T>;
  element: PatchworkViewElement;
}

export const AccountPicker = (props: PatchworkToolProps<any>) => {
  const currentAccount = makeDocumentProjection<TinyPatchworkLayoutDoc>(
    props.handle
  );
  const [self, selfHandle] = useDocument<ContactDoc>(
    () => currentAccount.contactUrl,
    props.element
  );

  let avatarInputRef: HTMLInputElement | undefined;
  let colorPopupRef: HTMLDivElement | undefined;

  const [signupName, setSignupName] = createSignal("");
  const [activeTab, setActiveTab] = createSignal<string>(
    AccountPickerTab.SignUp
  );
  const [showAccountUrl, setShowAccountUrl] = createSignal(false);
  const [isCopyTooltipOpen, setIsCopyTooltipOpen] = createSignal(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = createSignal(false);
  const [showColorPopup, setShowColorPopup] = createSignal(false);
  const [pendingAvatar, setPendingAvatar] =
    createSignal<{ file: File; url: string }>();

  const [accountTokenToLogin, setAccountTokenToLogin] = createSignal("");
  const accountAutomergeUrlToLogin = createMemo(() =>
    accountTokenToAutomergeUrl(accountTokenToLogin())
  );

  const [accountToLogin, accountToLoginHandle] = useDocument<TinyPatchworkLayoutDoc>(
    accountAutomergeUrlToLogin
  );
  const [contactToLogin, contactToLoginHandle] = useDocument<ContactDoc>(
    () => accountToLogin()?.contactUrl
  );

  const accountTokenToLoginStatus = createMemo<AccountTokenToLoginStatus>(
    () => {
      const token = accountTokenToLogin();
      if (!token || token === "") return null;
      if (!accountAutomergeUrlToLogin()) return "malformed";
      if (!accountToLogin()) {
        return accountToLoginHandle.loading ? "loading" : "not-found";
      }
      if (!contactToLogin()) {
        return contactToLoginHandle.loading ? "loading" : "not-found";
      }
      return "valid";
    }
  );

  const name = () => {
    const s = self();
    return s?.type === "registered" ? s.name : "";
  };

  createEffect(() => {
    if (!showColorPopup()) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (colorPopupRef?.contains(target)) return;
      if (target?.closest(".presence-cursor")) return;
      setShowColorPopup(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowColorPopup(false);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  // Contacts without a chosen color render in neutral gray everywhere
  // (cursors, avatars), so show the same here instead of pretending a
  // palette color is set.
  const presenceColor = () => (self() as any)?.color || "#888";

  const currentAccountToken = createMemo(() => {
    return currentAccount
      ? automergeUrlToAccountToken(props.handle.url, name())
      : null;
  });

  const onNameChange = (newName: string) => {
    const s = self();
    if (!currentAccount || !s || s.type !== "registered") return;
    selfHandle()?.change((contact: ContactDoc) => {
      if (contact.type === "registered") {
        contact.name = newName;
      }
    });
  };

  const onColorChange = (newColor: string) => {
    const s = self();
    if (!currentAccount || !s) return;
    selfHandle()?.change((contact: ContactDoc) => {
      (contact as any).color = newColor;
    });
  };

  const onAvatarChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const avatarFile = !target.files ? undefined : target.files[0];
    target.value = "";
    if (!avatarFile) return;
    setPendingAvatar({ file: avatarFile, url: URL.createObjectURL(avatarFile) });
  };

  const onCancelCrop = () => {
    const pending = pendingAvatar();
    if (pending) URL.revokeObjectURL(pending.url);
    setPendingAvatar(undefined);
  };

  const onCropAvatar = async (crop: Crop) => {
    const pending = pendingAvatar();
    const s = self();
    if (!pending || !currentAccount || !s || s.type !== "registered") return;
    onCancelCrop();

    const compressed = await compressAvatar(pending.file, crop);
    if (!compressed) return;

    const repo = props.element.repo as Repo;
    const imageHandle = await repo.create2<{
      content: Uint8Array;
      mimeType: string;
    }>();
    imageHandle.change((doc) => {
      doc.content = compressed.content;
      doc.mimeType = compressed.mimeType;
      (doc as any).name = pending.file.name;
      (doc as any).extension = "webp";
    });

    selfHandle()?.change((contact: ContactDoc) => {
      if (contact.type === "registered") {
        contact.avatarUrl = imageHandle.url;
      }
    });
  };

  const onSignUp = async () => {
    if (!currentAccount || !signupName()) return;

    let targetContactHandle = selfHandle();
    if (!currentAccount.contactUrl) {
      const repo = props.element.repo as Repo;
      targetContactHandle = await repo.create2<
        ContactDoc & HasPatchworkMetadata
      >({
        ["@patchwork"]: { type: "patchwork:contact" },
        type: "anonymous",
        color: getRandomUserColor(),
      });
      const targetContactUrl = targetContactHandle.url;
      props.handle.change((account: TinyPatchworkLayoutDoc) => {
        account.contactUrl = targetContactUrl;
      });
    }

    if (!targetContactHandle) return;
    targetContactHandle.change((contact: ContactDoc) => {
      contact.type = "registered";
      (contact as RegisteredContactDoc).name = signupName();
      if (!contact.color) {
        contact.color = generateColorFromString(targetContactHandle.url);
      }
    });
  };

  const onLogIn = async () => {
    const url = accountAutomergeUrlToLogin();
    if (!currentAccount || !url) return;
    localStorage.setItem(ACCOUNT_URL_STORAGE_KEY, url);
    window.location.replace("/");
  };

  const onLogout = async () => {
    localStorage.removeItem(ACCOUNT_URL_STORAGE_KEY);
    window.location.replace("/");
  };

  const onToggleShowAccountUrl = () => {
    setShowAccountUrl((prev) => !prev);
  };

  const onCopy = () => {
    const token = currentAccountToken();
    if (!token) return;
    navigator.clipboard.writeText(token);
    setIsCopyTooltipOpen(true);
    setTimeout(() => setIsCopyTooltipOpen(false), 1000);
  };

  const isLoggedIn = () => self()?.type === "registered";
  const canSignUp = () =>
    !isLoggedIn() && activeTab() === AccountPickerTab.SignUp && signupName();
  const canLogIn = () =>
    !isLoggedIn() &&
    activeTab() === AccountPickerTab.LogIn &&
    accountTokenToLogin() &&
    accountToLogin()?.contactUrl &&
    contactToLogin()?.type === "registered";

  return (
    <div class="account-picker">
      <Show when={!currentAccount?.contactUrl || self() !== undefined}>
      <Show when={!isLoggedIn()}>
        <Tabs
          class="auth"
          defaultValue={AccountPickerTab.SignUp}
          onChange={(tab: string) => setActiveTab(tab)}
          value={activeTab()}
        >
          <TabsList class="tabs-list">
            <TabsTrigger value={AccountPickerTab.SignUp} class="tabs-trigger">
              Sign up
            </TabsTrigger>
            <TabsTrigger value={AccountPickerTab.LogIn} class="tabs-trigger">
              Log in
            </TabsTrigger>
          </TabsList>
          <TabsContent value={AccountPickerTab.SignUp} class="tabs-content">
            <form class="field-group" onSubmit={(e) => { e.preventDefault(); if (canSignUp()) onSignUp(); }}>
              <Label for="name">Name</Label>
              <Input
                id="name"
                value={signupName()}
                onInput={(e) => setSignupName(e.currentTarget.value)}
                placeholder="Enter your name"
              />
              <Button type="submit" disabled={!canSignUp()}>
                Sign up
              </Button>
            </form>
          </TabsContent>
          <TabsContent value={AccountPickerTab.LogIn} class="tabs-content">
            <form class="field-group" onSubmit={(e) => { e.preventDefault(); if (canLogIn()) onLogIn(); }}>
              <p class="hint">
                Paste your account token to log in. You can find it in
                account settings on any device where you're signed in.
              </p>
              <Label for="accountUrl">Account token</Label>
              <div class="input-row">
                <Input
                  class={accountTokenToLoginStatus() === "valid" ? "valid" : ""}
                  id="accountUrl"
                  value={accountTokenToLogin()}
                  onInput={(e) =>
                    setAccountTokenToLogin(e.currentTarget.value)
                  }
                  type={showAccountUrl() ? "text" : "password"}
                  autocomplete="current-password"
                />
                <Button variant="ghost" onClick={onToggleShowAccountUrl}>
                  <Show when={showAccountUrl()} fallback={<EyeOffIcon />}>
                    <EyeIcon />
                  </Show>
                </Button>
              </div>
              <div class="error-text">
                <Show when={accountTokenToLoginStatus() === "malformed"}>
                  <div>
                    Not a valid account token, try copy-pasting again.
                  </div>
                </Show>
                <Show when={accountTokenToLoginStatus() === "loading"}>
                  <div class="loading-text">Looking up account...</div>
                </Show>
                <Show when={accountTokenToLoginStatus() === "not-found"}>
                  <div>Account not found</div>
                </Show>
              </div>
              <Button
                type="submit"
                onClick={onLogIn}
                disabled={!canLogIn()}
              >
                {`Log in${
                  contactToLogin()?.type === "registered"
                    ? ` as ${(contactToLogin() as RegisteredContactDoc).name}`
                    : ""
                }`}
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </Show>

      <Show when={isLoggedIn()}>
        <input
          ref={(el) => (avatarInputRef = el)}
          type="file"
          accept="image/*"
          class="sr-only"
          onChange={onAvatarChange}
        />

        <div class="profile-header">
          <div class="identity">
            <Show when={currentAccount?.contactUrl}>
              <button
                type="button"
                class="avatar-button"
                title="Change avatar"
                onClick={() => avatarInputRef?.click()}
                style={{
                  "box-shadow": `0 0 0 2px var(--account-picker-bg), 0 0 0 5px ${presenceColor()}`,
                }}
              >
                <patchwork-view
                  doc-url={currentAccount.contactUrl}
                  tool-id="contact"
                />
              </button>
            </Show>
            <div class="presence-slot">
              <PresenceCursor
                color={presenceColor()}
                name={name() || "You"}
                title="Change presence colour"
                onClick={() => setShowColorPopup((prev) => !prev)}
              />
            </div>
            <Show when={showColorPopup()}>
              <ColorPopup
                ref={(el) => (colorPopupRef = el)}
                value={(self() as any)?.color}
                onChange={onColorChange}
                onClose={() => setShowColorPopup(false)}
              />
            </Show>
          </div>
          <Input
            id="name"
            class="profile-name-input"
            value={name()}
            onInput={(e) => onNameChange(e.currentTarget.value)}
            placeholder="Your name"
          />
        </div>

        <div class="actions">
          <Tooltip open={isCopyTooltipOpen()}>
            <TooltipTrigger
              as="div"
              onClick={onCopy}
              onBlur={() => setIsCopyTooltipOpen(false)}
            >
              <Button variant="outline" type="button">
                <CopyIcon class="icon-inline" />
                Copy account token
              </Button>
            </TooltipTrigger>
            <TooltipContent class="tooltip-content">
              <p>Copied</p>
            </TooltipContent>
          </Tooltip>

          <Button onClick={() => setShowSignOutConfirm(true)} variant="ghost" class="sign-out">
            Sign out
          </Button>
        </div>

        <Show when={pendingAvatar()}>
          {(pending) => (
            <AvatarCropper
              src={pending().url}
              onCancel={onCancelCrop}
              onConfirm={onCropAvatar}
            />
          )}
        </Show>

        <Show when={showSignOutConfirm()}>
          <div class="modal-backdrop" onClick={() => setShowSignOutConfirm(false)} />
          <div class="modal">
            <p class="modal-title">Sign out?</p>
            <p class="hint">
              Make sure you've saved your account token first.
            </p>

            <Label for="signOutAccountUrl">Account token</Label>
            <div class="input-row">
              <Input
                onFocus={(e) => e.currentTarget.select()}
                value={currentAccountToken() || ""}
                id="signOutAccountUrl"
                type={showAccountUrl() ? "text" : "password"}
                readOnly
                autocomplete="off"
              />
              <Button variant="ghost" onClick={onToggleShowAccountUrl} type="button">
                <Show when={showAccountUrl()} fallback={<EyeOffIcon />}>
                  <EyeIcon />
                </Show>
              </Button>
            </div>

            <Tooltip open={isCopyTooltipOpen()}>
              <TooltipTrigger
                as="div"
                onClick={() => { onCopy(); }}
                onBlur={() => setIsCopyTooltipOpen(false)}
              >
                <Button variant="outline" class="wide" type="button">
                  <CopyIcon class="icon-inline" />
                  Copy token
                </Button>
              </TooltipTrigger>
              <TooltipContent class="tooltip-content">
                <p>Copied</p>
              </TooltipContent>
            </Tooltip>

            <div class="modal-actions">
              <Button variant="secondary" onClick={() => setShowSignOutConfirm(false)}>
                Cancel
              </Button>
              <Button onClick={onLogout} class="sign-out-confirm">
                Sign out
              </Button>
            </div>
          </div>
        </Show>
      </Show>
      </Show>
    </div>
  );
};

const AVATAR_MAX_SIZE = 512;

async function compressAvatar(
  file: File,
  crop: Crop
): Promise<{ content: Uint8Array; mimeType: string } | undefined> {
  const bitmap = await createImageBitmap(file);
  const side = Math.round(Math.min(AVATAR_MAX_SIZE, crop.size));

  const canvas = new OffscreenCanvas(side, side);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(
    bitmap,
    crop.x,
    crop.y,
    crop.size,
    crop.size,
    0,
    0,
    side,
    side
  );
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  const buffer = await blob.arrayBuffer();
  return { content: new Uint8Array(buffer), mimeType: "image/webp" };
}

// Inline SVG icon components

function EyeIcon() {
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

function CopyIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class ?? "icon"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

// The tool implementation returned by the plugin's `load()`. Lives here (not in
// the `.ts` entrypoint) because it uses JSX and imports the Solid runtime.
export const AccountPickerTool: ToolImplementation = (handle, element) => {
  const dispose = render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <AccountPicker handle={handle} element={element} />
      </RepoContext.Provider>
    ),
    element
  );
  return () => dispose();
};
