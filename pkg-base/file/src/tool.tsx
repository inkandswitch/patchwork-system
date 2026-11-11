import {render} from "solid-js/web"
import {FileEditor} from "./components/FileEditor"
import {PatchworkViewElement} from "@inkandswitch/patchwork-elements"
import {DocHandle} from "@automerge/automerge-repo/slim"
import {UnixFileEntry} from "@inkandswitch/patchwork-filesystem"

export function FileTool(
	handle: DocHandle<UnixFileEntry>,
	element: PatchworkViewElement
) {
	const dispose = render(
		() => <FileEditor handle={handle} element={element} />,
		element
	)

	return () => {
		dispose()
	}
}
