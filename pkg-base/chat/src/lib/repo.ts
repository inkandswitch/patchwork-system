import type {Repo} from "@automerge/automerge-repo/slim"

// The repo comes from the tool element (`element.repo`), set once at mount in
// tool.tsx. Leaf helpers that have no access to the element or a context read
// it from here instead of reaching for the global `window.repo`.
let activeRepo: Repo | null = null

export function setRepo(repo: Repo) {
	activeRepo = repo
}

export function getRepo(): Repo {
	if (!activeRepo) throw new Error("[Chat] repo not initialized")
	return activeRepo
}
