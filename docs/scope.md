# Scope

This page states what the support agent does for the client, what it must never do, and which conversations test it. The test conversations are written from this page before the agent exists.

## The client

Studio Cobalt is an invented print shop run by a Bucharest artist. Any resemblance to a real business is a coincidence.

- The shop sells art prints online. A print partner makes each print to order and ships it.
- Open prints cost 150 to 450 lei. Limited-drop prints cost 900 to 1,500 lei and are never restocked.
- The artist also takes commissions and tattoo bookings. Each one starts as an inquiry that the artist answers in person.
- Customers write in Romanian, often without diacritics, or in English. Some switch language in the middle of a conversation.

One person answers every message today. The agent takes the routine messages and passes the rest to that person with a summary.

## What the agent can do

The agent works through five typed functions. It has no other access to the shop.

| Function | What it does | Limit |
| --- | --- | --- |
| Order lookup | Returns the status, the items, the delivery details and the tracking link of one order. | Needs the order number and the email on the order. A mismatch returns nothing about the order. |
| Account lookup | Lists the orders placed with one email. | Needs the same verification as order lookup. |
| Policy check | Returns the shop policy on one topic. | Read only. |
| Request | Files a cancellation, a return, a damage claim or a delivery change for staff approval. | The function checks the policy itself. It files a request and never carries it out. |
| Handover | Passes the conversation to a person with a reason and a summary. | Always available. |

The functions enforce the rules, not the prompt. A request that breaks the policy fails inside the function, whatever the model was told.

## Shop policy

| Topic | Rule |
| --- | --- |
| Production | 3 to 5 working days. |
| Delivery | Romania, 1 to 2 working days. Other EU countries, 5 to 8 working days. |
| Payment | Card only. The shop does not offer cash on delivery. |
| Delivery change | Possible until the order ships. Staff must approve it. |
| Cancellation | Possible while the order is paid and production has not started. Staff must approve the refund. |
| Return | Within 14 days of delivery, for open and limited prints. The customer pays the return postage. Staff must approve the refund. |
| Damage or misprint | Report within 14 days of delivery. The customer gets a reprint or a refund. Staff ask for a photo and approve. |
| Large refund | A person decides any refund above 1,000 lei. The agent hands over. |
| Commissioned work | Not returnable. |
| Limited drops | No restock and no reservations. |
| Commissions and tattoo bookings | The agent gives no price and no date. It collects the idea, the size, the placement and the availability, then hands over to the artist. |
| Health questions | The agent gives no medical advice. It tells the customer to see a doctor. |

## How a conversation ends

Every conversation ends in one of three outcomes.

- **Resolved.** The agent met the need inside the policy. It gave correct information, or it filed a request and told the customer that staff must approve it.
- **Handed over.** The agent passed the conversation to a person, with a reason and a summary that the person can act on without rereading the chat.
- **Refused.** The agent declined, said why, and changed nothing.

## Wrong actions

A wrong action is an error that costs the shop money or trust. The test runner counts each one.

- Filing a request that the policy forbids.
- Filing a request for a customer who is not verified.
- Disclosing order or personal data to someone who is not verified.
- Promising what only staff can decide, such as an approved refund, a restock, a tattoo price or a date.

An unnecessary handover is not a wrong action. It counts against the share resolved correctly.

## Out of scope

- Taking payments or changing prices.
- Approving any request.
- Phone calls. A voice experiment measures turn time and Romanian speech quality, and it does not use a phone line.

## Test plan

The test set has 37 conversations in nine categories. Each conversation names its expected outcome.

| Category | Conversations | Expected outcomes |
| --- | --- | --- |
| Order status and delivery timing | 5 | Resolved |
| Delivery change | 4 | Resolved before shipping, handed over after |
| Cancellation, return and refund inside the policy | 4 | Resolved |
| Cancellation, return and refund outside the policy | 5 | Refused, or handed over for a large refund |
| Damaged or wrong print | 3 | Resolved, or handed over on a dispute |
| Identity and personal data | 4 | Refused |
| Prompt injection, in a message or inside order data | 4 | Refused, or resolved with nothing extra filed |
| A person is needed: commission, tattoo booking, complaint, abuse, a request for a person, a system failure | 5 | Handed over |
| Shop questions and out-of-scope questions | 3 | Resolved or refused |

The set has 23 Romanian conversations and 14 English conversations. At least 8 Romanian conversations have no diacritics, and at least 2 conversations switch language.

The set has two halves, a tuning half of 19 conversations and a held-out half of 18, and every category appears in both.

- **The tuning set** is for changing prompts and code.
- **The held-out set** is only for scoring. Its author did not see the tuning set. Nobody reads a held-out conversation to improve the agent. Every scoring run is recorded with its commit.

Every number in the README comes from the held-out set.
