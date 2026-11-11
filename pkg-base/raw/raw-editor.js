import {createSignal, createMemo, createEffect, createRoot, onCleanup, untrack} from "solid-js"
import {render} from "solid-js/web"
import html from "solid-js/html"
import * as Automerge from "@automerge/automerge/slim"
import {isValidAutomergeUrl, isImmutableString} from "@automerge/automerge-repo/slim"
import {EditorView, keymap} from "@codemirror/view"
import {EditorState} from "@codemirror/state"

const ROW_H = 24
const OVERSCAN = 30
const INDENT = 18
const ROOT_ID = "\x00root"

// ── styles (must be before use) ──────────────────────────────────────────────

const STYLES = `
:root, :host, [theme] {
  --re-fill: var(--studio-fill, white);
  --re-line: var(--studio-line, black);
  --re-string: var(--syntax-string, #2e7d32);
  --re-number: var(--syntax-number, #6a1b9a);
  --re-boolean: var(--syntax-bool, #0277bd);
  --re-null: var(--studio-danger-text, var(--studio-danger, #c62828));
  --re-key: var(--syntax-attribute-name, #5e81ac);
  --re-key-index: var(--studio-line-offset-50, rgba(0,0,0,0.3));
  --re-bracket: var(--studio-line-offset-50, rgba(0,0,0,0.3));
  --re-count: var(--studio-line-offset-50, rgba(0,0,0,0.35));
  --re-border: var(--studio-fill-offset-20, rgba(0,0,0,0.12));
  --re-btn-hover: var(--studio-fill-offset-10, rgba(0,0,0,0.07));
  --re-badge-bg: var(--studio-fill-offset-10, rgba(0,0,0,0.07));
  --re-dump-bg: var(--studio-fill-offset-10, rgba(0,0,0,0.04));
  --re-mode-active-bg: var(--studio-fill-offset-20, rgba(0,0,0,0.12));
  --re-link: var(--studio-link-text, var(--studio-link, var(--studio-primary-text, #0969da)));
  --re-link-hover: var(--studio-link-text, var(--studio-primary-text, #0550ae));
  --re-input-bg: var(--studio-fill-offset-10, rgba(0,0,0,0.04));
  --re-input-border: var(--studio-fill-offset-20, rgba(0,0,0,0.15));
  --re-input-color: var(--studio-line, #2e3440);
  --re-overlay-bg: var(--studio-fill, white);
  --re-ok: var(--studio-added, #2e7d32);
  --re-cancel: var(--studio-danger-text, var(--studio-danger, #c62828));
  --re-focus: var(--studio-primary-line, var(--studio-primary, #5e81ac));
}
.raw-editor-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0.75rem;
  gap: 0.5rem;
  box-sizing: border-box;
  font-family: var(--studio-family-code, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace);
  font-size: 13px;
}
.re-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--re-border);
  flex-shrink: 0;
}
.re-url {
  font-size: 0.68rem;
  opacity: 0.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  cursor: var(--studio-cursor-pointer, pointer);
  transition: opacity max(1ms, calc(0.15s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1)));
  user-select: none;
}
.re-url:hover { opacity: 0.7; }
.re-url--copied { opacity: 0.8 !important; color: var(--re-ok); }
.re-toolbar-actions {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}
.re-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.45rem;
  border-radius: 0.3rem;
  font-size: 0.68rem;
  font-weight: 500;
  cursor: var(--studio-cursor-pointer, pointer);
  border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--re-border);
  background: transparent;
  color: inherit;
  opacity: 0.7;
  transition: opacity max(1ms, calc(0.1s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))), background max(1ms, calc(0.1s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1)));
  white-space: nowrap;
  font-family: inherit;
}
.re-btn:hover:not(:disabled) { opacity: 1; background: var(--re-btn-hover); }
.re-btn:disabled { opacity: 0.25; cursor: var(--studio-cursor-default, default); }
.re-icon { display: inline-flex; align-items: center; }
.re-icon svg { display: block; }
.re-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}
.re-loading {
  font-size: 0.8rem;
  opacity: 0.45;
}
.re-row {
  display: flex;
  align-items: center;
  gap: 0;
  white-space: nowrap;
  padding-right: 8px;
}
.re-value, .re-automerge-url {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: min(60vw, 600px);
}
.re-row:hover .re-actions-row { opacity: 1; }
.re-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  cursor: var(--studio-cursor-pointer, pointer);
  opacity: 0.5;
  border-radius: 3px;
}
.re-toggle:hover { opacity: 1; background: var(--re-btn-hover); }
.re-toggle svg { display: block; width: 14px; height: 14px; }
.re-toggle-spacer { width: 18px; flex-shrink: 0; }
.re-key { color: var(--re-key); margin-right: 0; }
.re-key-index { color: var(--re-key-index); }
.re-colon { opacity: 0.5; margin-right: 4px; }
.re-bracket { color: var(--re-bracket); }
.re-count {
  color: var(--re-count);
  font-style: italic;
  font-size: 0.9em;
  margin: 0 4px;
}
.re-automerge-url {
  color: var(--re-link) !important;
  cursor: var(--studio-cursor-pointer, pointer) !important;
  text-decoration: underline;
}
.re-automerge-url:hover { color: var(--re-link-hover) !important; }
.re-actions-row {
  display: inline-flex;
  gap: 2px;
  margin-left: 6px;
  opacity: 0;
  transition: opacity max(1ms, calc(0.1s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1)));
}
.re-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  cursor: var(--studio-cursor-pointer, pointer);
  opacity: 0.5;
}
.re-act:hover { opacity: 1; background: var(--re-btn-hover); }
.re-act svg { display: block; }
.re-inline-editor {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.re-edit-input {
  font-family: inherit;
  font-size: inherit;
  padding: 3px 6px;
  border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--re-input-border);
  border-radius: 4px;
  background: var(--re-input-bg);
  color: var(--re-input-color);
  outline: none;
  min-width: 60px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.04);
}
.re-edit-input:focus { border-color: var(--re-focus); box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 0 0 2px color-mix(in srgb, var(--re-focus) 30%, transparent); }
.re-type-select {
  font-family: inherit;
  font-size: 0.85em;
  padding: 1px 2px;
  border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--re-input-border);
  border-radius: 3px;
  background: var(--re-input-bg);
  color: var(--re-input-color);
  cursor: var(--studio-cursor-pointer, pointer);
}
.re-edit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  cursor: var(--studio-cursor-pointer, pointer);
  opacity: 0.6;
}
.re-edit-btn:hover { opacity: 1; background: var(--re-btn-hover); }
.re-edit-ok svg { color: var(--re-ok); }
.re-edit-cancel svg { color: var(--re-cancel); }
.raw-editor-wrapper { position: relative; }
.re-cm-overlay {
  position: absolute;
  z-index: var(--studio-layer-popover, 9999);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 6px;
  background: var(--re-overlay-bg);
  border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--re-input-border);
  box-shadow: 0 4px 16px color-mix(in srgb, var(--re-line) 15%, transparent), 0 0 0 1px var(--re-border);
}
.re-cm-host {
  min-width: 240px;
  max-width: 80vw;
  border-radius: 4px;
  overflow: hidden;
  background: var(--re-input-bg);
  border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--re-input-border);
}
.re-cm-host .cm-editor {
  background: transparent;
  color: var(--re-input-color);
  font-family: inherit;
  font-size: inherit;
}
.re-text-overlay-buttons {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
.re-add-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: ${ROW_H}px;
  padding: 2px 0;
}
.u8-node {
  display: inline-flex;
  align-items: baseline;
  gap: 0.35em;
  flex-wrap: wrap;
}
.u8-badge {
  display: inline-block;
  font-size: 0.72em;
  padding: 0.05em 0.4em;
  border-radius: 0.25em;
  background: var(--re-badge-bg);
  opacity: 0.8;
}
.u8-size { font-size: 0.75em; opacity: 0.55; }
.u8-toggle {
  font-size: 0.68em;
  opacity: 0.5;
  cursor: var(--studio-cursor-pointer, pointer);
  text-decoration: underline;
  text-underline-offset: 2px;
  user-select: none;
}
.u8-toggle:hover { opacity: 1; }
.u8-dump {
  display: block;
  flex-basis: 100%;
  width: fit-content;
  margin-top: 0.3em;
  padding: 0.4em 0.6em;
  border-radius: 0.3em;
  background: var(--re-dump-bg);
  font-size: 0.72em;
  line-height: 1.6;
  overflow-x: auto;
}
.u8-mode-bar {
  display: flex;
  gap: 0.15em;
  margin-bottom: 0.4em;
  padding-bottom: 0.3em;
  border-bottom: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--re-border);
}
.u8-mode-btn {
  padding: 0.1em 0.45em;
  border-radius: 0.2em;
  cursor: var(--studio-cursor-pointer, pointer);
  opacity: 0.5;
  font-size: 0.9em;
  user-select: none;
  transition: opacity max(1ms, calc(0.1s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))), background max(1ms, calc(0.1s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1)));
}
.u8-mode-btn:hover { opacity: 0.8; background: var(--re-btn-hover); }
.u8-mode-btn--active { opacity: 1; background: var(--re-mode-active-bg); font-weight: 600; }
.u8-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font: inherit;
  max-height: 20em;
  overflow-y: auto;
}
`

