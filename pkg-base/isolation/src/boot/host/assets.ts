/**
 * Boot assets — the es-module-shims source, the automerge/subduction WASM
 * binaries, and the collected host styles. Fetched once and shared across all
 * isolation instances on the page (the promise is cached), since they are
 * identical for every iframe.
 *
 * Package note (differs from core): the es-module-shims source is **bundled**
 * (see ../../esms-source.generated.ts), not fetched from a host-served
 * `/es-module-shims.js`. The opaque-origin iframe can't fetch it itself and a
 * patchwork-base package can't assume the host serves it. The two WASM binaries
 * are still fetched from the host origin — that is a stable platform contract
 * every patchwork tool relies on (e.g. @patchwork/tasks fetches the same paths).
 */

import { collectHostStyles } from "./styles.js";
import { esmsSource } from "../../esms-source.generated.js";

export interface BootAssets {
  esmsSource: string;
  automergeWasm: ArrayBuffer;
  subductionWasm: ArrayBuffer;
  hostStyles: string;
}

let bootAssetsPromise: Promise<BootAssets> | null = null;

export function fetchBootAssets(): Promise<BootAssets> {
  if (bootAssetsPromise) return bootAssetsPromise;

  bootAssetsPromise = Promise.all([
    fetch("/automerge.wasm?main").then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch automerge.wasm: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch("/subduction.wasm").then((r) => {
      if (!r.ok)
        throw new Error(`Failed to fetch subduction.wasm: ${r.status}`);
      return r.arrayBuffer();
    }),
    collectHostStyles(),
  ]).then(([automergeWasm, subductionWasm, hostStyles]) => ({
    esmsSource,
    automergeWasm,
    subductionWasm,
    hostStyles,
  }));

  return bootAssetsPromise;
}
