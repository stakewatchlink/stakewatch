(() => {
  const $ = id => document.getElementById(id);
  const n0 = x => x == null || isNaN(x) ? '–' : Math.round(x).toLocaleString('en-US');
  const nk = x => x == null ? '–' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : x.toFixed(0);
  const usd = x => x == null ? '–' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : '$' + x.toFixed(2);
  const dt = s => new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dd = s => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const ago = s => { const d = Date.now() / 1000 - s; return d < 3600 ? Math.max(1, Math.round(d / 60)) + 'm ago' : d < 86400 ? Math.round(d / 3600) + 'h ago' : Math.round(d / 86400) + 'd ago'; };
  const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const dur = s => s == null ? '–' : s < 120 ? s + 's' : s < 7200 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + 'h';
  const pct = x => x == null ? '–' : (x * 100).toFixed(0) + '%';
  const LABEL = { Staked: 'Stake', Unstaked: 'Unstake', UnbondingPeriodStarted: 'Cooldown start', UnbondingPeriodReset: 'Cooldown reset' };
  let D, showCohort = false;

  fetch('data/latest.json?_=' + Date.now()).then(r => r.json()).then(d => { D = d; render(d); }).catch(e => { $('status').textContent = 'Data unavailable'; console.error(e); });

  function render(d) {
    const c = d.community, p = d.pending, m = d.market || {}, r = d.refill || {}, f = d.flows30d || {}, ft = d.followThrough || {};
    const full = c.available < 1;
    $('status').textContent = full ? 'Pool is FULL' : n0(c.available) + ' LINK open right now';
    $('status').className = 'status ' + (full ? 'full' : 'open');
    $('fill').style.width = Math.min(100, c.totalPrincipal / c.maxPoolSize * 100) + '%';
    $('staked-line').innerHTML = `<b>${n0(c.totalPrincipal)}</b> / ${n0(c.maxPoolSize)} LINK staked · ${(c.totalPrincipal / c.maxPoolSize * 100).toFixed(2)}%`;
    if (r.medianSeconds != null) $('lede').innerHTML = `LINK only gets in when someone withdraws, and over the last 30 days that space was re-staked in a median of <b>~${dur(r.medianSeconds)}</b>, mostly by automated bots. Here's what actually happens, and your realistic routes in.`;
    $('updated').textContent = 'Updated ' + new Date(d.updatedAt).toLocaleString() + ' · block ' + d.block;
    $('blk').textContent = d.block;
    $('h-open').textContent = n0(c.available) + ' LINK';
    $('h-lim').textContent = `${n0(c.minPerStaker)}–${n0(c.maxPerStaker)} LINK`;
    $('h-cd').textContent = `${Math.round(c.unbondingPeriodSec / 86400)}d / ${Math.round(c.claimPeriodSec / 86400)}d`;
    $('h-pend').textContent = `${n0(p.totalLink)} LINK (${p.count})`;
    $('h-pend-x').textContent = `${n0(p.excludingCohort.link)} LINK (${p.excludingCohort.count})`;

    $('r-med').textContent = r.medianSeconds != null ? '~' + dur(r.medianSeconds) : '–';
    $('r-p90').textContent = r.p90Seconds != null ? '~' + dur(r.p90Seconds) : '–';
    $('r-max').textContent = r.maxSeconds != null ? 'slowest: ~' + dur(r.maxSeconds) : '';
    $('r-60').textContent = r.within60sPct != null ? r.within60sPct.toFixed(0) + '%' : '–';
    $('r-n').textContent = r.samples ? `of ${r.samples} withdrawals` : 'no withdrawals in 30d';
    $('r-flow').textContent = nk(f.unstaked) + ' / ' + nk(f.staked);
    $('r-flow-s').textContent = Math.abs(f.unstaked - f.staked) < 1 ? 'every LINK withdrawn was re-staked' : `${n0(f.unstaked)} out, ${n0(f.staked)} in`;

    const coh = p.cohort, oth = ft.others || {}, cft = ft.cohort || {};
    $('cohort-txt').innerHTML = `${coh.count} pending unstakes (${n0(coh.link)} LINK) sit at exactly the ${n0(c.maxPerStaker)} LINK per-address max and unlock in batches of ~${Math.min(...coh.days.map(x => x.addresses))}–${Math.max(...coh.days.map(x => x.addresses))} addresses on the same day each week. ${ft.repeatRequesters} of them have re-requested within our ${ft.windowDays}-day scan. Of ${cft.requests} completed cohort claim windows we observed, <b>${cft.withdrew} withdrew</b> (${pct(cft.rate)}). For comparison, ${pct(oth.rate)} of other stakers' requests (${oth.withdrew}/${oth.requests}) did. This looks like rolling re-requests to keep an exit option open, so it probably won't free space. We show the forecast both ways.`;
    $('ft-rate').textContent = `${pct(oth.rate)} over ${ft.windowDays} days`;
    $('t-ex').onclick = () => { showCohort = false; toggle(); }; $('t-all').onclick = () => { showCohort = true; toggle(); };
    toggle();

    $('pending-tbl').querySelector('tbody').innerHTML = p.list.filter(x => x.status === 'cooling').slice(0, 40).map(x => `<tr><td>${dt(x.unbondingEndsAt)}</td><td>${n0(x.principal)}${x.cohort ? ' <span class="pill coh">cohort</span>' : ''}</td><td>claim until ${dd(x.claimPeriodEndsAt)}</td><td><a href="https://etherscan.io/address/${x.staker}" target="_blank" rel="noopener">${short(x.staker)}</a></td></tr>`).join('');

    $('activity-list').innerHTML = d.recent.slice(0, 30).map(e => {
      const amt = e.amount != null ? n0(e.amount) + ' LINK' : e.principal != null ? n0(e.principal) + ' LINK' : '';
      return `<li><span><span class="pill ${e.name}">${LABEL[e.name] || e.name}</span>${e.cohort ? '<span class="pill coh">cohort</span>' : ''}<a href="https://etherscan.io/tx/${e.tx}" target="_blank" rel="noopener">${short(e.staker)}</a></span><span>${amt} <span class="muted">· ${e.time ? ago(e.time) : '#' + e.block}</span></span></li>`;
    }).join('') || '<li class="muted">No events in scanned range</li>';

    const dr = m.directRewardRatePct, sr = m.stlinkApy;
    $('o-direct').textContent = dr ? '~' + dr.toFixed(2) + '%' : '–';
    $('o-med').textContent = r.medianSeconds != null ? '~' + dur(r.medianSeconds) : 'seconds';
    $('o-st').textContent = sr != null ? sr.toFixed(2) + '%' : '–';
    $('o-peg').textContent = m.stlinkPerLink ? m.stlinkPerLink.toFixed(4) : '–';
    $('o-aave').textContent = m.aaveLinkApy != null ? m.aaveLinkApy.toFixed(2) + '%' : '~0%';
    $('c-open').innerHTML = full ? '<span style="color:var(--bad)">No, pool full</span>' : '<span style="color:var(--ok)">Space open now</span>';
    $('c-direct').textContent = dr ? '~' + dr.toFixed(2) + '%' : '–';
    $('c-st').textContent = sr != null ? sr.toFixed(2) + '% APY' + (m.stlinkApy30d ? ` (30d ${m.stlinkApy30d.toFixed(2)}%)` : '') : '–';
    $('c-1y-d').textContent = dr ? `~${n0(1000 * (1 + dr / 100))} LINK (if you get in)` : '–';
    $('c-1y-s').textContent = sr != null && m.stlinkPerLink ? `~${n0(1000 / m.stlinkPerLink * (1 + sr / 100))} LINK-equiv. if bought at ${m.stlinkPerLink.toFixed(4)}` : '–';
    $('c-tvl-d').textContent = m.linkUsd ? usd(c.totalPrincipal * m.linkUsd) : n0(c.totalPrincipal) + ' LINK';
    $('c-tvl-s').textContent = usd(m.stakelinkTvlUsd);
    $('link-px').textContent = m.linkUsd ? '$' + m.linkUsd.toFixed(2) : '–';
  }

  function toggle() {
    $('t-ex').classList.toggle('on', !showCohort); $('t-all').classList.toggle('on', showCohort);
    $('t-ex').setAttribute('aria-pressed', !showCohort); $('t-all').setAttribute('aria-pressed', showCohort);
    const rate = D.followThrough?.others?.rate ?? 0;
    const rows = D.weekly.map(w => ({ ...w, name: w.from ? `${dd(w.from)} – ${dd(w.to)}` : 'Claimable now', exp: w.others * rate }));
    $('wtbl').querySelector('tbody').innerHTML = rows.map(w => `<tr><td>${w.name}</td><td>${n0(w.link)} <span class="muted">(${w.count})</span></td><td>${n0(w.others)} <span class="muted">(${w.count - w.cohortCount})</span></td><td><b>~${n0(w.exp)}</b></td></tr>`).join('');
    chart(rows);
  }

  function chart(rows) {
    const el = $('wchart');
    const W = Math.max(320, el.clientWidth || 1000), H = el.clientHeight || 240, pl = 46, pb = 28, pt = 18;
    const max = Math.max(...rows.map(w => showCohort ? w.link : w.others), 1);
    const y = v => H - pb - (v / max) * (H - pb - pt);
    const bw = (W - pl) / rows.length, gap = Math.min(28, bw * .25);
    let s = `<svg viewBox="0 0 ${W} ${H}">`;
    for (let g = 0; g <= 4; g++) { const v = max * g / 4; s += `<line x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#1f2a3d"/><text x="${pl - 6}" y="${y(v) + 4}" fill="#8a97ad" font-size="11" text-anchor="end">${nk(v)}</text>`; }
    rows.forEach((w, i) => {
      const x = pl + i * bw + gap / 2, bwi = bw - gap;
      s += `<rect x="${x}" y="${y(w.others)}" width="${bwi}" height="${H - pb - y(w.others)}" rx="3" fill="#5b7cff"/>`;
      if (showCohort) s += `<rect x="${x}" y="${y(w.others + w.cohort)}" width="${bwi}" height="${H - pb - y(w.cohort)}" rx="3" fill="#4a5568"/>`;
      s += `<rect x="${x + bwi * .3}" y="${y(w.exp)}" width="${bwi * .4}" height="${H - pb - y(w.exp)}" rx="2" fill="#2fd28b"/>`;
      const top = showCohort ? w.link : w.others;
      s += `<text x="${x + bwi / 2}" y="${y(top) - 5}" fill="#e6ebf5" font-size="11" text-anchor="middle">${nk(top)}</text>`;
      s += `<text x="${x + bwi / 2}" y="${H - 9}" fill="#8a97ad" font-size="11" text-anchor="middle">${w.from ? (W < 600 ? dd(w.from) : 'wk of ' + dd(w.from)) : 'now'}</text>`;
    });
    el.innerHTML = s + '</svg>';
  }
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => D && toggle(), 150); });
})();
