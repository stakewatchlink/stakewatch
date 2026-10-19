#!/usr/bin/env node
// StakeWatch data updater.
// Reads Chainlink Staking v0.2 community pool state + events from free public RPCs, pulls stLINK/LINK
// market data, writes data/latest.json and appends data/history.json. Incremental: scanned events are
// cached in data/cache/events.json (commit it so CI runs only scan new blocks).
// Usage: node scripts/update.mjs [--lookback-days=90] [--full] [--chunk=20000]
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const LOOKBACK_DAYS = Number(args['lookback-days'] || 90); // cold-start window: covers pending (35d) + ~55d of completed claim windows
const CHUNK = Number(args.chunk || 20000);                 // auto-splits on range errors
const DEPLOY_BLOCK = 18_600_000;                           // ~late Nov 2023, before v0.2 launch (used with --full)
const BLOCK_SEC = 12;
const CONCURRENCY = 8;

// eth_getLogs on historical blocks: most free RPCs restrict this (Oct 2026 testing: publicnode = recent
// blocks only, 1rpc = 50 blocks, cloudflare = 800, drpc free = rejects). MEV Blocker served 50k ranges.
const LOG_RPCS = (process.env.LOG_RPC_URLS || [
  'https://rpc.mevblocker.io',
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://cloudflare-eth.com',
].join(',')).split(',');
const RPCS = (process.env.RPC_URLS || [
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.mevblocker.io',
  'https://eth.drpc.org',
  'https://1rpc.io/eth',
  'https://cloudflare-eth.com',
].join(',')).split(',');

const COMMUNITY_POOL = '0xBc10f2E862ED4502144c7d632a3459F49DFCDB5e';
const OPERATOR_POOL = '0xa1d76a7ca72128541e9fcacafbda3a92ef94fdc5';
const STLINK = '0xb8b295df2cd735b15BE5Eb419517Aa626fc43cD5';
const REFERENCE_REWARD_RATE = Number(process.env.REWARD_RATE || 4.32); // % per staking.chain.link (manual, Oct 2026)
const COHORT_MIN_PER_DAY = 20; // >= this many max-stake (15k) addresses unlocking the same UTC day = "rolling cohort"

const abi = JSON.parse(fs.readFileSync(path.join(ROOT, 'abi/community_pool.json'), 'utf8'));
const iface = new ethers.Interface(abi);
const EVENTS = ['Staked', 'Unstaked', 'UnbondingPeriodStarted', 'UnbondingPeriodReset', 'PoolSizeIncreased', 'MaxPrincipalAmountIncreased', 'StakerMigrated'];
const TOPICS = EVENTS.map(e => iface.getEvent(e).topicHash);

const mkProv = u => new ethers.JsonRpcProvider(u, 1, { staticNetwork: true, batchMaxCount: 1 });
const providers = RPCS.map(mkProv), logProviders = LOG_RPCS.map(mkProv);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let rpcIdx = 0;
async function withRpc(fn, label = '', list = providers, tries = 2) {
  let lastErr;
  for (let attempt = 0; attempt < list.length * tries; attempt++) {
    const i = (list === providers ? rpcIdx + attempt : attempt) % list.length;
    try { const r = await fn(list[i]); if (list === providers) rpcIdx = i; return r; }
    catch (e) { lastErr = e; await sleep(300 * (attempt + 1)); }
  }
  throw new Error(`All RPCs failed ${label}: ${lastErr?.shortMessage || lastErr?.message}`);
}
async function pmap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const fmt = x => Number(ethers.formatUnits(x, 18));
async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'StakeWatch/0.2' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const atomic = (f, s) => { fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); };
const writeJSON = (f, o) => atomic(f, JSON.stringify(o, null, 1) + '\n');
const writeRows = (f, rows) => atomic(f, '[\n' + rows.map(r => JSON.stringify(r)).join(',\n') + '\n]\n'); // one row per line = small git diffs

