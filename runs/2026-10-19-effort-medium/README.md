# Run 2026-10-19 · effort medium · prompt onyx-prompt-v2 · ruleset onyx-v1 (c1437038eafb9804)

One generation per model (no repairs were needed by any of them). Strategy code and generation records are in this
folder.

- Local (llama-swap): qwen3.8-flash-coder, qwen3.8-coder-len, swift1.5-coder-len. Temperature 0.2, max 32 000 output
  tokens. Server-side sampling/effort settings of llama-swap apply on top.
- Claude (Claude Code CLI, `--effort medium`): claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5, claude-opus-5-5.
  Temperature and max output tokens are the CLI defaults (not settable).

Tournaments (references idle/orbiter/turret/hunter included, idle = 0):

- `all-1v1.json` / `.csv`: 1v1 round-robin, 20 seeds × planets [1, 3, 6, 10] × both spawns = 8 800 matches.
- `all-ffa.json`: FFA 8 ships, 30 seeds × [1, 3, 6, 10] planets, orbiting planets.

Limit: one sample per model. A second generation of the same model can rank very differently.
