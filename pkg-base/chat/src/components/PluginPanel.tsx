import {For, Show} from "solid-js"
import {useChat} from "../context/ChatContext"
import {pluginCatalog} from "../lib/plugin-catalog"

// The `/plugin` panel — the editable view of `doc.plugins`. Full-tier plugins are
// checkboxes bound to the array (the document is the truth); core-tier plugins are
// shown as locked "always on".
export function PluginPanel(props: {onClose: () => void}) {
	const {handle, doc} = useChat()

	const enabled = (id: string) => {
		const p = (doc() as any)?.plugins
		return Array.isArray(p) && p.includes(id)
	}

	const toggle = (id: string) => {
		handle.change((d: any) => {
			if (!Array.isArray(d.plugins)) d.plugins = []
			const i = d.plugins.indexOf(id)
			if (i >= 0) d.plugins.splice(i, 1)
			else d.plugins.push(id)
		})
	}

	const entries = pluginCatalog()
	const full = entries.filter((e) => e.tier === "full")
	const core = entries.filter((e) => e.tier === "core")

	return (
		<div class="chat-plugin-panel" on:click={(e) => e.stopPropagation()}>
			<div class="chat-plugin-panel-header">
				<span>Plugins</span>
				<button class="chat-plugin-panel-close" on:click={props.onClose}>
					&times;
				</button>
			</div>
			<div class="chat-plugin-panel-body">
				<For each={full}>
					{(e) => (
						<label class="chat-plugin-item">
							<input
								type="checkbox"
								checked={enabled(e.id)}
								on:change={() => toggle(e.id)}
							/>
							<span class="chat-plugin-name">{e.name}</span>
							<span class="chat-plugin-id">{e.id}</span>
						</label>
					)}
				</For>
				<Show when={core.length}>
					<div class="chat-plugin-section">always on</div>
					<For each={core}>
						{(e) => (
							<label class="chat-plugin-item chat-plugin-item-locked">
								<input type="checkbox" checked disabled />
								<span class="chat-plugin-name">{e.name}</span>
								<span class="chat-plugin-id">{e.id}</span>
							</label>
						)}
					</For>
				</Show>
			</div>
		</div>
	)
}