// ---------- 1. On-chain state ----------
async function poolState(addr) {
  return withRpc(async p => {
    const c = new ethers.Contract(addr, abi, p);
    const [total, max, limits, ub, active, open, paused] = await Promise.all([
      c.getTotalPrincipal(), c.getMaxPoolSize(), c.getStakerLimits(), c.getUnbondingParams().catch(() => [0n, 0n]), c.isActive(), c.isOpen(), c.paused().catch(() => false)]);
    return { totalPrincipal: fmt(total), maxPoolSize: fmt(max), available: fmt(max - total), minPerStaker: fmt(limits[0]), maxPerStaker: fmt(limits[1]),
      unbondingPeriodSec: Number(ub[0]), claimPeriodSec: Number(ub[1]), isActive: active, isOpen: open, paused };
  }, 'poolState');
}

// ---------- 2. Event scan with block cache ----------
async function getLogsRange(s, e) {
  try { return await withRpc(p => p.getLogs({ address: COMMUNITY_POOL, fromBlock: s, toBlock: e, topics: [TOPICS] }), `logs ${s}-${e}`, logProviders, 1); }
  catch (err) {
    if (e - s < 500) throw err;
    const m = Math.floor((s + e) / 2);
    return [...await getLogsRange(s, m), ...await getLogsRange(m + 1, e)];
  }
}
const cacheFile = path.join(CACHE, 'events.json');
const metaFile = path.join(CACHE, 'scan.json');
function saveCache(meta, events) { writeRows(cacheFile, events); writeJSON(metaFile, meta); }
async function scanEvents(head) {
  const meta = readJSON(metaFile, { firstScanned: null, lastScanned: null });
  const events = readJSON(cacheFile, []);
  const from = meta.lastScanned != null ? meta.lastScanned + 1 : (args.full ? DEPLOY_BLOCK : head - Math.ceil(LOOKBACK_DAYS * 86400 / BLOCK_SEC));
  if (meta.firstScanned == null) meta.firstScanned = from;
  const seen = new Set(events.map(e => e.tx + ':' + e.logIndex));
  const total = head - from + 1; let done = 0, added = 0, n = 0;
  for (let s = from; s <= head; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, head);
    for (const l of await getLogsRange(s, e)) {
      const k = l.transactionHash + ':' + l.index; if (seen.has(k)) continue; seen.add(k);
      const ev = iface.parseLog(l); if (!ev) continue;
      const o = { name: ev.name, block: l.blockNumber, tx: l.transactionHash, logIndex: l.index };
      if (ev.args.staker !== undefined) o.staker = ev.args.staker;
      for (const f of ['amount', 'newStake', 'newTotalPrincipal', 'maxPoolSize', 'maxPrincipalPerStaker']) if (ev.args[f] !== undefined) o[f] = fmt(ev.args[f]);
      events.push(o); added++;
    }
    meta.lastScanned = e; done += e - s + 1;
    if (++n % 10 === 0) { saveCache(meta, events); process.stderr.write(`  scanned ${done}/${total} blocks, +${added} events\n`); }
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  saveCache(meta, events);
  console.error(`  scan done: +${added}, ${events.length} cached events (blocks ${meta.firstScanned}-${meta.lastScanned})`);
  return { ...meta, events };
}

const tsCacheFile = path.join(CACHE, 'block-ts.json');
async function blockTimes(blocks, head, headTs) {
  const old = readJSON(tsCacheFile, {}), tc = {};
  await pmap(blocks, CONCURRENCY, async b => {
    if (old[b]) { tc[b] = old[b]; return; }
    try { tc[b] = (await withRpc(p => p.getBlock(b), 'block')).timestamp; } catch { tc[b] = headTs - (head - b) * BLOCK_SEC; }
  });
  writeJSON(tsCacheFile, tc); // pruned to blocks currently in use
  return tc;
}

