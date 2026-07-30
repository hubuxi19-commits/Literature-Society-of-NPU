const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const server = spawn(process.execPath, ["tests/static-server.cjs", "4173"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

function waitForServer(attempts = 40) {
  return new Promise((resolve, reject) => {
    const tryRequest = (remaining) => {
      const request = http.get("http://127.0.0.1:4173/", (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else if (remaining > 0) setTimeout(() => tryRequest(remaining - 1), 100);
        else reject(new Error(`测试服务器返回 ${response.statusCode}`));
      });
      request.on("error", () => {
        if (remaining > 0) setTimeout(() => tryRequest(remaining - 1), 100);
        else reject(new Error("测试服务器没有在 4173 端口启动"));
      });
      request.setTimeout(1000, () => request.destroy());
    };
    tryRequest(attempts);
  });
}

async function run() {
  try {
    await waitForServer();
    const browserCheck = spawn(process.execPath, ["tests/browser-check.cjs"], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    const exitCode = await new Promise((resolve) => {
      browserCheck.on("exit", (code) => resolve(code ?? 1));
    });
    process.exitCode = exitCode;
  } finally {
    server.kill();
  }
}

run().catch((error) => {
  console.error(error);
  server.kill();
  process.exitCode = 1;
});
