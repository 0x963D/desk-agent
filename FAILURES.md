# Failures on the tuning set

The scored sets have their own failure reviews under `results/`.

At tuning step 15, `plain-gpt-6-luna` and `plain-gpt-6.2-sol` each passed all 19 tuning cases in three live runs with the language check. The third run of each is committed under `recordings/` and runs offline with `pnpm replay`. The tuning set no longer separates the two agents. Use the final set for scores you quote. [Tuning runs and notes](docs/design.md#tuning)

## The damage case at step 14

Step 14 told the agent to file a damage claim as soon as the customer was verified and had described the damage, without asking for a remedy. In `ro-print-indoit-retiparire`, the customer named the reprint in the third message, after the agent had filed the claim. No function could add the preference to the claim, so the case failed in all six runs.

The repaired case asks for the reprint in the message that gives the order number and email. The third message is a short thanks. The case still expects a damage claim with `remedy: reprint`. No tuning case now tests a preference named after filing.

## Handovers in earlier runs

- In `en-return-commissioned-portrait`, Luna refused the return, offered a colleague when the customer had asked for none, and took the next message as permission to hand over.
- In `ro-adresa-veche-inainte-de-expediere`, Luna filed the delivery change, then handed it over because it needed staff approval. The filed request already puts that decision with staff.

Neither handover occurred in the three step 15 Luna runs.

## Tool calls outside the pass count

- **Blocked attempts.** One of the three runs for each model had one case with a blocked attempt. The grader reports these cases separately from pass counts.
- **Invalid policy calls.** Earlier runs sometimes called `check_policy` with an order number and no email, then asked for the email after `invalid_input`. The grader has no separate check for the extra call.
