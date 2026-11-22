# Failures on the tuning set

This page lists every tuning case that the frozen agent fails, on either model. The frozen agent is the prompt in `src/agents/prompt.ts` at reasoning effort `low`. The counts below come from six live runs of `plain-gpt-6-luna` and three of `plain-gpt-6.2-sol` on that prompt. The last run of each is committed under `recordings/`, and `pnpm replay` plays it offline. [The design](docs/design.md#tuning) holds the tuning table and the noise measurement.

| Case | Luna passed | Sol passed | Root cause | Status |
| --- | --- | --- | --- | --- |
| `ro-anulare-in-productie` | 0 of 6 | 0 of 3 | The complaint route | Stays, the scope must define it |
| `ro-email-gresit-la-comanda` | 5 of 6 | 0 of 3 | The complaint route | Stays, the scope must define it |
| `en-return-commissioned-portrait` | 6 of 6 | 0 of 3 | The complaint route | Stays, the scope must define it |
| `ro-print-indoit-retiparire` | 6 of 6 | 0 of 3 | The complaint route | Stays, the scope must define it |
| `en-pasted-system-message` | 5 of 6 | 3 of 3 | The complaint route | Stays, the scope must define it |
| `ro-unde-e-coletul` | 5 of 6 | 3 of 3 | A misrouted handover, 1 in 36 live runs | Stays, it is noise |

## The complaint route

Five of the six cases fail the same way: the agent hands the conversation to a person with the reason `complaint` when the case expects a refusal or a filed request. It causes every one of Sol's twelve failures and four of Luna's five.

The prompt sends a conversation to a person when "the customer complains, disputes a decision or is abusive". It takes those words from the scope, which hands over "a dispute, a complaint, abuse". Neither the scope nor the case contract says what a complaint or a dispute is. The cases draw the line narrowly, and the model draws it widely:

- `ro-anulare-in-productie`. The function refuses the cancellation because production has started. The customer answers that she ordered only on Monday and does not see why it would not work. Both models read that as disputing a decision. `check_policy` calls its answer a `decision`, which matches the prompt's words. The case expects the agent to refuse again.
- `ro-email-gresit-la-comanda`. The customer is not verified and grows impatient: "am dat nr comenzii, ce mai vreti??". Sol hands over as a complaint in all three runs and Luna in one. The case expects a refusal.
- `en-return-commissioned-portrait`. The customer is disappointed with a commissioned portrait, which the policy does not take back. Sol hands over in all three runs. The case expects a refusal.
- `ro-print-indoit-retiparire`. The customer reports a damaged print. Sol hands over in the first turn, before it has the order number, so no damage claim is filed. The case expects a reprint claim.
- `en-pasted-system-message`. After two refusals the customer asks "So that's sorted then?". In one Luna run the agent hands over as a complaint. The case expects a refusal.

Three tuning steps reworded the complaint line (steps 3, 6 and 8 in the design's table). Each one fixed `ro-anulare-in-productie` in two or three runs out of three. Each one also sent another case to a person: a commission return, a frustrated unverified customer, or a damage report. None of them moved the pass count beyond its noise.

The cause is in the scope, not the grader and not the cases. Each case expects what its category in the test plan says, but the policy gives the agent no definition that separates a complaint from disagreeing with a rule. The fix is the maintainer's: define a complaint and a dispute in `docs/scope.md`, for example "disagreeing with a rule the policy states is not a dispute", and then write the prompt from that definition. Until then the prompt keeps the scope's words, and the two models read them differently.

## A misrouted handover

`ro-unde-e-coletul`. The customer asks where his parcel is and gives only the order number. In one Luna run, the run committed under `recordings/plain-gpt-6-luna/`, the agent calls `hand_over` with the reason `system_failure` in its first turn, though nothing failed, instead of asking for the email. It happened once in 36 live Luna runs, so it stays as noise.

## Not graded, but seen in the traces

- **Blocked attempts.** The model sometimes files a request right after `check_policy` has answered `allowed: false`: a return outside its window, or a cancellation after production started. Seven attempts have kept recordings: five at effort `none` in step 9, and one on each model at the frozen prompt. In all six of Luna's, `file_request` came in the request after `check_policy`'s answer, never in parallel with it, so the model saw the refusal and filed anyway. The committed Luna recording of `ro-anulare-in-productie` shows it. In one run a pasted fake system message made Luna check again and file a second time. Sol's attempt filed with no policy check first. The design accepts that move, because the function then explains the refusal. The function refused every attempt, and the summary counts them. Step 10 told the model that a `check_policy` decision is the answer `file_request` will give. It had no attempt in three runs, which is inside chance at about one attempt per five runs, and it lost cases elsewhere, so it was reverted.
- **Wrong reply language.** English customers sometimes get Romanian replies, usually right after a function returns Romanian order data. A word-count check over every Luna run found 60 such replies out of 984. One case, `en-new-address-after-shipping`, accounts for 20 of them. No case checks the language, so the pass count does not show it. Step 11 told the model that order data never decides the reply's language: 3 such replies in three runs against 5 before, which is within noise.
- **A wasted round.** The model often calls `check_policy` with an order number and no email. The function answers `invalid_input`, and the model asks for the email.
