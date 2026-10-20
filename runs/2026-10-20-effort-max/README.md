# Run 2026-10-20 · stage 0 · effort max · prompt onyx-prompt-v3 · ruleset onyx-v2 (5aa0fc3100543790)

Two independent generations per model, no feedback yet (stage 0). Reference strategies v2 (idle / orbiter / turret /
hunter). Tournament: 1v1 round-robin, 10 seeds × planets [1, 3, 6, 10] × both spawns = 8 400 matches
(`stage0-1v1.json` / `.csv`).

| Model | Provider | Effort sent | Valid samples |
|---|---|---|---|
| qwen3.8-flash-coder | llama-swap → Strata | max (Strata maps to xhigh) | 2 |
| qwen3.8-coder-len | llama-swap → llama.cpp | xhigh (template's top level) | 2 |
| swift1.5-coder-len | llama-swap → llama.cpp | xhigh | 2 |
| deepseek/deepseek-v4.1-flash | OpenRouter | max | 2 |
| claude-opus-5 | Claude Code CLI | max | 2 |
| claude-haiku-5-5 | Claude Code CLI | max | 1 (s2 hit the 128 000 output-token cap twice) |
| claude-sonnet-5-5 | Claude Code CLI | max | 0 (128 000-token cap twice; s2 stopped by the subscription limit) |
| claude-opus-5-5 | Claude Code CLI | max | 0 (subscription limit; not retried by choice) |
| gemma4-12b | llama-swap → llama.cpp | xhigh | 0 (every attempt spent all 64 000 tokens reasoning) |

HTTP providers: temperature 0.2, max output 64 000 tokens. Claude Code: CLI defaults (not settable). Details of every
failed attempt: `failed-attempts/README.md`.

Ranking (Elo, idle = 0, 95 % bootstrap CI):

| # | Strategy | Elo | CI |
|---|---|---|---|
| 1 | hunter (ref) | 548 | 510–589 |
| 2 | deepseek-v4.1-flash s1 | 493 | 458–535 |
| 3 | turret (ref) | 474 | 439–512 |
| 4 | claude-opus-5 s1 | 445 | 405–486 |
| 5 | qwen3.8-coder-len s2 | 410 | 376–448 |
| 6 | claude-haiku-5-5 s1 | 229 | 190–270 |
| 7 | qwen3.8-coder-len s1 | 210 | 179–243 |
| 8 | qwen3.8-flash-coder s2 | 142 | 111–177 |
| 9 | swift1.5-coder-len s2 | 84 | 51–117 |
| 10 | orbiter (ref) | 68 | 37–96 |
| 11 | claude-opus-5 s2 | 51 | 20–86 |
| 12 | qwen3.8-flash-coder s1 | 19 | −15–56 |
| 13 | deepseek-v4.1-flash s2 | 2 | −32–38 |
| 14 | idle (ref) | 0 | — |
| 15 | swift1.5-coder-len s1 | −131 | −170–−90 |

Notes:

- Two samples of the same model can be far apart (deepseek 493 vs 2, claude-opus-5 445 vs 51).
- qwen3.8-flash-coder s2 throws `ReferenceError: obs is not defined` inside its dodge function on every dodge
  (89 faults per 1000 decisions); the 10-second smoke test never reached that path.
