import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAcyclicStaticChunkGraph } from "./production-javascript-import-contract.mjs";

const maximumBytes = 500_000;
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = resolve(webRoot, "dist", "assets");

async function javascriptFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files.sort();
}

const files = await javascriptFiles(assetsRoot);
if (files.length === 0) {
  throw new Error("生产构建中没有 JavaScript 资源，无法验证体积预算");
}

const oversized = [];
const artifacts = [];
for (const path of files) {
  const bytes = (await stat(path)).size;
  if (bytes > maximumBytes) oversized.push({ path, bytes });
  artifacts.push({
    name: path.slice(assetsRoot.length + 1),
    source: await readFile(path, "utf8"),
  });
}

if (oversized.length > 0) {
  const details = oversized
    .map(({ path, bytes }) => `${path.slice(webRoot.length + 1)}: ${bytes} > ${maximumBytes} bytes`)
    .join("\n");
  throw new Error(`生产 JavaScript 单文件超过体积预算：\n${details}`);
}

assertAcyclicStaticChunkGraph(artifacts);

process.stdout.write(
  `生产 JavaScript 契约通过：${files.length} 个文件均不超过 ${maximumBytes} bytes，静态分块依赖图无循环。\n`,
);
