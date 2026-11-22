# desk-agent project rules

- This repository is a customer-support agent delivered the way a forward-deployed engineer delivers one: a fixed test set first, then the agent, then measured results. Every claim in the README points to a number the test runner produced.
- Define test cases before the behaviour they test. Tune on the tuning set, check a change on the held-out set, which is the validation set, and quote the final set.
- Keep secrets in `.env` (ignored). Keep personal data out of fixtures, logs and traces. Fixtures are fictional or anonymised.
- Calls to paid model, speech or telephony providers need the maintainer's approval with an estimated cost first. Tests run offline against recorded responses by default.
- Private planning material lives outside this repository. Never copy it in.
- CI is described in `.agents/ci-profile.md`. Every CI change follows the ci-cd skill, which reads that profile.
- Verify with `.agents/skills/verify-desk-agent/SKILL.md` before handing off a change, once that skill exists.
