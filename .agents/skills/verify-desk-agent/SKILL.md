---
name: verify-desk-agent
description: Verify desk-agent, the measured Romanian and English support agent, through its CLI and its one-command container check. Covers the offline tests, the tuning replay, the chat replay and its masked session log, the scored-set report, the run list, the README check and the fences around scoring, recording and live chat. Use before handing off any change to src/, cases/, fixtures/, results/, package.json or the Docker files.
---

# Verify desk-agent

Run from the checkout root. The product is a CLI, `node src/cli.ts` behind the pnpm scripts, and an MCP server on stdio. Nothing on this page needs a key or the network, apart from the Docker build.

## Prepare

- `node --version` reports 24.3 or later, and `pnpm --version` reports 11.18.0, the version `packageManager` names.
- Run `pnpm install --frozen-lockfile`. A lockfile that disagrees with `package.json` fails here, as it does in CI and in the container.
- Run `git log --oneline -1` and `git status --short`. Note the commit and whether the tree is dirty before you read any number.

## Fences

- Never run `pnpm score` without the maintainer's approval. It runs the held-out set, the validation set, and appends a line to `results/ledger.jsonl`, and the report counts every line as one more use of that set. `pnpm score --set final` runs the final set, the one the README quotes, and needs the same approval.
- Never pass `--record` to any command without the maintainer's approval and a cost estimate. It calls a paid provider.
- Never run `pnpm chat` with a model agent and without `--replay` unless the maintainer approved a cost and a cap. It calls the paid provider on every reply. Set `SPEND_CAP_USD` to that cap for the run. A session of four turns on `plain-gpt-6-luna` cost $0.0006.
- Never commit `traces/chat/`. A session log is masked by pattern, and a pattern misses some personal data, such as a name.
- Never open `cases/held-out/`, `cases/final/`, `fixtures/held-out.yaml` or `fixtures/final.yaml` to improve an agent, and never copy a held-out or final case's text, order or id into a prompt or a rule. The commands below may load them through the loader. Tune on `cases/tuning/` only, in the tuner's checkout below.
- Never edit `results/` or `recordings/` by hand. A committed run and a committed recording are evidence.

## The tuner's checkout

Whoever changes the prompt or the agent works in a sparse clone that holds no scored set and no saved run, so nothing they read can carry a held-out or final case into the agent.

	git clone --no-checkout <path to this repository> <empty folder>
	cd <empty folder>
	git sparse-checkout set --no-cone '/*' '!cases/held-out/' '!cases/final/' '!fixtures/held-out.yaml' '!fixtures/final.yaml' '!recordings/*/held-out/' '!recordings/*/final/' '!results/*/' '!results/*-failures.md'
	git checkout <branch>

A pattern with a slash inside it is anchored at the root, so `test/fixtures/cases/held-out/`, which the tests need, stays. The patterns after `/*` start without a slash, because Git Bash on Windows turns an argument such as `!/cases/held-out/` into a Windows path. `cat .git/info/sparse-checkout` shows what Git stored. `ls cases` lists only `tuning`. `ls results` lists only `ledger-code.json` and `ledger.jsonl`. The pattern `!results/*-failures.md` excludes both scored-set failure reviews. `pnpm typecheck`, `pnpm tune`, `pnpm replay` and `pnpm chat --replay` work there. `pnpm test`, `pnpm report` and the container check read the saved runs, so they fail there, and the maintainer runs them in a full checkout.

## Drive

