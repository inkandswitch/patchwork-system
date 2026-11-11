// File plugin for Patchwork
// Bundleless plugin that supports viewing and editing various file types

import {FileDatatype} from "./datatype"
import {NewFileDatatype} from "./new-file-datatype"

export * from "./types"
export * from "./datatype"
export * from "./utils"

export const plugins = [
	{
		type: "patchwork:datatype",
		id: "file",
		name: "File",
		icon: "File",
		unlisted: true,
		async load() {
			return FileDatatype
		},
	},
	{
		type: "patchwork:tool",
		id: "file",
		name: "File",
		icon: "File",
		supportedDatatypes: ["file"],
		async load() {
			return (await import("./tool")).FileTool
		},
	},
	{
		type: "patchwork:datatype",
		id: "new-file",
		name: "New File",
		icon: "FilePlus",
		async load() {
			return NewFileDatatype
		},
	},
	{
		type: "patchwork:tool",
		id: "new-file",
		name: "New File",
		icon: "FilePlus",
		supportedDatatypes: ["new-file"],
		async load() {
			return (await import("./new-file-tool")).NewFileTool
		},
	},
]