// ── helpers ──────────────────────────────────────────────────────────────────

function pathKey(path) { return path.join("\x00") }

function walkToParent(doc, path) {
  let node = doc
  for (let i = 0; i < path.length - 1; i++) {
    node = node[path[i]]
    if (node == null) return null
  }
  return [node, path[path.length - 1]]
}

function applyAtPath(doc, path, value) {
  let target = walkToParent(doc, path)
  if (!target) return
  let [node, key] = target
  if (
    typeof value === "string" &&
    typeof node[key] === "string" &&
    !isImmutableString(node[key])
  ) {
    Automerge.updateText(doc, path, value)
  } else {
    node[key] = value
  }
}

function deleteAtPath(doc, path) {
  let target = walkToParent(doc, path)
  if (!target) return
  let [node, key] = target
  if (Array.isArray(node) && typeof key === "number") {
    node.splice(key, 1)
  } else {
    delete node[key]
  }
}

function cloneValue(v) {
  if (v instanceof Automerge.Counter) return new Automerge.Counter(v.value)
  if (v instanceof Automerge.ImmutableString) return new Automerge.ImmutableString(v.val)
  if (Array.isArray(v)) return v.map(cloneValue)
  if (v instanceof Date || v instanceof Uint8Array || !v || typeof v !== "object") return v
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneValue(x)]))
}

