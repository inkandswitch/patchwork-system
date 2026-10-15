// An in-process stand-in for the sync server and the origin's database.
import type {
  Chunk,
  ManagedTransport,
  StorageAdapterInterface,
  StorageKey,
  WebSocketEndpointInterface,
} from "@automerge/automerge-repo";
import {
  MessagePortTransport,
  type Subduction,
} from "@automerge/automerge-subduction";

export const SERVICE = "sync.test";

export class MemoryAdapter implements StorageAdapterInterface {
  readonly data = new Map<string, Uint8Array>();
  #key = (key: StorageKey) => key.join("\u0000");

  async load(key: StorageKey) {
    return this.data.get(this.#key(key));
  }
  async save(key: StorageKey, value: Uint8Array) {
    this.data.set(this.#key(key), value);
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    for (const [key, value] of entries) this.data.set(this.#key(key), value);
  }
  async remove(key: StorageKey) {
    this.data.delete(this.#key(key));
  }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const start = this.#key(prefix);
    return [...this.data]
      .filter(([key]) => key === start || key.startsWith(start + "\u0000"))
      .map(([key, data]) => ({ key: key.split("\u0000"), data }));
  }
  async removeRange(prefix: StorageKey) {
    for (const { key } of await this.loadRange(prefix)) await this.remove(key);
  }
}

export type Server = { subduction: Subduction; up: boolean };

export function endpointTo(server: Server): WebSocketEndpointInterface {
  return {
    url: `ws://${SERVICE}`,
    async connect() {
      if (!server.up) throw new Error("server is down");
      const { port1, port2 } = new MessageChannel();
      void server.subduction
        .acceptTransport(new MessagePortTransport(port2), SERVICE)
        .catch(() => {});
      const transport = new MessagePortTransport(port1);
      const closed = new Promise<void>((resolve) =>
        transport.onDisconnect(() => resolve())
      );
      return Object.assign(transport, {
        closed: () => closed,
      }) as unknown as ManagedTransport;
    },
  };
}

export async function eventually(
  check: () => boolean | Promise<boolean>,
  ms = 10_000
) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`not within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
