const { spawn } = require("node:child_process");
const path = require("node:path");
const { waitForServerReady } = require("./browser-harness.cjs");

const root = path.resolve(__dirname, "..");
const server = spawn(process.execPath, ["tests/static-server.cjs", "0"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === null) {
        reject(new Error(`浏览器检查异常退出（signal=${signal ?? "null"}）`));
      } else {
        resolve(code);
      }
    });
  });
}

async function stopServer() {
  if (
    !server.pid ||
    server.exitCode !== null ||
    server.signalCode !== null
  ) {
    return;
  }
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await exited;
}

async function run() {
  try {
    const baseUrl = await waitForServerReady(server);
    const browserCheck = spawn(process.execPath, ["tests/browser-check.cjs"], {
      cwd: root,
      env: {
        ...process.env,
        BROWSER_CHECK_BASE_URL: baseUrl,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    process.exitCode = await waitForChildExit(browserCheck);
  } finally {
    await stopServer();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
