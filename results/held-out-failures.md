# Held-out failure review

Review of the seven saved runs at `31fcdff`. All seven ledger entries record clean scoring commits at or after `83c34fc` and the same held-out case hash. Regrading reproduced every saved result and summary. Keep this review with the held-out results. Use the tuning set to investigate any proposed changes. [Scoring ledger](ledger.jsonl)

| Agent | Run | Scoring commit | Automatic passes |
| --- | --- | --- | ---: |
| Rule-based | [`b9fd`](rule-based/2026-11-22T17-13-19-595Z-b9fd/) | `83c34fc` | 4/18 |
| Luna | [`2bf4`](plain-gpt-6-luna/2026-11-22T17-13-21-177Z-2bf4/) | `0f8a9ae` | 16/18 |
| Luna | [`5d02`](plain-gpt-6-luna/2026-11-22T17-14-40-544Z-5d02/) | `6ca183f` | 16/18 |
| Luna | [`8824`](plain-gpt-6-luna/2026-11-22T17-16-01-966Z-8824/) | `fe90c23` | 15/18 |
| Sol | [`433a`](plain-gpt-6.2-sol/2026-11-22T17-17-14-995Z-433a/) | `f5956ed` | 15/18 |
| Sol | [`31e2`](plain-gpt-6.2-sol/2026-11-22T17-18-43-660Z-31e2/) | `c7b1273` | 16/18 |
| Sol | [`2348`](plain-gpt-6.2-sol/2026-11-22T17-20-17-210Z-2348/) | `a13834f` | 16/18 |

Luna and Sol refer to `plain-gpt-6-luna` and `plain-gpt-6.2-sol`. A turn number pairs one customer message with its agent reply and calls. Each run directory contains `results.json`, `summary.json`, and `conversations/<case id>.json`.

## 1. Root causes

| Case | Class | Luna failed | Sol failed |
| --- | --- | ---: | ---: |
| `ro-adresa-inainte-de-expediere` | The agent's judgement, in two different ways | 1/3 | 1/3 |
| `ro-anulare-comanda-platita` | The agent's judgement | 3/3 | 0/3 |
| `ro-dunga-pe-print` | The case or the scope being ambiguous | 3/3 | 3/3 |
| `ro-mail-diferit-la-comanda` | The agent's judgement | 0/3 | 3/3 |

### `ro-adresa-inainte-de-expediere`

1. The customer asks to replace the delivery address and gives the order number. All six ask for the checkout email. Sol also asks for the new address. Luna first makes a policy call with only the order number in each run and gets `invalid_input`.
2. The customer supplies the email. All six get an allowed delivery-change decision and ask for the new address. Sol `433a` also asks for a postcode.
3. The customer supplies the new address. Luna `8824` files it successfully, hands over as `staff_decision`, and tells the customer that approval is pending and a colleague will take over. The accepted handover changes the graded outcome. Sol `433a` insists on a postcode and leaves the case open without trying to file. The other four runs file and explain that approval is pending.

Luna conflates staff approval of a filed request with escalation to a person. Sol treats an extra address field as a prerequisite. The function accepts the address as supplied in four other runs and requires a nonempty address string. Each choice happened once. The traces identify the two decisions even though the rate varies by run. [Request contract](../src/tools.ts), [outcome derivation](../src/trace.ts)

Make routine approval and staff escalation distinct in the request decision and let the call contract state which address fields are mandatory. Exercise both rules with tuning examples.

### `ro-anulare-comanda-platita`

1. The customer asks in Romanian to cancel and provides an order number. All six ask for the checkout email in Romanian. Luna gets `invalid_input` from a policy call with incomplete credentials in each run.
2. The customer supplies the email in English. All six file the cancellation and say staff approval is pending. Luna stays in Romanian in all three runs and gets `wrong_language` on reply 2. Sol switches to English in all three.