// ---------- 3. Pending unstakes (live per-staker state) ----------
async function pendingUnstakes(events, head, nowTs, unbondingSec, claimSec) {
  const minBlock = head - Math.ceil((unbondingSec + claimSec + 86400) / BLOCK_SEC);
  const lastStart = {};
  for (const e of events) if (e.name === 'UnbondingPeriodStarted') lastStart[e.staker] = e;
  const candidates = Object.values(lastStart).filter(e => e.block >= minBlock);
  const c = s => withRpc(async p => {
    const k = new ethers.Contract(COMMUNITY_POOL, abi, p);
    const [ub, cl, pr] = await Promise.all([k.getUnbondingEndsAt(s), k.getClaimPeriodEndsAt(s), k.getStakerPrincipal(s)]);
    return { ub: Number(ub), cl: Number(cl), pr: fmt(pr) };
  }, 'staker ' + s);
  const rows = await pmap(candidates, CONCURRENCY, async st => {
    const r = await c(st.staker);
    if (!r.ub || r.pr === 0 || r.cl < nowTs) return null; // reset / fully unstaked / claim window expired
    return { staker: st.staker, principal: r.pr, unbondingEndsAt: r.ub, claimPeriodEndsAt: r.cl,
      status: r.ub <= nowTs ? 'claimable' : 'cooling', startedBlock: st.block, startedAt: nowTs - (head - st.block) * BLOCK_SEC, tx: st.tx };
  });
  return rows.filter(Boolean).sort((a, b) => a.unbondingEndsAt - b.unbondingEndsAt);
}

// Rolling cohort: many max-size (15k) stakes whose cooldowns end on the same UTC day.
function tagCohort(pending, maxPer, nowTs) {
  const day = p => new Date(Math.max(p.unbondingEndsAt, nowTs) * 1000).toISOString().slice(0, 10);
  const isMax = p => p.principal >= maxPer - 0.01;
  const perDay = {};
  for (const p of pending) if (isMax(p)) perDay[day(p)] = (perDay[day(p)] || 0) + 1;
  for (const p of pending) p.cohort = isMax(p) && perDay[day(p)] >= COHORT_MIN_PER_DAY;
  return Object.entries(perDay).filter(([, n]) => n >= COHORT_MIN_PER_DAY).map(([d, n]) => ({ date: d, addresses: n }));
}

// Observed follow-through: for unbond requests whose claim window has fully elapsed inside the scan
// window, did the staker actually withdraw (Unstaked) during cooldown end .. claim end?
function followThrough(events, head, firstScanned, unbondingSec, claimSec, cohortSet) {
  const ubB = Math.round(unbondingSec / BLOCK_SEC), clB = Math.round(claimSec / BLOCK_SEC);
  const unst = {};
  for (const e of events) if (e.name === 'Unstaked') (unst[e.staker] ||= []).push(e.block);
  const res = { cohort: { requests: 0, withdrew: 0 }, others: { requests: 0, withdrew: 0 } };
  for (const e of events) {
    if (e.name !== 'UnbondingPeriodStarted' || e.block < firstScanned || e.block + ubB + clB > head) continue;
    const g = cohortSet.has(e.staker) ? res.cohort : res.others;
    g.requests++;
    if ((unst[e.staker] || []).some(b => b >= e.block + ubB - 50 && b <= e.block + ubB + clB + 50)) g.withdrew++;
  }
  for (const g of Object.values(res)) g.rate = g.requests ? g.withdrew / g.requests : null;
  res.windowDays = Math.round((head - firstScanned) * BLOCK_SEC / 86400);
  res.repeatRequesters = [...cohortSet].filter(s => events.filter(e => e.name === 'UnbondingPeriodStarted' && e.staker === s).length > 1).length;
  return res;
}

