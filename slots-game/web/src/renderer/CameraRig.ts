import { Container } from "pixi.js";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";

class ParallaxLayer extends Container {
  constructor(readonly depth: number) {
    super();
  }
}

/** 一个逻辑相机，使每个世界层保持在不同的深度。 / English: A logical camera that keeps each world layer at a different depth. */
export class CameraRig extends Container {
  readonly farLayer = new ParallaxLayer(0.16);
  readonly terrainLayer = new ParallaxLayer(0.42);
  readonly actorLayer = new ParallaxLayer(0.72);
  /** 预设的前景必须在角色之后渲染并共享背景变换。 / English: The preset foreground must be rendered after the character and share the background transform. */
  readonly foregroundLayer = new ParallaxLayer(0.16);
  readonly gameLayer = new ParallaxLayer(1);
  readonly fxLayer = new ParallaxLayer(1.12);
  private readonly layers = [
    this.farLayer,
    this.terrainLayer,
    this.actorLayer,
    this.foregroundLayer,
    this.gameLayer,
    this.fxLayer,
  ];
  private viewportWidth = LOGICAL_WIDTH;
  private viewportHeight = LOGICAL_HEIGHT;
  private cameraX = 0;
  private cameraY = 0;
  private cameraZoom = 1;

  constructor() {
    super();
    this.addChild(...this.layers);
    this.setCamera(0, 0, 1);
  }

  setCamera(x: number, y: number, zoom: number): void {
    this.cameraX = x;
    this.cameraY = y;
    this.cameraZoom = zoom;
    const centerX = this.viewportWidth / 2;
    const centerY = this.viewportHeight / 2;
    for (const layer of this.layers) {
      const layerScale = 1 + (zoom - 1) * layer.depth;
      layer.pivot.set(centerX, centerY);
      layer.position.set(
        centerX - x * layer.depth,
        centerY - y * layer.depth,
      );
      layer.scale.set(layerScale);
    }
  }

  setViewportSize(width: number, height: number): void {
    this.viewportWidth = Number.isFinite(width) && width > 0 ? width : LOGICAL_WIDTH;
    this.viewportHeight = Number.isFinite(height) && height > 0 ? height : LOGICAL_HEIGHT;
    this.setCamera(this.cameraX, this.cameraY, this.cameraZoom);
  }
}
