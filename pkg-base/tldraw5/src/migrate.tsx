// A tldraw4 document opened in this tool is offered a one-way migration to
// tldraw5. The migration runs tldraw's own schema migrations by loading the
// stored snapshot into a v5 store, then writes the migrated records back and
// retypes the document.
//
// It has to be offered rather than done implicitly: mounting a v5 store on a v4
// document migrates the records in memory, and the store->Automerge sync would
// then write them back the moment anything moved. The gate in `tool.tsx` runs
// before that store exists.

import { useState } from "react";
import { createTLStore, defaultShapeUtils } from "@tldraw/tldraw";
import {
  getRegistry,
  type DatatypeDescription,
} from "@inkandswitch/patchwork-plugins";
import type { DocHandle } from "@automerge/automerge-repo/slim";

import type { TLDrawDoc } from "./datatype.ts";
import { PatchworkDocShapeUtil } from "./PatchworkDocShape.tsx";

export const TLDRAW4_TYPE = "tldraw4";
export const TLDRAW5_TYPE = "tldraw5";

type PatchworkMeta = {
  "@patchwork"?: { type?: string; suggestedImportUrl?: string };
};

export function getDocType(doc: unknown): string | undefined {
  return (doc as PatchworkMeta | undefined)?.["@patchwork"]?.type;
}

function tldraw5ImportUrl(): string | undefined {
  try {
    const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
    return registry.get(TLDRAW5_TYPE)?.importUrl;
  } catch {
    return undefined;
  }
}

export function migrateToTldraw5(handle: DocHandle<TLDrawDoc>) {
  const doc = handle.doc();
  if (!doc) throw new Error("document not loaded");

  const store = createTLStore({
    shapeUtils: [...defaultShapeUtils, PatchworkDocShapeUtil],
  });
  store.loadStoreSnapshot({
    store: JSON.parse(JSON.stringify(doc.store)),
    schema: JSON.parse(JSON.stringify(doc.schema)),
  });

  // Through JSON so the snapshot carries no `undefined`, which Automerge
  // refuses to store.
  const snapshot = JSON.parse(
    JSON.stringify(store.getStoreSnapshot())
  ) as TLDrawDoc;
  const importUrl = tldraw5ImportUrl();

  handle.change((d) => {
    d.store = snapshot.store;
    d.schema = snapshot.schema;
    const meta = (d as TLDrawDoc & PatchworkMeta)["@patchwork"];
    if (meta) {
      meta.type = TLDRAW5_TYPE;
      if (importUrl) meta.suggestedImportUrl = importUrl;
    }
  });
}

export function MigratePrompt({
  handle,
  readOnly,
}: {
  handle: DocHandle<TLDrawDoc>;
  readOnly: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onMigrate = () => {
    setBusy(true);
    setError(null);
    try {
      migrateToTldraw5(handle);
    } catch (err) {
      console.error("[tldraw5] migration failed", err);
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="tldraw5-migrate">
      <h2>This is a tldraw 4 document</h2>
      <p>
        Migrating rewrites its shapes to the tldraw 5 schema and retypes the
        document, so the tldraw 4 tool will no longer open it. Anyone else with
        this document is affected too.
      </p>
      <p>
        <strong>There is no undo for this</strong> — copy the document first if
        you want to keep a tldraw 4 version.
      </p>
      {readOnly ? (
        <p data-note>
          This view is pinned to a point in history and can't be written to.
          Open the document at its latest version to migrate it.
        </p>
      ) : (
        <button type="button" onClick={onMigrate} disabled={busy}>
          {busy ? "Migrating…" : "Migrate to tldraw 5"}
        </button>
      )}
      {error && <p data-error>{error}</p>}
    </div>
  );
}