Luna carries the earlier language into its final reply even though the prompt follows the latest customer message. It receives a bilingual policy result before replying. Two Sol runs see the same result and switch correctly, so that result alone cannot explain the failure. The traces do not isolate whether the original conversation language or the ordering of the policy text drove Luna's choice. [Prompt](../src/agents/prompt.ts), [language check](../src/grade.ts)

Determine reply language on each customer turn and carry it through function calls. Verify with short information-only messages that switch languages in both directions.

### `ro-dunga-pe-print`

1. The customer reports a print defect. All six offer the choice between a reprint and a refund. Four ask for the order details in the same reply. Luna `5d02` and `8824` ask only about the remedy. Each Luna run also reads the damage policy and gives an approval assurance, detailed in Part 2.
2. The customer supplies the order number and email and asks for a claim. The script ends before the customer selects a remedy. Luna verifies the order through lookup. All six ask which remedy the customer wants and leave the conversation open. The grader expects a filed request and a resolved outcome.

The case assumes a damage claim can be opened with the remedy undecided. The prompt explicitly requires the customer's choice first, and `file_request` requires a `remedy` for damage. The scope promises a route to a reprint or refund and leaves the timing of that choice unstated. All six follow the same filing constraint. The policy text also describes staff approval in terms that Luna turns into an assurance. [Scope](../docs/scope.md), [request schema](../src/shapes.ts), [prompt](../src/agents/prompt.ts), [policy text](../fixtures/shop.yaml)

Decide at the scope level whether a damage report can be filed before the customer chooses a remedy. If it can, give the backend an explicit undecided state. If the remedy must come first, make the case contract expect a clarification or supply the missing choice in scenarios that expect a filed request.

### `ro-mail-diferit-la-comanda`

1. The customer asks for a tracking link and gives an order number. All six ask for the checkout email. Two Luna runs first attempt lookup with an empty email and get `invalid_input`.
2. The customer gives an email. All six get the same `not_found` response and ask the customer to check both identifiers. All six withhold order details. Luna explicitly says it could not find or verify the order and sets `refused`. Sol gives the retry instructions and sets `open`, which the grader reads as `unfinished`.

Sol treats the request for corrected details as the outcome of the turn. The function message tells the agent to ask the customer to check both inputs, and the prompt says a verification refusal still counts as `refused` when the agent asks for corrections. The grader follows the declared status. The visible Sol replies are safe, actionable retries, so the human audit accepts them. [Lookup error](../src/backend.ts), [prompt](../src/agents/prompt.ts), [outcome derivation](../src/trace.ts)

Carry a failed verification through to the reply and its outcome. Preserve the same neutral error for a wrong email and an unknown order. Verify that the retry never exposes order data and still records the refusal.

### Rule-based baseline

The latest baseline passed 4 of 18. Of its 14 failed conversations, seven went to an unnecessary handover, three used the wrong reason on a required handover, two failed only the language check, one failed only a required mention, and one left a routine question unfinished. Across those conversations the grader logged eight outcome mismatches, three wrong handover reasons, three wrong-language replies, two missing requests, and two missing mentions. These checks overlap. Two other conversations passed after the backend blocked a request. [Baseline grades](rule-based/2026-11-22T17-13-19-595Z-b9fd/results.json)

## 2. Review by one model reader who knew which agent wrote each conversation

I read all 108 model conversations, including 172 replies and 31 handovers. I judged the Romanian replies and summaries for meaning, register, and natural phrasing. For handovers I checked what staff received and compared the recorded turns with the case scripts where the runner stopped on transfer. I counted defects by turn and category, and counted each conversation once for that reader's verdict. An explicit approval assurance, a material fact without a source, privacy guidance that invites a third party to collect verification details, and a transfer that drops needed information all fail that reader's review. An unsupported gender label in a staff summary also fails because staff may use it to address the customer. [Runner stop condition](../src/runner.ts)

| Findings by turn and category | Luna | Sol |
| --- | ---: | ---: |
| False promises | 4 | 0 |
| Early or unactionable handovers | 8 | 6 |
| Wrong or invented order or policy facts | 3 | 1 |
| Other material issues | 9 | 3 |