// ---------- 4. Market data ----------
async function market() {
  const m = { errors: [] };
  try {
    const d = await getJSON(`https://coins.llama.fi/prices/current/coingecko:chainlink,ethereum:${STLINK}`);
    m.linkUsd = d.coins['coingecko:chainlink']?.price; m.stlinkUsd = d.coins[`ethereum:${STLINK}`]?.price;
    m.priceSource = 'DefiLlama coins API';
  } catch (e) { m.errors.push('llama prices: ' + e.message); }
  if (!m.linkUsd || !m.stlinkUsd) try {
    const d = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=chainlink,stake-link-staked-link&vs_currencies=usd');
    m.linkUsd ||= d.chainlink?.usd; m.stlinkUsd ||= d['stake-link-staked-link']?.usd; m.priceSource = 'CoinGecko';
  } catch (e) { m.errors.push('coingecko: ' + e.message); }
  if (m.linkUsd && m.stlinkUsd) m.stlinkPerLink = m.stlinkUsd / m.linkUsd;
  try { const d = await getJSON('https://api.llama.fi/tvl/stake.link-liquid'); m.stakelinkTvlUsd = typeof d === 'number' ? d : null; }
  catch (e) { m.errors.push('llama tvl: ' + e.message); }
  try {
    const d = await getJSON('https://yields.llama.fi/pools');
    const p = d.data.find(x => x.project === 'stake.link-liquid' && x.symbol === 'STLINK' && x.chain === 'Ethereum');
    if (p) { m.stlinkApy = p.apy; m.stlinkApy30d = p.apyMean30d; }
    const a = d.data.find(x => x.project === 'aave-v3' && x.symbol === 'LINK' && x.chain === 'Ethereum');
    if (a) m.aaveLinkApy = a.apy;
  } catch (e) { m.errors.push('llama yields: ' + e.message); }
  return m;
}

