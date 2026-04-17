import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDefaultRepoRootFromPath,
  resolveScriptLayoutFromPath,
  resolveScriptPath,
} from "../../src/lib/script-runner.js";

describe("script-runner", () => {
  it("uses the package root for packaged installs inside node_modules", () => {
    const modulePath =
      "/usr/local/lib/node_modules/@aoagents/ao-cli/dist/lib/script-runner.js";

    expect(resolveScriptLayoutFromPath(modulePath)).toBe("package-install");
    expect(resolveDefaultRepoRootFromPath(modulePath)).toBe(
      "/usr/local/lib/node_modules/@aoagents/ao-cli",
    );
  });

  it("uses the repository root for source checkouts", () => {
    const modulePath =
      "/Users/test/agent-orchestrator/packages/cli/src/lib/script-runner.ts";

    expect(resolveScriptLayoutFromPath(modulePath)).toBe("source-checkout");
    expect(resolveDefaultRepoRootFromPath(modulePath)).toBe(
      "/Users/test/agent-orchestrator",
    );
  });

  it("includes the expected scripts path in missing-script errors", () => {
    const expectedScriptsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/assets/scripts",
    );

    expect(() => resolveScriptPath("does-not-exist.sh")).toThrowError(
      new RegExp(
        `Script not found: does-not-exist\\.sh\\. Expected at: .*does-not-exist\\.sh \\(scripts directory: ${expectedScriptsDir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\)`,
      ),
    );
  });
});
