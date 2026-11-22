---
name: verify-desk-agent
description: Verify desk-agent, the measured Romanian and English support agent, through its CLI and its one-command container check. Covers the offline tests, the tuning replay, the chat replay and its masked session log, the held-out report, the run list, the README check and the fences around scoring, recording and live chat. Use before handing off any change to src/, cases/, fixtures/, results/, package.json or the Docker files.
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
- Never run `pnpm chat` with a model agent and without `--replay` unless the maintainer approved a cost and a cap. It calls the paid provider on every reply. Set `SPEND_CAP_USD` to that cap for the run. A session of four turns on `plain-gpt-6-luna` cost $0.0006.
- Never commit `traces/chat/`. A session log is masked by pattern, and a pattern misses some personal data, such as a name.
- Never open `cases/held-out/` or `fixtures/held-out.yaml` to improve an agent, and never copy a held-out case's text, order or id into a prompt or a rule. The commands below may load them through the loader. Tune on `cases/tuning/` only.
- Never edit `results/` or `recordings/` by hand. A committed run and a committed recording are evidence.

## Drive

| Command | What it proves | A pass looks like |
| --- | --- | --- |
| `pnpm typecheck` | The source and the tests type-check under the strict `tsconfig.json`. | Exit 0, nothing printed after `tsc --noEmit`. |
| `pnpm test` | The shapes, backend, MCP server, runner, grader, summary, recorder, CLI, environment file lookup, plain agent, redaction, chat, blind audit packet, agreement report and label sheet, offline. Model calls are stubbed or replayed. | `Test Files  18 passed (18)` and no failed test. |
| `pnpm tune --agent <name>` | One agent plays every tuning case through the runner and MCP. Writes `traces/<agent>/<run>/`. A model agent replays `recordings/<agent>/tuning/`. | Exit 0, a PASS or FAIL line per case, then the summary. The rule-based floor is `passed every check     10/19 (53%)`. |
| `pnpm replay` | Every agent in the registry that can run offline plays the tuning set. | Exit 0 and one report per agent. At the time of writing `rule-based` passes `10/19`, `plain-gpt-6-luna` `18/19` and `plain-gpt-6.2-sol` `19/19`, the last live run of each committed under `recordings/`. A model agent without recordings prints `skipped: recordings/<agent>/tuning holds no recordings`. |
| `pnpm regrade <run directory>` | A saved run grades the same under the current grader and cases. Writes nothing. | The same report the run printed. For a held-out run, a sentence after the numbers when no ledger line records it or the cases changed. |
| `pnpm report` | The numbers the README may quote: the latest scored run of each agent, graded again and matched to its ledger line. Writes nothing. `--markdown` prints the same table as Markdown. | Exit 0 and one row per agent in `results/ledger.jsonl`: at the time of writing `rule-based`, `plain-gpt-6-luna` and `plain-gpt-6.2-sol`, scored 3 times each. The README's Results table is this output. |
| `pnpm report --runs` | Every line of `results/ledger.jsonl`, oldest first, from the ledger alone. `--markdown` prints it as Markdown. | Exit 0 and one row per ledger line with its agent, time, commit, dirty flag, cases hash and counts. At the time of writing 9 rows, all with cases hash `e610f4028cde`. |
| `pnpm report --check-readme` | The README's Results table is the current `pnpm report --markdown`. | Exit 0 and `README.md shows the current pnpm report --markdown table.` A failure names the first line of the table that differs. Fix it by pasting the output of `pnpm report --markdown` between the two marker lines, never by editing a number. |
| `pnpm chat --agent <name> --replay <tuning case id>` | A tuning case plays through the same session, MCP server and agent code as a scored run, from its committed recording, offline. Writes a masked session log under `traces/chat/<agent>/`. | Exit 0, a `customer` and an `agent` line per turn, one `·` line per function call, a `[status · time · cost]` line, and a closing line that names the session log and says the replay spent nothing. The log holds `[email]` and `[address]` where the case had an email and a street. |
| `docker compose run --rm check` | The stranger's path. It builds a Linux image, installs with the frozen lockfile, then runs `pnpm check` with no network: typecheck, test, replay, report, README check. | Exit 0, and the output ends with `README.md shows the current pnpm report --markdown table.` |

Pick the commands by what the change touches.

- `src/grade.ts`, `src/trace.ts`, `src/summary.ts` or a held-out case: run `pnpm test`, then `pnpm report`. When the report stops with `no longer agrees with its line in results/ledger.jsonl`, the change moves a published number. Stop and tell the maintainer, who decides whether to score again. Never edit the ledger to make it agree.
- `src/redact.ts` or `src/chat.ts`: run `pnpm test`, then `pnpm chat --agent plain-gpt-6-luna --replay ro-adresa-veche-inainte-de-expediere` and read the session log it names. No email, phone number, card number, IBAN or street may appear in it, and the order number must.
- `README.md`, `results/` or anything that moves a reported number: run `pnpm report --check-readme`.
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

- Delete only the `traces/` run directories and `traces/chat/` session logs you created. `.artifacts/verification/` keeps the evidence.
- `docker compose run --rm` removes its container. The `desk-agent-check` image stays as the build cache. `docker image rm desk-agent-check` removes it.
- Remove any fresh clone folder you made.
- Never delete anything under `results/` or `recordings/`.
