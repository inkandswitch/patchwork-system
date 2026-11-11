export const ThemePreferencesDatatype = {
	init(doc: any) {
		doc["@patchwork"] = {type: "theme-preferences"}
	},
	getTitle() {
		return "Theme Preferences"
	},
	setTitle() {
		// Theme preferences doc title is not user-editable
	},
}
