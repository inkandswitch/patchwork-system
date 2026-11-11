// Starting the automerge worker's wasm: automerge and subduction, each from
// the file this build emitted (see
// emitted.ts). Tabs need only automerge: their Repo's backend is a port to
// the worker.
import { initializeWasm } from "@automerge/automerge/slim";
import { AUTOMERGE_WASM, SUBDUCTION_WASM } from "./emitted.js";

let ready: Promise<void> | undefined;

export function initHubWasm(): Promise<void> {
  ready ??= Promise.all([
    initializeWasm(new Request(AUTOMERGE_WASM)),
    initSubduction(),
  ]).then(() => undefined);
  ready.catch(() => (ready = undefined));
  return ready;
}

// subduction's slim entry re-exports its wasm-bindgen module's named exports
// but not the default init, so it is started with `initSync` on a module
// compiled here
async function initSubduction() {
  const [slim, module] = await Promise.all([
    import("@automerge/subduction/slim"),
    compile(SUBDUCTION_WASM),
  ]);
  // in the module, but not in the slim entry's types
  const { initSync } = slim as unknown as {
    initSync(input: { module: WebAssembly.Module }): unknown;
  };
  initSync({ module });
}

async function compile(url: string): Promise<WebAssembly.Module> {
  const module = await WebAssembly.compileStreaming(fetch(url));
  compiled.set(module, url);
  return module;
}

const compiled = new WeakMap<WebAssembly.Module, string>();

/** Every wasm memory instantiated here, with the file it was compiled from. */
const memories: Array<{ url: string; memory: WebAssembly.Memory }> = [];
let watching = false;

/**
 * Note the memory of every wasm instance from here on. automerge
 * instantiates from its `Request` (instantiateStreaming), subduction from
 * the module compiled above (new WebAssembly.Instance); none hands back its
 * instance.
 */
export function watchWasmMemories(): void {
  if (watching) return;
  watching = true;
  const note = (url: string, instance: WebAssembly.Instance) => {
    for (const value of Object.values(instance.exports)) {
      if (value instanceof WebAssembly.Memory)
        memories.push({ url, memory: value });
    }
  };
  const wasm = WebAssembly as {
    instantiateStreaming: typeof WebAssembly.instantiateStreaming;
    Instance: typeof WebAssembly.Instance;
  };
  const instantiateStreaming = wasm.instantiateStreaming;
  wasm.instantiateStreaming = async (source, imports) => {
    const response = await source;
    const result = await instantiateStreaming(response, imports);
    note(response.url, result.instance);
    return result;
  };
  const Instance = wasm.Instance;
  wasm.Instance = class extends Instance {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      super(module, imports);
      const url = compiled.get(module);
      if (url) note(url, this);
    }
  };
}

const bytesFrom = (file: string) =>
  memories
    .filter(
      ({ url }) =>
        new URL(url, self.location.href).pathname ===
        new URL(file, self.location.href).pathname
    )
    .reduce((bytes, { memory }) => bytes + memory.buffer.byteLength, 0);

/** How much memory this instance's wasm holds, in MB. */
export function wasmGrowthMb(): number {
  const bytes = bytesFrom(AUTOMERGE_WASM) + bytesFrom(SUBDUCTION_WASM);
  return Math.round(bytes / 1048576);
}
