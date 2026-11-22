# desk-agent

A bilingual (Romanian and English) customer-support agent, built and measured the way a forward-deployed engineer delivers one: test set first, then the agent, then results on held-out conversations.

Work in progress. Results, architecture and setup will appear here as they are measured.

## Results

<!-- report table: start -->
| agent | runs | conversations | passed every check | resolved correctly | handover rate | wrong-action rate | blocked attempts | median turn | p95 turn | cost per conversation | code | latest commit | times scored |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| rule-based | 1 | 18 | 4/18 (22%), per run 4 | 1/18 (6%), per run 1 | 12/18 (67%), per run 12 | 0/18 (0%), per run 0 | 2/18 (11%), per run 2 | 0.17 ms | 1.92 ms | $0.0000 | cf4c36d9eeec | 2d848d8 | 3 |
| plain-gpt-6-luna | 3 | 54 | 47/54 (87%), per run 15–16 | 17/54 (31%), per run 5–6 | 16/54 (30%), per run 5–6 | 0/54 (0%), per run 0 | 0/54 (0%), per run 0 | 2412.49 ms | 4042.02 ms | $0.0002 | cf4c36d9eeec | 940172a | 3 |
| plain-gpt-6.2-sol | 3 | 54 | 47/54 (87%), per run 15–16 | 20/54 (37%), per run 6–7 | 15/54 (28%), per run 5 | 0/54 (0%), per run 0 | 0/54 (0%), per run 0 | 2684.78 ms | 4756.97 ms | $0.0117 | cf4c36d9eeec | 72d7b66 | 3 |

Validation set, cases/held-out. Each row covers every scored run of one agent with the same cases and the same code as its latest run, each regraded and matched to its line in results/ledger.jsonl. A count is the total over those runs, its share, and the lowest and highest count in one run. Turn times are nearest-rank over every turn of those runs. Code is the start of the SHA-256 of src/, package.json, pnpm-lock.yaml and the set's fixtures. Times scored counts the agent's lines for this set in the ledger.
<!-- report table: end -->

## Run the check

With Docker installed, from a clone of this repository:

	docker compose run --rm check

The container runs with no network and needs no key. It typechecks, runs the tests, replays the tuning set for every agent that can run offline, and prints the report: for each scored set, every run of each agent on the cases and code of its latest run, graded again from the files in `results/`. [The design](docs/design.md#the-report-and-the-one-command-check) explains each step.
