# Design

This page explains the foundation of the support agent for Studio Cobalt: the data shapes, the five functions and the MCP server that carries them, the runner, the recorder, the grader and the scoring record. It records what was chosen, what was considered, and why the alternatives lost. [The scope](scope.md) holds the shop policy, and [the case contract](writing-cases.md) holds the case and fixture formats. This page does not repeat them.

Nothing here calls a model or the network unless a command is given `--record`, or `pnpm chat` talks live to a model agent.

	pnpm test                    # the runner's own tests, offline
	pnpm typecheck
	pnpm tune                    # run cases/tuning, write traces/<agent>/<run>/
	pnpm score                   # run cases/held-out, write results/<agent>/<run>/, append results/ledger.jsonl
	pnpm score --set final       # the same on cases/final
	pnpm regrade <run directory> # grade a saved run again, without the agent
	pnpm replay                  # run cases/tuning for every agent that can run offline
	pnpm report                  # per scored set, each agent's runs on the latest run's cases and code, regraded from results/
	pnpm report --markdown       # the same table as Markdown
	pnpm report --runs           # every line of results/ledger.jsonl, oldest first; --markdown for Markdown
	pnpm report --check-readme   # fail when the README's table is not the current report --markdown
	pnpm ledger:code             # write the code hash of ledger lines older than code_sha256 to results/ledger-code.json, from Git
	docker compose run --rm check   # typecheck, test, replay and report in a container with no network
	pnpm tune --agent rule-based # pick an agent from the registry
	pnpm tune --agent plain-gpt-6-luna   # the model agent, replayed from recordings/
	pnpm tune --record           # call the agent's live model and write recordings/<agent>/tuning/
	pnpm mcp                     # serve the five functions over stdio, on the tuning orders
	pnpm chat --agent <name>     # type as the customer and the agent answers, on the tuning orders
	pnpm chat --agent <name> --replay <tuning case id>   # play a tuning case's recording, offline
	pnpm audit:packet --out <dir> --key <file> [--seed <text>]   # a blind packet of the scored model conversations
	pnpm audit:agreement --key <file> <verdict file>...          # readers against the grader and against each other

Git ignores `traces/`, which holds the tuning runs and the chat session logs, and `.artifacts/`. A scoring run in `results/` and a recording in `recordings/` are meant to be committed.

## Read the code in this order

The source is about 3,300 lines in 29 files. `wc -l src/*.ts src/agents/*.ts` regenerates the count.

1. `src/shapes.ts` names every shape that crosses a file or a function boundary.
2. `src/tools.ts` holds the five function contracts.
3. `src/backend.ts` is the in-memory shop. It verifies the customer and enforces the policy.
4. `src/mcp.ts` serves the backend as an MCP server and reads it back through an MCP client. It is also the stdio entry.
5. `src/agent.ts` is the agent boundary. `src/model.ts` replays and records model calls, and `src/spend.ts` caps what a recording or a live chat may spend. `src/snapshot.ts` is the one deep copy that the backend, the runner and the recorder share.
6. `src/runner.ts` opens a session, one conversation through MCP that takes one customer message at a time, and plays a case through it.
7. `src/trace.ts` derives the effects and the outcome from a conversation.
8. `src/grade.ts` compares a conversation with its case. `src/language.ts` reads the language of a message for it.
9. `src/summary.ts` turns the results of one run into the numbers.
10. `src/files.ts` reads and writes files and enforces the case contract. `src/ledger.ts` records a scoring run with the hashes of its cases and its code. `src/report.ts` lays out the report and the run tables and finds the README's table.
11. `src/chat.ts` lets a person talk to an agent, and `src/redact.ts` masks the personal data in what it logs and prints.
12. `src/packet.ts` builds the blind packet for readers, and `src/agreement.ts` loads their verdicts and measures how far they agree.
13. `src/cli.ts` holds the ten commands, and `src/env.ts` finds the environment file it loads. `src/agents/` holds the registry, the rule-based baseline and the plain model agent: `prompt.ts` is the system prompt, `openai.ts` the live client and its prices, `plain.ts` the agent.

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
| `LedgerEntry` | One scoring run: the time, the agent, the commit, the tree state, a hash of the cases of its set, a hash of its code and the summary, whose split names the set. | `results/ledger.jsonl` |
| `ChatLog` | One `pnpm chat` session: the conversation id, the agent, the replayed case if any, the start time and the turns, every string in them masked. | `traces/chat/<agent>/<session>.json` |
| `AuditKey` | The seed of a blind packet and, for each random id in it, the agent, the run and the case. | A path given by `--key`, outside the packet. |
| `Verdict` | One reader's judgement of one conversation: the id, `acceptable`, one field per criterion and a note. | `results/audit/<reader>.jsonl` |

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

