// What the page's importmap gives the tool, made up for its tests. `host`
// says what's there.
export const host = { tools: [], versions: {}, selected: [] };

const listeners = new Set();

export const packages = {
  on(_event, cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  async versions(key) {
    return host.versions[key] ?? [];
  },
};

export const getType = (doc) => doc?.["@patchwork"]?.type;
export const toolsForType = () => host.tools;
export const tool = (id) => host.tools.find((t) => t.id === id);
export const defaultTool = () => host.tools[0];

export class OpenDocumentEvent extends CustomEvent {
  constructor(detail) {
    super("patchwork:open-document", { detail, bubbles: true, composed: true });
  }
}

export function subscribe(_element, _selector, listener) {
  queueMicrotask(() => listener(host.selected));
  return () => {};
}
