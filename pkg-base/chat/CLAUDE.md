# Chat Tool

A patchwork chat tool with Discord/IRC-style layout, built with Solid.js + TypeScript.

## Architecture

- **Solid.js + JSX** — full reactive UI with signals, contexts, and fine-grained updates
- **Bundled** — `src/` compiled via Vite to `dist/index.js`
- **Ephemeral messaging** for presence/typing via `handle.broadcast()` / `handle.on("ephemeral-message")`
- **Build:** `pnpm build` then `pushwork sync` after any change

### Plugin registration (`src/index.ts`)

Exports a `plugins` array with one `patchwork:datatype` and one `patchwork:tool`:

```js
export const plugins = [
  { type: "patchwork:datatype", id: "chitterchatter", name: "Chitterchatter", icon: "MessageCircle",
    async load() { return (await import("./datatype")).ChatDatatype } },
  { type: "patchwork:tool", id: "chitterchatter", name: "Chitterchatter", icon: "MessageCircle",
    supportedDatatypes: ["chitterchatter", "chat"], // "chat" = legacy docs created before the rename
    async load() { return (await import("./tool")).ChatTool } },
]
```

### Render contract (`src/tool.tsx`)

`ChatTool(handle, element)` mounts a Solid root and returns `dispose` as cleanup.

### Datatype contract (`src/datatype.ts`)

Implements `init(doc)`, `getTitle(doc)`, `setTitle(doc, title)`.

## Document Schema

```js
{
  title: string,
  messages: [{
    id: string,           // generateId() — random + timestamp
    name: string,         // sender display name
    text: string,
    timestamp: number,
    font?: string,        // from chat profile doc (contact.chatProfileUrl)
    avatarUrl?: string,   // automerge URL to avatar file doc
    replyTo?: string,     // id of message being replied to
    imageUrl?: string,    // automerge URL to pasted image file doc
    imageName?: string,
    voiceUrl?: string,    // automerge URL to recording doc
    voiceDuration?: number,
    gifSelfieUrl?: string, // automerge URL to GIF file doc
    reactions?: { [emoji: string]: string[] }  // emoji -> array of user names
  }],
  docs: DocLink[]  // {url, type, name} — all files (images, voice notes, gifs) referenced by messages
}
```

## Features

### Messages & Layout
- Discord/IRC-style: avatar left, name + timestamp right, message below
- Consecutive messages from same author within 5 min are grouped (continuation rows — no avatar/name repeated)
- Replies always break continuation (show full avatar + name)
- Messages with `font` render in that font family

### Emoji Reactions
- Hover actions bar (top-right) with reply + react buttons
- Full emoji picker overlay with 160+ emojis and search
- Reactions display as badges with count; clicking toggles your reaction
- `+` button on reaction row opens picker to add more

### Custom Emoticons
- Users can add custom emoticons (images resized to 128x128, encoded as WebP)
- Stored in the chat profile doc at `.emoticons` — a `{name: automergeUrl}` map
- File docs are standard patchwork file docs (`@patchwork.type: "file"`, content as Uint8Array)
- Animated GIFs are decoded with `gifuct-js` (from esm.sh), resized frame-by-frame to 128x128, and re-encoded as GIF with transparency via `SimpleGIFEncoder`
- Static images are resized to 128x128 and encoded as WebP
- Emoticon catalog is broadcast via presence so peers see each other's emoticons
- Use `:name:` syntax in messages to insert emoticons inline
- Messages embed the emoticon URLs they reference in a `.emoticons` field for offline rendering
- Adopt button ("+") appears on hover over other users' emoticons in the picker
- Add dialog: name input + file picker, accessible from the emoticon section header

### Presence & Typing
- Broadcasts presence every 10s via ephemeral messages
- Green dot + name in presence bar for active users
- Typing indicator at bottom (above input) when someone is typing
- 30s timeout for presence, 3s timeout for typing indicator

### Image Paste
- Paste images from clipboard into the textarea
- Shows preview bar before sending
- Creates a file doc (`@patchwork.type: "file"`) with image content as Uint8Array
- Stores DocLink in chat's `.docs` array

### Voice Notes
- Mic button to start/stop recording
- Uses `audio/webm;codecs=opus` when supported, falls back to `audio/webm`
- Creates a recording doc (`@patchwork.type: "recording"`) pointing to a separate audio data doc
- Recordings < 0.5s are discarded
- Playback with play/pause button, random waveform visualization, duration display

### Reply System
- Click reply button on any message to set reply context
- Reply bar shows above input with original message preview
- Reply reference renders above the message with original author avatar + name + text snippet
- Clicking reply reference scrolls to and highlights the original message

### GIF Selfie Mode
- Camera toggle button (left of input bar) — shows live camera feed when active
- On send: captures 10 frames over 2 seconds, encodes to GIF89a with LZW compression
- Built-in `SimpleGIFEncoder` class handles quantization + encoding
- GIF replaces avatar for that message (square `border-radius:4px` to distinguish from circular avatars)
- In continuation rows, GIF shows as inline thumbnail aligned with avatar column
- Recording feedback: button dims with spinner, input row shows processing state

### Theme System
- Uses the **Patchwork system theme** — the host sets `[theme]`, `color-scheme`
  and the `--studio-*` design tokens (see `patchwork-base/theming`). There is no
  in-tool theme picker.
