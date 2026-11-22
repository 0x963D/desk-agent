import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = ".env";

// The repository's primary checkout, which `git worktree list` always names first.
function primaryCheckout(cwd: string): string | undefined {
  try {
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /^worktree (.+)$/m.exec(listed)?.[1];
  } catch {
    return undefined;
  }
}

// The environment file the CLI loads: the one in the current folder, or else the one in the
// repository's primary checkout, so a linked worktree uses the key its main checkout holds.
export function envFile(cwd: string): string | undefined {
  const here = join(cwd, ENV_FILE);
  if (existsSync(here)) return here;
  const primary = primaryCheckout(cwd);
  const there = primary && join(primary, ENV_FILE);
  return there && existsSync(there) ? there : undefined;
}
