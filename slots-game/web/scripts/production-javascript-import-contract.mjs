import { posix } from "node:path";
import { init, parse } from "es-module-lexer";

await init;

/** 提取所有静态模块来源，包括 import、重导出和仅副作用导入；动态 import 不参与初始化图。 / English: Extract all static module sources, including imports, re-exports, and side-effect-only imports; dynamic imports do not participate in the initialization graph. */
export function staticModuleSpecifiers(source) {
  const [imports] = parse(source);
  return imports
    .filter(({ d }) => d === -1)
    .map(({ n, s, e }) => n ?? source.slice(s, e));
}

function normalizedArtifactName(name) {
  const normalized = posix.normalize(name.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || posix.isAbsolute(normalized)
  ) {
    throw new Error(`生产 JavaScript 产物名称越出资源根目录：${name}`);
  }
  return normalized;
}

function localArtifactReference(importerName, specifier) {
  const path = specifier.split(/[?#]/, 1)[0];
  if (path.startsWith("/assets/")) return normalizedArtifactName(path.slice("/assets/".length));
  if (!path.startsWith("./") && !path.startsWith("../")) return null;

  const resolved = posix.normalize(posix.join(posix.dirname(importerName), path));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`生产 JavaScript 静态引用越出资源根目录：${importerName} -> ${specifier}`);
  }
  return resolved;
}

/** 构造所有生产 JavaScript 产物之间的静态依赖图。 / English: Construct a static dependency graph between all production JavaScript artifacts. */
export function staticChunkGraph(artifacts) {
  const sources = new Map();
  for (const artifact of artifacts) {
    const name = normalizedArtifactName(artifact.name);
    if (sources.has(name)) throw new Error(`生产 JavaScript 产物名称重复：${name}`);
    sources.set(name, artifact.source);
  }

  if (sources.size === 0) throw new Error("生产构建中没有 JavaScript 资源，无法验证静态依赖图");

  const graph = new Map([...sources.keys()].sort().map((name) => [name, new Set()]));
  const missing = [];
  for (const [name, source] of sources) {
    let specifiers;
    try {
      specifiers = staticModuleSpecifiers(source);
    } catch (error) {
      throw new Error(`无法解析生产 JavaScript 产物 ${name}`, { cause: error });
    }

    for (const specifier of specifiers) {
      const dependency = localArtifactReference(name, specifier);
      if (dependency === null) continue;
      if (sources.has(dependency)) {
        graph.get(name).add(dependency);
      } else if (/\.(?:m?js)$/i.test(dependency)) {
        missing.push(`${name} -> ${specifier}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`生产 JavaScript 静态引用缺少对应产物：\n${missing.sort().join("\n")}`);
  }
  return graph;
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of [...graph.get(node)].sort()) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dependency)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indexes.has(node)) visit(node);
  }
  return components;
}

function cycleDescription(graph, component) {
  const members = new Set(component);
  const edges = component.flatMap((name) => [...graph.get(name)]
    .filter((dependency) => members.has(dependency))
    .sort()
    .map((dependency) => `${name} -> ${dependency}`));
  return edges.join("\n");
}

/** 拒绝任意多节点强连通分量以及单节点自环。 / English: Any multi-node strongly connected components and single-node self-loops are rejected. */
export function assertAcyclicStaticChunkGraph(artifacts) {
  const graph = staticChunkGraph(artifacts);
  const cycles = stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1 || graph.get(component[0]).has(component[0]));

  if (cycles.length > 0) {
    const details = cycles.map((component) => cycleDescription(graph, component)).join("\n\n");
    throw new Error(`生产 JavaScript 静态分块图存在循环依赖：\n${details}`);
  }
  return graph;
}
