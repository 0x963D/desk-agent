# Design

This page explains the foundation of the support agent for Studio Cobalt: the data shapes, the five functions and the MCP server that carries them, the runner, the recorder, the grader and the scoring record. It records what was chosen, what was considered, and why the alternatives lost. [The scope](scope.md) holds the shop policy, and [the case contract](writing-cases.md) holds the case and fixture formats. This page does not repeat them.

Nothing here calls a model or the network unless a command is given `--record`.

	pnpm test                    # the runner's own tests, offline
	pnpm typecheck
	pnpm tune                    # run cases/tuning, write traces/<agent>/<run>/
	pnpm score                   # run cases/held-out, write results/<agent>/<run>/, append results/ledger.jsonl
	pnpm regrade <run directory> # grade a saved run again, without the agent
	pnpm tune --agent rule-based # pick an agent from the registry
	pnpm tune --record           # call the agent's live model and write recordings/<agent>/tuning/
	pnpm mcp                     # serve the five functions over stdio, on the tuning orders

Git ignores `traces/` and `.artifacts/`. A scoring run in `results/` and a recording in `recordings/` are meant to be committed.

## Read the code in this order

The source is about 1,400 lines in 17 files. `wc -l src/*.ts src/agents/*.ts` regenerates the count.

1. `src/shapes.ts` names every shape that crosses a file or a function boundary.
2. `src/tools.ts` holds the five function contracts.
3. `src/backend.ts` is the in-memory shop. It verifies the customer and enforces the policy.
4. `src/mcp.ts` serves the backend as an MCP server and reads it back through an MCP client. It is also the stdio entry.
5. `src/agent.ts` is the agent boundary. `src/model.ts` replays and records model calls, and `src/spend.ts` caps what a recording may spend.
6. `src/runner.ts` plays one case through MCP and returns its conversation.
7. `src/trace.ts` derives the effects and the outcome from a conversation.
8. `src/grade.ts` compares a conversation with its case.
9. `src/summary.ts` turns the results of one run into the numbers.
10. `src/files.ts` reads and writes files and enforces the case contract. `src/ledger.ts` records a scoring run.
11. `src/cli.ts` holds the three commands. `src/agents/` holds the registry and the rule-based baseline.

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

Six choices in the shapes remove states that should not exist.

- The expectation is a union on `outcome`. `handover_reason` exists only on `handed_over`, and a `refused` case has no `requests`, because a refusal changes nothing.
- An order is a union on `status`. `tracking_url` exists only once the order ships, and `delivered_on` exists only once it arrives.
- A conversation stores no outcome, no requests and no handover. `src/trace.ts` derives all three from the accepted function calls in the turns, so a stored copy cannot disagree with them.
- A test result has no `passed` flag and no outcome failure. `passed` in `src/grade.ts` is true when the observed outcome equals the expected one and the list of failures is empty. A saved result whose outcomes differ therefore never reads as a pass.
- A case file is strict. A misspelled key such as `reply_never_mention` fails the load. A loose schema would drop the key and silently remove a safety check.
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

A customer is verified when a function receives an order number and the email on that order. The comparison ignores capitals and surrounding spaces. An unknown order and a wrong email return the same `not_found` error, so the answer reveals nothing about which one was wrong.

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

The fake backend is built again from the fixtures for each conversation, so no case sees another case's requests.

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

A phrase check catches a verbatim disclosure. It does not catch a paraphrase or a rude tone.

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

Recordings live at `recordings/<agent>/<split>/<case id>.json`, one array of `ModelCall` per file. None exists yet. A missing recording fails with a message that recording one is a paid call and needs the maintainer's approval.

## Contested point 7: how a recording is made

An agent in the registry may declare `liveModel`, a function that builds its live model client. The client answers `complete(request)` with the response and the cost of that call in US dollars, which the provider reports. The rule-based agent declares none, and `--record` refuses it before the run starts.

With `--record`, the CLI builds the live client once per run and, for each conversation, wraps it with `recordModel` in `src/model.ts`. The agent receives the wrapper as `model` in `open`, so its code is the same for a live run and a replay. For each call the recorder:

1. asks the spend guard whether a live call is allowed,
2. copies the request, then times the live call with `performance.now()`,
3. adds the reported cost to the running spend,
4. keeps the call, with the copied request and response, the time and the cost.

