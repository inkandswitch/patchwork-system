/**
 * A Worker that can load a script from another origin.
 *
 * Browsers won't start a worker from another origin, and tools are often served
 * from somewhere other than the page. So for those we start it from a blob that
 * imports the real script. Relative imports in the worker still work, but
 * `self.location` is the blob's URL.
 *
 * Import it as `Worker`, because vite only bundles a worker when it sees
 * `new Worker(new URL("./x.js", import.meta.url))`:
 *
 *   import {CrossOriginWorker as Worker} from "./cross-origin-worker.js"
 *   new Worker(new URL("./worker.js", import.meta.url), {type: "module"})
 *
 * The fallback base class is so this can be imported in node.
 */
export class CrossOriginWorker extends /** @type {typeof Worker} */ (globalThis.Worker ?? class {}) {
	/**
	 * @param {string | URL} url
	 * @param {WorkerOptions} [options]
	 */
	constructor(url, options) {
		super(sameOrigin(url, options?.type), options)
	}
}

/**
 * @param {string | URL} url
 * @param {WorkerType} [type]
 */
function sameOrigin(url, type) {
	const href = new URL(url, globalThis.document?.baseURI ?? location.href)
	if (href.origin === location.origin) return href
	const src = JSON.stringify(href.href)
	const boot = type === "module" ? `import ${src}` : `importScripts(${src})`
	// Not revoked, since the worker may not have fetched it yet.
	return URL.createObjectURL(new Blob([boot], {type: "text/javascript"}))
}
