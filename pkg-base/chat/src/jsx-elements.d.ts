import "solid-js"

// The host's <patchwork-view> custom element, used in JSX to embed another tool
// (e.g. tool-id="contact-avatar"). The installed @inkandswitch/patchwork-elements
// version doesn't ship the JSX augmentation, so declare it locally.
declare module "solid-js" {
	namespace JSX {
		interface IntrinsicElements {
			"patchwork-view": any
			marquee: any
		}
	}
}
