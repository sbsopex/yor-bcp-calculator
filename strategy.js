// ============================================================
//  SBS — Ideal Strategy Module  (strategy.js)
//  Depends on helpers already defined in index.html:
//    num(), fmt(), fmtIDR(), fmtIDRs(), dFull(), dShort(),
//    addDays(), isWeekend(), simBaseDate(),
//    rockDailyForDate(), tier(), signedNet(), $()
//    compute()  — re-runs the main projection after solving
// ============================================================

// ── Binary-search solver ─────────────────────────────────────
// Finds the minimum flat repositioning/day so that premium
// stock reaches the target within the horizon, using the
// actual Rock YOR forecast day by day (not an average).
function solveMinRepo(eStock, eCap, target, horizon, otherIn, otherOut, today) {
  const eTarget = eCap * target;
  if (eStock <= eTarget) return 0;           // already at target

  // simulate forward with a given repo/day, return final stock
  function simulate(repoPerDay) {
    let s = eStock;
    for (let i = 1; i <= horizon; i++) {
      const msl = rockDailyForDate(addDays(today, i));
      const mslIn  = Math.round(msl.in  || 0);
      const mslOut = Math.round(msl.out || 0);
      const net = mslOut + otherOut + repoPerDay - mslIn - otherIn;
      s = Math.max(0, s - net);
    }
    return s;
  }

  // quick check: can we even solve within a sane repo ceiling?
  const MAX_REPO = 9999;
  if (simulate(MAX_REPO) > eTarget) return null;   // impossible

  // binary search for minimum integer repo that gets us to target
  let lo = 0, hi = MAX_REPO;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    simulate(mid) <= eTarget ? (hi = mid) : (lo = mid + 1);
  }
  return lo;
}

// ── Phased strategy builder ──────────────────────────────────
// Computes how many TEU/day of repo is actually needed each day,
// based on the varying MSL forecast. Days where MSL already
// drains enough get repo = 0; others get the gap filled.
function buildPhasedRows(eStock, eCap, target, horizon, otherIn, otherOut, flatRepo, today) {
  const eTarget = eCap * target;
  const rows = [];
  let s = eStock;
  for (let i = 0; i <= horizon; i++) {
    const date = addDays(today, i);
    const msl  = rockDailyForDate(date);
    const mslIn  = Math.round(msl.in  || 0);
    const mslOut = Math.round(msl.out || 0);
    // natural drain on this day (without extra repo)
    const naturalNet = mslOut + otherOut - mslIn - otherIn;
    // show the flat recommended repo (it may be 0 on good days)
    const repoUsed = i === 0 ? 0 : flatRepo;
    const net = naturalNet + repoUsed;
    const yor = eCap ? s / eCap : 0;
    rows.push({ i, date, mslIn, mslOut, repoUsed, eS: s, eyor: yor, net, naturalNet });
    if (i > 0) s = Math.max(0, s - net);
  }
  return rows;
}

// ── Sensitivity table ────────────────────────────────────────
// Shows: if we can only do X% of the recommended repo, how many
// extra days does recovery take?
function buildSensitivity(eStock, eCap, target, horizon, otherIn, otherOut, flatRepo, today) {
  if (!flatRepo || flatRepo === 0) return null;
  const eTarget = eCap * target;
  const levels = [1.0, 0.75, 0.5, 0.25, 0];
  const rows = [];
  for (const pct of levels) {
    const repo = Math.round(flatRepo * pct);
    let s = eStock, recDay = null;
    for (let i = 1; i <= 90; i++) {       // search up to 90 days
      const msl = rockDailyForDate(addDays(today, i));
      const net = Math.round(msl.out || 0) + otherOut + repo
                - Math.round(msl.in  || 0) - otherIn;
      s = Math.max(0, s - net);
      if (s <= eTarget && recDay === null) recDay = i;
    }
    rows.push({ pct: Math.round(pct * 100), repo, recDay });
  }
  return rows;
}

// ── Laden solver ─────────────────────────────────────────────
function solveLaden(lStock, lCap, target, horizon, lIn, lOut) {
  const lTarget = lCap * target;
  const lExcess = Math.max(0, lStock - lTarget);
  if (lExcess === 0) return { ok: true, reqLOut: lOut, addlLOut: 0, lExcess };
  // minimum daily outbound to clear excess within horizon
  const reqLOut = Math.ceil(lExcess / horizon + lIn);
  const addlLOut = Math.max(0, reqLOut - lOut);
  return { ok: addlLOut === 0, reqLOut, addlLOut, lExcess };
}

