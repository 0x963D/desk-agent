---
name: verify-desk-agent
description: Verify desk-agent, the measured Romanian and English support agent, through its CLI and its one-command container check. Covers the offline tests, the tuning replay, the held-out report and the fences around scoring and recording. Use before handing off any change to src/, cases/, fixtures/, results/, package.json or the Docker files.
---

# Verify desk-agent

Run from the checkout root. The product is a CLI, `node src/cli.ts` behind the pnpm scripts, and an MCP server on stdio. Nothing on this page needs a key or the network, apart from the Docker build.

## Prepare

- `node --version` reports 24.3 or later, and `pnpm --version` reports 11.18.0, the version `packageManager` names.
- Run `pnpm install --frozen-lockfile`. A lockfile that disagrees with `package.json` fails here, as it does in CI and in the container.
- Run `git log --oneline -1` and `git status --short`. Note the commit and whether the tree is dirty before you read any number.

## Fences

- Never run `pnpm score` without the maintainer's approval. It runs the held-out set and appends a line to `results/ledger.jsonl`, and the report counts every line as one more use of the held-out set.
- Never pass `--record` to any command without the maintainer's approval and a cost estimate. It calls a paid provider.
- Never open `cases/held-out/` or `fixtures/held-out.yaml` to improve an agent, and never copy a held-out case's text, order or id into a prompt or a rule. The commands below may load them through the loader. Tune on `cases/tuning/` only.
- Never edit `results/` or `recordings/` by hand. A committed run and a committed recording are evidence.

## Drive

| Command | What it proves | A pass looks like |
| --- | --- | --- |
| `pnpm typecheck` | The source and the tests type-check under the strict `tsconfig.json`. | Exit 0, nothing printed after `tsc --noEmit`. |
| `pnpm test` | The shapes, backend, MCP server, runner, grader, summary, recorder, CLI and plain agent, offline. Model calls are stubbed or replayed. | `Test Files  12 passed (12)` and no failed test. |
| `pnpm tune --agent <name>` | One agent plays every tuning case through the runner and MCP. Writes `traces/<agent>/<run>/`. A model agent replays `recordings/<agent>/tuning/`. | Exit 0, a PASS or FAIL line per case, then the summary. The rule-based floor is `passed every check     10/19 (53%)`. |
| `pnpm replay` | Every agent in the registry that can run offline plays the tuning set. | Exit 0, one report per runnable agent, and for a model agent without recordings `skipped: recordings/<agent>/tuning holds no recordings`. |
| `pnpm regrade <run directory>` | A saved run grades the same under the current grader and cases. Writes nothing. | The same report the run printed. For a held-out run, a sentence after the numbers when no ledger line records it or the cases changed. |
| `pnpm report` | The numbers the README may quote: the latest scored run of each agent, graded again and matched to its ledger line. Writes nothing. `--markdown` prints the same table as Markdown. | Exit 0 and one row per agent. At the time of writing the only row is `rule-based`: 18 conversations, `6/18 (33%)` passed, `2/18 (11%)` resolved correctly, `12/18 (67%)` handed over, `0/18 (0%)` wrong actions, `2/18 (11%)` blocked attempts, commit `63a63ee`, scored 2 times. |
| `docker compose run --rm check` | The stranger's path. It builds a Linux image, installs with the frozen lockfile, then runs `pnpm check` with no network: typecheck, test, replay, report. | Exit 0, and the output ends with the report table. |

Pick the commands by what the change touches.

- `src/grade.ts`, `src/trace.ts`, `src/summary.ts` or a held-out case: run `pnpm test`, then `pnpm report`. When the report stops with `no longer agrees with its line in results/ledger.jsonl`, the change moves a published number. Stop and tell the maintainer, who decides whether to score again. Never edit the ledger to make it agree.
- An agent, its prompt or a tuning case: run `pnpm tune --agent <name>` on the replay. When the replay fails with `does not match its recording`, the requests changed, and only a new recording, which needs approval, can prove the change.
- `Dockerfile`, `compose.yaml`, `.dockerignore`, `package.json` or `pnpm-lock.yaml`: run the container check from a fresh clone of the committed branch, so it sees only what Git holds.

	git clone --branch <branch> <path to this repository> <empty folder>
	cd <empty folder>
	docker compose run --rm check

`compose.yaml` sets `network_mode: none`, so a pass proves the run needed no network and no key. To check what the image holds, run `docker run --rm --network none desk-agent-check ls -A`. It must list no `.git` and no `.env`.

`pnpm mcp` serves the five functions over stdio on the tuning orders. `test/mcp.test.ts` drives it through a real stdio client. To try it by hand, give the MCP Inspector the command `pnpm mcp`.

## Evidence

Save the commit, each command, its exit code and the tail of its output under `.artifacts/verification/`, which Git ignores. Keep the report table and the `traces/<agent>/<run>/` path of any tuning run you cite. For a handoff, paste the test tail and the report table, and say which commands you did not run and why.

## Cleanup

- Delete only the `traces/` run directories you created. `.artifacts/verification/` keeps the evidence.
- `docker compose run --rm` removes its container. The `desk-agent-check` image stays as the build cache. `docker image rm desk-agent-check` removes it.
- Remove any fresh clone folder you made.
- Never delete anything under `results/` or `recordings/`.
