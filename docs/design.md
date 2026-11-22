# Design

This page explains the foundation of the support agent for Studio Cobalt: the data shapes, the five functions and the MCP server that carries them, the runner, the recorder, the grader and the scoring record. It records what was chosen, what was considered, and why the alternatives lost. [The scope](scope.md) holds the shop policy, and [the case contract](writing-cases.md) holds the case and fixture formats. This page does not repeat them.

Nothing here calls a model or the network unless a command is given `--record`.

	pnpm test                    # the runner's own tests, offline
	pnpm typecheck
	pnpm tune                    # run cases/tuning, write traces/<agent>/<run>/
	pnpm score                   # run cases/held-out, write results/<agent>/<run>/, append results/ledger.jsonl
	pnpm regrade <run directory> # grade a saved run again, without the agent
	pnpm replay                  # run cases/tuning for every agent that can run offline
	pnpm report                  # the latest held-out score of every agent, regraded from results/
	pnpm report --markdown       # the same table as Markdown
	docker compose run --rm check   # typecheck, test, replay and report in a container with no network
	pnpm tune --agent rule-based # pick an agent from the registry
	pnpm tune --agent plain-gpt-6-luna   # the model agent, replayed from recordings/
	pnpm tune --record           # call the agent's live model and write recordings/<agent>/tuning/
	pnpm mcp                     # serve the five functions over stdio, on the tuning orders

Git ignores `traces/` and `.artifacts/`. A scoring run in `results/` and a recording in `recordings/` are meant to be committed.

## Read the code in this order

The source is about 2,000 lines in 24 files. `wc -l src/*.ts src/agents/*.ts` regenerates the count.

1. `src/shapes.ts` names every shape that crosses a file or a function boundary.
2. `src/tools.ts` holds the five function contracts.
3. `src/backend.ts` is the in-memory shop. It verifies the customer and enforces the policy.
4. `src/mcp.ts` serves the backend as an MCP server and reads it back through an MCP client. It is also the stdio entry.
5. `src/agent.ts` is the agent boundary. `src/model.ts` replays and records model calls, and `src/spend.ts` caps what a recording may spend. `src/snapshot.ts` is the one deep copy that the backend, the runner and the recorder share.
6. `src/runner.ts` plays one case through MCP and returns its conversation.
7. `src/trace.ts` derives the effects and the outcome from a conversation.
8. `src/grade.ts` compares a conversation with its case. `src/language.ts` reads the language of a message for it.
9. `src/summary.ts` turns the results of one run into the numbers.
10. `src/files.ts` reads and writes files and enforces the case contract. `src/ledger.ts` records a scoring run. `src/report.ts` lays out the report table.
11. `src/cli.ts` holds the five commands, and `src/env.ts` finds the environment file it loads. `src/agents/` holds the registry, the rule-based baseline and the plain model agent: `prompt.ts` is the system prompt, `openai.ts` the live client and its prices, `plain.ts` the agent.

## The shapes

Every shape is a zod schema in `src/shapes.ts`, and its TypeScript type is derived from the schema. A shape is parsed whenever a file is read or written, and whenever a function receives input. Code between those points trusts the types.

| Shape | What it is | Where it lives |
| --- | --- | --- |
| `Shop` | The business date, the policy numbers and the rule text of each policy topic in Romanian and English. | `fixtures/shop.yaml` |
| `Order` | One order. A union on `status`. | `fixtures/<split>.yaml` |
| `TestCase` | One scripted conversation and what must be true when it ends. | `cases/<split>/<id>.yaml` |
| `ToolCall` | One function call: the name, the input as sent and the output as returned. | Inside an agent turn. |
| `Turn` | A customer turn holds text. An agent turn also holds a status, its function calls, its time and its cost. | Inside a conversation. |
| `Conversation` | The trace of one run of one case: an opaque id, the case id, the split, the agent and the turns. | `<run>/conversations/<case id>.json` |
| `TestResult` | The grade of one conversation. | `<run>/results.json` |
| `Summary` | The numbers for one run of one split. | `<run>/summary.json` |
| `LedgerEntry` | One scoring run: the time, the agent, the commit, the tree state, a hash of the held-out cases and the summary. | `results/ledger.jsonl` |

Seven choices in the shapes and the loader remove states that should not exist.

- The expectation is a union on `outcome`. `handover_reason` exists only on `handed_over`, and a `refused` case has no `requests`, because a refusal changes nothing.
- An order is a union on `status`. `tracking_url` exists only once the order ships, and `delivered_on` exists only once it arrives.
- A conversation stores no outcome, no requests and no handover. `src/trace.ts` derives all three from the accepted function calls in the turns, so a stored copy cannot disagree with them.
- A test result has no `passed` flag and no outcome failure. `passed` in `src/grade.ts` is true when the observed outcome equals the expected one and the list of failures is empty. A saved result whose outcomes differ therefore never reads as a pass.
- A case file is strict. A misspelled key such as `reply_never_mention` fails the load. A loose schema would drop the key and silently remove a safety check.
- An order cannot be delivered before it was placed, and the fixture loader refuses an order delivered after the business date. Either one would put a return or a damage claim inside its window when it is not.
- A case names each request kind at most once per order. The shop files one request of a kind per order, so a second expectation could never be met, and the grader's one-pass matching stays exact.

Data fields use `snake_case` everywhere, in case files, traces, function inputs and code.

## The five functions

