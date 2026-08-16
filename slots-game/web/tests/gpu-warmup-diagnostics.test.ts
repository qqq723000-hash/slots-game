import { describe, expect, it } from "vitest";
import {
  GPU_WARMUP_RESOURCE_LIMIT,
  collectGpuWarmupDiagnosticBaseTextures,
  createGpuWarmupUploadDiagnostic,
  retainSlowGpuWarmupUploads,
  sanitizeGpuWarmupPublicUrl,
  type GpuWarmupBaseTextureLike,
  type GpuWarmupUploadDiagnostic,
} from "../src/renderer/GpuWarmupDiagnostics";

const LOCAL_ORIGIN = "https://game.example";

function baseTexture(
  url: string,
  width: number,
  height: number,
  cacheId = url,
): GpuWarmupBaseTextureLike {
  return {
    cacheId,
    textureCacheIds: [cacheId],
    realWidth: width,
    realHeight: height,
    resource: { src: url },
  };
}

function upload(
  group: string,
  groupIndex: number,
  durationMs: number,
): GpuWarmupUploadDiagnostic {
  return createGpuWarmupUploadDiagnostic({
    group,
    groupIndex,
    targetType: "Sprite",
    durationMs,
    baseTextures: [baseTexture(`/assets/${group}.avif`, 10, 10)],
    origin: LOCAL_ORIGIN,
  });
}

