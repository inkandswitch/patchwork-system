// A static server for the spike. /__spike/* answers "server", so a worker
// can tell whether its fetches went through the service worker.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT ?? 5199);
const types = { ".html": "text/html", ".js": "text/javascript" };

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");
  const headers = { "cache-control": "no-store" };
  if (pathname.startsWith("/__spike/")) {
    response.writeHead(200, headers).end("server");
    return;
  }
  const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    headers["content-type"] = types[extname(file)] ?? "application/octet-stream";
    response.writeHead(200, headers).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, () => console.log(`spike on http://localhost:${port}`));