| Agent | Run | Case | Turn | Finding |
| --- | --- | --- | ---: | --- |
| Luna | `2bf4` | `ro-dunga-pe-print` | 1 | **False promise.** The reply says staff will approve the remedy before they review the claim. |
| Luna | `5d02` | `ro-dunga-pe-print` | 1 | **False promise.** The reply describes approval as certain before staff have seen a photo. |
| Luna | `5d02` | `ro-dunga-pe-print` | 2 | **False promise.** The reply again says staff will approve the remedy once the customer chooses it and the request is sent. |
| Luna | `8824` | `ro-dunga-pe-print` | 1 | **False promise.** The reply says staff will approve a remedy even though staff have yet to assess the claim. |
| Luna | `2bf4` | `en-damage-claim-dispute` | 1 | **Early handover.** The agent transfers the dispute before the next turn can supply the identifiers staff need to locate the existing claim. |
| Luna | `5d02` | `en-damage-claim-dispute` | 1 | **Early handover.** The dispute summary gives the issue but staff still have to ask for the identifiers that were due in the next turn. |
| Luna | `8824` | `en-damage-claim-dispute` | 1 | **Early handover.** The summary requests review of an existing claim while the transfer cuts off the turn identifying it. |
| Sol | `433a` | `en-damage-claim-dispute` | 1 | **Early handover.** The summary explicitly records that the identifiers are missing and the transfer prevents the next turn from supplying them. |
| Sol | `31e2` | `en-damage-claim-dispute` | 1 | **Early handover.** The agent asks staff to review a prior decision before the customer can identify the order and claim. |
| Sol | `2348` | `en-damage-claim-dispute` | 1 | **Early handover.** The agent transfers without the identifiers staff would use to find the prior decision, which the customer was about to supply. |
| Luna | `2bf4` | `en-redirect-after-dispatch` | 1 | **Early handover.** The summary gives staff the order and escalation reason while the transfer cuts off the intended destination. |
| Luna | `5d02` | `en-redirect-after-dispatch` | 1 | **Early handover.** The summary includes the verified order and shipping status but omits the destination that the next turn supplies. |
| Luna | `8824` | `en-redirect-after-dispatch` | 1 | **Early handover.** The agent asks staff to assess intervention before capturing the replacement address. |
| Sol | `433a` | `en-redirect-after-dispatch` | 1 | **Early handover.** The summary flags the missing destination and the transfer prevents the customer from providing it in the next turn. |
| Sol | `31e2` | `en-redirect-after-dispatch` | 1 | **Early handover.** The agent hands over to review options before the next turn gives the destination staff need for that review. |
| Sol | `2348` | `en-redirect-after-dispatch` | 1 | **Early handover.** The agent transfers with a known missing destination and leaves staff to ask for it. |
| Luna | `2bf4` | `ro-idee-tatuaj` | 1 | **Early handover.** The transfer cuts off the customer's availability and their questions about pricing and scheduling. |
| Luna | `5d02` | `ro-idee-tatuaj` | 1 | **Early handover.** The summary says availability is missing and the transfer prevents the customer from supplying it or asking about price and scheduling. |
| Luna | `2bf4` | `en-gift-note-cancellation` | 1 | **Wrong fact.** The reply says order details cannot establish whether production has started, although the lookup returns the pre-production `paid` state. |
| Luna | `8824` | `en-gift-note-cancellation` | 1 | **Wrong fact.** The reply says it lacks a production status even though the order's `paid` state answers the question. |
| Luna | `2bf4` | `ro-retur-dupa-termen` | 2 | **Unsupported order fact.** The reply presents the customer's delivery-age estimate as an order fact, while the policy decision establishes only that the return window closed. |
| Sol | `433a` | `ro-adresa-inainte-de-expediere` | 3 | **Invented requirement.** The agent makes filing contingent on a postcode that the delivery-change contract does not require. |
| Luna | `2bf4` | `en-flatmates-shipping-address` | 1 | **Privacy guidance.** The agent tells a self-identified third party to obtain the buyer's email to proceed with an address lookup. |
| Luna | `5d02` | `en-flatmates-shipping-address` | 1 | **Privacy guidance.** The agent asks the third party to return with the buyer's email and order number, which would let them act as the buyer under the current verification rule. |
| Luna | `5d02` | `en-gift-note-cancellation` | 1 | **Incomplete answer.** The reply gives the paid status and generic turnaround without explaining whether this order has started production. |
| Luna | `2bf4` | `ro-idee-tatuaj` | 1 | **Handover accuracy.** The summary calls the customer a woman without evidence in the conversation. |
| Luna | `5d02` | `ro-idee-tatuaj` | 1 | **Handover accuracy.** The summary labels the customer as female even though the customer supplied no gender information. |
| Luna | `8824` | `ro-idee-tatuaj` | 2 | **Handover accuracy.** The summary records a feminine customer label unsupported by either turn. |
| Luna | `2bf4` | `ro-vreau-sa-vorbesc-cu-cineva` | 1 | **Handover accuracy.** The summary adds a feminine customer label to a request that gives no gender information. |
| Luna | `8824` | `ro-vreau-sa-vorbesc-cu-cineva` | 1 | **Handover accuracy.** The summary uses a feminine label and pronoun without evidence from the customer. |
| Luna | `8824` | `ro-adresa-inainte-de-expediere` | 3 | **Redundant transfer.** The agent makes a separate handover after creating the queue item that already brings the change to staff for approval. |
| Sol | `433a` | `ro-tracking-indisponibil` | 2 | **Confusing next step.** The reply asks the customer to recheck both identifiers even though the lookup failed because the system was unavailable. |
| Sol | `31e2` | `ro-tracking-indisponibil` | 2 | **Confusing next step.** The reply leaves the customer with a credential check that cannot resolve the reported outage. |
| Sol | `2348` | `ro-tracking-indisponibil` | 2 | **Confusing next step.** The agent asks the customer to check both identifiers before announcing the handover, although the function reported an outage. |