A damage claim names `remedy` only when the customer chose a reprint or a refund. The field is optional, because the scope lets staff decide after a photo, and a required field made the agent ask a question that the customer had no reason to answer. A new address, a damage description and a handover summary must hold more than spaces, or the function answers `invalid_input`. A customer is verified when a function receives an order number and the email on that order. The comparison ignores capitals and surrounding spaces. An unknown order and a wrong email return the same `not_found` error, so the answer reveals nothing about which one was wrong.

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

The runner sends every function call through MCP. For each conversation it builds a server on that case's backend, which holds the case's orders and outage flag, connects a client over the SDK's `InMemoryTransport`, and closes both when the conversation ends. `openSession` does this for one conversation and takes the customer's messages one at a time. `runCase` plays a case's turns through it, and `pnpm chat` plays a person's, so both reach the agent and the shop by one path. The trace records the input as the agent sent it and the output as the client returned it, so the traces of the rule-based agent are the same as before MCP, apart from the conversation id and the time. The runner takes a JSON copy of the input before it sends it and of the output when it arrives, and it hands the agent a copy of the history at each turn. Agent code that later edits a call or an earlier turn changes its own copy, never the trace.

`pnpm mcp` runs `src/mcp.ts`, which serves the tuning orders over stdio with `serveStdio`. It reads `fixtures/tuning.yaml` by name, so it never serves the held-out or the final orders. pnpm writes its own banner to stderr, so an MCP client can launch `pnpm mcp` directly. To try the functions by hand, give the MCP Inspector the command `pnpm mcp`.

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

With `--record`, the CLI builds the live client once per run and, for each conversation, wraps it with `recordModel` in `src/model.ts`. The runner wraps it once more to measure each turn, and the agent receives that as `model` in `open`, so its code is the same for a live run and a replay. The recorder sends each call through `guardedModel`, the live client under the spend guard, which a live `pnpm chat` uses on its own. For each call:

1. the recorder copies the request,
2. the guarded client asks the spend guard whether a live call is allowed, times the live call with `performance.now()` and adds the reported cost to the running spend,
3. the recorder keeps the call, with the copied request and response, the time and the cost, and hands the agent a separate copy, so an agent that edits a response changes nothing in the recording.

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

`pnpm score` first reads the commit and whether the tree is dirty, and refuses to run outside a Git checkout. It hashes the case files of the set it scores, runs, appends one line to `results/ledger.jsonl`, and only then saves `results.json` and `summary.json`. No saved score therefore exists without its line. A ledger write that fails leaves the conversations and no summary.

`regrade` on a scored run looks up the run's ledger line. When the case files of its set have changed since that line, or when no line records the run, the report says so in a sentence after the numbers.

| Alternative | Verdict | Why |
| --- | --- | --- |
| One fixed output directory per split. | Rejected. | A second run overwrote the first, so a scoring run could not be kept. |
| Summarise whatever results exist. | Rejected. | An interrupted run published numbers over fewer cases. |
| `regrade` writes new results into the run. | Rejected. | A committed scoring run would change after the fact. `regrade` prints and writes nothing. |

## Contested point 10: how the agent is chosen

`src/agents/index.ts` holds a registry keyed by agent name. `--agent <name>` picks one, and the default is `rule-based`. Adding an agent is one entry in its list. The registry is a `Map`, not a plain object, because a plain object answers inherited names: `tune --agent constructor` found `Object` and crashed inside the run. A name that is not in the map is refused before a run directory exists.

`pnpm tune` takes no set and runs `cases/tuning`. `pnpm score` runs `cases/held-out`, the validation set, and `--set final` runs `cases/final`, the set the README quotes. `--set tuning` is refused, and `pnpm tune --set` is refused with the usage line, so the tuning command reaches neither scored set. The loader reads one folder. A ledger line's set is its summary's `split`, which every line has recorded since the first score, so no line needed a new field. The ledger refuses a line whose split is `tuning`. A case whose `split` differs from its folder fails the load, so a held-out case moved into `cases/tuning` cannot run as tuning.

## The report and the one-command check