When the conversation ends, the CLI saves the calls in order to the conversation's recording path. A replay of that file gives the agent the same responses, times and costs, so it produces the same turns.

The request is copied when the call is made, because an agent usually keeps one message list and grows it after each call. A recording that kept a reference would store the final list for every call, and the replay would fail on its first call. A test grows the list and replays.

A model agent gets its tools from `open` as well. `tools` is an MCP client over that conversation's server, and `toolDefinitions` in `src/mcp.ts` is the list the server returns from `tools/list`: name, description and JSON Schema input, which map directly onto a model API's tool definitions. A model agent sends those definitions in its requests, so a change to a description makes the old recordings fail to replay until they are recorded again.

The spend guard in `src/spend.ts` keeps the running spend in `.artifacts/spend.json`, which Git ignores. It refuses a live call when the spend so far has reached the cap, which `SPEND_CAP_USD` sets and which defaults to 50 dollars. The CLI loads `.env` at start with `process.loadEnvFile`, so the cap and a provider key can live there, and no message prints a value from it.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The agent records its own calls. | Rejected. | Each agent would repeat the timing, the cost and the file format, and could get them wrong. |
| A spend total per run. | Rejected. | A crash or a second run starts again from zero, so the cap would bound one run, not the money spent. |
| Save the recording after every call. | Rejected. | An interrupted conversation would leave a recording that replays its first turns and then fails. |
| A wrapper around the live client, a spend file that outlives runs, one save per conversation. | Chosen. | Time and cost are measured in one place, the cap holds across runs and crashes, and a saved recording is always whole. |

## Contested point 8: where time and cost live

Time and cost live on the agent turn as `duration_ms` and `cost_usd`. A test result copies the turn times and sums the cost. The summary reads results only.

- An agent that calls a model reports `usage` with its reply: the recorded time and cost of the model calls in that turn.
- The runner's clock times an agent that reports no `usage`, and that turn costs nothing. The rule-based agent takes this path.

| Alternative | Verdict | Why |
| --- | --- | --- |
| The runner's clock for every agent. | Rejected. | On replay a model call returns at once, so the clock would report a time near zero. |
| Totals per conversation. | Rejected. | The summary needs the median and the 95th percentile of turns. |
| The recorded time added to the runner's clock. | Rejected. | A replay would add the replay's own overhead, so a replay and the live run would report different times. |
| The recorded time and cost, reported by the agent. | Chosen. | A live run and its replay add up the same recorded numbers. |

## Contested point 9: what a run leaves behind

Each run writes its own directory, named by its start time and a random suffix. Conversations are written as each case finishes, then `results.json` and `summary.json`. A second run never touches the first.

A summary needs one result for every case of its split. An interrupted run leaves its finished conversations on disk, and `regrade` on that directory refuses to print numbers and names the missing cases. The same refusal covers a case added after the run.

`pnpm score` first reads the commit and whether the tree is dirty, and refuses to run outside a Git checkout. It hashes the held-out case files, runs, and appends one line to `results/ledger.jsonl`.

| Alternative | Verdict | Why |
| --- | --- | --- |
| One fixed output directory per split. | Rejected. | A second run overwrote the first, so a scoring run could not be kept. |
| Summarise whatever results exist. | Rejected. | An interrupted run published numbers over fewer cases. |
| `regrade` writes new results into the run. | Rejected. | A committed scoring run would change after the fact. `regrade` prints and writes nothing. |

## Contested point 10: how the agent is chosen

`src/agents/index.ts` holds a registry keyed by agent name. `--agent <name>` picks one, and the default is `rule-based`, the only entry today. The registry is a plain object, so adding an agent is one line.

`pnpm tune` and `pnpm score` take no split. Each command maps to one split, and the loader reads one folder. A case whose `split` differs from its folder fails the load, so a held-out case moved into `cases/tuning` cannot run as tuning.

## The rule-based agent

`src/agents/rule-based.ts` is a baseline of keyword rules, kept small on purpose. It hands over when the customer asks for a person or for a commission or a tattoo. It asks for the order number and the email until it has both. It then answers a status question from `lookup_order`, or files a cancellation or a return. It hands over on `unavailable` and on a `large_refund` rejection, and it refuses on any other rejection. Any other message goes to a person with the reason `staff_decision`. It never calls `check_policy`, and it files no damage claim and no delivery change. A later agent has a floor to beat.

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
