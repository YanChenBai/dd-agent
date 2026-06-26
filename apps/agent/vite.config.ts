import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      dev: {
        cache: false,
        command: "node --import @oxc-node/core/register src/index.ts",
        dependsOn: ["@dd-agent/native#build"],
      },
    },
  },
});
