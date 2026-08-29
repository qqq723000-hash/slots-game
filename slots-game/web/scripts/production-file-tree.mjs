import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

function releasePath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  return value === "" ? "." : value;
}

function nodeKind(metadata) {
  if (metadata.isSymbolicLink()) return "symbolic-link";
  if (metadata.isFIFO()) return "fifo";
  if (metadata.isSocket()) return "socket";
  if (metadata.isBlockDevice()) return "block-device";
  if (metadata.isCharacterDevice()) return "character-device";
  return "unknown";
}

/**
 * 枚举发布输入树时不得跟随链接或静默忽略特殊节点。
 * 任何可能进入发布 COPY 边界的节点都必须是目录或经过清单摘要固定的普通文件。
 *
 * 英文 / English: Enumerations publishing input trees must not follow links or silently ignore special nodes. Any node that may enter the publishing COPY boundary must be a directory or an ordinary file that has been fixed with a manifest digest.
 */
export async function regularFilesUnder(root) {
  const output = [];

  async function visit(path) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`生产发布树含非普通节点 symbolic-link：${releasePath(root, path)}`);
    }
    if (metadata.isFile()) {
      output.push(path);
      return;
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `生产发布树含非普通节点 ${nodeKind(metadata)}：${releasePath(root, path)}`,
      );
    }
    for (const entry of await readdir(path)) await visit(resolve(path, entry));
  }

  await visit(root);
  return output.sort();
}