- `chat.css` (`.chat-root`) maps the studio tokens onto the names the rest of the
  stylesheet uses: `--studio-fill` / `--studio-fill-offset-N` → `--bg-*`,
  `--studio-line` / `--studio-line-offset-N` → `--text-*`, `--studio-primary` →
  `--accent`, `--studio-link` → `--link`, plus `--studio-font-size` /
  `--studio-family-sans` for the root font. oklch fallbacks keep it legible if
  loaded outside the host.
- `ThemeContext` no longer computes colours — it only derives `isLightBg` from
  the rendered background (luminance of computed `--studio-fill`) so syntax
  highlighting and named-colour resolution pick the right light/dark variant. It
  re-evaluates via a `MutationObserver` on the `[theme]` host + a
  `prefers-color-scheme` listener when the host swaps themes at runtime.

### Avatars & Cat Ears
- Reads `avatarUrl` from contact doc, renders in circle
- Clicking any avatar toggles CSS cat ears (triangle pseudo-elements)
- Cat ears state is per-session (not persisted)

## User Identity

Resolved from `window.accountDocHandle`:
```js
const ad = accountDocHandle.doc()
const contact = await repo.find(ad.contactUrl)
// contact.doc().name             -> display name
// contact.doc().chatProfileUrl   -> automerge URL to chat profile doc
// contact.doc().avatarUrl        -> avatar file doc URL
```

### Chat Profile Doc

Stored at `contact.chatProfileUrl`. Contains per-user chat preferences and read state:
```js
{
  font?: string,          // custom font family for messages
  readPositions: {        // per-chat read tracking
    [chatUrl]: number     // timestamp of last read message
  }
}
```

On first load, if the contact has `.chat.font` but no `.chatProfileUrl`, the tool
migrates by creating the profile doc and deleting the old `.chat` field.

### Notifications & Unread Tracking

- The `<title>` shows `* ChatTitle` when there are unread messages
- When someone is typing: `name is typing… — ChatTitle`
- Both combine: `* name is typing… — ChatTitle`
- A notification sound (`3beep.mp3`) plays when a new message arrives while the window is not focused
- Read position updates when: window is visible AND scroll is at the bottom

## Event Handling (tldraw embedding issue)

The tool uses `e.preventDefault()` + `e.stopPropagation()` on critical button clicks (theme, GIF toggle) to prevent parent tool event handlers from interfering when embedded. This was added because clicks weren't working when the chat was embedded inside tldraw. The CLAUDE.md in the parent repo notes: only `stopPropagation()` on `pointerDown`/`pointerUp`, never on `click` — but this tool had to work around tldraw's event handling. The send button and Enter key handler may still have issues when embedded.

## Icons

All UI icons are inline SVGs (defined in `SVG_ICONS` object) — no emoji used for UI chrome. The emoji list itself (`EMOJI_LIST`) is only used as data for the reaction picker.

## Build & Sync

After any change: `cd` into this directory, run `pnpm build`, then `pushwork sync`.

## Patchwork API patterns

### Globals

```js
window.repo                  // the automerge Repo
window.accountDocHandle      // current user's account DocHandle
```

### automerge-repo (current API)

```js
const handle = await repo.find(url)        // returns Promise<DocHandle>, already ready
const fresh  = await repo.create2(initial) // create a new doc (repo.create is deprecated)
```

Do NOT use the old pattern: `const handle = repo.find(url); await handle.whenReady()`.

### Reading & writing

```js
const doc = handle.doc()             // synchronous snapshot
handle.change(d => { d.foo = 1 })    // ALL writes go through change()
handle.on("change", render)          // fires on local + remote edits
```

### Automerge gotchas

- **No `undefined`** — use `delete d.prop` inside `change()` or set to `null`.
- Always mutate inside `handle.change(d => …)`. Never mutate `handle.doc()` directly.

### Custom DOM events

```js
import { openDocument } from "@inkandswitch/patchwork-elements"
openDocument(element, url, toolId)   // navigate Patchwork to another document
```

### Ephemeral messaging

```js
handle.broadcast({ type: "typing", name })   // to all peers with this doc open
handle.on("ephemeral-message", payload => {
  const msg = payload.message                 // the wrapped payload
})
```

### Files & assets

```js
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem"
// converts automerge URL to a URL usable as <img src> / <audio src>
```

### Importmap (bare imports, no CDN needed)

Available via Patchwork's importmap: `@automerge/automerge`, `@automerge/automerge-repo`,
`@inkandswitch/patchwork-elements`, `@inkandswitch/patchwork-filesystem`,
`@inkandswitch/patchwork-plugins`, `@codemirror/state`, `@codemirror/view`,
`@codemirror/language`, `solid-js` and subpaths.

## Gotchas

- **Never `stopPropagation()` on `click`.** Solid delegates `click` to `document`; stopping it kills `onClick`. Only stop propagation on `pointerdown`/`pointerup`.
- **Always return a cleanup function** from the render function — remove listeners, dispose roots, cancel intervals.
- **Pin id === tool id.** Mismatched ids mean the pin won't resolve to the tool.
- **No shadow DOM.** Tools render into the light DOM. Namespace CSS classes.
