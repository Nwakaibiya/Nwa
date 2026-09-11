# HyperMint

Telegram copy-mint bot for EVM chains. Watch any wallet; when it mints, your
wallet mints the same drop from the same contract, with the recipient argument
rewritten to yours.

Default chain is **Robinhood Chain** (`chainId 4663`, Arbitrum Nitro). Any other
EVM network works by setting `CHAIN_ID` + `RPC_URLS` — that is how Arc gets
added the day it is reachable, no code change.

## How it stays fast

| Stage | What it does |
| --- | --- |
| Discovery | `eth_getBlockByNumber(latest, true)` — full transactions in one round trip, so a target's mint is visible without a second call for receipts or logs |
| Sampling | Several polls stay in flight at once (`MAX_IN_FLIGHT_POLLS`), so the head is sampled every `POLL_INTERVAL_MS` even though a round trip takes ~90ms |
| Gap recovery | Nitro produces blocks faster than any poll loop; skipped blocks are fetched in parallel (`BACKFILL_CONCURRENCY`), retried once, and replayed through the same pipeline |
| Throttling | An endpoint that answers `429`/`503` is parked with an exponential cooldown and skipped while the rest of the pool serves; the poll cadence stretches to `MAX_POLL_INTERVAL_MS` and creeps back to `POLL_INTERVAL_MS` once it recovers |
| Redundancy | Every RPC call is raced across all configured endpoints (`Promise.any`), transactions are broadcast to all of them at once |
| Hot path | Nonce and gas prices are cached in the background; a detected mint goes straight to sign → broadcast with zero pre-flight RPC calls |
| Transport | Persistent keep-alive sockets — no TLS handshake at the moment it matters |

Measured on this box against the public Robinhood RPC: ~89ms average round
trip, ~75ms best, sign time under 1ms. The RPC round trip dominates, so the
single biggest speed upgrade available to you is **more/closer endpoints** in
`RPC_URLS` — a private node in the sequencer's region beats any code change.

There is no public mempool on Nitro (`eth_newPendingTransactionFilter` and
`txpool_*` are disabled on the public endpoint, and there is no websocket), so
copying happens at block level, not pending-tx level. Any bot claiming pending
frontrunning on this chain against a public endpoint is guessing.

## Setup

1. `@BotFather` → new bot → copy the token.
2. `@userinfobot` → copy your numeric Telegram user id.
3. Copy `.env.example` to `.env` (Replit: use the Secrets tab) and fill in
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_IDS`, and `PRIVATE_KEY`.
4. `npm install && npm start`

Only the ids in `TELEGRAM_OWNER_IDS` can talk to the bot; everyone else is
ignored.

### Replit

The repo ships `.replit` and `replit.nix`. Import it, put the variables in
**Secrets** (not `.env`), press Run. For it to keep running when you close the
tab you need a **Reserved VM deployment** — the free workspace sleeps, and a
sleeping sniper misses every mint. The bot serves a status JSON on `PORT`
(default 3000) so an uptime pinger has something to hit.

`DATA_FILE` defaults to `data/state.json`, which survives Replit restarts.

## Commands

```
/add <address> [label]   watch a wallet
/remove <address>        stop watching
/list                    watched wallets
/status                  head block, poll latency, hit stats
/settings                current config with toggle buttons
/set <key> <value>       change a setting
/mode fast|verified      detection mode
/dryrun on|off           simulate instead of spending
/pause /resume /panic    kill switches
/wallet                  bot wallet address, balance, current fees
/trades                  recent copies
/allow /deny /clearlists contract allow/deny lists
```

### Detection modes

- **fast** — copies straight off the block. Fires on known mint selectors and
  on any payable call to a contract. Zero extra RPC calls.
- **verified** — pulls the target's receipt and only copies if an NFT was
  actually minted (ERC721/ERC1155 transfer out of the zero address). Costs one
  round trip (~80ms measured) and catches free mints with exotic selectors that
  fast mode ignores.

### Settings

| Key | Meaning |
| --- | --- |
| `copies` | How many identical mints to send per detection |
| `value_bps` | Percent of the target's msg.value to send, in bps (`10000` = exact copy) |
| `max_value` | Hard cap per transaction, in native units |
| `daily_cap` | Rolling 24h spend cap |
| `gas_bps` | Gas limit as bps of the target's gas (`13000` = +30% headroom) |
| `prio_bps` / `maxfee_bps` | Fee aggressiveness vs the current network fees |
| `min_prio_gwei` | Floor on priority fee |
| `cooldown` | Minimum seconds between copies of the same wallet |
| `rewrite` | Rewrite the target's address in calldata to yours |
| `notify_skips` | Telegram message for every skipped transaction |

## Safety behaviour

- **Dry run is the default.** Nothing is spent until you `/dryrun off`.
- Allowlist/merkle-gated mints are skipped: the target's proof does not match
  your wallet, so the copy would revert and burn gas.
- Per-transaction cap, rolling 24h cap, per-target cooldown, contract allow/deny
  lists, `/panic` returns to paused + dry run.
- Known non-mint selectors (transfers, approvals, swaps) are rejected before
  anything else.

## Verifying before you risk money

```bash
npm test                      # unit tests for detection + calldata rewriting
npm run latency               # measures block cadence and RPC round trip
npm run shadow -- 60          # 60s live dry run against the busiest wallets
npm run replay -- 0x<tx hash> verified   # replay a real mint through the engine
```

`shadow` and `replay` need no Telegram token and never send a transaction.

## Limitations

- Block-level copying, not mempool (see above). You land in the block *after*
  the target, which is what every copy bot on a sequencer chain actually does.
- The quantity argument is never rewritten — guessing which calldata word is a
  quantity is how bots revert. Use `copies` to mint more.
- Allowlist mints cannot be copied, by design.
- A mint whose price is paid in ERC20 rather than native value is copied
  as-is; the token approval must already exist on your wallet.
