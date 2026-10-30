// How long the service worker gives a tab to say it'll resolve a request before
// asking the next one. A tab that hasn't been handed its Repo yet says it can't
// at once, so this is for one that can't answer at all: a frozen background
// tab, or one from a build before tabs resolved.
//
// Its own module so the node test harness can widen it: there, a fake tab runs
// on the service worker's own event loop, and its "accepted" can wait behind
// its own resolving on a loaded machine.
export const ACCEPT_TIMEOUT_MS = 250;
