# desk-agent

A customer-support agent for a small Romanian shop, delivered the way a forward-deployed engineer delivers one. The test set came first. The agent came second and was tuned only on its tuning set. The results come from a set that nobody who tuned the agent had read. Every run and every reader's verdict is committed, and the commands below regrade them into each number on this page.

## The problem

Studio Cobalt is an invented Bucharest print shop. One person answers every customer message, in Romanian (often without diacritics) or in English, and sometimes in both within one conversation. Most messages are routine: where is my order, change the address, cancel, return, a damaged print. The rest need the owner: a commission, a tattoo booking, a complaint, a refund above 1,000 lei.

The agent takes the routine messages and hands the rest to that person with a summary they can act on. It must never do what costs the shop money or trust: file a request the policy forbids, act for a customer who is not verified, disclose an order to a stranger, or promise what only staff decide. [The scope](docs/scope.md) states the policy, the three ways a conversation may end (resolved, handed over, refused) and what counts as a wrong action.

## How it works

```mermaid
flowchart LR
    customer["Customer<br/>(scripted case or pnpm chat)"] --> session["Session<br/>one message at a time"]
    session --> agent["Agent<br/>plain function calling"]
    agent <--> model["Model<br/>live, or replayed from recordings/"]
    agent -- "tools/call" --> mcp["MCP server<br/>five typed functions"]
    mcp --> shop["Shop backend<br/>checks identity and policy"]
    session -- "scored runs" --> trace["Trace"] --> grader["Grader"] --> ledger["Ledger and report"]
```

- **Five functions, behind a real MCP server:** order lookup, account lookup, policy check, file a request for staff approval, and hand over to a person. The functions enforce the policy and the identity check themselves. A request the policy forbids fails inside the function, whatever the model was told.
- **The agent** is about 120 lines of plain function calling, plus a 46-line system prompt, with no agent framework, on two models from one vendor: a cheaper one (`plain-gpt-6-luna`) and a stronger one (`plain-gpt-6.2-sol`). Both use the same code and the same prompt. The prompt says how to behave and holds no shop facts, which come from the functions.
- **The runner** plays each case through the same session and MCP path a live chat uses. **The grader** checks the outcome, the requests on file, exact phrases and the reply language. The requests and any handover come from the accepted function calls in the trace. Only the choice between resolved and refused comes from the status the agent declares with each reply.
- **The ledger** records every scoring run with its commit and a hash of its cases and its code. **The report** grades every saved run again and refuses to print a number that no longer matches its ledger line.

[The design](docs/design.md) explains each choice and the alternatives it beat.

## How it was measured