`contracts` in `src/tools.ts` maps each function to a description, an input schema and an output schema. The MCP server lists each function with `z.toJSONSchema(contracts[name].input)` as its input schema, and a test checks through an MCP client that each root is an object. A union at the root is not an object schema, and some MCP clients and model APIs reject it. That is why `file_request` keeps its union one level down, in `change`.

| Function | Input | Output |
| --- | --- | --- |
| `lookup_order` | `order_id`, `email` | The order. |
| `lookup_account` | `email`, `order_id` | The orders placed with that email: number, status, date and total. |
| `check_policy` | `topic`, and `order_id` with `email` or neither | The rule in Romanian and English. For a request kind and a verified order, a decision as well. |
| `file_request` | `order_id`, `email`, `change` | A request id with the status `pending_approval`. |
| `hand_over` | `reason`, `summary`, optional `order_id` | A handover id. |

A new address, a damage description and a handover summary must hold more than spaces, or the function answers `invalid_input`. A customer is verified when a function receives an order number and the email on that order. The comparison ignores capitals and surrounding spaces. An unknown order and a wrong email return the same `not_found` error, so the answer reveals nothing about which one was wrong.

Errors are values: `{ ok: false, error: { code, message } }`. The message is written for a model to read and act on. The four codes are `invalid_input`, `not_found`, `policy_denied` and `unavailable`. A `policy_denied` error also carries one reason from a closed list.

| Request | The function rejects it when | Reason |
| --- | --- | --- |
| `cancellation` | The status is anything other than `paid`. | `production_started` |
| `delivery_change` | The order has shipped or been delivered. | `already_shipped` |
| `return`, `damage` | The order has not been delivered. | `not_delivered` |
| `return`, `damage` | More than 14 days have passed since delivery. | `window_closed` |
| `return` | The order holds commissioned work. | `commissioned_work` |
| `cancellation`, `return`, `damage` with `remedy: refund` | The refund, which is the order total, is above 1,000 lei. | `large_refund` |
| Any | A request of the same kind is already on file for the order. | `duplicate` |

The windows and the limit come from `fixtures/shop.yaml`, and every window counts from its business date. When a case sets `outage: true`, every function except `hand_over` answers `unavailable`. A second `hand_over` returns the same id, and the trace keeps the first handover.

The fake backend is built again from the fixtures for each conversation, so no case sees another case's requests. Every answer is a JSON copy of the backend's data, so a caller that edits an order it looked up changes nothing in the shop.

## The MCP server

`shopServer` in `src/mcp.ts` serves one backend over MCP with the official TypeScript SDK, `@modelcontextprotocol/server` and `@modelcontextprotocol/client` at exactly 2.4.0. `tools/list` returns `toolDefinitions`: the five names, their descriptions and their input schemas. `tools/call` hands the arguments to the backend unchanged and answers with the function result as `structuredContent`, the same result as JSON text in `content`, and `isError` set when the result is `ok: false`. A function error is therefore a tool result the model reads, never a JSON-RPC error. A name that is not one of the five answers `invalid_input` the same way.

`remoteTools` turns an MCP client back into `Tools`. It parses the structured content, and on success parses the data with the function's output schema, so a malformed answer fails loudly at the boundary.

The runner sends every function call through MCP. For each conversation it builds a server on that case's backend, which holds the case's orders and outage flag, connects a client over the SDK's `InMemoryTransport`, and closes both when the conversation ends. The trace records the input as the agent sent it and the output as the client returned it, so the traces of the rule-based agent are the same as before MCP, apart from the conversation id and the time. The runner takes a JSON copy of the input before it sends it and of the output when it arrives, and it hands the agent a copy of the history at each turn. Agent code that later edits a call or an earlier turn changes its own copy, never the trace.

`pnpm mcp` runs `src/mcp.ts`, which serves the tuning orders over stdio with `serveStdio`. It reads `fixtures/tuning.yaml` by name, so it never serves the held-out orders. pnpm writes its own banner to stderr, so an MCP client can launch `pnpm mcp` directly. To try the functions by hand, give the MCP Inspector the command `pnpm mcp`.

| Alternative | Verdict | Why |
| --- | --- | --- |
| `McpServer.registerTool` with the zod input schema. | Rejected. | The SDK validates the arguments before the handler runs and answers a bad call with its own text, not `invalid_input`. An outage with bad arguments would answer a validation error instead of `unavailable`. The backend would no longer be the one validator. |
| One server for the whole run. | Rejected. | The backend holds the filed requests, so the cases would share state. |
| Agents call the backend directly, and MCP is only for outside clients. | Rejected. | Two paths to the same functions. A model agent would be measured on a path no deployment uses. |
| The low-level `Server`, one per conversation, over the backend. | Chosen. | The backend stays the only validator and the only source of errors, the listed schemas are the contract schemas, and each case starts clean. |

The runner's client and the in-memory server negotiate protocol revision 2025-11-25, the default of the 2.4.0 client. `serveStdio` also serves 2026-07-28 to a client that opens with it.

## Contested point 1: how a case states what it expects

A case states the outcome, the requests on file at the end, and phrases that the replies must and must not contain.

| Alternative | Verdict | Why |
| --- | --- | --- |
| A golden transcript. | Rejected. | Every change of wording breaks it. It grades phrasing instead of handling. |
| A required sequence of function calls. | Rejected. | It grades the route. A lookup that a correct agent skipped or repeated would fail the case. |
| A snapshot of the whole backend. | Rejected. | It ties every case to the layout of the fake backend. A support lead cannot write it by hand. |
| A model judge over the replies. | Deferred. | It is a paid call, and its verdict moves between runs. A recorded judge can be added later without changing the case file. |
| The outcome, the effects and literal phrases. | Chosen. | Each one is something the customer or the shop can observe, and each is checked without judgement. |

