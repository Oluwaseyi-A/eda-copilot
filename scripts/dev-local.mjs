import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(".");
const webPort = Number(process.env.WEB_PORT || 5173);
const apiPort = Number(process.env.PORT || 8080);

const api = spawn(process.execPath, ["build/cloud-api.js"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, PORT: String(apiPort) },
});

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

const web = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://localhost:${webPort}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalizedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const diskPath = join(root, normalizedPath);

  if (!diskPath.startsWith(root + sep) && diskPath !== root) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!existsSync(diskPath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes.get(extname(diskPath)) || "application/octet-stream",
  });
  createReadStream(diskPath).pipe(response);
});

web.listen(webPort, () => {
  console.log(`EDA Copilot web: http://localhost:${webPort}/index.html`);
  console.log(`EDA Copilot API: http://localhost:${apiPort}/api/health`);
});

function shutdown() {
  web.close();
  api.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