`pnpm report` prints the numbers the README may quote, one table per scored set, the final set first. It reads `results/ledger.jsonl`. For each agent on a set, a row covers every scored run with the same cases and the same code as the agent's latest run on that set. It grades each run's saved conversations again with `grade` and `summarize`, the same code that scored them, and compares every field of each new summary with the summary on its ledger line. One differing field stops the report with the field, both values and the likely cause: the cases changed since the score, or they did not and the grader or the saved conversations did. When every run agrees, the row gives each count as the total over its runs, the share of their conversations, and the lowest and highest count in one run, such as `47/54 (87%), per run 15–16`. The turn times are nearest-rank over every turn of those runs, and the cost is their total over their conversations. The row names its number of runs, the start of the code hash, the commit of the latest run, marked `(dirty)` when that tree was dirty, and the number of lines the agent has for the set, so a reader sees how often the set was used. The report writes nothing and adds no ledger line.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Print the summary saved on the ledger line. | Rejected. | It trusts a copy. A grader change that moves a number would go unnoticed until the next score. |
| Print the best run of each agent. | Rejected. | Picking the best of several held-out runs is tuning on the held-out set. |
| Regrade the latest run only. | Rejected. | One run of a model agent moves by a case from the next. Luna and Sol each passed 47 of 54 held-out conversations over three runs, and the latest runs read 15 and 16, so one looked a case ahead. |
| Pool every run of the agent on the set. | Rejected. | A run on other cases or other code measures another test or another agent. |
| Regrade every run on the latest run's cases and code, print the total and the range, and stop on any difference. | Chosen. | Every printed number is one the current code reproduces from committed files, and the range shows how far one run moves. |

### How the report knows two runs used the same code

`pnpm score` records `code_sha256`, a SHA-256 over the files that decide how a run plays and grades, apart from its cases: everything under `src/`, `package.json`, `pnpm-lock.yaml`, `fixtures/shop.yaml` and the set's order file. It hashes them as they are on disk, so a dirty tree hashes what ran. Each file adds its path from the root, with forward slashes, then its bytes, in path order, the scheme of `cases_sha256`. Tests, docs, recordings and results are left out, because none of them changes a conversation or its grade. The prompt is in `src/`, so a prompt change is a code change.

The nine lines written before the field cannot be rewritten. `pnpm ledger:code` computes the same hash from Git, from the files each clean line's commit holds, and writes it to `results/ledger-code.json`, keyed by the line's run. Run again, it checks every hash in that file against Git and adds the missing ones. A dirty line gets none, because its commit does not hold what ran. The report takes a line's own field first, then that file, and a line whose code is unknown stands alone in its row. Both are committed files, so the Docker image, which has no `.git`, reports the same rows. A test scores twice at two commits, removes the field from both lines, and shows that the runs stand alone until `pnpm ledger:code` gives them the hash they recorded.

On the current ledger the seven lines from `2d848d8` to `72d7b66` share one code hash, because the commits between them changed only `results/`. The two earlier rule-based lines each have their own, so the rule-based row covers its latest run alone.

Ledger lines are evidence and are never edited. A history rewrite changes commit IDs, so `results/commit-map.json` maps original full IDs to rewritten full IDs. `pnpm ledger:code` uses the mapped IDs to read from Git, and `pnpm report` uses them in its commit columns. When no mapping exists for a commit, both commands use the ID recorded in the ledger.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The commit. | Rejected. | Every score commits its results, so each of the nine runs sits at its own commit, and no row would ever cover two runs. |
| Compare commits with `git diff` when the report runs. | Rejected. | The Docker image has no Git history, so the container check could not run it. |
| Hash only the files a scored run imports. | Rejected. | It follows the import graph, which moves as the code does. Hashing all of `src/` costs at most a row that starts again after a change to a file a run does not use, such as `src/report.ts`. That shows fewer runs, never a wrong number. |
| A content hash of the code, recorded by score and computed once from Git for older lines. | Chosen. | Two runs share a row only when the files that decide them are byte for byte the same, whatever else changed between their commits, and the check needs no Git where it runs. |

`pnpm report --runs` prints one row for every line of the ledger, oldest first: the agent, the set, the time, the commit, whether the tree was dirty, the first 12 characters of the cases hash and of the code hash, and the counts of the summary. It reads the ledger, `results/ledger-code.json`, and `results/commit-map.json`, so it works where the saved runs are absent, and a change of hash between two rows shows that the cases or the code changed between those scores. `--markdown` prints it as Markdown.

README.md shows the `pnpm report --markdown` table between the lines `<!-- report table: start -->` and `<!-- report table: end -->`. `pnpm report --check-readme` builds the report as `pnpm report --markdown` does, regrading the latest runs, and fails when the lines between the markers differ from it. The error names the first line that differs. A new score makes the table stale, and so does a hand edit or a grader change that moves a number. `pnpm check` runs it last, so the container check fails until the README shows the current numbers.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The README quotes the numbers in its prose. | Rejected. | A sentence cannot be compared with the report, so a stale number goes unnoticed. |
| A command that rewrites the README table. | Deferred. | Pasting the output of `pnpm report --markdown` is one step, and the check catches a paste that went wrong. |
| A marked block that must equal the report. | Chosen. | The README cannot hold a number that the current code and the committed runs do not reproduce. |

