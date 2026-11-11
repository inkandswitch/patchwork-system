# File Plugin for Patchwork

A Solid.js-based plugin for viewing and editing various file types in Patchwork.

## Features

- **Text File Editing**: Full-featured text editor with syntax support
- **Image Viewing**: Display images (PNG, JPG, GIF, SVG, WebP, BMP)
- **PDF Viewing**: Embedded PDF viewer
- **HTML Viewing**: Sandboxed HTML preview
- **Long Text Support**: Read-only mode for very large text files (>100KB)

## Tech Stack

- **Solid.js** - Reactive UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Automerge** - CRDT for document synchronization

## Getting Started

### Install Dependencies

```bash
pnpm install
```

### Development

Build the plugin in watch mode:

```bash
pnpm dev
```

### Build

Build the plugin for production:

```bash
pnpm build
```

### Deploy

Build and sync to Patchwork:

```bash
pnpm push
```

## Adding CodeMirror extensions from outside

A tool that shows a text file with `<patchwork-view tool-id="file">` can add
its own CodeMirror extensions to the editor. Just before the editor is
created, the file tool dispatches a bubbling `file:codemirror-extensions`
event from inside the patchwork-view; push extensions onto
`event.detail.extensions`. It also carries `handle`, `doc`, and `readOnly`
(true for the read-only viewer used for ImmutableString and very long files):

```js
host.addEventListener("file:codemirror-extensions", (event) => {
	event.detail.extensions.push(myExtension)
})
```

The extensions must be built with the shared `@codemirror/*` modules from the
import map (the same ones the editor uses), not a bundled copy.

## Project Structure

```
file/
├── src/
│   ├── components/        # Solid.js components
│   │   ├── FileEditor.tsx       # Main editor component
│   │   ├── TextFileEditor.tsx   # Text editing
│   │   ├── ImageFileViewer.tsx  # Image display
│   │   ├── PDFFileViewer.tsx    # PDF display
│   │   ├── HTMLFileViewer.tsx   # HTML preview
│   │   └── ReadOnlyTextViewer.tsx # Read-only text viewer
│   ├── datatype.ts        # File datatype definition
│   ├── tool.tsx           # Plugin tool implementation
│   ├── types.ts           # TypeScript type definitions
│   ├── utils.ts           # Utility functions
│   ├── isBinaryFile.ts    # Binary file detection
│   └── index.ts           # Plugin entry point
├── dist/                  # Build output
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## File Types Supported

### Text Files
- Plain text files
- JSON
- JavaScript/TypeScript
- Python
- And more...

### Binary Files
- Images: PNG, JPG, GIF, SVG, WebP, BMP
- PDFs
- HTML files (rendered in iframe)

### Special Handling
- Large text files (>100KB) are displayed in read-only mode for performance
- Binary files are detected automatically using content analysis

## Plugin Definition

The plugin exports two main components:

1. **Datatype**: Defines how file documents are structured and managed
2. **Tool**: Provides the UI for viewing and editing files

## Notes

- This plugin uses a bundleless architecture but still requires a build step for TypeScript/Solid.js compilation
- No `@patchwork/*` dependencies - uses only standard Automerge and Solid.js
- Built to be lightweight and performant

## License

Copyright Ink & Switch