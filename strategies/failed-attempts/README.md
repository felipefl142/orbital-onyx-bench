Generation records of failed attempts (2026-10-20, effort max, prompt onyx-prompt-v3).

Model failures (the model's own behaviour at effort max; not retried again):

- claude-haiku-5-5 s2: attempts 1 and 2 both stopped at the 128 000 output-token maximum while still reasoning.
- claude-sonnet-5-5 s1: stopped at the 128 000 output-token maximum, twice (attempt 1's record was overwritten by a
  naming bug, since fixed; the file `claude-sonnet-5-5@max-s2.attempt1.gen.json` is that run's last record).

Infrastructure failures (retried):

- claude-sonnet-5-5 s2 and claude-opus-5-5 s1/s2: the Claude subscription session limit was reached before the
  request started.
- qwen3.8-flash-coder s2 (first try): the server's engine stopped mid-generation (SIGTERM); record kept outside the
  repository.

- gemma4-12b (llama-swap, llama.cpp): at effort max every attempt (4 for s1, 2 more for s2 before it was stopped)
  used all 64 000 output tokens on reasoning and returned no answer. A capped 6 000-token probe showed no literal
  repetition but an endless "let's refine… wait, I should also check…" cycle after a complete plan. Recorded as a
  model failure at max; s2 was stopped by hand (no record).
