import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const CLI_DIST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveRepoRoot(): string {
  const override = process.env["AO_REPO_ROOT"];
  return override ? resolve(override) : DEFAULT_REPO_ROOT;
}

function getScriptPath(scriptName: string): string {
  return resolve(CLI_DIST_ROOT, "assets", "scripts", scriptName);
}

export function resolveScriptPath(scriptName: string): string {
  const scriptPath = getScriptPath(scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptName}`);
  }
  return scriptPath;
}

export function hasRepoScript(scriptName: string): boolean {
  return existsSync(getScriptPath(scriptName));
}

export async function runRepoScript(scriptName: string, args: string[]): Promise<number> {
  const shell = process.env["AO_BASH_PATH"] || "bash";
  const scriptPath = resolveScriptPath(scriptName);
  const repoRoot = resolveRepoRoot();

  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(shell, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, AO_REPO_ROOT: repoRoot },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit(1);
        return;
      }

      resolveExit(code ?? 1);
    });
  });
}

export async function executeScriptCommand(scriptName: string, args: string[]): Promise<void> {
  try {
    const exitCode = await runRepoScript(scriptName, args);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
