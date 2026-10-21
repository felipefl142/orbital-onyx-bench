# Run 2026-10-20 · stage 1 (feedback) · effort max · ruleset onyx-v2 (5aa0fc3100543790)

Each model received its best stage-0 strategy (`../2026-10-20-effort-max/`) and its own numbers from the stage-0
tournament (`npm run generate -- --improve-from runs/2026-10-20-effort-max/stage0-1v1.json`), and wrote an improved
version. Two samples per model, effort max, max output 64 000 tokens, temperature 0.2. Claude models were not run.
Validation: four 30-second smoke matches (hunter, turret with orbiting planets, idle on 10 planets, 4-ship FFA).

All 8 samples passed validation (repairs: flash-coder s1 1, coder-len s2 1, deepseek s1/s2 1 each).

Tournament: stage-0 and stage-1 strategies plus the references in one 1v1 round-robin, 10 seeds × planets
[1, 3, 6, 10] × both spawns = 20 240 matches (`stage1-1v1.json` / `.csv`). Elo with idle = 0, 95 % bootstrap CI.

| Model | Stage-0 parent | Stage 1 s1 | Stage 1 s2 |
|---|---|---|---|
| qwen3.8-coder-len | 441 (max-s2) | 283 | **667** |
| qwen3.8-flash-coder | 132 (max-s2, ReferenceError on every dodge) | **398** | 340 |
| deepseek-v4.1-flash | 550 (max-s1) | **572** | 559 |
| swift1.5-coder-len | 105 (max-s2) | −69 | −40 |

References in the same tournament: hunter 610 [582, 645], turret 497, orbiter 55, idle 0.

- qwen3.8-coder-len@stage1-s2 (667 [635, 701]) is the first LLM strategy rated above hunter; head to head it scores
  0.62 against hunter and 0.47 against turret over 80 games each.
- swift1.5-coder-len got worse after feedback in both samples.