// ---------- main ----------
(async () => {
  const t0 = Date.now();
  const head = await withRpc(p => p.getBlockNumber(), 'head');
  const nowTs = (await withRpc(p => p.getBlock(head), 'headBlock')).timestamp;
  console.error(`head block ${head}`);
  const [community, operator] = await Promise.all([poolState(COMMUNITY_POOL), poolState(OPERATOR_POOL).catch(e => ({ error: e.message }))]);
  console.error(`community pool: ${community.totalPrincipal} / ${community.maxPoolSize} LINK`);
  const { events, firstScanned, lastScanned } = await scanEvents(head);
  const pending = await pendingUnstakes(events, head, nowTs, community.unbondingPeriodSec, community.claimPeriodSec);
  const cohortDays = tagCohort(pending, community.maxPerStaker, nowTs);
  const cohortSet = new Set(pending.filter(p => p.cohort).map(p => p.staker));

  const recent = events.filter(e => ['Staked', 'Unstaked', 'UnbondingPeriodStarted', 'UnbondingPeriodReset'].includes(e.name)).slice(-40).reverse();
  const tc = await blockTimes([...new Set(recent.map(e => e.block))], head, nowTs);
  const pIdx = Object.fromEntries(pending.map(p => [p.staker, p]));
  recent.forEach(e => { e.time = tc[e.block]; if (e.name === 'UnbondingPeriodStarted' && pIdx[e.staker]) e.principal = pIdx[e.staker].principal; if (cohortSet.has(e.staker)) e.cohort = true; });

  // Daily + weekly forecast, with and without the rolling cohort
  const sumBy = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const byDay = {};
  for (const p of pending) {
    const d = new Date(Math.max(p.unbondingEndsAt, nowTs) * 1000).toISOString().slice(0, 10);
    const o = byDay[d] ||= { date: d, link: 0, cohort: 0, others: 0 };
    o.link += p.principal; o[p.cohort ? 'cohort' : 'others'] += p.principal;
  }
  const timeline = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  const weeks = [{ label: 'Claimable now', from: null, to: nowTs, list: pending.filter(p => p.status === 'claimable') }];
  for (let w = 0; w < 5; w++) {
    const from = nowTs + w * 7 * 86400, to = from + 7 * 86400;
    const list = pending.filter(p => p.status === 'cooling' && p.unbondingEndsAt > from && p.unbondingEndsAt <= to);
    if (list.length || w < 4) weeks.push({ label: `Week ${w + 1}`, from, to, list });
  }
  const weekly = weeks.map(w => ({ label: w.label, from: w.from, to: w.to, count: w.list.length, link: sumBy(w.list, p => p.principal),
    cohort: sumBy(w.list.filter(p => p.cohort), p => p.principal), others: sumBy(w.list.filter(p => !p.cohort), p => p.principal),
    cohortCount: w.list.filter(p => p.cohort).length }));

  // 30-day flows + refill speed (blocks from each Unstaked to the next Staked)
  const since = head - Math.round(30 * 86400 / BLOCK_SEC);
  const in30 = n => events.filter(e => e.name === n && e.block >= since);
  const gaps = [];
  events.forEach((e, i) => { if (e.name === 'Unstaked' && e.block >= since) { const n = events.slice(i + 1).find(x => x.name === 'Staked'); if (n) gaps.push((n.block - e.block) * BLOCK_SEC); } });
  gaps.sort((a, b) => a - b);
  const q = f => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))] : null;
  const refill = { samples: gaps.length, medianSeconds: q(0.5), p90Seconds: q(0.9), maxSeconds: gaps.at(-1) ?? null,
    within60sPct: gaps.length ? gaps.filter(g => g <= 60).length / gaps.length * 100 : null, note: 'Seconds from each Unstaked to the next Staked event, block-time estimate (12s/block).' };

  const pend = pending, coh = pend.filter(p => p.cohort), oth = pend.filter(p => !p.cohort);
  const mk = await market();
  const latest = {
    updatedAt: new Date().toISOString(), block: head, blockTime: nowTs,
    contracts: { communityPool: COMMUNITY_POOL, operatorPool: OPERATOR_POOL, stLINK: STLINK },
    community, operator: operator.error ? operator : { totalPrincipal: operator.totalPrincipal, maxPoolSize: operator.maxPoolSize, available: operator.available },
    pending: { count: pend.length, totalLink: sumBy(pend, p => p.principal), claimableNow: sumBy(pend.filter(p => p.status === 'claimable'), p => p.principal),
      cohort: { count: coh.length, link: sumBy(coh, p => p.principal), days: cohortDays, definition: `Pending unstakes at the ${community.maxPerStaker} LINK per-address max where >=${COHORT_MIN_PER_DAY} such addresses unlock the same UTC day` },
      excludingCohort: { count: oth.length, link: sumBy(oth, p => p.principal), claimableNow: sumBy(oth.filter(p => p.status === 'claimable'), p => p.principal) },
      soonest: pend.filter(p => p.status === 'cooling').slice(0, 5).map(p => ({ date: new Date(p.unbondingEndsAt * 1000).toISOString(), link: p.principal, cohort: p.cohort })),
      list: pend },
    weekly, timeline,
    followThrough: followThrough(events, head, firstScanned, community.unbondingPeriodSec, community.claimPeriodSec, cohortSet),
    flows30d: { staked: sumBy(in30('Staked'), e => e.amount), unstaked: sumBy(in30('Unstaked'), e => e.amount), stakes: in30('Staked').length,
      unstakes: in30('Unstaked').length, unbondsStarted: in30('UnbondingPeriodStarted').length },
    refill, recent,
    market: { ...mk, directRewardRatePct: REFERENCE_REWARD_RATE, directRewardRateSource: 'staking.chain.link (manual reference)' },
    scan: { fromBlock: firstScanned, toBlock: lastScanned, events: events.length, seconds: (Date.now() - t0) / 1000 },
  };
  atomic(path.join(DATA, 'latest.json'), JSON.stringify(latest));
  const histFile = path.join(DATA, 'history.json');
  const hist = readJSON(histFile, []);
  hist.push({ t: latest.updatedAt, block: head, staked: community.totalPrincipal, max: community.maxPoolSize, available: community.available,
    pendingCount: pend.length, pendingLink: latest.pending.totalLink, pendingExCohort: latest.pending.excludingCohort.link,
    refillMedianS: refill.medianSeconds, linkUsd: mk.linkUsd, stlinkPerLink: mk.stlinkPerLink, stakelinkTvlUsd: mk.stakelinkTvlUsd });
  writeRows(histFile, hist.slice(-10000)); // ~139 days at 20-min cadence
  const { list, ...pendSummary } = latest.pending;
  console.log(JSON.stringify({ staked: community.totalPrincipal, max: community.maxPoolSize, available: community.available, pending: pendSummary,
    weekly, refill, flows30d: latest.flows30d, followThrough: latest.followThrough, market: mk, scan: latest.scan }, null, 1));
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
