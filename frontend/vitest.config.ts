import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
        execArgv: ["--max-old-space-size=512"],
      },
    },
    isolate: true,
    bail: 1,
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.d.ts"],
    },
  },
});
