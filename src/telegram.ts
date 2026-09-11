import { Bot, InlineKeyboard } from 'grammy';
import { type Address, type Chain, formatEther, parseEther } from 'viem';
import { normalizeAddress } from './config.js';
import { type Engine, short } from './engine.js';
import type { Executor } from './executor.js';
import { log } from './log.js';
import type { RpcPool } from './rpc.js';
import type { Settings, Store } from './store.js';
import type { Watcher } from './watcher.js';

export interface BotDeps {
  store: Store;
  engine: Engine;
  watcher: Watcher;
  rpc: RpcPool;
  chain: Chain;
  executor: Executor | undefined;
  ownerIds: number[];
  pollIntervalMs: number;
}

const HELP = `*HyperMint — copy mint sniper*

*Targets*
/add \`<address>\` \[label] — watch a wallet
/remove \`<address>\` — stop watching
/list — watched wallets

*Control*
/status — engine, head block, latency
/settings — current configuration
/set \`<key> <value>\` — change a setting
/mode \`fast|verified\` — detection mode
/dryrun \`on|off\` — simulate instead of spending
/pause /resume /panic
/wallet — bot wallet and balance
/trades — recent copies
/allow \`<contract>\` /deny \`<contract>\` /clearlists

*Settings keys*
\`copies\` \`value_bps\` \`max_value\` \`daily_cap\` \`gas_bps\`
\`prio_bps\` \`maxfee_bps\` \`min_prio_gwei\` \`cooldown\`
\`rewrite\` \`notify_skips\``;

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

function parseOnOff(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (['on', 'true', 'yes', '1'].includes(value.toLowerCase())) return true;
  if (['off', 'false', 'no', '0'].includes(value.toLowerCase())) return false;
  return undefined;
}

