import { defineConfig } from "vitest/config";

// The score tests run git in a temporary repository, which takes several seconds on Windows.
export default defineConfig({ test: { testTimeout: 30_000 } });