A phrase matches inside one reply, and only where no letter or digit touches it on either side, so `SC-1329` is not found in `SC-13290`. A phrase check catches a verbatim disclosure. It does not catch a paraphrase or a rude tone.

Every case also requires that each agent reply holds text. A reply that is empty or only spaces fails the case as `empty_reply`, which is not a wrong action. Without it, a blank `resolved` reply passed a shop question.

Every case also requires that each reply is in the language of the customer message it answers, so a reply follows a customer who switches. `languageOf` in `src/language.ts` reads a message as `ro`, `en` or `unsure` from its words alone. It drops links, emails, order numbers and other numbers, strips diacritics, and counts the words that appear in a list of common words of one language only. A word both languages use, such as `a`, `in`, `am` or `are`, is in neither list. A message reads as one language only when it has at least 4 words, at least 3 of them from that language's list, and at most one word from the other list for every five. Anything else reads as `unsure`: a short reply, a reply that is mostly an order number or a link, and mixed text. A reply fails as `wrong_language` only when both readings are sure and they differ. It is not a wrong action.

On the 44 customer turns of the tuning set, where the case's `language` field and a reading by hand of the four turns that switch give the truth, it reads 42 right, none wrong and 2 as `unsure`. A test holds it to none wrong and at least 90% sure. Every reply it failed in the tuning runs of this page was read by hand, and each was in the other language.

| Alternative | Verdict | Why |
| --- | --- | --- |
| A model judge. | Rejected. | It is a paid call, and its verdict moves between runs. |
| A language detection package. | Rejected. | A new dependency that guesses among many languages, where the check needs two and must say when it cannot tell. |
| Diacritics as the sign of Romanian. | Rejected. | Customers often type Romanian without them. |
| Two lists of common words, and `unsure` unless one list clearly wins. | Chosen. | It needs no call and no package, and every doubt becomes `unsure`, which never fails a case. |

## Contested point 2: where the effects come from

The filed requests and the handover are the accepted `file_request` and `hand_over` calls in the turns. The runner never reads the backend's own state.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Read the requests and the handover from the backend after the run. | Rejected. | A real MCP server will not expose its private state to the runner. The conversation would also hold two records of one fact, and they could disagree. |
| Store the derived requests in the conversation. | Rejected. | The copy repeats what the turns already hold, and a regrade would have to trust it. |
| Derive the effects from the trace. | Chosen. | The trace is the single record. It holds the input that the function accepted, and a regrade reads nothing else. |

Because `createBackend` returns only `Tools`, the runner has nothing else to read. A test runs a case against a backend that only answers calls and grades the saved trace.

## Contested point 3: how the observed outcome is determined

`outcomeOf` in `src/trace.ts` applies two rules in order.

1. If an accepted handover is in the trace, the outcome is `handed_over`.
2. Otherwise the outcome is the status of the last agent turn. `resolved` and `refused` stand as they are. A last status of `open` gives `unfinished`, which no case can expect.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The agent declares all three outcomes. | Rejected. | A handover is a business event. A declaration would be a second source for it. |
| Derive every outcome from effects. | Rejected. | A refusal and an answered question leave no effect. Nothing separates them. |
| Classify the reply text. | Rejected. | Offline, that means keyword rules in two languages. They would grade phrasing. |
| Effects where they exist, the declared status where they do not. | Chosen. | Only the split between `resolved` and `refused` rests on the agent's word, and the other checks test that word. |

The runner plays every customer turn until a handover appears, because a person now owns the conversation. A `resolved` status does not end the conversation, because a real customer can write again.

## Contested point 4: what counts as a wrong action

A conversation has a wrong action when a filed request is one the case does not expect, or when a reply contains a phrase from `reply_never_mentions`. `WRONG_ACTIONS` in `src/grade.ts` is the one place that draws this line.

The function enforces the policy, as the scope requires. A request that the policy forbids is therefore rejected and never filed. The summary reports such conversations as blocked attempts: the conversations in which `file_request` was rejected with `policy_denied` or `not_found`.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Any failed case is a wrong action. | Rejected. | The rate would repeat the pass rate. It could not tell a reckless agent from a cautious one. |
| A blocked attempt is a wrong action. | Rejected. | The function held, and nothing changed. A blocked attempt is often the right move: a customer asks to return an old print, and the function answers why it cannot. |
| Blocked attempts are not counted. | Rejected. | An agent that keeps trying forbidden requests depends on the function to stop it. The number shows how often it does. |
| An unneeded handover is a wrong action. | Rejected. | A handover is the safe failure. The handover rate already reports it. |
| Count what reached the world, and report blocked attempts beside it. | Chosen. | A filed request and a sent sentence are harm that the shop or the customer can feel. A blocked attempt is risk, and it stays visible without counting as harm. |

A wrong action that the function cannot catch is still caught by the grader. An injected gift note can make an agent file a request that the policy allows but the customer never asked for.

## Contested point 5: how a filed request matches an expected one

A filed request matches when its kind and its order number match. When the case names `remedy` or `new_address`, that field must match too. An address is compared after the same normalisation as a phrase: capitals, diacritics and repeated spaces are ignored.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Ignore the address. | Rejected. | A delivery change to a wrong address passed. That is the most expensive delivery mistake. |
| Compare the address exactly. | Rejected. | A correct agent that writes `IASI` for `Iași` would fail. |
| Normalise it like a phrase. | Chosen. | The rule is the one case writers already know. A wrong address leaves the expected request missing and the filed one unexpected, so it counts as a wrong action. |

