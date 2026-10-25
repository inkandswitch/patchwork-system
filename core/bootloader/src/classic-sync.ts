// Classic automerge-repo sync, in the tab's own Repo: a WebSocket to a legacy
// sync server, alongside the Subduction connection.
import type { Repo } from "@automerge/automerge-repo/slim";
// Not the package root, which also brings in the server adapter and `ws`.
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket/WebSocketClientAdapter";

import {
  DEFAULT_CLASSIC_SYNC_SERVER,
  readClassicSyncServer,
} from "./sync-config.js";

const connections = new WeakMap<
  Repo,
  { url: string; adapter: WebSocketClientAdapter; ready: Promise<void> }
>();

/**
 * Connect `repo` to the classic sync server at `server`, resolving once the
 * socket is up. Connecting to the server it's already connected to returns
 * the same connection; connecting to another drops the first.
 */
export function connectClassicSync(
  repo: Repo,
  server: string = readClassicSyncServer()
): Promise<void> {
  const url = server.trim() || DEFAULT_CLASSIC_SYNC_SERVER;
  if (!/^wss?:\/\//.test(url)) {
    return Promise.reject(
      new Error(`invalid classic sync server URL: ${server}`)
    );
  }
  const current = connections.get(repo);
  if (current?.url === url) return current.ready;
  if (current) repo.networkSubsystem.removeNetworkAdapter(current.adapter);

  const adapter = new WebSocketClientAdapter(url);
  repo.networkSubsystem.addNetworkAdapter(adapter);
  const ready = adapter.whenReady();
  connections.set(repo, { url, adapter, ready });
  // A later attempt starts over rather than waiting on this one.
  ready.catch(() => {
    if (connections.get(repo)?.adapter !== adapter) return;
    repo.networkSubsystem.removeNetworkAdapter(adapter);
    connections.delete(repo);
  });
  return ready;
}
