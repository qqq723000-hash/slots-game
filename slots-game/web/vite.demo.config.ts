import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

const DEMO_BASE_PATH = "/slots-game/";
const FORBIDDEN_DEMO_MODULE = /\/src\/(?:bootstrap\.ts|testing\/|protocol\/(?:RgsGateway|configuredGateway)\.ts)/;

function staticDemoModuleBoundary(): Plugin {
  return {
    name: "static-demo-module-boundary",
    generateBundle(_options, bundle) {
      const forbidden = Object.values(bundle)
        .filter((entry) => entry.type === "chunk")
        .flatMap((entry) => Object.keys(entry.modules))
        .map((path) => path.replaceAll("\\", "/"))
        .filter((path) => FORBIDDEN_DEMO_MODULE.test(path));
      if (forbidden.length > 0) {
        throw new Error(`Static demo imported a forbidden production/test module:\n${forbidden.join("\n")}`);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode !== "demo") {
    throw new Error("The static demo must be built with --mode demo");
  }

  return {
    root: fileURLToPath(new URL("./demo", import.meta.url)),
    publicDir: fileURLToPath(new URL("./public", import.meta.url)),
    base: DEMO_BASE_PATH,
    define: {
      __PRIMAL_STATIC_DEMO__: JSON.stringify(true),
      "import.meta.env.VITE_ASSET_STREAMING_MODE": JSON.stringify("off"),
    },
    plugins: [staticDemoModuleBoundary()],
    resolve: {
      alias: [{
        find: "../protocol/configuredGateway",
        replacement: fileURLToPath(
          new URL("./src/demo/staticDemoConfiguredGateway.ts", import.meta.url),
        ),
      }],
    },
    build: {
      outDir: fileURLToPath(new URL("./dist-demo", import.meta.url)),
      emptyOutDir: true,
      manifest: false,
      sourcemap: false,
      chunkSizeWarningLimit: 2_500,
    },
    preview: {
      host: "127.0.0.1",
      port: 4174,
      strictPort: true,
    },
  };
});