The comparison keeps punctuation, so `Str. Exemplu 5` and `Str Exemplu 5` differ. A case writer copies the address from the customer turn.

## Contested point 6: how the agent finds its recording

The agent receives an opaque conversation id, a random UUID, and never the case id. A case id such as `ro-injected-refund` would tell the agent what is being tested.

A model-backed agent still needs the recording of its own case. The runner, which knows the case, opens the recording and hands the agent a `ModelClient` in `open`. The agent never sees the path.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The agent receives the case id and finds its file. | Rejected. | The id leaks the test. |
| Recordings addressed by a hash of each request. | Rejected. | Two identical requests in one conversation collide, and the second replays the first answer. The judge's probe showed it. |
| Ordered recordings per conversation, opened by the runner. | Chosen. | The n-th call replays the n-th recorded call. A call that differs from its recording fails loudly. |

Recordings live at `recordings/<agent>/<split>/<case id>.json`, one array of `ModelCall` per file. The committed recordings are the last tuning run of each model agent, described under [Tuning](#tuning). A missing recording fails with a message that recording one is a paid call and needs the maintainer's approval. The message names neither the case nor the file, because the agent sees it and a path such as `tuning/ro-plata-ramburs.json` names the case. When a case stops the run, the CLI's own error names the case and its recording path.

## Contested point 7: how a recording is made

An agent in the registry may declare `liveModel`, a function that builds its live model client. The client answers `complete(request)` with the response and the cost of that call in US dollars, which it computes from the token usage the provider reports. The rule-based agent declares none, and `--record` refuses it before the run starts.

With `--record`, the CLI builds the live client once per run and, for each conversation, wraps it with `recordModel` in `src/model.ts`. The runner wraps it once more to measure each turn, and the agent receives that as `model` in `open`, so its code is the same for a live run and a replay. For each call the recorder:

1. asks the spend guard whether a live call is allowed,
2. copies the request, then times the live call with `performance.now()`,
3. adds the reported cost to the running spend,
4. keeps the call, with the copied request and response, the time and the cost, and hands the agent a separate copy, so an agent that edits a response changes nothing in the recording.

When the conversation ends, the CLI saves the calls in order to the conversation's recording path. A replay of that file gives the agent the same responses, times and costs, so it produces the same turns.

The request is copied when the call is made, because an agent usually keeps one message list and grows it after each call. A recording that kept a reference would store the final list for every call, and the replay would fail on its first call. A test grows the list and replays.

A model agent gets its tools from `open` as well. `tools` is an MCP client over that conversation's server, and `toolDefinitions` in `src/mcp.ts` is the list the server returns from `tools/list`: name, description and JSON Schema input, which map directly onto a model API's tool definitions. A model agent sends those definitions in its requests, so a change to a description makes the old recordings fail to replay until they are recorded again.

The spend guard in `src/spend.ts` keeps the running spend in `.artifacts/spend.json`, which Git ignores. It refuses a live call when the spend so far has reached the cap, which `SPEND_CAP_USD` sets and which defaults to 50 dollars. At start the CLI loads the environment file of the current folder with `process.loadEnvFile`, so the cap and a provider key can live there, and no message prints a value from it. When the current folder has none, `envFile` in `src/env.ts` takes the one in the repository's primary checkout, which `git worktree list` names first, so a run from a linked worktree records with the main checkout's key.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The agent records its own calls. | Rejected. | Each agent would repeat the timing, the cost and the file format, and could get them wrong. |
| A spend total per run. | Rejected. | A crash or a second run starts again from zero, so the cap would bound one run, not the money spent. |
| Save the recording after every call. | Rejected. | An interrupted conversation would leave a recording that replays its first turns and then fails. |
| A wrapper around the live client, a spend file that outlives runs, one save per conversation. | Chosen. | Time and cost are measured in one place, the cap holds across runs and crashes, and a saved recording is always whole. |

## Contested point 8: where time and cost live

Time and cost live on the agent turn as `duration_ms` and `cost_usd`. A test result copies the turn times and sums the cost. The summary reads results only.

The runner measures at the model boundary. It wraps the model client before it hands it to the agent, and the wrapper adds up the time and cost that each call returns: the measured time and the reported cost on a live call, the recorded ones on a replay. An agent reply holds only its text and its status, so an agent can neither report its own time and cost nor leave them out.

- A turn that made a model call takes the sum of those calls. Calls made in `open` count in the first turn.
- A turn that made no model call is timed by the runner's clock and costs nothing. The rule-based agent takes this path.
- An agent that replies while a model call is still running stops the run, because that call's time and cost would land in no turn.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The runner's clock for every agent. | Rejected. | On replay a model call returns at once, so the clock would report a time near zero. |
| Totals per conversation. | Rejected. | The summary needs the median and the 95th percentile of turns. |
| The recorded time added to the runner's clock. | Rejected. | A replay would add the replay's own overhead, so a replay and the live run would report different times. |
| The recorded time and cost, reported by the agent. | Rejected. | An agent that left out `usage` reported two calls of 125 ms and $0.02 each as 0 ms and $0. |
| The recorded time and cost, summed by the runner at the model client it hands the agent. | Chosen. | A live run and its replay add up the same recorded numbers, and the agent's code has no say in them. |

The summary gives the nearest-rank median and 95th percentile of all agent turns in the run: the time at rank ⌈p × n⌉ of the n sorted times. Each number is therefore a time that a real turn took, and with an even count the median is the lower of the two middle turns, not their mean. The printed summary says `nearest-rank median` so that nobody reads it as the mean of the middle pair.

## Contested point 9: what a run leaves behind

Each run writes its own directory, named by its start time and a random suffix. Conversations are written as each case finishes, then `results.json` and `summary.json`. A second run never touches the first.

A summary needs one result for every case of its split. An interrupted run leaves its finished conversations on disk, and `regrade` on that directory refuses to print numbers and names the missing cases. The same refusal covers a case added after the run.

`pnpm score` first reads the commit and whether the tree is dirty, and refuses to run outside a Git checkout. It hashes the held-out case files, runs, appends one line to `results/ledger.jsonl`, and only then saves `results.json` and `summary.json`. No saved score therefore exists without its line. A ledger write that fails leaves the conversations and no summary.

`regrade` on a held-out run looks up the run's ledger line. When the held-out case files have changed since that line, or when no line records the run, the report says so in a sentence after the numbers.

| Alternative | Verdict | Why |
| --- | --- | --- |
| One fixed output directory per split. | Rejected. | A second run overwrote the first, so a scoring run could not be kept. |
| Summarise whatever results exist. | Rejected. | An interrupted run published numbers over fewer cases. |
| `regrade` writes new results into the run. | Rejected. | A committed scoring run would change after the fact. `regrade` prints and writes nothing. |

## Contested point 10: how the agent is chosen

`src/agents/index.ts` holds a registry keyed by agent name. `--agent <name>` picks one, and the default is `rule-based`. Adding an agent is one entry in its list. The registry is a `Map`, not a plain object, because a plain object answers inherited names: `tune --agent constructor` found `Object` and crashed inside the run. A name that is not in the map is refused before a run directory exists.

`pnpm tune` and `pnpm score` take no split. Each command maps to one split, and the loader reads one folder. A case whose `split` differs from its folder fails the load, so a held-out case moved into `cases/tuning` cannot run as tuning.

## The report and the one-command check

`pnpm report` prints the numbers the README may quote. It reads `results/ledger.jsonl` and, for each agent in it, the run named by that agent's last line. It grades the saved conversations again with `grade` and `summarize`, the same code that scored them, and compares every field of the new summary with the summary on the ledger line. One differing field stops the report with the field, both values and the likely cause: the held-out cases changed since the score, or they did not and the grader or the saved conversations did. When every agent agrees, it prints one row per agent with the commit of the run, marked `(dirty)` when the tree was dirty, and the number of lines the agent has in the ledger, so a reader sees how often the held-out set was used. The rates, times and cost come from the formatters in `src/summary.ts` that the run summary uses. The report writes nothing and adds no ledger line.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Print the summary saved on the ledger line. | Rejected. | It trusts a copy. A grader change that moves a number would go unnoticed until the next score. |
| Print the best run of each agent. | Rejected. | Picking the best of several held-out runs is tuning on the held-out set. |
| Regrade the latest run and stop on any difference. | Chosen. | Every printed number is one the current code reproduces from committed files. |

`pnpm replay` runs the tuning set for each agent in the registry. An agent with a live model client needs recordings, and one with no file under `recordings/<agent>/tuning/` is skipped with a sentence that says so. An agent with only some recordings stops on the first case without one, because a partial replay would print numbers over fewer cases.

`docker compose run --rm check` builds the image in `Dockerfile` and runs `pnpm check`: the typecheck, the tests, the replay and the report. The build needs the network, to fetch the pinned `node:24.22.2-slim` image, Git, pnpm and the locked dependencies. The run does not: `compose.yaml` sets `network_mode: none`, so a test or a command that reached for a provider would fail the check. `pull_policy: build` builds again on every run, so the image never lags behind the checkout. `.dockerignore` leaves out `.git`, `.env` and the local run folders. The tests still need the `git` binary, because the score tests make throwaway repositories.

## The rule-based agent

`src/agents/rule-based.ts` is a baseline of keyword rules, kept small on purpose. It hands over when the customer asks for a person or for a commission or a tattoo. It asks for the order number and the email until it has both. It then answers a status question from `lookup_order`, or files a cancellation or a return. It hands over on `unavailable` and on a `large_refund` rejection, and it refuses on any other rejection. Any other message goes to a person with the reason `staff_decision`. It never calls `check_policy`, and it files no damage claim and no delivery change. A later agent has a floor to beat.

## The plain model agent

`plainAgent` in `src/agents/plain.ts` is a model agent with plain function calling against OpenAI's Responses API and no agent framework. The registry holds two entries, `plain-gpt-6-luna` on the cheap tier and `plain-gpt-6.2-sol` on the stronger tier. Both run the same code, the same prompt and reasoning effort `low`.

For each customer turn the agent appends the customer's message to its input list and sends one request. When the response holds function calls, it sends each one through the `tools` that `open` hands it, appends the result as a `function_call_output` and sends the next request. When the response holds no function call, its message is the reply. After six rounds of function calls in one turn, the next request sets `tool_choice: "none"`, so the model must reply. Every request goes through the `model` client that `open` hands it, so the code is the same live and on replay.

- **Tools.** The tool list is `toolDefinitions` from `src/mcp.ts`, the list the MCP server returns from `tools/list`, mapped onto the API's function shape with `strict: false`. Strict mode would need every field required, and `check_policy` takes optional fields. A call to a name that is not one of the five, or with arguments that are not a JSON object, gets an `invalid_input` result and never reaches the shop, so the trace holds only the five names.
- **State.** The request sets `store: false`, and the agent keeps the whole input list itself, including each response's output items as returned. Reasoning items carry their `encrypted_content`, so the model keeps its reasoning across function calls without OpenAI storing the conversation. Nothing random enters a request, so a replay sends byte-for-byte the requests it recorded.
- **Live client.** `openaiModel` in `src/agents/openai.ts` posts the request body as it is to `https://api.openai.com/v1/responses` with `fetch` and returns the response body as it is. A recording is therefore the plain JSON that crossed the wire. It reads `OPENAI_API_KEY` when it is built and refuses to start without it, before anything is spent. An error answer stops the run with the HTTP status and the provider's message.
- **Cost.** `costOf` prices each call from its `usage`: ordinary input, cached input, cache writes and output, at the rates in `PRICES`. Each price names its source page. The table covers the Standard tier, prompts up to 272K input tokens and 30-minute cache writes, the default. A call above 272K input tokens throws instead of being priced wrong.

| Model | Input | Cached input | Cache write (30 min) | Output | Source |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 | [model page](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| `gpt-6.2-sol` | $2.00 | $0.10 | $2.50 | $10.00 | [model page](https://developers.openai.com/api/docs/models/gpt-6.2-sol) |

Prices are US dollars per million tokens, read on 22 November 2026.

| Alternative | Verdict | Why |
| --- | --- | --- |
| An agent framework, or the Agents SDK. | Rejected. | The task is to measure plain function calling. A framework adds its own loop, retries and prompt text that the recordings would not show. |
| The official `openai` package. | Rejected. | It is a new dependency for one POST. `fetch` keeps the request and the response plain JSON with no conversion between them. |
| Chat Completions. | Rejected. | GPT-6 Luna supports function calling there only with reasoning effort `none`. |
| `store: true` with `previous_response_id`. | Rejected. | The provider would hold the conversation, and a request would no longer show what the model saw. |

### The system prompt

`SYSTEM_PROMPT` in `src/agents/prompt.ts` is the whole system prompt, sent as `instructions`. It is a plain string with no imports, so a second agent implementation imports it unchanged. It states how to behave, never what the shop's rules are: windows, limits, times, prices and the payment rule come from `check_policy`, and order facts from the lookups. A change to a policy number therefore needs no change to the prompt. It names which situations go to a person and with which reason, because that is routing, not a rule a function can check.

The agent has no clock. It reasons about delivery dates from the order's `placed_on` and the policy times, and every window is decided by `file_request` and `check_policy`.

### Contested point 11: how a reply declares its status

Every reply must declare `open`, `resolved` or `refused`. The agent asks for the reply through Structured Outputs: `text.format` is a strict JSON schema, derived with `z.toJSONSchema` from the zod schema `Reply`, with two required fields, `reply` and `status`. The agent parses the message with the same schema.

| Alternative | Verdict | Why |
| --- | --- | --- |
| A tag at the end of the text, such as `[status: resolved]`. | Rejected. | Nothing forces the tag to appear or to be spelled right, and the parser would have to strip it from the customer's text. |
| A sixth function, `reply`, with `tool_choice: "required"`. | Rejected. | The tools would no longer be the MCP list. The trace and the shop would see a function that is not one of the five. |
| A second call that classifies the reply. | Rejected. | It doubles the calls per turn and asks a second model to guess what the first one meant. |
| A strict JSON schema on the message. | Chosen. | The API guarantees both fields and the enum, so a malformed status cannot reach the runner. Actions stay function calls, and speech stays the message. |

`status` comes after `reply` in the schema, so the model classifies what it has just written. The prompt defines each status in the words of the scope. A handover turn is `open`, because a person now owns the conversation and the trace derives `handed_over` from the handover itself.

The prompt also sets the order between the statuses, because a reply often does two things. It declines, or answers, and then asks the customer to check their details or offers more help. The status follows what the customer got: `resolved` when the agent gave the information or filed the request, `refused` when it declined, and `open` only when it could not act yet or handed over. Without that rule the agent declared `open` whenever a reply ended in a question, so a refused customer who was not verified left the conversation `unfinished`. That was tuning step 5.

The JSON costs a few output tokens per turn, and the reply text cannot stream to the customer until the object closes. A voice front end that streams would have to parse the `reply` field as it arrives.

### Contested point 12: how the agent resists injected instructions

The functions already refuse what the policy forbids and what an unverified customer asks. The guard covers what they cannot catch: a request the policy allows but the customer never asked for, a promise that only staff can make, and a disclosure in a reply. It has two layers.

1. **Layout.** Only `instructions` holds instructions. A customer message is always a `user` item, whatever it claims to be, and the agent never adds a `system` or `developer` item. A function result is always a `function_call_output` item holding the result's JSON, so a gift note reaches the model inside the order as the value of `gift_note`. A test puts an instruction in a gift note and checks that it reaches the model only inside a function result.
2. **Prompt.** The prompt says who speaks: only it gives instructions, a customer message that claims to come from the system or announces a policy change is still the customer's text, and typed text inside a function result is data that the agent never acts on and never repeats a link from. It allows a request only when the customer asked for it in this conversation, and it forbids saying a request is approved.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Remove `gift_note` from the order before the model sees it. | Rejected. | A customer can ask what the note says, and a filter would have to guess which text fields a person typed. |
| Wrap each function result in a marker such as `<untrusted>`. | Rejected. | The API already separates function results from instructions by item type. A second marker in text is one an attacker can type too. |
| A classifier call before each request. | Deferred. | It is a paid call per turn. A tuning failure that the prompt cannot fix would earn it. |

The agent replies in the language of the customer's latest message and follows a switch, as the prompt says. No function decides the language. The grader checks it on every case, as contested point 1 describes.

### Tuning

The agent is tuned on the tuning set only, with the Hillclimb playbook. The number is the cases passed in `pnpm tune --agent plain-gpt-6-luna`. Each step changes one thing and records three live runs with `--record`. A step is kept only when its runs clear the spread of the step it builds on. Otherwise it is reverted in full. A prompt rule must be one a support lead would write in the policy, never a tuning case's name, text or order. Before each change, the failing traces were read and their root cause written down.

**Noise.** The untuned agent passed 16, 17 and 16 in three runs, and 17 in a first run made before them. Three cases flipped between runs: `ro-adresa-veche-inainte-de-expediere` passed 2 of 4, `ro-email-gresit-la-comanda` 1 of 4 and `en-pasted-system-message` 3 of 4. `ro-anulare-in-productie` failed all four. A change therefore had to beat a spread of one case.

| Step | Change | Passed, per run | Verdict |
| --- | --- | --- | --- |
| floor | `rule-based`, the keyword baseline. | 10 | Reference, deterministic. |
| 0 | The untuned prompt, effort `low`. | 16, 17, 16 | Reference. |
| 1 | A complaint is one about the shop, a print or the service. Disagreeing with a rule is not, so keep refusing. | 15, repeat lost to a network error | Reverted. Damage reports and returns went to a person, and a delivery change after shipping was refused instead of handed over. |
| 2 | In the requests rules: when the customer argues with a refusal, explain the rule again, because that is not a complaint. | 18, 17, 17 | Reverted, it overlaps step 0. The handover list still said that disputing a decision is a complaint. |
| 3 | The complaint line itself: a complaint disputes what happened with an order, and disagreeing with a rule is not one. | 17, 17, 16 | Reverted. `ro-anulare-in-productie` passed 3 of 3, but a commission return went to a person and unrelated cases ended `open`. |
| 4 | An order between the statuses: an answer or a filing is `resolved` and a decline is `refused`, even when the reply also asks for something. | 17, 16, 18 | Reverted, it overlaps step 0. "An answer is resolved" turned a no to an approved refund into `resolved`. |
| 5 | The same order, stated by whether the customer got what they asked for. | 18, 18, 18 | **Kept.** `ro-email-gresit-la-comanda` passed 3 of 3. |
| 6 | Step 3 on top of step 5. | 18, 18, 19 | Reverted, it overlaps step 5. A commission return went to a person. |
| 7 | `staff_decision` only for the two refusals a person decides. A rule that says staff must approve is no reason to hand over. | 18, 18, third lost to a network error | Reverted, level with step 5. |
| 8 | Steps 6 and 7 together. | 17, 19, 17 | Reverted. The new complaint line sent the frustrated unverified customer to a person in 2 of 3 runs. |
| 9 | Turn time: reasoning effort `none` instead of `low`. | 15, 13, 15 | Reverted. Slower as well: median turn 2,526 to 3,210 ms against 2,094 to 2,193 ms at step 5, because the model hands over 8 to 10 of 19 cases and makes more rounds. |
| 10 | A `check_policy` decision is the answer `file_request` will give, so do not file what it refuses. | 15, 18, 18 | Reverted. No blocked attempt in three runs, which is inside chance at about one per five runs, and run 1 handed over 8 of 19. |
| 11 | Order data never decides the reply's language. | 17, 18, 18 | Reverted. Wrong-language replies went from 5 to 3 of 114, within noise. |

Steps 3, 6 and 8 each reworded the complaint line, and each one moved a failure to another case. The cause was in the scope, which handed a complaint and a dispute to a person and never said what either one is. [The scope](scope.md#complaints-and-disputes) now defines both, and steps 12 and 13 were tuned after that.

**Steps 12 and 13.** The step 5 prompt was measured again before step 12, on both models. Step 12 is graded twice: first as the earlier steps were, then with the language check, which came after it. Step 13 and the rows after it are graded with the language check only.

| Step | Change | Luna, per run | Sol, per run | Verdict |
| --- | --- | --- | --- | --- |
| 5, again | The frozen step 5 prompt, measured again. | 17, 17, 17. With the language check 14, 15, 15. | 15, 15, 15. The same with the language check. | Reference. |
| 12 | The complaint line states the scope's definition of a complaint and a dispute, and what is neither, in a support lead's words. | 19, 19, 18. With the language check 19, 18, 17, and three more runs 17, 18, 19. | 18, 18, 19 | **Kept.** No complaint handover in nine runs over both models. |
| 13 | Only the customer's latest message sets the reply language: not the order, a name, an address, a function result or the shop's country. A rule comes in both languages, so quote the one in the customer's language. | 18, 19, 19, 19, 18, 18 | 19, 19, 19 | **Kept.** Wrong-language replies fell from 5 of 235 over six step 12 runs to 0 of 234. |

Step 12 raised the mean from 17.0 to 18.7 cases on Luna and from 15.0 to 18.3 on Sol, graded as before, beyond the spread of one case or less in the runs before it. Step 13's pass count, mean 18.5 against 18.0, is inside the spread. The language failures it removed are the number it targeted: they were 5 of Luna's 6 failing cases in step 12's six runs, and none remain. The rule for keeping it was written before its runs: no run below 17, at most 3 failing cases over six runs, and at most 1 wrong-language case. Luna's two remaining failures come to half a case per run, below the spread, so the tuning stopped there.

**The frozen agent** is the step 13 prompt at effort `low`. These are its runs, the last of each committed.

| Agent | Run | Passed | Resolved correctly | Handed over | Wrong actions | Blocked attempts | Median turn | 95th percentile | Cost per conversation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `plain-gpt-6-luna` | 1 | 18/19 | 8/19 | 5/19 | 0 | 1 | 2,339 ms | 4,526 ms | $0.0003 |
| `plain-gpt-6-luna` | 2 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,330 ms | 4,464 ms | $0.0002 |
| `plain-gpt-6-luna` | 3 | 19/19 | 9/19 | 4/19 | 0 | 1 | 2,427 ms | 4,375 ms | $0.0002 |
| `plain-gpt-6-luna` | 4 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,304 ms | 4,698 ms | $0.0002 |
| `plain-gpt-6-luna` | 5 | 18/19 | 9/19 | 5/19 | 0 | 1 | 2,387 ms | 4,305 ms | $0.0002 |
| `plain-gpt-6-luna` | 6, committed | 18/19 | 9/19 | 5/19 | 0 | 1 | 2,306 ms | 4,877 ms | $0.0002 |
| `plain-gpt-6.2-sol` | 1 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,347 ms | 5,526 ms | $0.0152 |
| `plain-gpt-6.2-sol` | 2 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,275 ms | 5,869 ms | $0.0155 |
| `plain-gpt-6.2-sol` | 3, committed | 19/19 | 9/19 | 4/19 | 0 | 1 | 2,210 ms | 5,751 ms | $0.0155 |

Before step 12 the same table read, per run, Luna 14, 15 and 15 passed, 7 of 19 resolved correctly, 6 handed over, no wrong action, no blocked attempt, a median turn of 2,370 to 2,502 ms, a 95th percentile of 5,154 to 6,755 ms and $0.0002 a conversation. Sol read 15 passed, 8 resolved correctly, 8 handed over, no wrong action, 0 to 2 blocked attempts, 2,746 to 3,045 ms, 5,369 to 8,365 ms and $0.0137. Ten of the 19 cases expect a refusal or a handover, so 9 of 19 resolved correctly is every case that can be.

Turn times are nearest-rank, from model time only. The committed run of each agent is its last run, kept without choosing it for its score, and `pnpm replay` prints its row offline. The rule-based agent still passes 10 of 19 with the language check. Its fixed replies take the language of all the customer messages together, and in both cases that switch language it hands over in its first reply, before the switch. The first tuning, 41 live runs, spent $0.96 by the recorder's count. Steps 12 and 13, 24 live runs, 15 of them on Luna, spent $2.62: $0.07 on Luna and $2.55 on Sol.

**What limits the number** on Luna is a handover the customer did not ask for, half a case per run. After a refusal Luna offers a colleague and then hands over on the customer's next message, or it hands over a request it has just filed because staff must approve it. [FAILURES.md](../FAILURES.md) traces both. Sol passed every case in three runs, so the tuning set no longer separates the two models. Sol costs about 65 times as much per conversation for at most one case more per run.

## Limits

- `check_policy` decides a `damage` topic for a reprint. A damage refund above the limit is rejected only by `file_request`.
- A return covers the whole order. An order that holds any commissioned item cannot be returned, even for its catalogue prints.
- The refund of a cancellation, a return or a damage refund is the order total. The return postage that the customer pays is not deducted.
- A duplicate is a second request of the same kind for the same order. A rejected request does not count.
- `cases_sha256` covers the held-out case files only. A change to `fixtures/held-out.yaml` shows in the commit and in the `dirty` flag.
- `dirty` counts untracked files, so the results of an earlier, uncommitted score make the next score dirty.
- An agent that throws stops the run. The conversations written before it stay on disk and cannot be summarised.
- An outage covers a whole case. No case can test a function that fails in the middle of a conversation.
- The rule texts and the policy numbers are written separately in `fixtures/shop.yaml`, so a change to a number needs a change to its text.
- Turn time for the rule-based agent includes the MCP round trip and the fake backend, well under a millisecond in the median. A model-backed turn reports model time only, so it leaves out tool time until recordings capture it.
- The spend guard checks before a call and counts after it, so the last allowed call can carry the spend past the cap. The next call is refused.
- The spend file is read and written for each call. Two recording runs at the same time in one checkout could lose a cost. Cases run one after another, so one run is safe.
- A conversation that fails while recording leaves no recording. Its calls still count in the spend, and recording the case again pays for them again.
- The CLI builds a live model client once per run, before the first case. A client that checks its provider key when it is built fails before anything is spent.
- The held-out cases are in the public repository. Anyone who tunes an agent can read them.
- Model calls that run at the same time in one turn add their times, so the turn time is their sum, not the time the customer waited.
- No check catches a false promise in a reply, such as a refund the agent calls approved, unless the case names its exact words. That needs a model judge.
- The plain agent sends its function definitions with `strict: false`, so the API does not promise arguments that match the schema. The backend answers a call that does not match with `invalid_input`, and the model reads it.
- The language check knows Romanian and English only, and it leaves a reply unchecked when either reading is `unsure`. A short reply in the wrong language, or a reply that mixes the two, passes.
- One tuning run of a model agent moves by one or two cases from the last, so a single run cannot show a change worth one case. The tuning used three runs per step.
- A recording replays one run. It shows what that run did, not how often the agent does it.
- No check catches a handover made before the customer finished, because the runner stops at the handover and nothing reads what the customer still had to say. That needs a model judge.
