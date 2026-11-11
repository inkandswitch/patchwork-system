// Built-in `chat:slash` plugins. Each command is a descriptor with autocomplete
// metadata plus behaviour: either a `transform` (rewrites the outgoing message)
// or a `sideEffect` id the host tool maps to a callback (opens a dialog, drives
// the Computer, pins a doc…) and sends no message.
//
// All built-ins are tier:"full" — the minimal `chat` tool (slashCommands:"core")
// gets none; `chitterchatter` (slashCommands:"all") gets them all. A host module
// can contribute more by registering a chat:slash plugin.

export interface SlashTransform {
	text: string
	action?: boolean
	overrideFont?: string
	overrideColor?: string
	marquee?: boolean
}

export interface SlashPlugin {
	type: "chat:slash"
	id: string
	cmd: string
	aliases?: string[]
	usage: string
	desc: string
	tier: "core" | "full"
	transform?: (argText: string) => SlashTransform | null
	// One of: "font-dialog" | "emoticon-dialog" | "computer" | "model" | "pin"
	sideEffect?: string
	// A self-contained side effect owned by the contributing plugin (e.g. `/call`
	// from the `call` bundle). The host calls it with the explicit SlotContext and
	// the argument text; it sends no message. Preferred over `sideEffect` — new
	// commands should carry their own behaviour here rather than growing the host's
	// hardcoded dispatch switch.
	run?: (ctx: any, argText: string) => void | Promise<void>
}

export const slashPlugins: SlashPlugin[] = [
	{
		// tier:"core" so a bare `chat` (empty plugin list) can still bootstrap itself.
		type: "chat:slash", id: "plugin", cmd: "/plugin", aliases: ["/plugins"], tier: "core",
		usage: "/plugin [ls | load <id> | unload <id>]",
		desc: "List, load, or unload chat plugins for this document",
		sideEffect: "plugin",
	},
	{
		type: "chat:slash", id: "computer", cmd: "/computer", tier: "full",
		usage: "/computer [invite|kick|nosey|clear|owner|own|pwn]",
		desc: "Manage the AI assistant: invite, kick, toggle nosey, clear context, see or take over the owner",
		sideEffect: "computer",
	},
	{
		type: "chat:slash", id: "model", cmd: "/model",
		aliases: ["/or", "/openrouter", "/ollama", "/provider", "/models"], tier: "full",
		usage: "/model", desc: "Configure the AI model and provider",
		sideEffect: "model",
	},
]

// Serializable registry descriptions: metadata only + an async `load()` that
// yields the "fancy code" (the `transform` fn). The host clones plugin entries
// (worker → main) but excludes `load`, so any function-valued field MUST live
// behind load() — a top-level `transform` fn throws DataCloneError. The tool
// itself uses the inline `slashPlugins` above (main thread, never cloned).
export const slashPluginDescriptions = slashPlugins.map((p) => {
	const {transform, run, ...meta} = p
	return {...meta, async load() { return {transform, run} }}
})

/** Match input text against the active slash plugins. Returns the matched plugin
 * plus the argument text (everything after the command word), or null. */
export function matchSlashCommand(
	text: string,
	plugins: SlashPlugin[]
): {plugin: SlashPlugin; argText: string} | null {
	if (!text.startsWith("/")) return null
	const lc = text.toLowerCase()
	for (const plugin of plugins) {
		const names = [plugin.cmd, ...(plugin.aliases || [])]
		for (const name of names) {
			const n = name.toLowerCase()
			if (lc === n || lc.startsWith(n + " ")) {
				let argText = text.slice(name.length)
				if (argText.startsWith(" ")) argText = argText.slice(1)
				return {plugin, argText}
			}
		}
	}
	return null
}
