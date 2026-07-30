const http = require("node:http");
const { readFile, stat } = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = Number(process.argv[2] || 4173);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(
      new URL(request.url, `http://${request.headers.host}`).pathname,
    );
    const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const filePath = path.resolve(root, relative);
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const info = await stat(filePath);
    const finalPath = info.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const body = await readFile(finalPath);
    response.writeHead(200, {
      "Content-Type":
        contentTypes[path.extname(finalPath).toLowerCase()] ??
        "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static test server listening on ${port}`);
});