export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);
  const { store, engine, watcher, chain } = deps;
  const symbol = chain.nativeCurrency.symbol;

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id === undefined || !deps.ownerIds.includes(id)) {
      log.warn(`rejected command from unauthorised user ${id}`);
      return;
    }
    await next();
  });

  bot.catch((error) => log.error('telegram handler error', error.message));

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'Markdown' }));

  bot.command('add', async (ctx) => {
    const [raw, ...rest] = ctx.match.trim().split(/\s+/);
    if (!raw) return ctx.reply('Usage: /add <address> [label]');
    let address: Address;
    try {
      address = normalizeAddress(raw);
    } catch (error) {
      return ctx.reply((error as Error).message);
    }
    const added = store.addTarget({
      address,
      label: rest.join(' '),
      addedAt: Date.now(),
      enabled: true,
    });
    return ctx.reply(added ? `Watching ${address}` : `${address} is already watched`);
  });

  bot.command('remove', async (ctx) => {
    const raw = ctx.match.trim();
    if (!raw) return ctx.reply('Usage: /remove <address>');
    try {
      const address = normalizeAddress(raw);
      return ctx.reply(store.removeTarget(address) ? `Removed ${address}` : 'That wallet was not watched');
    } catch (error) {
      return ctx.reply((error as Error).message);
    }
  });

  bot.command('list', (ctx) => {
    if (store.targets.length === 0) return ctx.reply('No wallets watched yet. Use /add <address>');
    const lines = store.targets.map(
      (target) => `• \`${target.address}\`${target.label ? ` — ${target.label}` : ''}${target.enabled ? '' : ' (disabled)'}`,
    );
    return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('status', async (ctx) => {
    const settings = store.settings;
    const ageMs = watcher.lastBlockAt ? Date.now() - watcher.lastBlockAt : 0;
    const best = Number.isFinite(engine.stats.bestLatencyMs) ? `${engine.stats.bestLatencyMs.toFixed(0)}ms` : '—';
    const lines = [
      `*${chain.name}* (chainId ${chain.id})`,
      `Head: ${watcher.head} (${ageMs}ms ago)`,
      `Poll: ${deps.pollIntervalMs}ms · last RPC ${watcher.lastPollMs.toFixed(0)}ms`,
      `RPCs: ${deps.rpc.urls.length} raced`,
      `Mode: ${settings.detectionMode} · dry run ${onOff(settings.dryRun)} · ${settings.paused ? 'PAUSED' : 'live'}`,
      `Targets: ${store.targets.length}`,
      `Detections ${engine.stats.detections} · copies ${engine.stats.copies} · skips ${engine.stats.skips} · failures ${engine.stats.failures}`,
      `Latency last ${engine.stats.lastLatencyMs.toFixed(0)}ms · best ${best}`,
      `Spent 24h: ${formatEther(store.spentInLast24h())} ${symbol}`,
    ];
    return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('wallet', async (ctx) => {
    if (!deps.executor) return ctx.reply('No PRIVATE_KEY configured — the bot can only run in dry run.');
    const balance = await deps.executor.balance();
    const fees = deps.executor.feeSnapshot;
    return ctx.reply(
      [
        `Wallet: \`${deps.executor.address}\``,
        `Balance: ${formatEther(balance)} ${symbol}`,
        `Base fee: ${formatEther(fees.baseFeePerGas * 1_000_000_000n)} gwei-ish (${fees.baseFeePerGas} wei)`,
        `Priority fee: ${fees.priorityFeePerGas} wei`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('settings', (ctx) => {
    const s = store.settings;
    const keyboard = new InlineKeyboard()
      .text(s.paused ? '▶️ Resume' : '⏸ Pause', 'toggle:paused')
      .text(s.dryRun ? '🔴 Go live' : '🧪 Dry run', 'toggle:dryRun')
      .row()
      .text(`Mode: ${s.detectionMode}`, 'toggle:mode')
      .text(`Rewrite: ${onOff(s.rewriteRecipient)}`, 'toggle:rewrite');
    return ctx.reply(renderSettings(s, symbol), { parse_mode: 'Markdown', reply_markup: keyboard });
  });

  bot.callbackQuery(/^toggle:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const s = store.settings;
    if (key === 'paused') store.updateSettings({ paused: !s.paused });
    if (key === 'dryRun') store.updateSettings({ dryRun: !s.dryRun });
    if (key === 'rewrite') store.updateSettings({ rewriteRecipient: !s.rewriteRecipient });
    if (key === 'mode') {
      store.updateSettings({ detectionMode: s.detectionMode === 'fast' ? 'verified' : 'fast' });
    }
    const next = store.settings;
    const keyboard = new InlineKeyboard()
      .text(next.paused ? '▶️ Resume' : '⏸ Pause', 'toggle:paused')
      .text(next.dryRun ? '🔴 Go live' : '🧪 Dry run', 'toggle:dryRun')
      .row()
      .text(`Mode: ${next.detectionMode}`, 'toggle:mode')
      .text(`Rewrite: ${onOff(next.rewriteRecipient)}`, 'toggle:rewrite');
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(renderSettings(next, symbol), {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  });

  bot.command('set', (ctx) => {
    const [key, value] = ctx.match.trim().split(/\s+/);
    if (!key || !value) return ctx.reply('Usage: /set <key> <value> — see /help for keys');
    try {
      const patch = buildPatch(key.toLowerCase(), value);
      store.updateSettings(patch);
      return ctx.reply(renderSettings(store.settings, symbol), { parse_mode: 'Markdown' });
    } catch (error) {
      return ctx.reply((error as Error).message);
    }
  });

  bot.command('mode', (ctx) => {
    const value = ctx.match.trim().toLowerCase();
    if (value !== 'fast' && value !== 'verified') return ctx.reply('Usage: /mode fast|verified');
    store.updateSettings({ detectionMode: value });
    return ctx.reply(
      value === 'fast'
        ? 'Fast mode: copies straight off the block, no receipt round trip.'
        : 'Verified mode: confirms an NFT was actually minted before copying (slower, safer).',
    );
  });

  bot.command('dryrun', (ctx) => {
    const value = parseOnOff(ctx.match.trim());
    if (value === undefined) return ctx.reply('Usage: /dryrun on|off');
    store.updateSettings({ dryRun: value });
    return ctx.reply(value ? 'Dry run on — nothing will be spent.' : '⚠️ Dry run OFF — real transactions will be sent.');
  });

  bot.command('pause', (ctx) => {
    store.updateSettings({ paused: true });
    return ctx.reply('⏸ Paused.');
  });

  bot.command('resume', (ctx) => {
    store.updateSettings({ paused: false });
    return ctx.reply('▶️ Live.');
  });

  bot.command('panic', (ctx) => {
    store.updateSettings({ paused: true, dryRun: true });
    return ctx.reply('🛑 Panic: paused and forced back into dry run.');
  });

  bot.command('allow', (ctx) => mutateList(ctx.match.trim(), 'contractAllowlist', store, ctx));
  bot.command('deny', (ctx) => mutateList(ctx.match.trim(), 'contractDenylist', store, ctx));

  bot.command('clearlists', (ctx) => {
    store.updateSettings({ contractAllowlist: [], contractDenylist: [] });
    return ctx.reply('Allowlist and denylist cleared.');
  });

  bot.command('trades', (ctx) => {
    const trades = store.trades.slice(0, 10);
    if (trades.length === 0) return ctx.reply('No copies recorded yet.');
    const lines = trades.map(
      (trade) =>
        `${new Date(trade.at).toISOString().slice(11, 19)} ${trade.status} ${formatEther(BigInt(trade.valueWei))} ${symbol} ${trade.latencyMs}ms ${short(trade.contract)}`,
    );
    return ctx.reply(lines.join('\n'));
  });

  return bot;
}

function mutateList(
  raw: string,
  key: 'contractAllowlist' | 'contractDenylist',
  store: Store,
  ctx: { reply: (text: string) => Promise<unknown> },
): Promise<unknown> {
  if (!raw) return ctx.reply(`Usage: /${key === 'contractAllowlist' ? 'allow' : 'deny'} <contract>`);
  try {
    const address = normalizeAddress(raw);
    const current = store.settings[key];
    if (current.includes(address)) return ctx.reply('Already listed.');
    store.updateSettings({ [key]: [...current, address] } as Partial<Settings>);
    return ctx.reply(`Added ${address}`);
  } catch (error) {
    return ctx.reply((error as Error).message);
  }
}

function renderSettings(s: Settings, symbol: string): string {
  return [
    '*Settings*',
    `mode: \`${s.detectionMode}\` · dryrun: \`${onOff(s.dryRun)}\` · paused: \`${onOff(s.paused)}\``,
    `copies: \`${s.copies}\` · value_bps: \`${s.valueBps}\` (${s.valueBps / 100}% of target value)`,
    `max_value: \`${formatEther(BigInt(s.maxValueWeiPerTx))} ${symbol}\` per tx`,
    `daily_cap: \`${formatEther(BigInt(s.dailyCapWei))} ${symbol}\``,
    `gas_bps: \`${s.gasLimitBps}\` · prio_bps: \`${s.priorityFeeBps}\` · maxfee_bps: \`${s.maxFeeBps}\``,
    `min_prio: \`${s.minPriorityFeeWei}\` wei · cooldown: \`${s.cooldownSecPerTarget}\`s`,
    `rewrite recipient: \`${onOff(s.rewriteRecipient)}\` · notify_skips: \`${onOff(s.notifySkips)}\``,
    `allowlist: ${s.contractAllowlist.length} · denylist: ${s.contractDenylist.length}`,
  ].join('\n');
}

function positiveInt(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative number`);
  return Math.round(parsed);
}

function buildPatch(key: string, value: string): Partial<Settings> {
  switch (key) {
    case 'copies':
      return { copies: Math.max(1, positiveInt(value, key)) };
    case 'value_bps':
      return { valueBps: positiveInt(value, key) };
    case 'max_value':
      return { maxValueWeiPerTx: parseEther(value).toString() };
    case 'daily_cap':
      return { dailyCapWei: parseEther(value).toString() };
    case 'gas_bps':
      return { gasLimitBps: Math.max(10_000, positiveInt(value, key)) };
    case 'prio_bps':
      return { priorityFeeBps: positiveInt(value, key) };
    case 'maxfee_bps':
      return { maxFeeBps: positiveInt(value, key) };
    case 'min_prio_gwei':
      return { minPriorityFeeWei: (BigInt(positiveInt(value, key)) * 1_000_000_000n).toString() };
    case 'cooldown':
      return { cooldownSecPerTarget: positiveInt(value, key) };
    case 'rewrite': {
      const parsed = parseOnOff(value);
      if (parsed === undefined) throw new Error('rewrite must be on or off');
      return { rewriteRecipient: parsed };
    }
    case 'notify_skips': {
      const parsed = parseOnOff(value);
      if (parsed === undefined) throw new Error('notify_skips must be on or off');
      return { notifySkips: parsed };
    }
    default:
      throw new Error(`Unknown setting "${key}" — see /help`);
  }
}
