(() => {
  const $ = id => document.getElementById(id);
  const f = (x, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  let D;
  function calc() {
    const out = $('c-out'); if (!D) return;
    const m = D.market || {}, src = $('c-src').value;
    const rate = src === 'stlink' ? (m.stlinkApy30d ?? m.stlinkApy) : m.directRewardRatePct;
    $('c-rsrc').textContent = src === 'stlink' ? 'stLINK 30-day APY from DefiLlama' : (m.directRewardRateSource || 'direct rate');
    if (rate == null) { out.textContent = 'Reward rate unavailable in live data — cannot estimate.'; return; }
    const amt = Math.max(0, +$('c-amt').value || 0), mo = Math.max(0, +$('c-mo').value || 0);
    const fee = Math.min(100, Math.max(0, +$('c-fee').value || 0)) / 100, gas = Math.max(0, +$('c-gas').value || 0);
    const gross = amt * rate / 100 * mo / 12, net = gross * (1 - fee), px = m.linkUsd;
    let s = `Estimated <b>${f(net)} LINK</b> over ${mo} month${mo == 1 ? '' : 's'} at ${rate.toFixed(2)}%/yr` + (fee ? ` after a ${f(fee * 100, 1)}% outside fee (gross ${f(gross)} LINK)` : '') + '.';
    if (px) s += `<br>≈ $${f(net * px)} at $${f(px)}/LINK, minus your ~$${f(gas, 0)} gas ⇒ <b>≈ $${f(net * px - gas)}</b> net (estimate).`;
    else s += '<br>USD value unavailable (no price in live data).';
    if (src === 'direct' && amt > (D.community?.maxPerStaker ?? 15000)) s += `<br><span class="muted">Note: direct staking is capped at ${(D.community.maxPerStaker).toLocaleString()} LINK per address.</span>`;
    out.innerHTML = s;
  }
  fetch('data/latest.json?_=' + Date.now()).then(r => r.json()).then(d => {
    D = d; const c = d.community || {};
    if (c.unbondingPeriodSec) $('r-cool').textContent = Math.round(c.unbondingPeriodSec / 86400) + '-day';
    if (c.claimPeriodSec) $('r-claim').textContent = Math.round(c.claimPeriodSec / 86400) + '-day';
    $('c-full').textContent = c.available === 0 ? 'full' : c.available != null ? 'open (' + Math.round(c.available).toLocaleString() + ' LINK free)' : 'unknown';
    calc();
  }).catch(e => { $('c-out').textContent = 'Live data unavailable — cannot estimate.'; console.error(e); });
  ['c-amt', 'c-src', 'c-mo', 'c-gas', 'c-fee'].forEach(i => $(i).addEventListener('input', calc));
})();
