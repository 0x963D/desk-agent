# desk-agent

A bilingual (Romanian and English) customer-support agent, built and measured the way a forward-deployed engineer delivers one: test set first, then the agent, then results on held-out conversations.

Work in progress. Results, architecture and setup will appear here as they are measured.

## Results

<!-- report table: start -->
<!-- report table: end -->

## Run the check

With Docker installed, from a clone of this repository:

	docker compose run --rm check

The container runs with no network and needs no key. It typechecks, runs the tests, replays the tuning set for every agent that can run offline, and prints the held-out report: the latest scored run of each agent, graded again from the files in `results/`. [The design](docs/design.md#the-report-and-the-one-command-check) explains each step.
