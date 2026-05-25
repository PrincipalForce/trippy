import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    // Default to node env. Component tests that need DOM should opt in via
    // `// @vitest-environment jsdom` at the top of the file and add jsdom as
    // a devDep when those tests arrive in M2.
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
