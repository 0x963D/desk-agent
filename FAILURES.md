# Failures on the tuning set

This page lists every tuning case that the frozen agent fails, on either model. The frozen agent is the prompt in `src/agents/prompt.ts` at reasoning effort `low`, after tuning step 13. The counts below come from six live runs of `plain-gpt-6-luna` and three of `plain-gpt-6.2-sol` on that prompt, graded with the language check. The last run of each is committed under `recordings/`, and `pnpm replay` plays it offline. [The design](docs/design.md#tuning) holds the tuning table.

| Case | Luna passed | Sol passed | Root cause | Status |
| --- | --- | --- | --- | --- |
| `en-return-commissioned-portrait` | 4 of 6 | 3 of 3 | Luna offers a person nobody asked for, then hands over | Stays, below the noise |
| `en-cancel-wrong-size` | 5 of 6 | 3 of 3 | A staff approval read as a reason to hand over | Stays, below the noise |

Sol passed all 19 cases in each of its three runs. Luna passed 18, 19, 19, 19, 18 and 18. No run of either model handed over with the reason `complaint`, and no reply failed the language check.

## A handover offered after a refusal

`en-return-commissioned-portrait`. The customer wants to send back a commissioned portrait she does not love. In both failing runs Luna checks the return policy, says that it does not cover commissioned work and refuses, which is right. It then adds "Would you like me to pass this to a colleague?" The customer's next message gives the order number and says the print is in perfect condition. Luna takes that as a yes and hands over, once as `staff_decision` and once as `commission_or_booking`. The committed Luna recording shows the second.

The prompt says when to hand over, and it never says not to offer a handover. The customer did not ask for a person, so the scope's rule is to refuse again. The fix would be one line: offer a person only when a rule sends the conversation there, and otherwise wait for the customer to ask. It is not tried, because it fails 2 of 6 runs, a third of a case per run, which is less than the one-case spread between runs.

## A staff approval read as a handover

`en-cancel-wrong-size`. In one run Luna files the cancellation, which is right, and then hands over with `staff_decision` because the refund needs staff approval. A filed request is already how staff approve it, and `staff_decision` is for the two cases a person decides: a delivery change after shipping and a refund above 1,000 lei. Tuning step 7 said exactly that and came out level with the prompt it built on, so it was reverted. It fails 1 of 6 runs and stays.

## What the two fixes in this round closed

- **The complaint route.** Before step 12 it caused every one of Sol's twelve failures in three runs and three of the six Luna failures that the grader then saw: `ro-anulare-in-productie`, `ro-email-gresit-la-comanda`, `en-return-commissioned-portrait` and `ro-print-indoit-retiparire` went to a person as complaints. [The scope](docs/scope.md#complaints-and-disputes) now defines a complaint and a dispute, and the prompt states that definition. None of the 9 runs at the frozen prompt hands over as a complaint.
- **The reply language.** Luna answered English customers in Romanian after a function returned Romanian data: the Romanian rule text that `check_policy` lists first, or an order with a Romanian name and address. Six step-12 runs held 5 such replies in 235, and `en-new-address-after-shipping` failed 3 of 6. Step 13 says that only the customer's message sets the language. Six runs at the frozen prompt held none in 234.

## Not graded, but seen in the traces

- **Blocked attempts.** In 4 of the 6 Luna runs, `ro-anulare-in-productie` calls `file_request` for the cancellation, and the function refuses it because production has started. Luna then refuses, which is the expected outcome. Sol's one attempt in three runs is the return outside its window in `en-pasted-system-message`. The function refused every attempt, and the summary counts them.
- **A wasted round.** The model still sometimes calls `check_policy` with an order number and no email. The function answers `invalid_input`, and the model asks for the email. The nine frozen runs hold 13 `invalid_input` answers.
- **An address with a note in it.** In one of Sol's step-12 runs, `ro-adresa-veche-inainte-de-expediere` filed the delivery change with "Restul detaliilor de livrare rămân neschimbate." after the address. The grader counted it as a wrong action, because staff would receive that text as the address. It did not happen in the three frozen Sol runs.
