#!/usr/bin/env node
/**
 * Serve the aggregated tools bundle (`static-dist/`, produced by
 * `scripts/bundle.mjs`) over plain HTTP with permissive CORS, so a shell
 * running on a *different* origin (the deployed PWA, `vite preview` on another
 * port, etc.) can `fetch()` the manifest and `import()` each tool.
 *
 * This is the local-development stand-in for the Netlify tools deployment.
 * Point a shell at it with either:
 *   - PATCHWORK_SYSTEM_PACKAGE_LIST_URL=http://localhost:4455/modules.json (build-time), or
 *   - localStorage.systemPackageListURL = "http://localhost:4455/modules.json" (runtime)
 *
 * Usage:
 *   node scripts/serve-tools.mjs [--dir <dir>] [--port <port>]
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { dir: "static-dist", port: 4455 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const { dir, port } = parseArgs(process.argv.slice(2));
const baseDir = resolvePath(ROOT, dir);

if (!existsSync(join(baseDir, "modules.json"))) {
  console.error(
    `No modules.json in ${baseDir}. Run \`pnpm bundle\` first.`
  );
  process.exit(1);
}

const server = createServer((req, res) => {
  // Module imports are CORS-mode; serve everything with open CORS.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  // Private Network Access: a public-origin (https) shell pointed at this
  // localhost server triggers a PNA preflight that requires this header.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // Prevent path traversal: resolve and confirm it stays under baseDir.
  const filePath = normalize(join(baseDir, urlPath));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let target = filePath;
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, "index.html");
  }
  if (!existsSync(target)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.setHeader("Content-Type", MIME[extname(target)] ?? "application/octet-stream");
  res.writeHead(200);
  createReadStream(target).pipe(res);
});

server.listen(port, () => {
  console.log(`Serving ${baseDir} with CORS at http://localhost:${port}/`);
  console.log(`  manifest: http://localhost:${port}/modules.json`);
});
