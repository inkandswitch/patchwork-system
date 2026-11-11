import {featureDescriptions} from "./features"
import {syntaxPluginDescriptions} from "./lib/syntax"
import {slashPluginDescriptions} from "./lib/slash-plugins"
import {messageActionDescriptions} from "./lib/message-actions"
import {emojiPackDescriptions} from "./lib/emoji-packs"

export const plugins = [
	{
		// The "Chat" preset: seeds just the computer. Grows via `/plugin load` or by
		// loading the chitter bundle. `chat` is also the legacy datatype id. The
		// "everything" preset is the chitter bundle's `chitter` datatype; the base
		// tool RENDERS `chitterchatter`/`chitter` docs via
		// `supportedDatatypes`, and chitter registers those datatypes' presets.
		type: "patchwork:datatype",
		id: "chat",
		name: "Chat",
		icon: "MessageSquare",
		async load() {
			return (await import("./datatype")).ChatDatatype
		},
	},
	{
		// The single chat tool. Which features are active is driven by the
		// document's `plugins` array, not by the tool. Registered under `chat`;
		// a `chitterchatter` alias below keeps existing pins/toolIds resolving.
		type: "patchwork:tool",
		id: "chat",
		name: "Chat",
		icon: "MessageSquare",
		supportedDatatypes: ["chitterchatter", "chat", "chitter"],
		async load() {
			return (await import("./tool")).ChatTool
		},
	},
	{
		// Host-embeddable component (<patchwork-view component="chat">). Defaults to
		// the minimal feature set; features="full" for everything.
		type: "patchwork:component",
		id: "chat",
		name: "Chat",
		icon: "MessageSquare",
		async load() {
			return (await import("./tool")).ChatComponent
		},
	},
	{
		// Streamlined context-sidebar variant: no sidebar, chats about whatever
		// document is focused (chat stored at focusedDoc['@patchwork'].chitchat),
		// and the computer edits that document via universal Automerge ops.
		type: "patchwork:component",
		id: "watercooler",
		name: "Watercooler",
		icon: "MessageCircle",
		tags: ["context-tool"],
		async load() {
			const {ChatContextComponent} = await import("./context-tool")
			return ChatContextComponent
		},
	},
	// ── Host-registrable feature plugins ────────────────────────────────────────
	// The four extensible seams, registered like newspace's sketchy:* plugins so
	// other modules can contribute inline syntax, slash commands, hover actions and
	// emoji packs. The tool also keeps these as built-in fallbacks (see lib/*),
	// so it works even if the registry is empty.
	//
	// These MUST be serializable: the host reads `plugins` in a worker and clones
	// each entry to the main thread (excluding `load`). `feature`/`parser-extension`
	// entries are pure data (RegExp is cloneable) and spread raw; `slash`,
	// `messageaction` and `emojipack` carry function fields, so they're registered
	// as descriptions with the fancy code behind `async load()`.
	...featureDescriptions,
	...syntaxPluginDescriptions,
	...slashPluginDescriptions,
	...messageActionDescriptions,
	...emojiPackDescriptions,
]
