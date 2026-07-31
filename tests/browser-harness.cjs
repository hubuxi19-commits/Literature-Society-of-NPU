const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const DEFAULT_BROWSER_BASE_URL = "http://127.0.0.1:4173";

function waitForServerReady(server, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      server.stdout.off("data", onStdout);
      server.stderr.off("data", onStderr);
      server.off("error", onError);
      server.off("exit", onExit);
    };
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation(value);
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(
          /^Static test server listening on 127\.0\.0\.1:(\d+)$/,
        );
        if (!match) continue;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        finish(resolve, `http://127.0.0.1:${port}`);
        return;
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString();
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => {
      const detail = stderr.trim();
      finish(
        reject,
        new Error(
          detail ||
            `测试服务器在就绪前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`,
        ),
      );
    };
    const timeout = setTimeout(
      () => finish(reject, new Error("测试服务器没有报告就绪端口")),
      timeoutMs,
    );

    server.stdout.on("data", onStdout);
    server.stderr.on("data", onStderr);
    server.once("error", onError);
    server.once("exit", onExit);
  });
}

function resolveBrowserBaseUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      !url.username &&
      !url.password
    ) {
      return url.origin;
    }
  } catch {
    // Use the stable local fallback below.
  }
  return DEFAULT_BROWSER_BASE_URL;
}

function inspectPng(png) {
  if (!Buffer.isBuffer(png) || png.length < 33) {
    throw new Error("PNG IHDR 数据块不完整");
  }
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("导出文件的 PNG 签名不正确");
  }
  const ihdrLength = png.readUInt32BE(8);
  const firstChunkType = png.subarray(12, 16).toString("ascii");
  if (ihdrLength !== 13 || firstChunkType !== "IHDR") {
    throw new Error("PNG 首个数据块必须是长度 13 的 IHDR");
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

module.exports = {
  inspectPng,
  resolveBrowserBaseUrl,
  waitForServerReady,
};