`pnpm replay` runs the tuning set for each agent in the registry. An agent with a live model client needs recordings, and one with no file under `recordings/<agent>/tuning/` is skipped with a sentence that says so. An agent with only some recordings stops on the first case without one, because a partial replay would print numbers over fewer cases.

`docker compose run --rm check` builds the image in `Dockerfile` and runs `pnpm check`: the typecheck, the tests, the replay, the report and the README check. The build needs the network, to fetch the pinned `node:24.22.2-slim` image, Git, pnpm and the locked dependencies. The run does not: `compose.yaml` sets `network_mode: none`, so a test or a command that reached for a provider would fail the check. `pull_policy: build` builds again on every run, so the image never lags behind the checkout. `.dockerignore` leaves out `.git`, `.env` and the local run folders. The tests still need the `git` binary, because the score tests make throwaway repositories.

## The blind audit

The grader checks what a case can state without judgement. A false promise, a fact with no source, a handover before the customer said what they need and a rude reply pass it. The audit has readers judge every scored conversation of the model agents against [the rubric](judging.md), without knowing which agent wrote it, and measures how far they agree with each other and with the grader.

`pnpm audit:packet --out <dir> --key <file>` reads every ledger line of an agent with a live model client, refuses a run that holds fewer conversations than its line scored, and writes one Markdown file per conversation. A file shows the numbered turns, each function call with its input and its result under the turn that made it, and the handover. The runner stops at a handover, so a trace ends there even when the script held more customer messages. Under **Not reached**, after the handover, the file lists those messages, taken from the case the conversation ran. The command refuses a conversation whose customer turns no longer match its case, because the list would then not be what the customer still had to say. In the six scored model runs, 14 of the 108 conversations end with such messages. It leaves out the agent, the run, the case id, the conversation id, the declared status, the time and the cost. The cost alone names the model, because one costs about 65 times the other. Each file is named by a random id. The packet also holds copies of the scope and the rubric, and `verdicts.jsonl`, one blank line per conversation in the shuffled order.

The ids and the order come from SHA-256 of the seed and a counter, so `--seed` rebuilds the same packet byte for byte. Without `--seed` a random one is drawn and printed. The key records the seed and maps each id to its agent, run and case. The command refuses a key inside the packet, a packet folder that is not empty, and a folder inside the repository that Git does not ignore.

`pnpm audit:agreement --key <file> <verdict file>...` validates each verdict file against the key: every id once, no unknown id, every field filled, `acceptable` true exactly when every criterion holds, and a note that names the turn of a failure. The file name names the reader. For each reader it prints the acceptable conversations per agent beside the grader's passes from the saved `results.json`, the agreement with the grader as a count, Cohen's kappa and a two-by-two table, and the criteria that failed most. For each pair of readers it prints their agreement on `acceptable`, Cohen's kappa and the ids where they differ. Kappa is undefined when both gave one answer to every conversation, and the report says so instead of dividing by zero.

`--partial` lets a verdict file judge only some of the key's conversations, such as a hand-checked sample. That reader is compared with the grader on the conversations it judged and with each other reader on the conversations both judged, and each of its headings says how many, such as `reader human, on 18 of 108 conversations`. Without the flag a file that misses a conversation is rejected, so a reader who skipped one by mistake is caught.

`pnpm audit:sheet --packet <dir> --ids <file> --out <file.html>` turns some of a packet's conversations into one page that a person labels in a browser. The ids file lists one id per line, in the order the page shows them. The command reads each conversation back from its packet file, so the page shows only what a packet reader sees, and it reads the seven criteria and their tests from the packet's `judging.md`. Each conversation shows as a chat with its function calls folded, then the handover, then any customer messages not reached in a dashed box, then the verdict form. The rubric and the scope sit behind a Rules button. The page keeps the answers in the browser's local storage and downloads `human.jsonl`, one verdict line per finished conversation, which `pnpm audit:agreement --partial` reads. Its content security policy allows no request, so the page works offline and sends nothing. The script that turns answers into verdict lines is `src/sheet-page.js`, and a test runs it in Node and loads its output with the same parser as any verdict file.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Build the page from the saved runs and the key. | Rejected. | The key names the agent and the case. Reading the packet keeps the page exactly as blind as the packet. |
| Let the reader fill `verdicts.jsonl` by hand. | Rejected for a hand-checked sample. | Typing nine fields per line is slow and error-prone, and the loader would reject a typo only at the end. |

