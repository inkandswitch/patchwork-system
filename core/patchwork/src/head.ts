import externals, {
  slim,
} from "@inkandswitch/patchwork-bootloader/externals-list";

const importmap: { imports: Record<string, string> } = { imports: {} };

for (const name of externals) {
  importmap.imports[name] = `/packages/${slim[name] ?? name}.js`;
}

const script = document.createElement("script");
script.type = "importmap";
script.textContent = JSON.stringify(importmap);
document.currentScript
  ? document.currentScript.after(script)
  : document.head.appendChild(script);
