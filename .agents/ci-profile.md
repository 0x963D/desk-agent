# CI profile: desk-agent

The `ci-cd` skill reads this file. It records how this repository's CI is set up and what the skill may do here. Keep measurements and diagnoses out of it. They go stale and steer the next run toward an old answer. Put them in the skill's work folder and in PRs.

## Setup

- **Provider and runners.** GitHub Actions on GitHub-hosted standard runners (`ubuntu-latest`). The repository is public, so these runners cost nothing.
- **Workflows.** `.github/workflows/ci.yml` has one job, `Check`. It checks out, installs pnpm from `packageManager` in `package.json`, sets up Node 24 with the pnpm store cached by `actions/setup-node`, installs with a frozen lockfile, then runs the steps of `pnpm check`, each as its own step: `pnpm typecheck` (`tsc --noEmit`), `pnpm test` (`vitest run`), `pnpm replay` (the tuning set replayed for every agent from its recordings), `pnpm report` (the saved runs regraded) and `pnpm report --check-readme` (the README's table checked against the report). They are offline against recorded responses, so the job sets no secret and calls no provider. It never runs `pnpm tune`, `pnpm score` or `pnpm regrade`.
- **How a PR gets CI.** On every `pull_request` event and on every push to `main`. A newer push to the same PR cancels its running check; pushes to `main` are never cancelled. No branch rule or required check exists yet.
- **Routing.** None. Every run runs every check, and vitest picks test files by its default glob, `test/*.test.ts` today.
- **Log grammar.** None. Each command is its own step.

## Objective

- **Lead metric.** Full-run time.
- **Tolerance.** Not set. Until the owner names one, a time win that raises job-minutes per PR is a decision for the owner.

## Settings

The scripts read this block. A key left out takes the default in the table below.

```json
{
  "repo": "0x963D/desk-agent",
  "defaultBranch": "main",
  "realRuns": { "events": ["pull_request"], "excludeBranches": ["main"], "titlePattern": null, "workflows": ["ci.yml"] },
  "ignoreJobs": null,
  "setup": { "steps": "^(Set up job|Complete job|Post |Run (actions/(checkout|setup-node)|pnpm/action-setup)@|Run pnpm install)" },
  "pools": [],
  "tests": { "pattern": "\\.(test|spec)\\.[cm]?[jt]sx?$", "routing": "^(\\.github/workflows/[^/]+\\.ya?ml|vitest\\.config\\.ts)$" },
  "cost": { "perMinute": null, "currency": "USD", "roundUpPerJob": true }
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `repo` | `owner/name` on the CI provider. | none |
| `defaultBranch` | The branch whose pushes count as main runs in cost. | `main` |
| `realRuns` | Which runs are real PR runs: their `events`, branches to leave out, a `titlePattern` on the run name, and the `workflows` file names to count. | `pull_request` runs off `main` |
| `realRuns.requestTitle` | Pattern for manual dispatch titles. Capture the comparison commit in a named group `base` and the intended commit in an optional group `head`. A captured head must match the executed commit. | none |
| `realRuns.requiredJobs` | Nonempty list of exact `workflow.yml / job name` keys that must each run once for a clean request. | none |
| `ignoreJobs` | A pattern for jobs that are bookkeeping, such as a planning job or a gate job that only waits for the others. | none |
| `setup.steps` | A pattern for provider steps that are setup: job set-up, checkout, toolchain, cache, install, teardown. | GitHub's usual step names |
| `setup.groups` | A pattern for log groups inside a script that are setup. | install, cache and setup groups |
| `setup.groupSeconds` | A pattern whose first capture is a group's own duration in seconds. Needed when a script runs groups concurrently. | none |
| `pools` | Runners that share one host: `name`, a `runners` pattern over runner names and labels, and `cpus`, such as `"0-4"`. | none |
| `tests.pattern` | A pattern over tracked paths that marks test files. | common test file names |
| `tests.routing` | A pattern over tracked paths for the files that name which tests run. | workflow files |
| `cost.perMinute` | Price of one runner minute, or `null` for a host you own. One rate covers every runner, so with mixed runner sizes, price each size's job-minutes yourself and say so. | `null` |
| `cost.roundUpPerJob` | Whether the provider bills each job in whole minutes. | `false` |

`setup.steps` names the job's unnamed steps as GitHub titles them, so the pnpm setup and the dependency install count as setup. `cost.perMinute` is `null` because the runs sit inside the included minutes, so job-minutes are the cost. GitHub counts each job in whole minutes against that allowance, hence `roundUpPerJob`.

## Authority

- **Build.** The skill may open CI-only PRs through the delivery workflow below.
- **Merge.** None. Nothing merges without the owner.
- **Needs the owner's yes.** A new job or lane, a branch rule or required check, a secret or any step that calls a model, speech or telephony provider, a scheduled or manual run, moving a check off the PR, and skipping or deleting a test.

## Ruled out

- **Paid runner minutes and larger runners.** CI stays on GitHub-hosted standard runners, which cost nothing for a public repository.
- **Running `pnpm score` or any command with `--record` in CI.** `score` adds a line to the scoring ledger, and `--record` calls a paid model provider, which needs the maintainer's approval and a cost estimate first (`AGENTS.md`). `pnpm tune` and `pnpm regrade` without `--record` are offline and may run in CI.

## Runs

- **Cost of a full run.** One job on one standard runner. It loads no service; the network is used only for the toolchain and the dependency install.
- **Measurement runs.** None: measure runs that happen anyway.
- **Heavy runs.** None exist.

## Sampling

None. The runners are GitHub-hosted.

## Delivery

One change per branch off `main`, one PR per change titled `type(scope): subject`, with no AI, model or vendor names in Git metadata. The lead pushes and opens the PR; the owner reviews and merges. A CI change, this profile included, ships as its own PR.