| Alternative | Verdict | Why |
| --- | --- | --- |
| Show the agent's declared status. | Rejected. | It is the agent's own claim of the outcome and anchors the reader. The customer never sees it. |
| Show the time and the cost of each turn. | Rejected. | The cost names the model. |
| Drop function results that hold an error, such as `invalid_input`. | Rejected. | A malformed call is behaviour a reader should judge, even though only one agent makes them. |
| Number the files 1 to 108. | Rejected. | A number invites reading in order, and the order is what the shuffle hides. |

The audit is blind only to a reader who has nothing but the packet. The saved conversations are in this repository, so anyone with the repository can find a reply's agent with a text search. The seed rebuilds the key from the code, so it is as secret as the key. Behaviour still differs by agent: in the six held-out runs, 12 of one agent's 54 conversations hold an `invalid_input` result and none of the other's, and one agent calls `check_policy` in 32 of its 54 conversations where the other calls it in 20. The reply length, the quotation marks and the language of the handover summaries are close between the two. A reader sees each customer script six times and could sort the six into two groups of three.

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

**Step 13's runs** at effort `low` are below. Luna's run 7 and Sol's run 4 were recorded after the damage claim's `remedy` became optional, a change to the function definitions that the old recordings could not replay, with the prompt unchanged.

| Agent | Run | Passed | Resolved correctly | Handed over | Wrong actions | Blocked attempts | Median turn | 95th percentile | Cost per conversation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `plain-gpt-6-luna` | 1 | 18/19 | 8/19 | 5/19 | 0 | 1 | 2,339 ms | 4,526 ms | $0.0003 |
| `plain-gpt-6-luna` | 2 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,330 ms | 4,464 ms | $0.0002 |
| `plain-gpt-6-luna` | 3 | 19/19 | 9/19 | 4/19 | 0 | 1 | 2,427 ms | 4,375 ms | $0.0002 |
| `plain-gpt-6-luna` | 4 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,304 ms | 4,698 ms | $0.0002 |
| `plain-gpt-6-luna` | 5 | 18/19 | 9/19 | 5/19 | 0 | 1 | 2,387 ms | 4,305 ms | $0.0002 |
| `plain-gpt-6-luna` | 6 | 18/19 | 9/19 | 5/19 | 0 | 1 | 2,306 ms | 4,877 ms | $0.0002 |
| `plain-gpt-6-luna` | 7, optional remedy | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,449 ms | 4,782 ms | $0.0003 |
| `plain-gpt-6.2-sol` | 1 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,347 ms | 5,526 ms | $0.0152 |
| `plain-gpt-6.2-sol` | 2 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,275 ms | 5,869 ms | $0.0155 |
| `plain-gpt-6.2-sol` | 3 | 19/19 | 9/19 | 4/19 | 0 | 1 | 2,210 ms | 5,751 ms | $0.0155 |
| `plain-gpt-6.2-sol` | 4, optional remedy | 19/19 | 9/19 | 4/19 | 0 | 1 | 2,289 ms | 5,470 ms | $0.0167 |

Before step 12 the same table read, per run, Luna 14, 15 and 15 passed, 7 of 19 resolved correctly, 6 handed over, no wrong action, no blocked attempt, a median turn of 2,370 to 2,502 ms, a 95th percentile of 5,154 to 6,755 ms and $0.0002 a conversation. Sol read 15 passed, 8 resolved correctly, 8 handed over, no wrong action, 0 to 2 blocked attempts, 2,746 to 3,045 ms, 5,369 to 8,365 ms and $0.0137. Ten of the 19 cases expect a refusal or a handover, so 9 of 19 resolved correctly is every case that can be.

Turn times are nearest-rank, from model time only. The rule-based agent still passes 10 of 19 with the language check. Its fixed replies take the language of all the customer messages together, and in both cases that switch language it hands over in its first reply, before the switch. The first tuning, 41 live runs, spent $0.96 by the recorder's count. Steps 12 and 13, 24 live runs, 15 of them on Luna, spent $2.62: $0.07 on Luna and $2.55 on Sol. The two runs with the optional remedy spent $0.32: $0.005 on Luna and $0.317 on Sol. One run each shows that the change broke neither agent on the tuning set. It cannot show a change of one case, which is inside the spread.

**Step 14.** `file_request` no longer needs a remedy, because the policy lets staff choose between a reprint and a refund after a photo. The step 13 prompt still told the agent to ask the customer to choose before it filed. Step 14 states the policy instead: file a damage claim once the customer is verified and has described the damage, give a remedy only when the customer chose one, never ask them to choose, and tell the customer that staff will ask for a photo and decide. It corrects the prompt to match the policy and is not a climb. So the rule written before its runs was to keep it unless it lowered the pass count beyond the spread, and to read every damage trace. The step 13 prompt was measured three more times on the same code first.