There are 55 conversations in three sets. Each set was written by a different author, each a language model working from the scope. The tuning and validation sets each cover every category of [the test plan](docs/scope.md#test-plan).

| Set | Conversations | Used for |
| --- | ---: | --- |
| Tuning, `cases/tuning/` | 19 | Changing the prompt and the code. |
| Validation, `cases/held-out/` | 18 | Checking a change after tuning. Its expected outcomes reached the person who later changed the policy, so it is not an unseen test. |
| Final, `cases/final/` | 18 | Scoring only. 11 Romanian and 7 English. Its author saw neither other set, and nobody who tuned the agent has read it. |

Every model agent ran each scored set three times from a clean tree. One run moves by a case or two, so the tables report the total, the share and the lowest and highest count in one run.

## Results

On the final set, by the automatic grader:

- **The cheaper model passed 52 of 54 conversations (17 to 18 per run), and the stronger one 51 of 54 (17 per run).** The keyword baseline passed 10 of 18.
- **No model agent took a wrong action the grader can detect, and none tried a forbidden request,** in 108 final conversations or 108 validation conversations. The grader cannot see a false promise. Neither blind reader below found one on the final set.
- **The stronger model costs about 70 times as much per conversation** ($0.0147 against $0.0002), with a median model time per turn of 2.2 s against 2.45 s.
- On the validation set both models passed 47 of 54.

The grader cannot see a false promise, a fact with no source or a handover made too early. Two readers judged all 108 final conversations against [a rubric](docs/judging.md) without knowing which agent wrote each one. Each conversation showed any customer messages that a handover cut off, so a reader could judge an early handover. Both are language models from vendors other than the agents' vendor.

| Acceptable on the final set | Cheaper model | Stronger model |
| --- | ---: | ---: |
| Automatic grader (passed every check) | 52/54 | 51/54 |
| Blind reader G (Grok 4.7) | 40/54 | 48/54 |
| Blind reader M (Gemini 3.8 Flash) | 47/54 | 54/54 |

- **Both readers put every needless or early handover and every reply in the wrong language on the cheaper model:** 7 handovers and 3 replies by reader G, 4 and 3 by reader M. Reader G also found facts with no source in a function result on both models, 4 and 6.
- **The grader's tie hides a gap.** Both readers put the stronger model 7 to 8 conversations ahead.
- **The readers agree with each other on 95 of 108 conversations** (Cohen's kappa 0.47). They agree with the grader on 87 and 100. Reader G is the stricter one.
- The readers are models, not people. A labelled human sample is the next check.

`pnpm audit:agreement --key results/audit/final/key.json results/audit/final/reader-g.jsonl results/audit/final/reader-m.jsonl` reproduces these numbers from the committed verdicts.

**On these numbers, the stronger model is the one to ship.** It costs about 1.5 cents a conversation. Each failure the readers find on the cheaper model is visible to the customer, and each one has to be fixed and measured on the tuning set before the cheaper model is worth its saving.

[The final failure review](results/final-failures.md) traces every failure the grader found to its root cause. [The validation review](results/held-out-failures.md) does the same for the validation set. Tuning is recorded step by step in [the design](docs/design.md#tuning), and [FAILURES.md](FAILURES.md) covers the tuning set.

This table is the output of `pnpm report --markdown`, and `pnpm check` fails when it differs. The keyword baseline is deterministic, so it has one run per set.

<!-- report table: start -->
| agent | runs | conversations | passed every check | resolved correctly | handover rate | wrong-action rate | blocked attempts | median turn | p95 turn | cost per conversation | code | latest commit | times scored |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| rule-based | 1 | 18 | 10/18 (56%), per run 10 | 4/18 (22%), per run 4 | 11/18 (61%), per run 11 | 0/18 (0%), per run 0 | 3/18 (17%), per run 3 | 0.16 ms | 1.06 ms | $0.0000 | 421a5b33baa2 | 0f25884 | 1 |
| plain-gpt-6-luna | 3 | 54 | 52/54 (96%), per run 17–18 | 20/54 (37%), per run 6–7 | 19/54 (35%), per run 6–7 | 0/54 (0%), per run 0 | 0/54 (0%), per run 0 | 2452.14 ms | 4818.32 ms | $0.0002 | 421a5b33baa2 | 89531ea | 3 |
| plain-gpt-6.2-sol | 3 | 54 | 51/54 (94%), per run 17 | 21/54 (39%), per run 7 | 18/54 (33%), per run 6 | 0/54 (0%), per run 0 | 0/54 (0%), per run 0 | 2196.27 ms | 5002.05 ms | $0.0147 | 421a5b33baa2 | 8042e64 | 3 |

Final set, cases/final. Each row covers every scored run of one agent with the same cases and the same code as its latest run, each regraded and matched to its line in results/ledger.jsonl. A count is the total over those runs, its share, and the lowest and highest count in one run. Turn times are nearest-rank over every turn of those runs. Code is the start of the SHA-256 of src/, package.json, pnpm-lock.yaml and the set's fixtures. Times scored counts the agent's lines for this set in the ledger.

| agent | runs | conversations | passed every check | resolved correctly | handover rate | wrong-action rate | blocked attempts | median turn | p95 turn | cost per conversation | code | latest commit | times scored |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| rule-based | 1 | 18 | 4/18 (22%), per run 4 | 1/18 (6%), per run 1 | 12/18 (67%), per run 12 | 0/18 (0%), per run 0 | 2/18 (11%), per run 2 | 0.17 ms | 1.92 ms | $0.0000 | cf4c36d9eeec | 2d848d8 | 3 |
| plain-gpt-6-luna | 3 | 54 | 47/54 (87%), per run 15–16 | 17/54 (31%), per run 5–6 | 16/54 (30%), per run 5–6 | 0/54 (0%), per run 0 | 0/54 (0%), per run 0 | 2412.49 ms | 4042.02 ms | $0.0002 | cf4c36d9eeec | 940172a | 3 |
| plain-gpt-6.2-sol | 3 | 54 | 47/54 (87%), per run 15–16 | 20/54 (37%), per run 6–7 | 15/54 (28%), per run 5 | 0/54 (0%), per run 0 | 0/54 (0%), per run 0 | 2684.78 ms | 4756.97 ms | $0.0117 | cf4c36d9eeec | 72d7b66 | 3 |

Validation set, cases/held-out. Each row covers every scored run of one agent with the same cases and the same code as its latest run, each regraded and matched to its line in results/ledger.jsonl. A count is the total over those runs, its share, and the lowest and highest count in one run. Turn times are nearest-rank over every turn of those runs. Code is the start of the SHA-256 of src/, package.json, pnpm-lock.yaml and the set's fixtures. Times scored counts the agent's lines for this set in the ledger.
<!-- report table: end -->

"Resolved correctly" is low by design. A conversation the scope sends to a person, or one the agent must refuse, is counted as handed over or refused, not resolved.

## Decisions and the numbers behind them

| Decision | What measured it |
| --- | --- |
| The functions enforce the policy and the identity check, not the prompt. | 0 wrong actions in 216 scored model conversations. The baseline's forbidden attempts, 3 on the final set and 2 on the validation set, were refused by the functions and changed nothing. |
| Define a complaint and a dispute in the scope instead of tuning the prompt around them. | All 12 tuning failures of the stronger model at that point were handovers marked as complaints. After the scope said what a complaint is, it passed 18 to 19 of 19. |
| Check the reply language with two word lists instead of a model or a package. | It read 42 of 44 tuning customer turns right, none wrong and 2 as unsure, and an unsure reading never fails a case. |
| Score three runs per agent and report the spread. | One run moves by one or two cases. A single run cannot show a change worth one case. |
| Quote the final set, not the tuning set. | Both models pass 19 of 19 tuning conversations in every run, so that set no longer tells them apart. The same agents pass 87% of the validation set. |
| Regrade every saved run in the report, and check the README against it in `pnpm check`. | A grader change that moves a published number stops the report with the field and both values. |
| Replay recorded model responses offline by default. | The check, CI and the Docker run need no key and no network, and the replay sends byte for byte the requests it recorded. |
| Recommend a model only after a blind reading. | The grader has the cheaper model one conversation ahead. Both blind readers put the stronger one 7 to 8 ahead, on exactly what the grader cannot see. |

## Limits

These are the weak spots, stated before a reader finds them.

- **The conversations are synthetic and scripted.** Language models wrote them from the scope. A scripted customer cannot react to what the agent says.
- **The sets are small.** One final conversation is 5.6 points of one run. Three runs narrow the noise but do not remove it.
- **The final set may be easier than the validation set.** The keyword baseline passes 10 of 18 final conversations and 4 of 18 validation conversations.
- **"Test set first" means before the model agent.** The keyword baseline existed before the cases. One tuning expectation changed after review, and one tuning case was repaired after a policy correction made it unpassable. [FAILURES.md](FAILURES.md) records both.
- **The validation set is not an unseen test.** The person who changed the complaint policy had seen its expected outcomes, which is why the final set exists.
- **One model vendor.** Both model agents use the same provider.
- **Text only.** The model takes about 2.2 to 2.5 s per turn in the median and about 5 s at the 95th percentile. That leaves out tool time. It is workable for chat and too slow for a voice line.
- **The language check passes what it cannot read.** A short reply or a mixed one counts as unsure and never fails.
- **No function amends a filed request,** and an order shows no earlier claim, so a wish the customer adds after a claim is filed needs a person.
- **Log redaction is by pattern.** It masks emails, phone, card and IBAN numbers and street addresses, but not names.
- **The agent framework comparison is not done.** Plain function calling was chosen because it keeps the recorded requests plain JSON, not because it beat a framework on a measured run.

## Run it

With Docker, from a fresh clone:

	docker compose run --rm check

Building the image downloads Node and the dependencies. The check itself runs with no network and needs no key. It typechecks, runs the 286 tests, replays the tuning set for every agent from its recordings, prints the report above and checks this README against it. CI runs the same steps on every pull request and every push to `main`.

Without Docker, with Node 24.3 or later and pnpm 11.18.0:

	pnpm install --frozen-lockfile
	pnpm check                                                     # the same steps as the container
	pnpm chat --agent plain-gpt-6-luna --replay ro-unde-e-coletul  # watch one tuning conversation, offline
	pnpm mcp                                                       # serve the five functions over stdio

Live runs, recording and scoring call a paid provider and need a key in `.env`. [The verification skill](.agents/skills/verify-desk-agent/SKILL.md) lists every command, what it proves and its fences.

## Where things are

| Path | What it holds |
| --- | --- |
| `docs/scope.md` | The client, the policy, the outcomes, the wrong actions and the test plan. |
| `docs/design.md` | Every design choice with its alternatives, the tuning steps, and the full list of limits. |
| `docs/judging.md` | The rubric a reader applies to one conversation. |
| `src/` | About 3,300 lines of TypeScript: shapes, functions, MCP server, agents, runner, grader, report, audit tools. |
| `cases/`, `fixtures/` | The three sets and their orders. |
| `recordings/` | The last tuning run of each model agent, replayed offline. |
| `results/` | Every scoring run, the ledger, and the failure reviews. |
