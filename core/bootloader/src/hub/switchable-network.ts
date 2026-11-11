// The worker's socket to the sync server, which can be switched off and on:
// for the bench's offline tests and as a dev escape hatch. Playwright's
// offline switch doesn't reach a SharedWorker's socket, and a
// WebSocketSubductionNetworkAdapter can't start again once stopped, so going
// back online starts a new one with the backend's `connect`.

import type {
  SubductionConnect,
  SubductionNetworkAdapterInterface,
} from "@automerge/automerge-repo-subduction";
import {
  WebSocketSubductionNetworkAdapter,
  type WebSocketConnectionStatus,
} from "@automerge/automerge-repo-subduction-network-websocket";

export class SwitchableNetwork implements SubductionNetworkAdapterInterface {
  readonly url: string;
  #inner: WebSocketSubductionNetworkAdapter;
  #unsubscribe: () => void = () => {};
  #connect: SubductionConnect | undefined;
  #offline = false;
  #status: WebSocketConnectionStatus = "idle";
  readonly #listeners = new Set<(status: WebSocketConnectionStatus) => void>();

  constructor(url: string) {
    this.url = url;
    this.#inner = this.#adapter();
  }

  get status(): WebSocketConnectionStatus {
    return this.#status;
  }

  get offline(): boolean {
    return this.#offline;
  }

  /** Called with the status now, then on every change. */
  subscribe(listener: (status: WebSocketConnectionStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#status);
    return () => this.#listeners.delete(listener);
  }

  /** Resolves once connected, across retries and offline spells. */
  connected(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#status === "connected") return resolve();
      const off = this.subscribe((status) => {
        if (status !== "connected") return;
        queueMicrotask(off);
        resolve();
      });
    });
  }

  start(connect: SubductionConnect): Promise<void> {
    this.#connect = connect;
    return this.#inner.start(connect);
  }

  stop(): Promise<void> {
    this.#unsubscribe();
    return this.#inner.stop();
  }

  async setOffline(offline: boolean): Promise<void> {
    if (offline === this.#offline) return;
    this.#offline = offline;
    if (offline) {
      this.#unsubscribe();
      await this.#inner.stop();
      this.#set("disconnected");
      return;
    }
    this.#inner = this.#adapter();
    if (this.#connect) void this.#inner.start(this.#connect).catch(() => {});
  }

  #adapter(): WebSocketSubductionNetworkAdapter {
    const adapter = new WebSocketSubductionNetworkAdapter(this.url);
    this.#unsubscribe = adapter.subscribe((status) => this.#set(status));
    return adapter;
  }

  #set(status: WebSocketConnectionStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}