describe("GPU warmup diagnostics", () => {
  it("keeps only a stripped and bounded same-origin public asset path", () => {
    expect(sanitizeGpuWarmupPublicUrl(
      "https://game.example/assets/primal-runtime/spine/ui.avif?token=secret#frame",
      LOCAL_ORIGIN,
    )).toBe("/assets/primal-runtime/spine/ui.avif");
    expect(sanitizeGpuWarmupPublicUrl(
      "https://cdn.example/assets/private.avif?token=secret",
      LOCAL_ORIGIN,
    )).toBeNull();
    expect(sanitizeGpuWarmupPublicUrl(
      "file:///Users/player/private/atlas.png",
      LOCAL_ORIGIN,
    )).toBeNull();
    expect(sanitizeGpuWarmupPublicUrl(
      "//attacker.example/assets/private.avif?token=secret",
      LOCAL_ORIGIN,
    )).toBeNull();
    expect(sanitizeGpuWarmupPublicUrl(
      "/assets/%2e%2e/private/player.png?token=secret",
      LOCAL_ORIGIN,
    )).toBeNull();
    expect(sanitizeGpuWarmupPublicUrl(
      "/internal/session/player-123.png",
      LOCAL_ORIGIN,
    )).toBeNull();

    const bounded = sanitizeGpuWarmupPublicUrl(
      `/assets/${"nested/".repeat(40)}atlas.avif?authorization=secret`,
      LOCAL_ORIGIN,
      72,
    );
    expect(bounded).toHaveLength(72);
    expect(bounded?.endsWith("…")).toBe(true);
    expect(bounded).not.toContain("secret");
  });

  it("describes unique BaseTextures with RGBA byte estimates and bounded resources", () => {
    const largest = baseTexture(
      "https://game.example/assets/spine/ui-level1.avif?signature=private",
      4_081,
      3_490,
    );
    const duplicate = largest;
    const generatedCanvas: GpuWarmupBaseTextureLike = {
      cacheId: "pixiid_42",
      realWidth: 162,
      realHeight: 63,
      resource: { src: "" },
    };
    const extras = Array.from({ length: GPU_WARMUP_RESOURCE_LIMIT + 2 }, (_, index) => (
      baseTexture(`/assets/extra-${index}.png`, 20 + index, 20 + index)
    ));

    const diagnostic = createGpuWarmupUploadDiagnostic({
      group: "textures",
      groupIndex: 28,
      targetType: "Sprite",
      durationMs: 398.123_87,
      baseTextures: [generatedCanvas, largest, duplicate, ...extras],
      origin: LOCAL_ORIGIN,
    });

    expect(diagnostic.durationMs).toBe(398.124);
    expect(diagnostic.textureCount).toBe(2 + extras.length);
    expect(diagnostic.resources).toHaveLength(GPU_WARMUP_RESOURCE_LIMIT);
    expect(diagnostic.resources[0]).toEqual({
      cacheId: "/assets/spine/ui-level1.avif",
      url: "/assets/spine/ui-level1.avif",
      width: 4_081,
      height: 3_490,
      estimatedRgbaBytes: 4_081 * 3_490 * 4,
    });
    expect(diagnostic.resources.some((resource) => resource.cacheId === "pixiid_42")).toBe(true);
    expect(diagnostic.totalEstimatedRgbaBytes).toBe(
      162 * 63 * 4
      + 4_081 * 3_490 * 4
      + extras.reduce((total, _entry, index) => total + (20 + index) ** 2 * 4, 0),
    );
    expect(JSON.stringify(diagnostic)).not.toContain("signature");
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });

  it("sorts slow uploads deterministically, replaces a repeated target, and truncates top-N", () => {
    let retained: readonly GpuWarmupUploadDiagnostic[] = [];
    for (const entry of [
      upload("game", 0, 9),
      upload("textures", 2, 80),
      upload("textures", 1, 80),
      upload("far", 0, 42),
    ]) {
      retained = retainSlowGpuWarmupUploads(retained, entry, 3);
    }

    expect(retained.map((entry) => [entry.group, entry.groupIndex, entry.durationMs])).toEqual([
      ["textures", 1, 80],
      ["textures", 2, 80],
      ["far", 0, 42],
    ]);

    retained = retainSlowGpuWarmupUploads(retained, upload("textures", 1, 12), 3);
    expect(retained.map((entry) => [entry.group, entry.groupIndex, entry.durationMs])).toEqual([
      ["textures", 2, 80],
      ["far", 0, 42],
      ["textures", 1, 12],
    ]);
  });

  it("normalizes invalid timing, dimensions, labels, and capacity without throwing", () => {
    const diagnostic = createGpuWarmupUploadDiagnostic({
      group: "unsafe group / player",
      groupIndex: Number.POSITIVE_INFINITY,
      targetType: "Display Object / local path",
      durationMs: Number.NaN,
      baseTextures: [{
        cacheId: "/Users/player/atlas.png",
        realWidth: Number.POSITIVE_INFINITY,
        realHeight: -5,
        resource: { src: "data:image/png;base64,private" },
      }],
      origin: LOCAL_ORIGIN,
    });

    expect(diagnostic).toMatchObject({
      group: "unknown",
      groupIndex: 0,
      targetType: "DisplayObject",
      durationMs: 0,
      textureCount: 1,
      totalEstimatedRgbaBytes: 0,
    });
    expect(diagnostic.resources[0]).toEqual({
      cacheId: null,
      url: null,
      width: 0,
      height: 0,
      estimatedRgbaBytes: 0,
    });
    expect(retainSlowGpuWarmupUploads([], diagnostic, 0)).toEqual([]);
  });

  it("collects unique attached renderable BaseTextures in stable graph order", () => {
    const first = baseTexture("/assets/first.png", 100, 100);
    const second = baseTexture("/assets/second.png", 200, 200);
    const root: {
      renderable: boolean;
      transform: object;
      children: Array<{
        parent: unknown;
        renderable: boolean;
        transform: object | null;
        texture: { baseTexture: GpuWarmupBaseTextureLike };
      }>;
    } = { renderable: true, transform: {}, children: [] };
    root.children.push(
      { parent: root, renderable: true, transform: {}, texture: { baseTexture: first } },
      { parent: root, renderable: true, transform: {}, texture: { baseTexture: first } },
      { parent: null, renderable: true, transform: {}, texture: { baseTexture: second } },
      { parent: root, renderable: false, transform: {}, texture: { baseTexture: second } },
      { parent: root, renderable: true, transform: null, texture: { baseTexture: second } },
      { parent: root, renderable: true, transform: {}, texture: { baseTexture: second } },
    );

    expect(collectGpuWarmupDiagnosticBaseTextures(root)).toEqual([first, second]);
  });
});
