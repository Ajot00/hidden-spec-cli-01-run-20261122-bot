# hidden-spec-cli-01-run-20261122-bot

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ajot00/hidden-spec-cli-01-run-20261122-bot/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ajot00/hidden-spec-cli-01-run-20261122-bot/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON editor calls to a tree of text files, matching lines exactly first, then ignoring trailing whitespace, then ignoring surrounding whitespace, so a model's drifted patch still lands where it belongs. Everything is applied atomically — one failed edit means no file is written.

## Run it

```sh
node main.ts fix.patch
```

`node main.ts [--format=unified|search-replace|v4a|json|auto] [--check] [--strict] [PATCH]` — PATCH is a file, or stdin when absent or `-`. Node 22+, standard library only, no install step, no network, no model calls. `SPEC.md` is the whole specification.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
