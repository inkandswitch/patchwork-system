// Read/write the `.tldraw` archive format used by offline.tldraw.com: a zip
// holding a SQLite database of the store records, plus metadata and session
// JSON. Record state is stored as JSON text keyed by record id, which maps
// directly onto our `TLDrawDoc` (`store` + `schema`).

import initSqlJs from "sql.js";
import wasmBinary from "sql.js/dist/sql-wasm.wasm";
import {
  createTLStore,
  defaultShapeUtils,
  type SerializedSchema,
  type SerializedStore,
  type TLRecord,
} from "@tldraw/tldraw";

import { unzip, zip, type ZipEntries } from "./zip.ts";

export type TldrArchive = {
  displayName: string;
  store: SerializedStore<TLRecord>;
  schema: SerializedSchema;
  // The raw zip entries, so the caller can pick up `script/**` and anything
  // else the archive carries that isn't part of the store.
  files: ZipEntries;
};

const SCHEMA_SQL = `
CREATE TABLE documents (
	id TEXT PRIMARY KEY,
	state BLOB NOT NULL,
	lastChangedClock INTEGER NOT NULL
);
CREATE INDEX idx_documents_lastChangedClock ON documents(lastChangedClock);
CREATE TABLE tombstones (
	id TEXT PRIMARY KEY,
	clock INTEGER NOT NULL
);
CREATE INDEX idx_tombstones_clock ON tombstones(clock);
CREATE TABLE metadata (
	migrationVersion INTEGER NOT NULL,
	documentClock INTEGER NOT NULL,
	tombstoneHistoryStartsAtClock INTEGER NOT NULL,
	schema TEXT NOT NULL
);
`;

const MIGRATION_VERSION = 2;

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function loadSql() {
  return (sqlPromise ??= initSqlJs({ wasmBinary }));
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  throw new Error("expected text column");
}

export async function readTldrArchive(
  bytes: Uint8Array,
  fallbackName: string
): Promise<TldrArchive> {
  const files = await unzip(bytes);

  const dbBytes = files.get("db.sqlite");
  if (!dbBytes) throw new Error("archive has no db.sqlite");

  const SQL = await loadSql();
  const db = new SQL.Database(dbBytes);
  try {
    const store = {} as SerializedStore<TLRecord>;
    const documents = db.prepare("SELECT id, state FROM documents");
    while (documents.step()) {
      const [id, state] = documents.get();
      (store as Record<string, TLRecord>)[text(id)] = JSON.parse(text(state));
    }
    documents.free();

    const metadata = db.prepare("SELECT schema FROM metadata");
    if (!metadata.step()) throw new Error("archive has no schema");
    const schema = JSON.parse(text(metadata.get()[0])) as SerializedSchema;
    metadata.free();

    return {
      displayName: displayName(files) ?? fallbackName,
      files,
      ...loadable(store, schema),
    };
  } finally {
    db.close();
  }
}

// An archive written by a newer tldraw than the one we bundle can name sequence
// versions we have no migrators for and record types we have no definition for;
// either one makes the whole snapshot fail to load. Clamping each sequence to
// the highest version we know and dropping unknown record types lets older
// archives migrate normally and newer ones load as-is — the same trade the paste
// handler makes in `tool.tsx`.
function loadable(store: SerializedStore<TLRecord>, schema: SerializedSchema) {
  const local = createTLStore({ shapeUtils: defaultShapeUtils });
  const ourSequences = (
    local.getStoreSnapshot().schema as SerializedSchema & {
      sequences: Record<string, number>;
    }
  ).sequences;
  const ourTypes = local.schema.types as Record<string, unknown>;

  const theirSequences = (
    schema as SerializedSchema & { sequences?: Record<string, number> }
  ).sequences;

  const sequences: Record<string, number> = {};
  for (const [name, version] of Object.entries(theirSequences ?? {})) {
    const known = ourSequences[name];
    if (known === undefined) continue;
    sequences[name] = Math.min(version, known);
  }

  const kept = {} as Record<string, TLRecord>;
  for (const [id, record] of Object.entries(store) as [string, TLRecord][]) {
    if (!(record.typeName in ourTypes)) continue;
    kept[id] = record;
  }

  return {
    store: kept as SerializedStore<TLRecord>,
    schema: (theirSequences
      ? { ...schema, sequences }
      : schema) as SerializedSchema,
  };
}

function displayName(files: ZipEntries): string | null {
  const raw = files.get("metadata.json");
  if (!raw) return null;
  try {
    const name = JSON.parse(new TextDecoder().decode(raw)).displayName;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

export type TldrArchiveOut = Omit<TldrArchive, "files"> & {
  scriptFiles?: Map<string, Uint8Array>;
};

export async function writeTldrArchive(
  archive: TldrArchiveOut
): Promise<Uint8Array> {
  const SQL = await loadSql();
  const db = new SQL.Database();
  let dbBytes: Uint8Array;
  try {
    db.run(SCHEMA_SQL);

    const insert = db.prepare(
      "INSERT INTO documents (id, state, lastChangedClock) VALUES (?, ?, ?)"
    );
    let clock = 0;
    for (const [id, record] of Object.entries(archive.store)) {
      insert.run([id, JSON.stringify(record), ++clock]);
    }
    insert.free();

    db.run(
      "INSERT INTO metadata (migrationVersion, documentClock, tombstoneHistoryStartsAtClock, schema) VALUES (?, ?, ?, ?)",
      [MIGRATION_VERSION, clock, 0, JSON.stringify(archive.schema)]
    );

    dbBytes = db.export();
  } finally {
    db.close();
  }

  const encoder = new TextEncoder();
  const entries: ZipEntries = new Map();
  entries.set("db.sqlite", dbBytes);
  entries.set(
    "metadata.json",
    encoder.encode(
      JSON.stringify(
        {
          formatVersion: 1,
          displayName: archive.displayName,
          createdWith: "@tl/tldr-archive",
          documentClock: countRecords(archive.store),
        },
        null,
        "\t"
      )
    )
  );
  entries.set("session.json", encoder.encode(JSON.stringify(session(archive))));
  // The script tree round-trips, but `metadata.json`'s `script.sha256` does
  // not: the desktop app's digest recipe isn't reproducible from the archive,
  // so the key is left off rather than written wrong.
  for (const [path, bytes] of archive.scriptFiles ?? []) {
    entries.set(`script/${path}`, bytes);
  }
  entries.set("assets/", new Uint8Array(0));
  return zip(entries);
}

function countRecords(store: SerializedStore<TLRecord>) {
  return Object.keys(store).length;
}

function session(archive: { store: SerializedStore<TLRecord> }) {
  const pageIds = Object.keys(archive.store).filter((id) =>
    id.startsWith("page:")
  );
  return {
    version: 0,
    currentPageId: pageIds[0] ?? "page:page",
    exportBackground: true,
    isFocusMode: false,
    isDebugMode: false,
    isToolLocked: false,
    isGridMode: false,
    pageStates: pageIds.map((pageId) => ({
      pageId,
      camera: { x: 0, y: 0, z: 1 },
      selectedShapeIds: [],
      focusedGroupId: null,
    })),
  };
}
