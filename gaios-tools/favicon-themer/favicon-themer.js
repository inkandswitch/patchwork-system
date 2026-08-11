// A Patchwork "system-tray" tool that keeps the browser-tab favicon in sync with
// the active theme. It renders no visible UI: mounting the tray surface simply
// imports this module and runs the effect below on the main thread.
//
// The Patchwork mark is four independently-fillable shapes (left bar, circle,
// triangle, right bar). We tint each with a theme accent CSS variable and rebuild
// the favicon as an inline SVG data URI whenever the theme changes.

const SVG_NS = "http://www.w3.org/2000/svg"

// Marks the <link> we manage so we never clobber or restore the wrong one.
const OWN_LINK_ATTR = "data-favicon-themer"

// Which theme accent drives each shape, with a sane fallback if the theme (or the
// theming engine) hasn't defined the variable yet.
const SHAPE_COLORS = [
	{shape: "circle", cssVar: "--studio-primary", fallback: "#35f7ca"},
	{shape: "left", cssVar: "--studio-secondary", fallback: "#33ccf8"},
	{shape: "triangle", cssVar: "--studio-warning", fallback: "#f8c43b"},
	{shape: "right", cssVar: "--studio-danger", fallback: "#ff6a90"},
]

function readCssVar(name, fallback) {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim()
	return value || fallback
}

function currentColors() {
	const colors = {}
	for (const {shape, cssVar, fallback} of SHAPE_COLORS) {
		colors[shape] = readCssVar(cssVar, fallback)
	}
	return colors
}

// Geometry matches the shipped Patchwork favicon.svg; only the fills are dynamic.
function buildFaviconSvg(colors) {
	return (
		`<svg xmlns="${SVG_NS}" viewBox="-89.4528 -89.4528 1669.7856 1669.7856" role="img" aria-label="Patchwork">` +
		`<rect id="left" x="46.78" y="83.81" width="300" height="1400" rx="25" ry="25" transform="rotate(-4 196.78 783.81)" fill="${colors.left}"/>` +
		`<circle id="circle" cx="724.52" cy="446.17" r="300" fill="${colors.circle}"/>` +
		`<path id="triangle" d="M446.15,1340.55l117.95-501.74c3.16-13.44,16.62-21.78,30.06-18.62l501.74,117.95c21.68,5.1,26.38,33.86,7.44,45.59l-619.69,383.79c-18.94,11.73-42.6-5.29-37.5-26.98Z" fill="${colors.triangle}"/>` +
		`<rect id="right" x="1144.1" y="7.08" width="300" height="1400" rx="25" ry="25" transform="rotate(-4 1294.1 707.08)" fill="${colors.right}"/>` +
		`</svg>`
	)
}

// Hide any existing icon <link>s so ours wins, remembering them for restore.
function stashExistingIcons() {
	const stashed = []
	for (const link of document.querySelectorAll('link[rel~="icon"]')) {
		if (link.hasAttribute(OWN_LINK_ATTR)) continue
		stashed.push({node: link, parent: link.parentNode, next: link.nextSibling})
		link.remove()
	}
	return stashed
}

function ownLink() {
	let link = document.head.querySelector(`link[${OWN_LINK_ATTR}]`)
	if (!link) {
		link = document.createElement("link")
		link.setAttribute(OWN_LINK_ATTR, "")
		link.rel = "icon"
		link.type = "image/svg+xml"
		document.head.appendChild(link)
	}
	return link
}

function paintFavicon() {
	const svg = buildFaviconSvg(currentColors())
	ownLink().href = "data:image/svg+xml," + encodeURIComponent(svg)
}

// Render contract for a `patchwork:component`: `(element, repo) => cleanup`.
function render(element) {
	// Tray surface with no visible chrome — collapse to zero and stay out of the
	// way while our effect (the favicon) runs.
	if (element && element.style) {
		element.style.width = "0"
		element.style.height = "0"
		element.style.overflow = "hidden"
		element.style.flex = "0 0 0"
		element.style.pointerEvents = "none"
	}

	const stashed = stashExistingIcons()
	paintFavicon()

	// The theme engine flips <html theme="…"> (and may touch class/style) when the
	// active theme changes; the OS light/dark preference can also change.
	const observer = new MutationObserver(paintFavicon)
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["theme", "class", "style"],
	})

	const media = window.matchMedia("(prefers-color-scheme: dark)")
	media.addEventListener("change", paintFavicon)

	// Theme CSS is injected asynchronously at boot, so repaint shortly after mount
	// to pick up the real palette instead of the base defaults.
	const settleTimer = setTimeout(paintFavicon, 600)

	return () => {
		clearTimeout(settleTimer)
		observer.disconnect()
		media.removeEventListener("change", paintFavicon)
		const link = document.head.querySelector(`link[${OWN_LINK_ATTR}]`)
		if (link) link.remove()
		for (const {node, parent, next} of stashed) {
			if (parent) parent.insertBefore(node, next)
		}
	}
}

export const plugins = [
	{
		type: "patchwork:component",
		id: "favicon-themer",
		name: "Favicon Themer",
		icon: "Palette",
		tags: ["system-tray"],
		async load() {
			return render
		},
	},
]
