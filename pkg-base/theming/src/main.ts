import type {Extension} from "@codemirror/state"
import lycheeCssUrl from "./lychee.css"
import gloomCssUrl from "./gloom.css"
;(async function () {(await import("./active-theme.ts")).startActiveTheme()})();

export const plugins = [
	{
		type: "codemirror:extension",
		id: "codemirror-theme",
		name: "Theme",
		supportedDatatypes: "*",
		async load(): Promise<Extension[]> {
			const theme = await import("./codemirror-theme.ts")
			return theme.default
		},
	},
	{
		type: "patchwork:theme" as const,
		id: "lychee",
		name: "Lychee",
		style: new URL(lycheeCssUrl, import.meta.url).href,
		async load() {
			return {}
		},
	},
	{
		type: "patchwork:theme" as const,
		id: "gloom",
		name: "Gloom",
		style: new URL(gloomCssUrl, import.meta.url).href,
		async load() {
			return {}
		},
	},
	{
		type: "patchwork:datatype" as const,
		id: "theme-preferences",
		name: "Theme Preferences",
		icon: "Palette",
		unlisted: true,
		async load() {
			const {ThemePreferencesDatatype} = await import("./datatype.ts")
			return ThemePreferencesDatatype
		},
	},
	{
		type: "patchwork:tool" as const,
		id: "theme-titlebar",
		name: "Theme",
		icon: "Palette",
		supportedDatatypes: "*" as const,
		tags: ["titlebar-tool"],
		unlisted: true,
		forTitleBar: true,
		async load() {
			const {ThemeTitlebarTool} = await import("./theme-titlebar.ts")
			return ThemeTitlebarTool
		},
	},
	{
		type: "patchwork:component" as const,
		id: "theme-tray",
		name: "Theme",
		icon: "Palette",
		tags: ["system-tray"],
		async load() {
			const {ThemeTray} = await import("./theme-tray.tsx")
			return ThemeTray
		},
	},
	{
		type: "patchwork:tool" as const,
		id: "theme-picker",
		name: "Theme Picker",
		icon: "Palette",
		supportedDatatypes: ["theme-preferences"],
		async load() {
			const {ThemePickerTool} = await import("./tool.tsx")
			return ThemePickerTool
		},
	},
	{
		type: "patchwork:datatype" as const,
		id: "custom-theme",
		name: "Custom Theme",
		unlisted: true,
		icon: "Paintbrush",
		async load() {
			const {CustomThemeDatatype} = await import("./theme-editor-datatype.ts")
			return CustomThemeDatatype
		},
	},
	{
		type: "patchwork:tool" as const,
		id: "theme-editor",
		name: "Theme Editor",
		icon: "Paintbrush",
		supportedDatatypes: ["custom-theme"],
		async load() {
			const {ThemeEditorTool} = await import("./theme-editor.tsx")
			return ThemeEditorTool
		},
	},
]
