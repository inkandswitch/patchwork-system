// Build-only ambient declarations. Augments the host globals Patchwork tools
// rely on (set up by the bootloader) so checkJs can resolve them. Not published
// — consumers bring their own DOM lib + Patchwork globals.
import type {Repo, DocHandle} from "@automerge/automerge-repo"

declare global {
	interface Window {
		/** The automerge Repo instance, installed by the Patchwork bootloader. */
		repo: Repo
		/** The current user's account DocHandle. */
		accountDocHandle: DocHandle<any>
		/** Chrome built-in AI entry points (Gemini Nano), when available. */
		ai?: any
		LanguageModel?: any
	}
}

export {}