| Agent | Step, run | Passed | Resolved correctly | Handed over | Wrong actions | Blocked attempts | Median turn | 95th percentile | Cost per conversation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `plain-gpt-6-luna` | step 13, 8 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,239 ms | 5,132 ms | $0.0002 |
| `plain-gpt-6-luna` | step 13, 9 | 19/19 | 9/19 | 4/19 | 0 | 0 | 1,925 ms | 4,270 ms | $0.0002 |
| `plain-gpt-6-luna` | step 13, 10 | 18/19 | 9/19 | 5/19 | 0 | 0 | 1,942 ms | 3,886 ms | $0.0002 |
| `plain-gpt-6-luna` | step 14, 1 | 18/19 | 8/19 | 5/19 | 1 | 1 | 2,400 ms | 4,538 ms | $0.0003 |
| `plain-gpt-6-luna` | step 14, 2 | 17/19 | 7/19 | 5/19 | 1 | 0 | 2,387 ms | 4,699 ms | $0.0002 |
| `plain-gpt-6-luna` | step 14, 3 | 17/19 | 8/19 | 5/19 | 1 | 1 | 2,638 ms | 4,553 ms | $0.0003 |
| `plain-gpt-6-luna` | step 15, 1 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,344 ms | 4,838 ms | $0.0002 |
| `plain-gpt-6-luna` | step 15, 2 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,315 ms | 4,386 ms | $0.0002 |
| `plain-gpt-6-luna` | step 15, 3, committed | 19/19 | 9/19 | 4/19 | 0 | 1 | 2,407 ms | 5,277 ms | $0.0002 |
| `plain-gpt-6.2-sol` | step 13, 5 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,298 ms | 5,606 ms | $0.0160 |
| `plain-gpt-6.2-sol` | step 13, 6 | 19/19 | 9/19 | 4/19 | 0 | 2 | 2,331 ms | 5,710 ms | $0.0165 |
| `plain-gpt-6.2-sol` | step 13, 7 | 18/19 | 9/19 | 4/19 | 0 | 2 | 2,372 ms | 5,361 ms | $0.0165 |
| `plain-gpt-6.2-sol` | step 14, 1 | 18/19 | 8/19 | 5/19 | 1 | 0 | 2,375 ms | 5,048 ms | $0.0166 |
| `plain-gpt-6.2-sol` | step 14, 2 | 18/19 | 8/19 | 5/19 | 1 | 0 | 2,213 ms | 6,113 ms | $0.0164 |
| `plain-gpt-6.2-sol` | step 14, 3 | 18/19 | 8/19 | 5/19 | 1 | 0 | 2,219 ms | 5,579 ms | $0.0165 |
| `plain-gpt-6.2-sol` | step 15, 1 | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,148 ms | 5,574 ms | $0.0162 |
| `plain-gpt-6.2-sol` | step 15, 2 | 19/19 | 9/19 | 4/19 | 0 | 1 | 2,158 ms | 5,148 ms | $0.0165 |
| `plain-gpt-6.2-sol` | step 15, 3, committed | 19/19 | 9/19 | 4/19 | 0 | 0 | 2,340 ms | 5,681 ms | $0.0156 |

**Step 14 result.** Luna's mean fell from 18.7 to 17.3 cases and Sol's from 18.7 to 18.0. The case `ro-print-indoit-retiparire` passed all six step 13 runs above and failed all six step 14 runs. On the other 18 cases Luna passed 18, 18 and 17 before and 18, 17 and 17 after, and Sol passed 18, 18 and 17 before and 18 in each run after. Those differences are inside the spread. Every step 14 run filed the claim on the customer's second message with no remedy and told her that staff would ask for a photo and decide, as the policy required. The script expected the reprint she named in her third message, after the claim was on file. The grader counted that claim as one wrong action in each run. Sol handed over the claim in each run to pass on the reprint preference. The other step 14 failures were the two Luna handovers that step 13 also showed. A fourth Luna step 14 run stopped at `en-return-commissioned-portrait`, when OpenAI answered 400 and flagged the request under its usage policy. It left no summary, so it is not in the table, and Luna's run 3 was recorded after it.

Step 14's 13 live runs, the stopped one included, spent $1.90: $0.03 on Luna and $1.87 on Sol.

**Step 15.** The prompt stayed the same. The repaired case moved the reprint preference into the message with the order number and email. The third message became a short thanks, and the expected damage claim still specifies `remedy: reprint`. Both agents passed all 19 cases in each of three live runs with the language check. [Tuning failure history](../FAILURES.md)