// ── Revenue calculation ──────────────────────────────────────
// Splits repo LOLO revenue from regular throughput revenue
function calcRevenue(phasedRows, lIn, lOut, eRev, lRev, flatRepo, horizon) {
  let throughputRev = 0, repoRev = 0;
  phasedRows.forEach((r, idx) => {
    if (idx === 0) return;   // day 0 is starting state
    throughputRev += (r.mslIn + r.mslOut) * eRev + (lIn + lOut) * lRev;
    repoRev       += r.repoUsed * eRev;
  });
  return { throughputRev, repoRev, totalRev: throughputRev + repoRev };
}

// ── HTML helpers ─────────────────────────────────────────────
function ppCell(a, b) {
  const d = (b - a) * 100;
  const cls = d < 0 ? 'dn' : d > 0 ? 'up' : '';
  const ar  = d < 0 ? '↓' : d > 0 ? '↑' : '–';
  return `<td class="num ${cls}">${ar} ${Math.abs(d).toFixed(1)} pp</td>`;
}
function stCell(a, b) {
  const d = b - a;
  const cls = d < 0 ? 'dn' : d > 0 ? 'up' : '';
  const ar  = d < 0 ? '↓' : d > 0 ? '↑' : '–';
  return `<td class="num ${cls}">${ar} ${fmt(Math.abs(d))}</td>`;
}

