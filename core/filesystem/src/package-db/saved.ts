import type { PackageEntry } from "./types.js";

// Two stores: every saved version of a package, and which one is current.
export function openSaved(name: string): Promise<IDBDatabase> {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("versions", { keyPath: ["key", "version"] })
      .createIndex("key", "key");
    db.createObjectStore("current", { keyPath: "key" });
  };
  return done(request);
}

export async function readCurrent(db: IDBDatabase): Promise<PackageEntry[]> {
  const tx = db.transaction(["current", "versions"]);
  const current: { key: string; version: string }[] = await done(
    tx.objectStore("current").getAll(),
  );
  return Promise.all(
    current.map(({ key, version }) =>
      done<PackageEntry>(tx.objectStore("versions").get([key, version]))
    ),
  );
}

export function readVersions(db: IDBDatabase, key: string) {
  return done<PackageEntry[]>(
    db.transaction("versions").objectStore("versions").index("key")
      .getAll(key),
  ).then((all) => all.sort((a, b) => a.addedAt - b.addedAt));
}

export function writeCurrent(db: IDBDatabase, entry: PackageEntry) {
  const tx = db.transaction(["versions", "current"], "readwrite");
  const plugins = entry.plugins.map(
    ({ load, import: _import, module, ...plugin }) => plugin,
  );
  tx.objectStore("versions").put({ ...entry, plugins });
  tx.objectStore("current").put({ key: entry.key, version: entry.version });
  return finished(tx);
}

export function deleteCurrent(db: IDBDatabase, key: string) {
  const tx = db.transaction("current", "readwrite");
  tx.objectStore("current").delete(key);
  return finished(tx);
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