| Command | What it proves | A pass looks like |
| --- | --- | --- |
| `pnpm typecheck` | The source and the tests type-check under the strict `tsconfig.json`. | Exit 0, nothing printed after `tsc --noEmit`. |
| `pnpm test` | The shapes, backend, MCP server, runner, grader, summary, recorder, CLI, environment file lookup, model agents, redaction, chat, blind audit packet, agreement report and label sheet, offline. Model calls are stubbed or replayed. | `Test Files  20 passed (20)` and no failed test. |
| `pnpm tune --agent <name>` | One agent plays every tuning case through the runner and MCP. Writes `traces/<agent>/<run>/`. A model agent replays `recordings/<agent>/tuning/`. | Exit 0, a PASS or FAIL line per case, then the summary. The rule-based floor is `passed every check     10/19 (53%)`. |
| `pnpm replay` | The rule-based agent and every registered model agent with a directory under `recordings/` play the tuning set. A missing case recording or an unowned recordings directory fails the run. | Exit 0 and one report per agent. `rule-based` passes `10/19`. `plain-gpt-6-luna` and `plain-gpt-6.2-sol` each pass `19/19` on their third step 15 run, committed under `recordings/`. A model agent without a directory prints `skipped: recordings/<agent> is missing`. |
| `pnpm regrade <run directory>` | A saved run grades the same under the current grader and cases. Writes nothing. | The same report the run printed. For a held-out run, a sentence after the numbers when no ledger line records it or the cases changed. |
| `pnpm report` | One table per scored set, final first. Each agent's row covers the runs on its latest cases and code. The report grades each run again and matches it to its ledger line. `--markdown` prints the same tables as Markdown. | Exit 0. Each table covers 1 rule-based run and 3 runs per model agent. On final, `rule-based` passes `10/18`, `plain-gpt-6-luna` passes `52/54` (17 to 18 per run), and `plain-gpt-6.2-sol` passes `51/54` (17 per run). All three rows have code `421a5b33baa2`. On validation, `rule-based` passes `4/18` and each model agent passes `47/54` (15 to 16 per run), all with code `cf4c36d9eeec`. The README's Results tables show this output. |
| `pnpm ledger:code` | Every clean ledger line without `code_sha256` has the code hash of its commit in `results/ledger-code.json`, computed from Git. Reads `results/commit-map.json` when present to resolve rewritten commits. Needs Git history for the resolved commits. | Exit 0 and `results/ledger-code.json: 0 lines added, 9 checked against Git`. Run `git status --short -- results/ledger-code.json` and expect empty output. |
| `pnpm report --runs` | Every line of `results/ledger.jsonl`, oldest first, from the ledger, `results/ledger-code.json` and the optional `results/commit-map.json`. `--markdown` prints it as Markdown. | Exit 0 and 16 rows. The 9 `held-out` rows have cases hash `e610f4028cde` and code hashes `8a3ce0df23b3`, `3a6e48f957da`, and `cf4c36d9eeec` on the last 7. The 7 `final` rows have cases hash `f1a2b385dc97` and code hash `421a5b33baa2`. |
| `pnpm report --check-readme` | The README's Results table is the current `pnpm report --markdown`. | Exit 0 and `README.md shows the current pnpm report --markdown table.` A failure names the first line of the table that differs. Fix it by pasting the output of `pnpm report --markdown` between the two marker lines, never by editing a number. |
| `pnpm chat --agent <name> --replay <tuning case id>` | A tuning case plays through the same session, MCP server and agent code as a scored run, from its committed recording, offline. Writes a masked session log under `traces/chat/<agent>/`. | Exit 0, a `customer` and an `agent` line per turn, one `·` line per function call, a `[status · time · cost]` line, and a closing line that names the session log and says the replay spent nothing. The log holds `[email]` and `[address]` where the case had an email and a street. |
| `pnpm audit:packet --out <empty folder> --key <file outside it> --seed <text>` | The blind packet for the default validation set. It shuffles the model agents' conversations under random ids and shows customer messages a handover left unplayed under **Not reached**. Writes the packet and the key outside the repository. | Exit 0 and `packet: <n> conversations from <runs> runs`, 18 conversations for each scored validation run of a model agent (432 from 24 runs when the eight model agents have three runs each), then `not reached: <m> conversations stopped at a handover before the script's last customer message`, the key path and the seed. The same seed rebuilds the same ids. Give a reader the packet folder only, never the key. |
| `pnpm audit:agreement --key <file> [--partial] <verdict file>...` | Each reader against the grader and against each other reader. Writes nothing. | Exit 0, one `reader <name>` block per file with agreement and kappa, and one `readers <a> and <b>` block per pair. A file that misses a conversation is refused unless `--partial` is given. |
| `pnpm audit:sheet --packet <dir> --ids <file> --out <file.html>` | A page a person labels in a browser, built from the packet files for the listed ids. | Exit 0 and `sheet: <n> conversations in <file>`. The page opens offline, shows a dashed **Not reached** box after a handover that cut the script short, and downloads `human.jsonl`. |
| `docker compose run --rm check` | The stranger's path. It builds a Linux image, installs with the frozen lockfile, then runs `pnpm check` with no network: typecheck, test, replay, report, README check. | Exit 0, and the output ends with `README.md shows the current pnpm report --markdown table.` |

Pick the commands by what the change touches.

- `src/grade.ts`, `src/trace.ts`, `src/summary.ts` or a held-out case: run `pnpm test`, then `pnpm report`. When the report stops with `no longer agrees with its line in results/ledger.jsonl`, the change moves a published number. Stop and tell the maintainer, who decides whether to score again. Never edit the ledger to make it agree.
- `src/redact.ts` or `src/chat.ts`: run `pnpm test`, then `pnpm chat --agent plain-gpt-6-luna --replay ro-adresa-veche-inainte-de-expediere` and read the session log it names. No email, phone number, card number, IBAN or street may appear in it, and the order number must.
- `README.md`, `results/` or anything that moves a reported number: run `pnpm report --check-readme`.
- `src/packet.ts`, `src/sheet.ts`, `src/sheet-page.*`, `docs/judging.md` or `docs/scope.md`: run `pnpm test`, then build a packet and a sheet into a folder outside the repository with the audit commands above, and open the sheet.
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