**The frozen agent** uses the step 14 prompt at effort `low`. The committed recordings come from the third step 15 run for each agent on the repaired tuning set. Run `pnpm replay` to reproduce their grades offline.

The tuning set no longer separates the agents after fifteen steps of measuring prompt and case changes against these 19 cases. Use the final-set table from `pnpm report` for scores you quote.

## Talking to the agent

`pnpm chat --agent <name>` lets a person type as the customer. `chat` in `src/chat.ts` plays each message through `openSession`, the session that `runCase` plays a case through: the same agent code, the same MCP server and client, and a backend built from the tuning orders, so a chat never sees a held-out order. The terminal shows the customer's and the agent's text as they are, one line per function call with its input and its result cut at 200 characters, then the reply's status, time and cost. When the input is piped rather than typed, chat echoes each customer line, so the output reads as a transcript. Chat ends when the input ends, or when the agent hands over, as a case does, because a person now owns the conversation. A blank line is skipped.

A model agent's live client is built before chat prints anything, so a missing key stops it before anything is spent. The client is `guardedModel`, under the spend guard that `--record` uses, so a chat's calls count in the same `.artifacts/spend.json` and stop at the same cap. Chat prints the cap and the spend so far when it starts, and what it spent when it ends. It saves no recording, because a recording holds the requests as sent, with the customer's text unmasked. The rule-based agent makes no model call, so its chat costs nothing and needs no key.

`--replay <tuning case id>` plays the customer turns of one tuning case against the agent's committed recording, `recordings/<agent>/tuning/<case id>.json`, with the case's outage flag. The session is the one the scored run used, so the agent sends the requests it recorded and the replay answers them, offline and without a key. Chat loads only the tuning split, so a held-out case cannot be replayed.

Each session writes its log to `traces/chat/<agent>/<start time>-<suffix>.json` after every turn, so an interrupted chat keeps its finished turns. The log is a `ChatLog`: the turns with every string passed through `redact`, and the conversation id, the agent, the start time and the replayed case, which are the shop's own and stay as they are.

| Alternative | Verdict | Why |
| --- | --- | --- |
| A loop in chat that calls the agent and the MCP client itself. | Rejected. | A second path to the agent. A chat could show behaviour that no scored run has. |
| Chat saves a recording, so a live session can be replayed. | Rejected. | The recording would hold the customer's text unmasked, beside the masked log. |
| Replay prints the saved trace of a tuning run. | Rejected. | A trace shows what happened once. Replaying the recording runs the agent's code again. |
| One session that a case and a chat both feed, one message at a time. | Chosen. | `runCase` became a loop over a case's turns on that session, and every runner test passed without a change. |

## Contested point 13: where personal data is masked

`redact` in `src/redact.ts` is the one function that masks personal data. It replaces an email address with `[email]`, an IBAN with `[iban]`, a street and its house number with `[address]`, and any run of nine digits or more with `[card]`, `[phone]` or `[number]`. A run of 13 to 19 digits is a card number, unless it starts with `+` or `00`, which makes it a phone number like any run of 9 to 12 digits. A longer run is a number. It keeps the city after a street, an order number, a status, a date, a price, a size and a request id, because staff follow a log by them. `redacted` passes every string in a value through `redact` and returns a copy.

Digit runs fail closed. A run is digits with at most two spaces, dots, hyphens or brackets between each, and only a digit ends one, so a card number glued to a word is still masked. A date has 8 digits and an order number 4, so the length rule keeps either one alone. A date or an order number that touches a longer number with only a space between joins the run and is masked with it. An exception for dates let a card number typed in the shape of a date through, as an automated review showed, so there is none.

Chat writes through two calls. `conversation` shows what the customer and the agent said, unmasked, because the person at the terminal typed it or is reading the reply to it. `note` shows everything else, and chat passes each note through `redact`: the function-call lines, the status lines, the banner, the closing line and the error of a chat that stopped. The saved log masks the conversation as well. The model and the functions receive the text as it was typed, because `redact` runs only where chat writes, after the session holds the turn. A function can verify a customer only from the email the customer gave.

The scored traces under `traces/` and `results/` and the recordings under `recordings/` are never masked. They hold invented customers only: every email is at `example.com`, which the case loader enforces, and every name, address and order is invented. They must stay exact, because `regrade` and `report` grade a saved trace again and must reproduce its ledger line, and a replay matches each request to its recording byte for byte. Masking would also change grades. A case whose `reply_never_mentions` holds an email would pass a reply that leaked it, because the grader would read `[email]`. One test shows that, and another shows that a chat replaying a tuning case leaves the case's saved trace and its regrade unchanged. The commands that print grades print them exact, since a failure detail can name the address that did not match.

