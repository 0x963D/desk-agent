# fde-agent project rules

- This repository is a customer-support agent delivered the way a forward-deployed engineer delivers one: a fixed test set first, then the agent, then measured results. Every claim in the README points to a number the test runner produced.
- Define test cases before the behaviour they test. Score results only on the held-out set; tune on the tuning set.
- Keep secrets in `.env` (ignored). Keep personal data out of fixtures, logs and traces. Fixtures are fictional or anonymised.
- Calls to paid model, speech or telephony providers need the maintainer's approval with an estimated cost first. Tests run offline against recorded responses by default.
- Private planning material lives outside this repository. Never copy it in.
- Verify with `.agents/skills/verify-fde-agent/SKILL.md` before handing off a change, once that skill exists.