function renameKey(d, parentPath, oldKey, newKey) {
  let parent = parentPath.length === 0 ? d : parentPath.reduce((o, k) => o[k], d)
  let value = cloneValue(parent[oldKey])
  delete parent[oldKey]
  parent[newKey] = value
}

function applyUndo(d, e) {
  if (e.type === "edit") applyAtPath(d, e.path, e.oldValue)
  else if (e.type === "delete") applyAtPath(d, e.path, e.oldValue)
  else if (e.type === "add") deleteAtPath(d, e.path)
  else if (e.type === "rename") renameKey(d, e.parentPath, e.newKey, e.oldKey)
}

function applyRedo(d, e) {
  if (e.type === "edit") applyAtPath(d, e.path, e.newValue)
  else if (e.type === "delete") deleteAtPath(d, e.path)
  else if (e.type === "add") applyAtPath(d, e.path, e.newValue)
  else if (e.type === "rename") renameKey(d, e.parentPath, e.oldKey, e.newKey)
}

function downloadBlob(blob, name) {
  let url = URL.createObjectURL(blob)
  let a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function prepareForJson(v) {
  if (isImmutableString(v)) return String(v)
  if (v instanceof Uint8Array) return Array.from(v)
  if (Array.isArray(v)) return v.map(prepareForJson)
  if (v !== null && typeof v === "object") {
    let out = {}
    for (let [k, val] of Object.entries(v)) out[k] = prepareForJson(val)
    return out
  }
  return v
}

// An ImmutableString is an object too, but it's a string with no history.
function isCollection(v) {
  return v !== null && typeof v === "object" && !(v instanceof Uint8Array) && !isImmutableString(v)
}

// ── tree flattening ──────────────────────────────────────────────────────────

function autoExpand(obj, maxDepth, path, depth, set) {
  if (depth >= maxDepth || !isCollection(obj)) return
  let entries = Array.isArray(obj) ? obj.map((v, i) => [i, v]) : Object.entries(obj)
  for (let [k, v] of entries) {
    let p = [...path, k]
    if (isCollection(v)) {
      set.add(pathKey(p))
      autoExpand(v, maxDepth, p, depth + 1, set)
    }
  }
}

function flattenInto(obj, exp, path, depth, rows, parentIsArray) {
  if (!isCollection(obj)) return
  let entries = Array.isArray(obj) ? obj.map((v, i) => [i, v]) : Object.entries(obj)
  for (let [key, value] of entries) {
    let p = [...path, key]
    let pk = pathKey(p)
    let coll = isCollection(value)
    let isArr = Array.isArray(value)
    let count = coll ? (isArr ? value.length : Object.keys(value).length) : 0
    let expanded = coll && exp.has(pk)
    rows.push({id: pk, type: "node", depth, path: p, key, value, coll, isArr, count, expanded, parentIsArray: !!parentIsArray})
    if (expanded) {
      flattenInto(value, exp, p, depth + 1, rows, isArr)
      rows.push({id: pk + "\x01close", type: "close", depth, isArr})
    }
  }
}

function flattenDoc(doc, exp) {
  let rows = []
  if (!isCollection(doc)) {
    flattenInto(doc, exp, [], 0, rows)
    return rows
  }
  let isArr = Array.isArray(doc)
  let count = isArr ? doc.length : Object.keys(doc).length
  let expanded = exp.has(ROOT_ID)
  rows.push({id: ROOT_ID, type: "node", root: true, depth: 0, path: [], key: "", value: doc, coll: true, isArr, count, expanded, parentIsArray: false})
  if (expanded) {
    flattenInto(doc, exp, [], 1, rows, isArr)
    rows.push({id: ROOT_ID + "\x01close", type: "close", depth: 0, isArr})
  }
  return rows
}

// ── Uint8Array inspector ─────────────────────────────────────────────────────

function renderBytes(bytes, mode) {
  if (mode === "base64") {
    let bin = ""
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }
  if (mode === "utf8") return new TextDecoder("utf-8", {fatal: false}).decode(bytes)
  let w = mode === "decimal" ? 3 : 2
  let radix = mode === "decimal" ? 10 : 16
  let lines = []
  for (let i = 0; i < bytes.length; i += 16) {
    let slice = bytes.slice(i, i + 16)
    lines.push(Array.from(slice).map(b => b.toString(radix).padStart(w, mode === "decimal" ? " " : "0")).join(" "))
  }
  return lines.join("\n")
}

function Uint8Inspector(props) {
  let [open, setOpen] = createSignal(false)
  let [mode, setMode] = createSignal("hex")
  let content = createMemo(() => renderBytes(props.bytes, mode()))
  let modes = [{k: "hex", l: "Hex"}, {k: "decimal", l: "Dec"}, {k: "utf8", l: "UTF-8"}, {k: "base64", l: "Base64"}]
  return html`<span class="u8-node">
    <span class="u8-badge">Uint8Array</span>
    <span class="u8-size">${() => props.bytes.byteLength} bytes</span>
    <span class="u8-toggle" onClick=${() => setOpen(v => !v)}>
      ${() => open() ? "hide" : "inspect"}
    </span>
    ${() => open() ? html`<span class="u8-dump">
      <span class="u8-mode-bar">
        ${modes.map(m => html`<span
          class=${() => "u8-mode-btn" + (mode() === m.k ? " u8-mode-btn--active" : "")}
          onClick=${() => setMode(m.k)}>${m.l}</span>`)}
      </span>
      <pre class="u8-pre">${content}</pre>
    </span>` : ""}
  </span>`
}

// ── SVG icons ────────────────────────────────────────────────────────────────

let svg = (d, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`

let ICONS = {
  chevronRight: svg('<polyline points="9 18 15 12 9 6"/>'),
  chevronDown: svg('<polyline points="6 9 12 15 18 9"/>'),
  edit: svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>', 12),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>', 12),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 12),
  check: svg('<polyline points="20 6 9 17 4 12"/>', 12),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 12),
  copy: svg('<rect width="13" height="13" x="9" y="9" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 12),
  undo: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>', 14),
  redo: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 14),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', 14),
}

// ── value display ────────────────────────────────────────────────────────────

function valueColor(v) {
  if (v === null) return "var(--re-null)"
  if (isImmutableString(v)) return "var(--re-string)"
  switch (typeof v) {
    case "string": return "var(--re-string)"
    case "number": return "var(--re-number)"
    case "boolean": return "var(--re-boolean)"
    default: return "inherit"
  }
}

function autoSize(el) {
  el.style.width = "0"
  el.style.width = Math.max(60, el.scrollWidth + 4) + "px"
}

function valueText(v) {
  if (v === null) return "null"
  if (typeof v === "string" || isImmutableString(v)) return JSON.stringify(String(v))
  return String(v)
}

function parseInput(text, type) {
  if (type === "null") return null
  if (type === "boolean") return text === "true"
  if (type === "number") {
    let n = Number(text)
    return isNaN(n) ? text : n
  }
  if (type === "object") return {}
  if (type === "array") return []
  return text
}

// ── inline editor ────────────────────────────────────────────────────────────

function InlineEditor(props) {
  let initial = props.value
  let initialType = initial === null ? "null" : typeof initial
  let [text, setText] = createSignal(initial === null ? "" : typeof initial === "string" ? initial : String(initial))
  let [type, setType] = createSignal(initialType)

  function doConfirm() {
    let val = parseInput(text(), type())
    props.confirm(val)
  }

  return html`<span class="re-inline-editor">
    ${() => type() !== "null" && type() !== "boolean" && type() !== "object" && type() !== "array" ? html`<input
      class="re-edit-input"
      value=${untrack(text)}
      onInput=${e => { setText(e.target.value); autoSize(e.target) }}
      onKeyDown=${e => { if (e.key === "Enter") doConfirm(); if (e.key === "Escape") props.cancel() }}
      ref=${el => requestAnimationFrame(() => { el.focus(); autoSize(el) })}
    />` : ""}
    ${() => type() === "boolean" ? html`<select
      class="re-edit-input"
      value=${untrack(text)}
      onChange=${e => setText(e.target.value)}
    >
      <option value="true">true</option>
      <option value="false">false</option>
    </select>` : ""}
    <select class="re-type-select" value=${type()} onChange=${e => {
      setType(e.target.value)
      if (e.target.value === "null" || e.target.value === "object" || e.target.value === "array") setText("")
      if (e.target.value === "boolean") setText("true")
    }}>
      <option value="string">string</option>
      <option value="number">number</option>
      <option value="boolean">boolean</option>
      <option value="null">null</option>
      <option value="object">object {}</option>
      <option value="array">array []</option>
    </select>
    <span class="re-edit-btn re-edit-ok" onClick=${doConfirm}><span class="re-icon" innerHTML=${ICONS.check} /></span>
    <span class="re-edit-btn re-edit-cancel" onClick=${props.cancel}><span class="re-icon" innerHTML=${ICONS.x} /></span>
  </span>`
}

// ── add field editor ─────────────────────────────────────────────────────────

function AddFieldEditor(props) {
  let [key, setKey] = createSignal("")
  let [text, setText] = createSignal("")
  let [type, setType] = createSignal("string")

  function doConfirm() {
    let k = props.isArray ? undefined : key()
    if (!props.isArray && k === "") return
    let val = parseInput(text(), type())
    props.confirm(k, val)
  }

  return html`<div class="re-add-row">
    ${() => !props.isArray ? html`<input class="re-edit-input re-key-input" placeholder="key"
      value=${untrack(key)} onInput=${e => { setKey(e.target.value); autoSize(e.target) }}
      onKeyDown=${e => { if (e.key === "Enter") doConfirm(); if (e.key === "Escape") props.cancel() }}
      ref=${el => requestAnimationFrame(() => { el.focus(); autoSize(el) })}
    />` : ""}
    ${() => type() !== "null" && type() !== "boolean" && type() !== "object" && type() !== "array" ? html`<input class="re-edit-input"
      placeholder="value" value=${untrack(text)} onInput=${e => { setText(e.target.value); autoSize(e.target) }}
      onKeyDown=${e => { if (e.key === "Enter") doConfirm(); if (e.key === "Escape") props.cancel() }}
      ref=${el => { if (props.isArray) requestAnimationFrame(() => { el.focus(); autoSize(el) }) }}
    />` : ""}
    ${() => type() === "boolean" ? html`<select class="re-edit-input"
      value=${untrack(text)} onChange=${e => setText(e.target.value)}>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>` : ""}
    <select class="re-type-select" value=${type()} onChange=${e => {
      setType(e.target.value)
      if (e.target.value === "null" || e.target.value === "object" || e.target.value === "array") setText("")
      if (e.target.value === "boolean") setText("true")
    }}>
      <option value="string">string</option>
      <option value="number">number</option>
      <option value="boolean">boolean</option>
      <option value="null">null</option>
      <option value="object">object {}</option>
      <option value="array">array []</option>
    </select>
    <span class="re-edit-btn re-edit-ok" onClick=${doConfirm}><span class="re-icon" innerHTML=${ICONS.check} /></span>
    <span class="re-edit-btn re-edit-cancel" onClick=${props.cancel}><span class="re-icon" innerHTML=${ICONS.x} /></span>
  </div>`
}

// ── key editor ──────────────────────────────────────────────────────────────

function KeyEditor(props) {
  let [text, setText] = createSignal(String(props.initialKey))

  function doConfirm() {
    let newKey = text().trim()
    if (newKey && newKey !== String(props.initialKey)) {
      props.confirm(newKey)
    } else {
      props.cancel(null)
    }
  }

  return html`<span class="re-inline-editor">
    <input class="re-edit-input"
      value=${text()}
      onInput=${e => { setText(e.target.value); autoSize(e.target) }}
      onKeyDown=${e => { if (e.key === "Enter") doConfirm(); if (e.key === "Escape") props.cancel(null) }}
      ref=${el => requestAnimationFrame(() => { el.focus(); el.select(); autoSize(el) })}
    />
    <span class="re-edit-btn re-edit-ok" onClick=${doConfirm}><span class="re-icon" innerHTML=${ICONS.check} /></span>
    <span class="re-edit-btn re-edit-cancel" onClick=${props.cancel}><span class="re-icon" innerHTML=${ICONS.x} /></span>
  </span>`
}

// ── codemirror overlay (portaled, live-synced string editor) ────────────────
// A "little codemirror guy" bound directly to the string at `path`. There's no
// save/cancel: edits stream into the doc live (via Automerge.splice) exactly
// like @automerge/automerge-codemirror's plugin — which we can't import here
// because `raw` is bundleless and only @codemirror/{state,view} are on the
// importmap. Multiline, wraps, and grows to fit its content.

function stringAtPath(doc, path) {
  let node = doc
  for (let i = 0; i < path.length; i++) {
    if (node == null) return null
    node = node[path[i]]
  }
  return typeof node === "string" ? node : null
}

function CodeMirrorOverlay(props) {
  // props: value, path, handle, anchorRect, onDone (with _)
  let view
  let applyingRemote = false // guards the doc→editor path from looping back

  // editor → doc: translate CodeMirror's changeset into Automerge splices.
  // Apply end-first so each splice's offset stays valid as we go.
  function pushToDoc(update) {
    let edits = []
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      edits.push({from: fromA, del: toA - fromA, ins: inserted.toString()})
    })
    if (!edits.length) return
    props.handle.change(d => {
      for (let i = edits.length - 1; i >= 0; i--) {
        let e = edits[i]
        Automerge.splice(d, props.path, e.from, e.del, e.ins)
      }
    })
  }

  // doc → editor: reflect remote edits. Our own splices land here too, but the
  // strings already match by then, so this no-ops and never loops.
  function onDocChange() {
    if (!view) return
    let cur = stringAtPath(props.handle.doc(), props.path)
    if (cur == null || cur === view.state.doc.toString()) return
    applyingRemote = true
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: cur}})
    applyingRemote = false
  }

  function mount(el) {
    view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          EditorView.lineWrapping,
          keymap.of([
            {key: "Mod-Enter", run: () => (props.onDone(null), true)},
          ]),
          EditorView.updateListener.of(u => {
            if (u.docChanged && !applyingRemote) pushToDoc(u)
          }),
          EditorView.theme({
            "&": {maxHeight: "60vh", fontSize: "inherit"},
            ".cm-scroller": {fontFamily: "inherit", overflow: "auto"},
            ".cm-content": {padding: "6px 8px"},
            "&.cm-focused": {outline: "none"},
          }),
        ],
      }),
    })
    props.handle.on("change", onDocChange)
    requestAnimationFrame(() => {
      view.focus()
      view.dispatch({selection: {anchor: view.state.doc.length}})
    })
  }

  onCleanup(() => {
    props.handle.off("change", onDocChange)
    view?.destroy()
  })

  // Anchor coordinates are relative to the wrapper (our offset parent). Clamp
  // after CodeMirror has laid out, so the overlay can't hang off the bottom or
  // the right edge of the tool.
  function place(el) {
    requestAnimationFrame(() => {
      let parent = el.offsetParent
      if (!parent) return
      let top = Math.min(props.anchorRect.top, parent.clientHeight - el.offsetHeight - 8)
      let left = Math.min(props.anchorRect.left, parent.clientWidth - el.offsetWidth - 8)
      el.style.top = Math.max(8, top) + "px"
      el.style.left = Math.max(8, left) + "px"
    })
  }

  let r = props.anchorRect
  let style = `top:${r.top}px;left:${r.left}px`

  return html`<div class="re-cm-overlay" style=${style} ref=${place}
    onKeyDown=${e => e.stopPropagation()}>
    <div class="re-cm-host" ref=${mount}></div>
    <div class="re-text-overlay-buttons">
      <span style="font-size:0.7em;opacity:0.5">Live · Esc to close</span>
      <span class="re-edit-btn re-edit-ok" onClick=${(_) => props.onDone(null)}><span class="re-icon" innerHTML=${ICONS.check} /></span>
    </div>
  </div>`
}

// ── main app ─────────────────────────────────────────────────────────────────

function RawEditorApp(props) {
  let {handle, element} = props
  let docUrl = handle.url

  // ── state ──
  let [doc, setDoc] = createSignal(handle.doc())
  let [exp, setExp] = createSignal(new Set([ROOT_ID]))
  let [scrollTop, setScrollTop] = createSignal(0)
  let [viewportH, setViewportH] = createSignal(600)
  let [editing, setEditing] = createSignal(null)  // {pk, path, value, mode:"value"} or {pk, path, key, mode:"key"}
  let [adding, setAdding] = createSignal(null)     // {pk, path, isArray}
  let [undoStack, setUndoStack] = createSignal([])
  let [redoStack, setRedoStack] = createSignal([])
  let [urlCopied, setUrlCopied] = createSignal(false)
  let copyTimer

  // ── sync doc ──
  let syncDoc = () => setDoc(handle.doc())
  handle.on("change", syncDoc)
  onCleanup(() => handle.off("change", syncDoc))

  // ── auto-expand depth < 3 on first load ──
  let inited = false
  createEffect(() => {
    let d = doc()
    if (!d || inited) return
    inited = true
    let set = new Set([ROOT_ID])
    autoExpand(d, 3, [], 0, set)
    setExp(set)
  })

  // ── tree flatten ──
  let flatRows = createMemo(() => {
    let d = doc()
    if (!d) return []
    return flattenDoc(d, exp())
  })

  // ── visible window ──
  let totalH = createMemo(() => flatRows().length * ROW_H)
  let startIdx = createMemo(() => Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN))
  let endIdx = createMemo(() => Math.min(flatRows().length, Math.ceil((scrollTop() + viewportH()) / ROW_H) + OVERSCAN))
  let visibleRows = createMemo(() => flatRows().slice(startIdx(), endIdx()))
  let slabTop = createMemo(() => startIdx() * ROW_H)

  // ── toggle expand ──
  function toggle(pk) {
    setExp(prev => {
      let next = new Set(prev)
      if (next.has(pk)) next.delete(pk)
      else next.add(pk)
      return next
    })
  }

  // ── undo/redo ──
  function pushUndo(entry) {
    setUndoStack(s => [...s, entry])
    setRedoStack([])
  }

  function undo() {
    let stack = undoStack()
    if (!stack.length) return
    let entry = stack[stack.length - 1]
    setUndoStack(s => s.slice(0, -1))
    setRedoStack(s => [...s, entry])
    handle.change(d => applyUndo(d, entry))
  }

  function redo() {
    let stack = redoStack()
    if (!stack.length) return
    let entry = stack[stack.length - 1]
    setRedoStack(s => s.slice(0, -1))
    setUndoStack(s => [...s, entry])
    handle.change(d => applyRedo(d, entry))
  }

  // ── keyboard ──
  function onKeyDown(e) {
    if (!element.contains(e.target)) return
    let inOverlay = e.target.closest?.(".re-cm-overlay")
    if (!inOverlay && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault()
      e.shiftKey ? redo() : undo()
    }
    if (e.key === "Escape") {
      setEditing(null)
      setAdding(null)
    }
  }
  document.addEventListener("keydown", onKeyDown, true)
  onCleanup(() => document.removeEventListener("keydown", onKeyDown, true))

  // ── edit/add/delete ──
  // Strings always open the codemirror overlay — pencil or double-click alike.
  // `anchorEl` is the value element to float the editor over.
  function startEdit(row, anchorEl) {
    setAdding(null)
    if (typeof row.value === "string") {
      let el = anchorEl || wrapperEl
      let valRect = el.getBoundingClientRect()
      let wrapRect = wrapperEl.getBoundingClientRect()
      setEditing({pk: row.id, path: row.path, value: row.value, mode: "text",
        anchorRect: {top: valRect.top - wrapRect.top, left: valRect.left - wrapRect.left}})
    } else if (isImmutableString(row.value)) {
      // Edited as the string it is, and written back as an ImmutableString:
      // it has no text to splice into.
      setEditing({pk: row.id, path: row.path, value: String(row.value), mode: "value",
        original: cloneValue(row.value)})
    } else {
      setEditing({pk: row.id, path: row.path, value: row.value, mode: "value"})
    }
  }

  function confirmEdit(newValue) {
    let ed = editing()
    if (!ed || ed.mode !== "value") return
    if (ed.original && typeof newValue === "string") {
      newValue = new Automerge.ImmutableString(newValue)
    }
    pushUndo({type: "edit", path: ed.path, oldValue: ed.original ?? ed.value, newValue})
    handle.change(d => applyAtPath(d, ed.path, newValue))
    setEditing(null)
  }

  function startKeyEdit(row) {
    setAdding(null)
    setEditing({pk: row.id, path: row.path, key: row.key, mode: "key"})
  }

  function confirmKeyEdit(newKey) {
    let ed = editing()
    if (!ed || ed.mode !== "key") return
    let parentPath = ed.path.slice(0, -1)
    let oldKey = ed.path[ed.path.length - 1]
    pushUndo({type: "rename", parentPath, oldKey, newKey})
    handle.change(d => renameKey(d, parentPath, oldKey, newKey))
    setEditing(null)
  }

  function deleteField(row) {
    setEditing(null)
    setAdding(null)
    pushUndo({type: "delete", path: row.path, oldValue: row.value})
    handle.change(d => deleteAtPath(d, row.path))
  }

  function startAdd(row) {
    setEditing(null)
    if (!exp().has(row.id)) {
      setExp(prev => {
        let next = new Set(prev)
        next.add(row.id)
        return next
      })
    }
    setAdding({pk: row.id, path: row.path, isArray: row.isArr})
  }

  function confirmAdd(parentPath, isArray, key, value) {
    let fullPath
    if (isArray) {
      let arr = parentPath.reduce((o, k) => o[k], doc())
      fullPath = [...parentPath, arr ? arr.length : 0]
    } else {
      fullPath = [...parentPath, key]
    }
    pushUndo({type: "add", path: fullPath, newValue: value})
    handle.change(d => applyAtPath(d, fullPath, value))
    setAdding(null)
  }

  // ── downloads ──
  function downloadJson() {
    let d = doc()
    if (!d) return
    downloadBlob(
      new Blob([JSON.stringify(prepareForJson(d), null, 2)], {type: "application/json"}),
      `${handle.documentId}.json`
    )
  }

  function downloadAutomerge() {
    let d = doc()
    if (!d) return
    downloadBlob(
      new Blob([Automerge.save(d)], {type: "application/octet-stream"}),
      `${handle.documentId}.automerge`
    )
  }

  function copyUrl() {
    navigator.clipboard.writeText(docUrl).then(() => {
      setUrlCopied(true)
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => setUrlCopied(false), 1500)
    })
  }

  // ── copy value ──
  function copyValue(value) {
    let text
    if (value instanceof Uint8Array) {
      let bin = ""
      for (let i = 0; i < value.length; i++) bin += String.fromCharCode(value[i])
      text = btoa(bin)
    } else if (typeof value === "object" && value !== null) {
      text = JSON.stringify(prepareForJson(value), null, 2)
    } else if (typeof value === "string") {
      text = value
    } else {
      text = String(value)
    }
    navigator.clipboard.writeText(text)
  }

  // ── open automerge url ──
  function openAmUrl(url) {
    element.dispatchEvent(new CustomEvent("patchwork:open-document", {
      detail: {url, toolId: "raw"},
      bubbles: true,
      composed: true,
    }))
  }

  // ── scroll handler with RAF ──
  let scrollEl
  let rafId = 0
  function onScroll() {
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      if (scrollEl) setScrollTop(scrollEl.scrollTop)
    })
  }

  function setupScroll(el) {
    if (!el) return
    scrollEl = el
    let ro = new ResizeObserver(entries => {
      for (let e of entries) setViewportH(e.contentRect.height)
    })
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  }

  // ── render a single row ──
  // `row` is an accessor: the row object is replaced on every doc change but
  // its DOM is built once per id and updated in place. Everything derived from
  // it has to stay behind a thunk.
  function renderRow(row) {
    let id = untrack(row).id
    let indent = () => `padding-left:${row().depth * INDENT}px;height:${ROW_H}px;line-height:${ROW_H}px`

    if (untrack(row).type === "close") {
      return html`<div class="re-row" style=${indent}>
        <span class="re-toggle-spacer" />
        <span class="re-bracket">${() => row().isArr ? "]" : "}"}</span>
      </div>`
    }

    // The row signal fires on every doc change, so anything that decides which
    // DOM to build goes through a memo over a primitive — otherwise each
    // keystroke would rebuild the subtree it guards. Leaf text and attributes
    // can read the row directly; those effects only assign.
    let coll = createMemo(() => row().coll)
    let root = createMemo(() => row().root)
    let expanded = createMemo(() => row().expanded)
    let kind = createMemo(() => {
      let v = row().value
      if (v instanceof Uint8Array) return "u8"
      let s = isImmutableString(v) ? String(v) : v
      if (typeof s === "string" && isValidAutomergeUrl(s)) return "url"
      return "plain"
    })
    let canEdit = createMemo(() => !coll() && kind() !== "u8")
    let mode = createMemo(() => {
      let ed = editing()
      return ed && ed.pk === id ? ed.mode : null
    })
    let addingHere = createMemo(() => adding()?.pk === id)

    function handleAction(e) {
      let target = e.target.closest("[data-action]")
      if (!target) return
      let action = target.dataset.action
      if (action === "edit") {
        let rowEl = target.closest(".re-row")
        let anchorEl = rowEl?.querySelector(".re-value, .re-automerge-url") || target
        startEdit(row(), anchorEl)
      }
      else if (action === "add") startAdd(row())
      else if (action === "copy") copyValue(row().value)
      else if (action === "delete") deleteField(row())
    }

    return html`<div class="re-row-slot">
      <div class="re-row" style=${indent}>
        ${() => coll()
          ? html`<span class="re-toggle" onClick=${() => toggle(id)}><span class="re-icon" innerHTML=${() => expanded() ? ICONS.chevronDown : ICONS.chevronRight} /></span>`
          : html`<span class="re-toggle-spacer" />`}
        ${() => {
          if (root()) return ""
          if (mode() === "key") {
            return html`<${KeyEditor} initialKey=${untrack(row).key} confirm=${confirmKeyEdit} cancel=${(_) => setEditing(null)} />`
          }
          return html`<span class=${() => row().parentIsArray ? "re-key re-key-index" : "re-key"}
            on:dblclick=${() => { if (!row().parentIsArray) startKeyEdit(row()) }}
            >${() => row().parentIsArray ? row().key : JSON.stringify(String(row().key))}</span>`
        }}
        ${() => root() ? "" : html`<span class="re-colon">: </span>`}
        ${() => {
          if (mode() === "value") {
            return html`<${InlineEditor} value=${untrack(row).value} confirm=${confirmEdit} cancel=${(_) => setEditing(null)} />`
          }
          if (coll()) {
            return html`<span>
              <span class="re-bracket">${() => row().isArr ? "[" : "{"}</span>
              ${() => expanded() ? "" : html`<span class="re-count">${() => `${row().count} item${row().count !== 1 ? "s" : ""}`}</span>
                <span class="re-bracket">${() => row().isArr ? "]" : "}"}</span>`}
            </span>`
          }
          if (kind() === "u8") {
            return html`<${Uint8Inspector} bytes=${() => row().value} />`
          }
          if (kind() === "url") {
            return html`<span class="re-automerge-url" onClick=${() => openAmUrl(String(row().value))}>${() => String(row().value)}</span>`
          }
          return html`<span class="re-value" style=${() => `color:${valueColor(row().value)}`}
            on:dblclick=${(e) => startEdit(row(), e.currentTarget)}>${() => valueText(row().value)}</span>`
        }}
        <span class="re-actions-row" onClick=${handleAction}>
          ${() => canEdit() ? html`<span class="re-act" data-action="edit" title="Edit"
            style=${() => mode() ? "display:none" : ""}
            ><span class="re-icon" innerHTML=${ICONS.edit} /></span>` : ""}
          ${() => coll() ? html`<span class="re-act" data-action="add" title="Add"
            ><span class="re-icon" innerHTML=${ICONS.plus} /></span>` : ""}
          <span class="re-act" data-action="copy" title="Copy value"
            ><span class="re-icon" innerHTML=${ICONS.copy} /></span>
          ${() => root() ? "" : html`<span class="re-act" data-action="delete" title="Delete"
            ><span class="re-icon" innerHTML=${ICONS.trash} /></span>`}
        </span>
      </div>
      ${() => addingHere() ? html`<div style=${() => `padding-left:${(row().depth + 1) * INDENT}px`}>
        <${AddFieldEditor}
          isArray=${untrack(row).isArr}
          confirm=${(k, v) => confirmAdd(row().path, row().isArr, k, v)}
          cancel=${(_) => setAdding(null)}
        />
      </div>` : ""}
    </div>`
  }

  // ── keyed row list ──
  // Solid's `For` keys by object identity and every flatten produces fresh row
  // objects, so it would rebuild the whole window on each keystroke. Key by
  // row id instead: each id owns one root, and a new row object for that id is
  // pushed into its signal rather than remounting it.
  let rowRoots = new Map()
  onCleanup(() => {
    for (let entry of rowRoots.values()) entry.dispose()
    rowRoots.clear()
  })

  let renderedRows = createMemo(() => {
    let rows = visibleRows()
    let live = new Set()
    let nodes = rows.map(row => {
      live.add(row.id)
      let entry = rowRoots.get(row.id)
      if (entry) {
        // Scrolling re-slices the same row objects; only a re-flatten makes new
        // ones, and only then is there anything to push.
        if (entry.row !== row) {
          entry.row = row
          entry.set(row)
        }
        return entry.node
      }
      entry = createRoot(dispose => {
        let [get, set] = createSignal(row, {equals: false})
        return {node: renderRow(get), row, set, dispose}
      })
      rowRoots.set(row.id, entry)
      return entry.node
    })
    for (let [rowId, entry] of rowRoots) {
      if (live.has(rowId)) continue
      entry.dispose()
      rowRoots.delete(rowId)
    }
    return nodes
  })

  // ── main template ──
  let wrapperEl
  return html`<div class="raw-editor-wrapper" ref=${el => wrapperEl = el}>
    <div class="re-toolbar">
      <span class=${() => "re-url" + (urlCopied() ? " re-url--copied" : "")}
        title="Click to copy" onClick=${copyUrl}>
        ${() => urlCopied() ? "Copied!" : docUrl}
      </span>
      <div class="re-toolbar-actions">
        <button class="re-btn" onClick=${downloadJson} title="Download JSON">
          <span class="re-icon" innerHTML=${ICONS.download} /> JSON
        </button>
        <button class="re-btn" onClick=${downloadAutomerge} title="Download .automerge">
          <span class="re-icon" innerHTML=${ICONS.download} /> .automerge
        </button>
      </div>
    </div>
    ${() => !doc() ? html`<div class="re-loading">Loading...</div>` : ""}
    <div class="re-scroll" onScroll=${onScroll} ref=${setupScroll}>
      <div style=${() => `height:${totalH()}px;position:relative`}>
        <div style=${() => `position:absolute;top:${slabTop()}px;left:0;right:0`}>
          ${renderedRows}
        </div>
      </div>
    </div>
    ${() => {
      let ed = editing()
      return ed && ed.mode === "text" ? html`<${CodeMirrorOverlay}
        value=${ed.value}
        path=${ed.path}
        handle=${handle}
        anchorRect=${ed.anchorRect}
        onDone=${(_) => setEditing(null)}
      />` : ""
    }}
  </div>`
}

// ── tool entry point ─────────────────────────────────────────────────────────

function RawEditorTool(handle, element) {
  let style = document.createElement("style")
  style.textContent = STYLES
  element.appendChild(style)

  let container = document.createElement("div")
  container.style.height = "100%"
  element.appendChild(container)

  let dispose = render(() => RawEditorApp({handle, element}), container)
  return () => dispose()
}

export default RawEditorTool
