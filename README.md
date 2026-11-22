# desk-agent

A bilingual (Romanian and English) customer-support agent, built and measured the way a forward-deployed engineer delivers one: test set first, then the agent, then results on held-out conversations.

Work in progress. Results, architecture and setup will appear here as they are measured.

## Results

<!-- report table: start -->
| agent | conversations | passed every check | resolved correctly | handover rate | wrong-action rate | blocked attempts | median turn | p95 turn | cost per conversation | commit | times scored |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| rule-based | 18 | 4/18 (22%) | 1/18 (6%) | 12/18 (67%) | 0/18 (0%) | 2/18 (11%) | 0.17 ms | 1.92 ms | $0.0000 | 2d848d8 | 3 |
| plain-gpt-6-luna | 18 | 15/18 (83%) | 5/18 (28%) | 6/18 (33%) | 0/18 (0%) | 0/18 (0%) | 2386.77 ms | 3511.71 ms | $0.0002 | 940172a | 3 |
| plain-gpt-6.2-sol | 18 | 16/18 (89%) | 7/18 (39%) | 5/18 (28%) | 0/18 (0%) | 0/18 (0%) | 2735.88 ms | 4756.97 ms | $0.0118 | 72d7b66 | 3 |

Validation set, cases/held-out. Each row regrades the latest scored run of one agent and matches it to its line in results/ledger.jsonl. Turn times are nearest-rank. Times scored counts the agent's lines for this set in the ledger.
<!-- report table: end -->

## Run the check

With Docker installed, from a clone of this repository:

	docker compose run --rm check

The container runs with no network and needs no key. It typechecks, runs the tests, replays the tuning set for every agent that can run offline, and prints the held-out report: the latest scored run of each agent, graded again from the files in `results/`. [The design](docs/design.md#the-report-and-the-one-command-check) explains each step.