| Alternative | Verdict | Why |
| --- | --- | --- |
| Mask the scored traces and recordings too. | Rejected. | A replay would no longer match its recording, a regrade would no longer match the ledger, and a leaked email would grade as a pass. |
| Mask before the model sees the text. | Rejected. | The functions verify a customer by the email and file the address the customer typed. Masked, neither works. |
| Mask by field name, such as `email` and `address` in a function result. | Rejected. | It misses what a customer types, which has no field. The patterns catch both. |
| A named-entity model or a hosted service. | Rejected. | A dependency or a paid call for every line, with no measured gain on the data the shop handles. |
| One text function wherever chat writes outside the conversation. | Chosen. | One place to fix a miss, and a test for each kind it masks. |

## Limits

- `check_policy` decides a `damage` topic as a claim that asks for no refund. A damage refund above the limit is rejected only by `file_request`.
- No function can amend a filed damage claim to add a remedy preference. The tuning set has no case where the customer first names a preference after the agent files the claim.
- A case that leaves `remedy` out matches a damage claim with any remedy, so the grader does not catch a remedy the customer never chose. The rubric's `requests` criterion does.
- A return covers the whole order. An order that holds any commissioned item cannot be returned, even for its catalogue prints.
- The refund of a cancellation, a return or a damage refund is the order total. The return postage that the customer pays is not deducted.
- A duplicate is a second request of the same kind for the same order. A rejected request does not count.
- `code_sha256` covers all of `src/`, so a change to a file that no scored run uses, such as the report, starts a new row for the next score.
- `cases_sha256` covers the case files of the scored set only. A change to its order file shows in `code_sha256` instead.
- `dirty` counts untracked files, so the results of an earlier, uncommitted score make the next score dirty.
- An agent that throws stops the run. The conversations written before it stay on disk and cannot be summarised.
- An outage covers a whole case. No case can test a function that fails in the middle of a conversation.
- The rule texts and the policy numbers are written separately in `fixtures/shop.yaml`, so a change to a number needs a change to its text.
- Turn time for the rule-based agent includes the MCP round trip and the fake backend, well under a millisecond in the median. A model-backed turn reports model time only, so it leaves out tool time until recordings capture it.
- The spend guard checks before a call and counts after it, so the last allowed call can carry the spend past the cap. The next call is refused.
- The spend file is read and written for each call. Two recording runs or live chats at the same time in one checkout could lose a cost. Cases run one after another, so one run or one chat is safe.
- A conversation that fails while recording leaves no recording. Its calls still count in the spend, and recording the case again pays for them again.
- The CLI builds a live model client once per run, before the first case. A client that checks its provider key when it is built fails before anything is spent.
- The held-out and final cases are in the public repository. Anyone who tunes an agent can read them, unless the tuner works in the sparse checkout that the verification skill describes.
- Model calls that run at the same time in one turn add their times, so the turn time is their sum, not the time the customer waited.
- No check catches a false promise in a reply, such as a refund the agent calls approved, unless the case names its exact words. [The blind audit](#the-blind-audit) asks readers to catch it.
- The plain agent sends its function definitions with `strict: false`, so the API does not promise arguments that match the schema. The backend answers a call that does not match with `invalid_input`, and the model reads it.
- The language check knows Romanian and English only, and it leaves a reply unchecked when either reading is `unsure`. A short reply in the wrong language, or a reply that mixes the two, passes.
- One tuning run of a model agent moves by one or two cases from the last, so a single run cannot show a change worth one case. The tuning used three runs per step.
- A recording replays one run. It shows what that run did, not how often the agent does it.
- No automatic check catches a handover made before the customer finished, because the runner stops at the handover. [The blind audit](#the-blind-audit) shows a reader the customer messages not reached and asks the reader to catch it.
- The two blind readers judged the first packet, built before it showed the customer messages not reached. A reader of that packet could not tell that a handover cut a conversation short, so their verdicts on the `handover` criterion for those 14 conversations rest on less than the script held.
- `redact` masks by pattern, so it misses personal data in a shape it does not know: a name, typed or in `customer_name`; a street without a street word it knows, such as `Fundătura` or `Prelungirea`, or without a house number; a house number in words; a phone number under nine digits; digits split by words; an email written as `ana at example dot com`; an IBAN glued to a word, of which only the digits after its last letter are masked; and any other personal fact in free text, such as a birthday in a gift note. The city after a street stays on purpose.
- `redact` also masks what is not personal when it matches a pattern: any run of nine digits or more, and a phrase such as `1 more place` that reads as a house number, a word and a street word.
- The terminal shows the conversation of a chat unmasked, so its scrollback holds what the customer typed.
