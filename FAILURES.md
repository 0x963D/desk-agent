# Failures on the tuning set

This page lists every tuning case that the frozen agent fails, on either model. The frozen agent is the prompt in `src/agents/prompt.ts` at reasoning effort `low`, after tuning step 14. The counts below come from three live runs of `plain-gpt-6-luna` and three of `plain-gpt-6.2-sol` on that prompt, graded with the language check. The last run of each is committed under `recordings/`, and `pnpm replay` plays it offline. [The design](docs/design.md#tuning) holds the tuning table.

| Case | Luna passed | Sol passed | Root cause | Status |
| --- | --- | --- | --- | --- |
| `ro-print-indoit-retiparire` | 0 of 3 | 0 of 3 | The case expects a reprint that the customer names only after the claim is filed | Open, the case's expectation needs the maintainer's decision |
| `en-return-commissioned-portrait` | 2 of 3 | 3 of 3 | Luna offers a person nobody asked for, then hands over | Stays, below the noise |
| `ro-adresa-veche-inainte-de-expediere` | 2 of 3 | 3 of 3 | A staff approval read as a reason to hand over | Stays, below the noise |

Luna passed 18, 17 and 17. Sol passed 18 in each run. Without the damage case, Luna passed 18, 17 and 17 of the other 18 and Sol 18 of 18 each time. No run handed over with the reason `complaint`, and no reply failed the language check.

## A remedy named after the claim is filed

`ro-print-indoit-retiparire`. The customer reports a bent, scratched print in the first message, gives the order number and the email in the second, and says in the third that she would rather have a reprint. The case expects a damage claim with `remedy: reprint`.

Step 14 tells the agent to file once the customer is verified and has described the damage, and to name a remedy only when the customer chose one. All six runs do exactly that. Each one files the claim on the second message with no remedy, asks for no remedy, and tells the customer that staff will ask for a photo and decide. When the reprint wish arrives in the third message, the claim is already on file, and no function can amend it. Sol hands over with `staff_decision` in all three runs, so that a colleague adds the wish to the claim. Luna does so once, once tries to file the claim again with the reprint and is refused as a duplicate, and once tells the customer that the claim cannot be changed.

The grader reads the claim without a remedy as a missing request and an unexpected one, so each run counts one wrong action. The scope does not call it one. The claim is inside the policy, the customer is verified and asked for it, and staff decide the remedy. The case was written while `file_request` required a remedy, and its third message answers the question the old prompt asked. No prompt that files on the second message can pass it. Changing the case is the maintainer's call: the customer could state the wish before she is verified, or the case could expect a claim with any remedy and a handover that passes the wish on.

## A handover offered after a refusal

`en-return-commissioned-portrait`. The customer wants to send back a commissioned portrait she does not love. In the failing run Luna checks the return policy, says it does not cover commissioned work, and adds "Would you like me to pass this to a colleague?" The customer's next message gives the order number and says the print is in perfect condition. Luna takes that as a yes and hands over with `staff_decision`. The committed Luna recording shows it.

The prompt says when to hand over, and it never says not to offer a handover. The customer did not ask for a person, so the scope's rule is to refuse again. The fix would be one line: offer a person only when a rule sends the conversation there, and otherwise wait for the customer to ask. It is not tried, because it fails 1 of 3 runs here and 2 of 6 at step 13, less than the one-case spread between runs.

## A staff approval read as a handover

`ro-adresa-veche-inainte-de-expediere`. In one run Luna files the delivery change, which is right, and then hands over with `staff_decision` because the change needs staff approval. A filed request is already how staff approve it, and `staff_decision` is for the two cases a person decides: a delivery change after shipping and a refund above 1,000 lei. At step 13 the same mistake failed `en-cancel-wrong-size` in 1 of 6 runs. Tuning step 7 said exactly that and came out level with the prompt it built on, so it was reverted. It fails 1 of 3 runs and stays.

## Not graded, but seen in the traces

- **Blocked attempts.** In 1 of the 3 Luna runs, `ro-anulare-in-productie` calls `file_request` for the cancellation, and the function refuses it because production has started. Luna then refuses, which is the expected outcome. The other blocked attempt is the duplicate damage claim above. Sol made none in three runs.
- **A refusal labelled resolved.** In the last of the three Sol runs at the step 13 prompt, before this change, `ro-anulare-in-productie` refused the cancellation twice and then, asked once more, refused a third time with the status `resolved`. The prompt already says that declining again is a refusal. It did not recur in the three step 14 runs.
- **A wasted round.** The model still sometimes calls `check_policy` with an order number and no email. The function answers `invalid_input`, and the model asks for the email.
