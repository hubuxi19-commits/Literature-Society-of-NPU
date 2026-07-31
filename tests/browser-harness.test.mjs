import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const {
  inspectPng,
  resolveBrowserBaseUrl,
  waitForServerReady,
} = require("./browser-harness.cjs");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

function buildPngHeader(width = 1080, height = 1920) {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    png,
    0,
  );
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test("runner 从自己启动的子进程输出解析随机端口", async () => {
  const child = new FakeChild();
  const ready = waitForServerReady(child, { timeoutMs: 200 });

  child.stdout.write("Static test server listening on 127.0.0.1:");
  child.stdout.write("54321\n");

  assert.equal(await ready, "http://127.0.0.1:54321");
});

test("runner 在服务子进程启动错误时拒绝继续", async () => {
  const child = new FakeChild();
  const ready = waitForServerReady(child, { timeoutMs: 200 });

  child.emit("error", new Error("spawn EPERM"));

  await assert.rejects(ready, /spawn EPERM/);
});

test("runner 在服务子进程就绪前退出时拒绝继续", async () => {
  const child = new FakeChild();
  const ready = waitForServerReady(child, { timeoutMs: 200 });
  child.stderr.write("listen EADDRINUSE\n");

  child.emit("exit", 1, null);

  await assert.rejects(ready, /EADDRINUSE/);
});

test("browser runner 使用端口 0 和子进程报告的专属 base URL", async () => {
  const [runner, server, browserCheck] = await Promise.all([
    readFile(new URL("./run-browser-check.cjs", import.meta.url), "utf8"),
    readFile(new URL("./static-server.cjs", import.meta.url), "utf8"),
    readFile(new URL("./browser-check.cjs", import.meta.url), "utf8"),
  ]);

  assert.match(runner, /\["tests\/static-server\.cjs",\s*"0"\]/);
  assert.doesNotMatch(runner, /require\("node:http"\)/);
  assert.match(runner, /BROWSER_CHECK_BASE_URL:\s*baseUrl/);
  assert.match(server, /server\.address\(\)\.port/);
  assert.match(browserCheck, /process\.env\.BROWSER_CHECK_BASE_URL/);
});

test("browser check 只接受本机 HTTP base URL 并安全回退", () => {
  assert.equal(
    resolveBrowserBaseUrl("http://127.0.0.1:54321/path"),
    "http://127.0.0.1:54321",
  );
  assert.equal(
    resolveBrowserBaseUrl("https://example.com"),
    "http://127.0.0.1:4173",
  );
  assert.equal(resolveBrowserBaseUrl("not a url"), "http://127.0.0.1:4173");
});

test("PNG 检查读取完整签名后的 IHDR 尺寸", () => {
  assert.deepEqual(inspectPng(buildPngHeader()), {
    width: 1080,
    height: 1920,
  });
});

test("PNG 检查拒绝仅中间三个字节为 PNG 的伪文件", () => {
  const invalid = buildPngHeader();
  invalid[0] = 0;

  assert.throws(() => inspectPng(invalid), /PNG 签名/);
});

test("PNG 检查要求首个数据块为长度 13 的 IHDR", () => {
  const wrongType = buildPngHeader();
  wrongType.write("IDAT", 12, "ascii");
  assert.throws(() => inspectPng(wrongType), /IHDR/);

  const wrongLength = buildPngHeader();
  wrongLength.writeUInt32BE(12, 8);
  assert.throws(() => inspectPng(wrongLength), /IHDR/);
});

test("PNG 检查拒绝被截断的 IHDR 数据块", () => {
  assert.throws(() => inspectPng(buildPngHeader().subarray(0, 24)), /IHDR/);
});