// ── Main entry point ─────────────────────────────────────────
async function generateStrategy() {
  const btn = $('stratBtn'), out = $('stratOut');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Solving…'; }

  // Try to pull live stock from YOR Daily sheet
  let source = 'current inputs';
  try {
    const fc = await fetchSheet();
    if (fc.lastActual) {
      $('eStock').value = Math.round(fc.lastActual.eStk);
      if (fc.lastActual.lStk != null) $('lStock').value = Math.round(fc.lastActual.lStk);
      source = 'live YOR Daily data';
    }
  } catch (e) { /* keep current inputs */ }

  // Read all inputs
  const eStock   = num('eStock'),  lStock   = num('lStock');
  const eCap     = num('eCap'),    lCap     = num('lCap');
  const t        = num('target') / 100;
  const horizon  = Math.max(1, num('days'));
  const otherIn  = num('eIn'),     otherOut = num('eOut');
  const lIn      = num('lIn'),     lOut     = num('lOut');
  const eRev     = num('eRev'),    lRev     = num('lRev');
  const today    = simBaseDate();

  // ── Solve ──────────────────────────────────────────────────
  const flatRepo = solveMinRepo(eStock, eCap, t, horizon, otherIn, otherOut, today);
  const impossible = flatRepo === null;
  const recoversWithoutRepo = flatRepo === 0;

  const safeRepo = impossible ? 0 : flatRepo;

  // Apply recommended repo to the main simulation so the chart updates
  $('eRepo').value = safeRepo;
  compute();    // re-runs the main projection

  // Build day-by-day phased rows & sensitivity
  const phasedRows = buildPhasedRows(eStock, eCap, t, horizon, otherIn, otherOut, safeRepo, today);
  const sensitivity = buildSensitivity(eStock, eCap, t, horizon, otherIn, otherOut, safeRepo, today);
  const ladenResult = solveLaden(lStock, lCap, t, horizon, lIn, lOut);
  const rev = calcRevenue(phasedRows, lIn, lOut, eRev, lRev, safeRepo, horizon);

  // Recovery day from phased rows
  const eHit    = phasedRows.find(r => r.eyor <= t && r.i > 0);
  const eRecDay = eHit ? eHit.i : null;
  const eRecDate = eRecDay != null ? dFull(addDays(today, eRecDay)) : null;
  const eEndRow  = phasedRows[phasedRows.length - 1];
  const eEndYor  = eEndRow ? eEndRow.eyor : eStock / eCap;
  const eEndStock = eEndRow ? eEndRow.eS  : eStock;

  // Verdict text
  let verdictE;
  if (recoversWithoutRepo) {
    verdictE = `The MSL forecast alone is already enough to drain Premium to ${Math.round(t*100)}% within ${horizon} days — <b>no extra repositioning required.</b>`;
  } else if (impossible) {
    verdictE = `Even at maximum repositioning, Premium <b>cannot reach ${Math.round(t*100)}%</b> within ${horizon} days. Extend the horizon or cap "another MSL" inbound.`;
  } else if (eRecDay != null) {
    verdictE = `Adding <b>${fmt(safeRepo)} TEU/day repositioning</b> on top of the MSL forecast brings Premium to ${Math.round(t*100)}% by <b>${eRecDate} (H+${eRecDay})</b>.`;
  } else {
    verdictE = `At <b>${fmt(safeRepo)} TEU/day repositioning</b>, Premium approaches target but does not cross it within ${horizon} days — consider extending the horizon.`;
  }

  // ── Phased detail table ────────────────────────────────────
  const phasedTbl = phasedRows.map(r => `
    <tr class="${r.i === 0 ? 'today' : ''} ${isWeekend(r.date) ? 'wknd' : ''}">
      <td>H+${r.i}</td>
      <td>${dShort(r.date)}${isWeekend(r.date) ? ' <span class="we">wk</span>' : ''}</td>
      <td>${fmt(r.eS)}</td>
      <td>${fmt(r.mslIn)}</td>
      <td>${fmt(r.mslOut)}</td>
      <td class="${r.naturalNet >= 0 ? 'pos' : 'neg'}">${r.i === 0 ? '—' : (r.naturalNet >= 0 ? '+' : '−') + fmt(Math.abs(r.naturalNet))}</td>
      <td>${r.i === 0 ? '—' : fmt(r.repoUsed)}</td>
      <td><span class="chip ${tier(r.eyor, t)}">${(r.eyor * 100).toFixed(1)}%</span></td>
    </tr>`).join('');

  // ── Sensitivity table ──────────────────────────────────────
  const sensTbl = sensitivity ? `
    <div class="report-sub">Sensitivity — what if we can only do part of the recommended repositioning?</div>
    <table class="ba-table">
      <tr>
        <th>Repo effort</th>
        <th style="text-align:right">TEU/day</th>
        <th style="text-align:right">Recovery day</th>
        <th style="text-align:right">Recovery date</th>
      </tr>
      ${sensitivity.map(r => `
        <tr>
          <td>${r.pct === 100 ? '<b>Recommended (100%)</b>' : r.pct + '% of recommended'}</td>
          <td class="num">${fmt(r.repo)}</td>
          <td class="num ${r.recDay == null ? 'up' : (r.recDay > horizon ? 'amber' : 'dn')}">
            ${r.recDay == null ? '> 90d' : 'H+' + r.recDay}
          </td>
          <td class="num">${r.recDay != null ? dFull(addDays(today, r.recDay)) : '—'}</td>
        </tr>`).join('')}
    </table>` : '';

  // ── Render output ──────────────────────────────────────────
  out.innerHTML = `
  <div class="ideal-banner">
    <div class="ihead">🎯 Ideal strategy to ${Math.round(t*100)}% YOR · horizon H+${horizon} · source: ${source}</div>
    <div class="ideal-grid">
      <div class="ideal-cell e">
        <h4>🔵 Premium (priority)</h4>
        <div class="recline"><span>Current YOR</span><b>${((eStock/eCap)*100).toFixed(1)}%</b></div>
        <div class="recline"><span>Over target by</span><b>${fmt(Math.max(0, eStock - eCap*t))} TEU</b></div>
        <div class="recline"><span>Method</span><b>Day-by-day Rock YOR simulation</b></div>
        <div class="recline"><span>Minimum repositioning needed</span><b>${impossible ? 'unsolvable' : recoversWithoutRepo ? 'none' : fmt(safeRepo) + ' TEU/day'}</b></div>
        <div class="recline"><span>Recovery</span><b>${eRecDay != null ? 'H+' + eRecDay + ' (' + eRecDate + ')' : '> H+' + horizon}</b></div>
        <div class="recline"><span>YOR at H+${horizon}</span><b>${(eEndYor*100).toFixed(1)}%</b></div>
      </div>
      <div class="ideal-cell l">
        <h4>🟡 Laden</h4>
        <div class="recline"><span>Current YOR</span><b>${((lStock/lCap)*100).toFixed(1)}%</b></div>
        <div class="recline"><span>Over target by</span><b>${fmt(ladenResult.lExcess)} TEU</b></div>
        <div class="recline"><span>Outbound now</span><b>${fmt(lOut)} TEU/day</b></div>
        <div class="recline"><span>Outbound needed</span><b>${ladenResult.ok ? 'sufficient' : fmt(ladenResult.reqLOut) + ' TEU/day'}</b></div>
        <div class="recline"><span>Extra needed</span><b class="${ladenResult.addlLOut > 0 ? 'up' : 'dn'}">${ladenResult.addlLOut > 0 ? '+' + fmt(ladenResult.addlLOut) + ' TEU/day' : 'none'}</b></div>
      </div>
    </div>
    <div class="ideal-note">
      ${verdictE}
      ${ladenResult.addlLOut > 0
        ? ` Laden needs <b>+${fmt(ladenResult.addlLOut)} TEU/day</b> reach-stacker outbound to clear its ${fmt(ladenResult.lExcess)} TEU surplus.`
        : ' Laden is within reach of target at current outbound.'}
      MSL volume is fixed forecast (Rock YOR · IDJKTSS · 2026); repositioning and line evacuation are the controllable levers.
    </div>
  </div>

  <div class="report-card" id="reportBlock">
    <div class="report-head">
      <h3>SBS — Premium YOR Recovery Strategy</h3>
      <div class="meta">Generated ${dFull(today)} · Target ${Math.round(t*100)}% YOR · Horizon H+${horizon} · Source: ${source}</div>
    </div>
    <div class="report-body">

      <div class="report-sub">Recommended plan</div>
      <div class="plan-row">
        <div class="plan-chip">🔵 Premium — hold MSL forecast · reposition <b>${fmt(safeRepo)}</b> TEU/day out${otherOut - otherIn !== 0 ? ` · another MSL net ${signedNet(otherIn - otherOut)}/day` : ''}</div>
        <div class="plan-chip">🟡 Laden — outbound <b>${fmt(Math.max(lOut, ladenResult.reqLOut))}</b> TEU/day</div>
      </div>

      <div class="report-sub">Current vs projected (H+${horizon})</div>
      <table class="ba-table">
        <tr><th>Metric</th><th style="text-align:right">Current</th><th style="text-align:right">Projected H+${horizon}</th><th style="text-align:right">Change</th></tr>
        <tr><td>Premium YOR</td><td class="num">${((eStock/eCap)*100).toFixed(1)}%</td><td class="num">${(eEndYor*100).toFixed(1)}%</td>${ppCell(eStock/eCap, eEndYor)}</tr>
        <tr><td>Premium stock (TEU)</td><td class="num">${fmt(eStock)}</td><td class="num">${fmt(eEndStock)}</td>${stCell(eStock, eEndStock)}</tr>
      </table>

      <div class="report-sub">Revenue impact (LOLO, H+${horizon})</div>
      <table class="ba-table">
        <tr><th>Item</th><th style="text-align:right">Amount</th></tr>
        <tr><td>MSL throughput LOLO revenue</td><td class="num">${fmtIDRs(rev.throughputRev)}</td></tr>
        <tr><td>↳ Repositioning LOLO revenue (${fmt(safeRepo * horizon)} moves)</td><td class="num">${fmtIDRs(rev.repoRev)}</td></tr>
        <tr><td><b>Total revenue under plan</b></td><td class="num"><b>${fmtIDRs(rev.totalRev)}</b></td></tr>
      </table>
      <div class="dash-note" style="margin:0 0 4px">Repositioning generates LOLO on the out-lift, so draining via repositioning <b>adds</b> revenue rather than forgoing it — unlike capping inbound. The constraint is depot/line capacity to absorb evacuated empties.</div>

      <div class="report-sub">Day-by-day plan (H+0 → H+${horizon})</div>
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Day</th><th>Date</th><th>Premium stock</th>
            <th>MSL IN</th><th>MSL OUT</th>
            <th>Natural net</th><th>REPO added</th><th>Premium YOR%</th>
          </tr></thead>
          <tbody>${phasedTbl}</tbody>
        </table>
      </div>

      ${sensTbl}

      <div class="report-actions">
        <button class="btn" onclick="printStrategyReport()">📄 Print / PDF this report</button>
      </div>
    </div>
  </div>`;

  if (btn) { btn.disabled = false; btn.textContent = '🎯 Generate Ideal Strategy'; }
}

// ── Print helper for strategy report ─────────────────────────
function printStrategyReport() {
  const node = document.getElementById('reportBlock');
  if (!node) return;
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups to print the report.'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>SBS YOR Strategy Report</title>
    <style>${window.REPORT_PRINT_CSS || ''}</style>
    </head><body>${node.innerHTML}</body></html>`);
  w.document.close(); w.focus();
  setTimeout(() => { w.print(); }, 350);
}
