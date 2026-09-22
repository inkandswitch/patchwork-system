import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim";

type Item = { from: string; text: string; at: number };
type Doc = { items: Item[] };

const params = new URLSearchParams(location.search);
const tabName =
  params.get("name") ??
  `tab-${Math.random().toString(36).slice(2, 6)}`;

const css = `
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #111; color: #eee; }
  header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;
           padding: 10px 14px; border-bottom: 1px solid #333; }
  header b { font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .on { background: #4ade80; } .off { background: #f87171; }
  main { display: grid; grid-template-columns: 1fr 320px; gap: 0; height: calc(100vh - 43px); }
  #items { overflow: auto; padding: 14px; margin: 0; list-style: none; }
  #items li { padding: 2px 0; }
  #items .me { color: #93c5fd; }
  aside { border-left: 1px solid #333; padding: 14px; overflow: auto; }
  aside dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; }
  aside dt { color: #888; } aside dd { margin: 0; word-break: break-all; }
  form { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid #333;
         grid-column: 1 / -1; }
  input[type=text] { flex: 1; background: #1c1c1c; border: 1px solid #333; color: #eee;
                     padding: 6px 8px; font: inherit; }
  button { background: #222; border: 1px solid #444; color: #eee; padding: 6px 12px;
           font: inherit; cursor: pointer; }
  button:hover { background: #2a2a2a; }
  a { color: #93c5fd; }
`;

async function start() {
  const bench = window.bench;
  const repo = window.repo;
  if (!repo) {
    document.body.textContent = `${bench.mode}: no repo in this mode`;
    return;
  }

  let url = params.get("doc") as AutomergeUrl | null;
  if (!url) {
    const created = repo.create<Doc>({ items: [] });
    url = created.url;
    params.set("doc", url);
    history.replaceState(null, "", `?${params}`);
  }

  const { handle } = (await bench.find(url)) as unknown as {
    handle: DocHandle<Doc>;
  };
  await handle.whenReady();

  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
  document.body.innerHTML = `
    <header>
      <b>${bench.mode}</b>
      <span>${tabName}</span>
      <span><span class="dot off" id="dot"></span> <span id="net">…</span></span>
      <button id="cut">go offline</button>
      <a id="another" target="_blank">open another tab</a>
    </header>
    <main>
      <ul id="items"></ul>
      <aside>
        <dl>
          <dt>doc</dt><dd id="docid"></dd>
          <dt>heads</dt><dd id="heads"></dd>
          <dt>server heads</dt><dd id="sheads"></dd>
          <dt>in step</dt><dd id="instep"></dd>
          <dt>sync rounds</dt><dd id="rounds"></dd>
          <dt>storage writes</dt><dd id="writes"></dd>
          <dt>server bytes</dt><dd id="bytes"></dd>
          <dt>items</dt><dd id="count"></dd>
        </dl>
      </aside>
      <form id="say">
        <input type="text" id="text" placeholder="say something" autocomplete="off" autofocus>
        <button type="submit">append</button>
      </form>
    </main>
  `;

  const $ = (id: string) => document.getElementById(id)!;
  ($("another") as HTMLAnchorElement).href = `?${params}&name=tab-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  $("docid").textContent = handle.documentId;

  $("say").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("text") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    handle.change((doc) => {
      doc.items.push({ from: tabName, text, at: Date.now() });
    });
  });

  let offline = false;
  $("cut").addEventListener("click", () => {
    offline = !offline;
    bench.setOffline(offline);
    $("cut").textContent = offline ? "go online" : "go offline";
  });

  const renderItems = () => {
    const items = handle.doc()?.items ?? [];
    $("items").innerHTML = items
      .map(
        (item) =>
          `<li class="${item.from === tabName ? "me" : ""}">${item.from}: ${item.text
            .replace(/</g, "&lt;")}</li>`
      )
      .join("");
    $("count").textContent = String(items.length);
  };
  handle.on("change", renderItems);
  renderItems();

  const short = (hashes: readonly string[] | undefined) =>
    hashes?.length ? hashes.map((h) => h.slice(0, 6)).join(" ") : "—";

  setInterval(async () => {
    const heads = handle.heads() ?? [];
    const server = bench.serverHeads(handle.documentId);
    $("heads").textContent = short(heads);
    $("sheads").textContent = short(server);
    $("instep").textContent = server
      ? heads.every((h) => server.includes(h))
        ? "yes"
        : "no"
      : "unknown";
    $("rounds").textContent = String(bench.syncRounds());
    $("writes").textContent = String(bench.storageWrites() ?? "—");
    $("bytes").textContent = String(bench.serverBytes() ?? "—");
    const up = await bench.isOnline();
    $("dot").className = `dot ${up ? "on" : "off"}`;
    $("net").textContent = up ? "connected" : "offline";
  }, 300);
}

void start();
