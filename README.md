# StakeWatch

An honest tracker for the **Chainlink Staking v0.2 community pool** (`0xBc10f2E862ED4502144c7d632a3459F49DFCDB5e`).
The pool is full, and freed space is re-staked within seconds. The site shows what actually happens and the realistic routes in:

* Pool status
* How fast openings get taken (30-day median and p90 refill time, LINK withdrawn vs re-staked)
* Weekly unlock forecast, shown with and without the rolling 15,000-LINK cohort
* Your realistic options: wait for a direct spot, stLINK, or hold
* Weekly report and big-unlock alert signup (beehiiv embed, fallback https://stakewatch.beehiiv.com/subscribe)

## Layout
```
index.html, assets/          static site (relative paths, works at https://<user>.github.io/stakewatch/)
scripts/update.mjs           data updater (Node 20, ethers v6)
abi/community_pool.json      verified ABI (Sourcify)
data/latest.json             snapshot read by the site
data/history.json            one row per run (capped at 10k rows, about 139 days at a 20-min cadence)
data/cache/events.json       scanned pool events, one per line (committed, so CI scans incrementally)
data/cache/scan.json         first and last scanned block
data/cache/block-ts.json     block timestamps for the recent-activity feed
.github/workflows/update.yml cron every 20 min + manual run: update, commit data, deploy Pages
```

## Run locally
```bash
npm ci                       # installs ethers
node scripts/update.mjs      # or: npm run update
python3 -m http.server 8787  # open http://localhost:8787
```
Options: `--lookback-days=90` (cold-start window), `--full` (from block 18,600,000), `--chunk=20000`.
Env overrides: `RPC_URLS`, `LOG_RPC_URLS` (comma-separated), `REWARD_RATE` (direct staking %, manual reference).

Timing: a cold 90-day scan (about 648k blocks) took about 2.6 min on this box. An incremental run takes about 20 to 40 s.

## How the numbers are made
* **Pool state**: `getTotalPrincipal`, `getMaxPoolSize`, `getStakerLimits`, `getUnbondingParams`, `isActive` and `isOpen`.
* **Events** (names from the verified ABI): `Staked`, `Unstaked`, `UnbondingPeriodStarted`, `UnbondingPeriodReset`, `PoolSizeIncreased`, `MaxPrincipalAmountIncreased`, `StakerMigrated`.
* **Pending unstakes**: for each `UnbondingPeriodStarted` in the last ~36 days, the script reads live `getUnbondingEndsAt`, `getClaimPeriodEndsAt` and `getStakerPrincipal`. Reset, withdrawn and expired requests are dropped.
* **Refill time**: seconds from each `Unstaked` to the next `Staked` (block delta × 12s).
* **Rolling cohort** (heuristic): pending unstakes at the 15,000 LINK max where 20 or more such addresses unlock on the same UTC day. In Oct 2026 these were about 393 addresses in weekly batches of 77 to 81. 0 of 606 of their completed claim windows ended in a withdrawal. Other stakers withdrew in about 43% of cases.
* **Likely withdrawn** = non-cohort unlocks × the observed non-cohort withdrawal rate.
* **RPC log limits**: free RPCs restrict `eth_getLogs` on old blocks. publicnode wants a token for archive ranges, 1rpc allows 50 blocks, Cloudflare 800, and dRPC's free plan refuses. `rpc.mevblocker.io` handled 50k ranges in testing. The scanner tries each log RPC and halves the range on failure.
* **Market data**: DefiLlama coins/TVL/yields, with CoinGecko as the price fallback.

## Deploy on GitHub Pages
1. Create a repo named `stakewatch` and push `main`.
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Actions → General → Workflow permissions: **Read and write** (needed for the data commits).
4. Run the workflow once from the Actions tab (workflow_dispatch).

No secrets are needed, because only free public RPCs and APIs are used. Notes:
* Scheduled workflows run best-effort and can be delayed.
* GitHub disables schedules after 60 days without repo activity. The data commits count as activity.
* On a **private** repo, about 72 runs a day uses roughly 2,000+ Actions minutes a month, which is more than the free tier. A public repo is free, or you can lower the cadence.
* Commits made with `GITHUB_TOKEN` don't re-trigger the workflow, so there's no loop.
* Commit noise: every run deploys fresh data to Pages, but the repo only gets a data commit when the fingerprint (pool total, pending count and amount, event count) changes, or every 6h. `history.json` therefore gains one row per data commit.

Live: https://stakewatchlink.github.io/stakewatch/

Local cron alternative:
```cron
*/20 * * * * cd /path/to/stakewatch && /usr/bin/node scripts/update.mjs >> data/update.log 2>&1
```

## TODO before launch
* Sponsor slot, Ledger affiliate URL (`#TODO-ledger-affiliate-link`)
* The direct reward rate (4.32%) is a manual reference

Not financial advice.
