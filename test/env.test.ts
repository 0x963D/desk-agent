import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { envFile } from "../src/env.ts";
import { tempDir } from "./helpers.ts";

async function repoWithWorktree(): Promise<{ primary: string; linked: string }> {
  const primary = await tempDir();
  const linked = join(await tempDir(), "linked");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: primary,
      stdio: "ignore",
    });
  git("init", "-q");
  await writeFile(join(primary, "README.md"), "a repository\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "start");
  git("worktree", "add", "-q", linked);
  return { primary, linked };
}

const real = (path: string | undefined) => path && realpathSync(path);

test("a linked worktree without an environment file uses the one in the primary checkout", async () => {
  const { primary, linked } = await repoWithWorktree();
  await writeFile(join(primary, ".env"), "DESK_AGENT_TEST=primary\n");

  expect(real(envFile(linked))).toBe(real(join(primary, ".env")));
});

test("an environment file in the current folder wins over the primary checkout's", async () => {
  const { primary, linked } = await repoWithWorktree();
  await writeFile(join(primary, ".env"), "DESK_AGENT_TEST=primary\n");
  await writeFile(join(linked, ".env"), "DESK_AGENT_TEST=linked\n");

  expect(real(envFile(linked))).toBe(real(join(linked, ".env")));
});

test("no environment file is found when neither checkout holds one, or outside Git", async () => {
  const { linked } = await repoWithWorktree();

  expect(envFile(linked)).toBeUndefined();
  expect(envFile(await tempDir())).toBeUndefined();
});