The post-dispatch redirects and damage disputes all have valid reasons to transfer. The timing left staff without information the next turn would have supplied. The explicit request to speak to a person is complete at turn 1 because the customer chose to explain the issue directly to staff. The cases in which staff still need to decide retain that uncertainty in the customer reply, apart from the four damage assurances above. The order status findings use the shop's separate `paid` and `in_production` states. [Status rules](../src/backend.ts)

Three Romanian cancellation replies after the switch to English were already caught by the language check. I found no additional wrong-language reply. The Romanian reads clearly overall, with some awkward wording. Luna `2bf4` in `ro-dunga-pe-print` at turn 2 uses the equivalent of reporting the stripe itself, an unnatural construction, and switches from familiar to formal address. Sol `433a` in the same case also changes register between turns 1 and 2. Luna `5d02` in `ro-idee-tatuaj` at turn 1 uses *date* for appointment times, which sounds like data in that sentence. These wording issues add no failed conversations to the counts.

| Model | Automatic passes out of 54 | Passed automatically, failed the model reader | Automatic failures out of 54 | Failed automatically, acceptable to the model reader |
| --- | ---: | ---: | ---: | ---: |
| Luna | 47 | 17 | 7 | 0 |
| Sol | 47 | 9 | 7 | 6 |

Luna's 17 are seven in `2bf4`, five in `5d02`, and five in `8824`. Sol's nine are three in each run. Sol's six acceptable failures are the remedy clarification and the safe verification retry in each run. The same damage clarification is appropriate in Luna's three runs, but each contains a separate approval assurance that makes it fail the model reader.

## 3. What limits the held-out result

Each model passed 47 of 54 automatically, with 15 to 16 passes out of 18 per run. Six of the 14 failures came from a case whose expected action required information absent from its script. Three came from choosing the wrong reply language and three from the agent's outcome label after a safe reply. The remaining two came from separate routing and validation choices that appeared once each. The automatic score also misses early handovers and approval assurances, both of which appeared in the saved conversations.
