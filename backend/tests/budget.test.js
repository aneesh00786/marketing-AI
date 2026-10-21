const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Budget & ROI. The Meta Marketing API is mocked; every amount below is a known number.
let A;
let B;
let programA;
let programB;
let budgetId;
let ledgerBefore;

const db = () => h.db();
const api = (ws, method, path, body) => h.api(method, `/api/v1/budgets${path}`, { token: ws.token, body });
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function program(ws, name) {
  const r = await h.api('POST', '/api/v1/command/programs', { token: ws.token, body: { name, channels: ['email'], budgetAmount: 9999, budgetCurrency: 'USD' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.program.id;
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Budget A' });
  B = await h.createWorkspace({ name: 'Budget B' });
  programA = await program(A, 'Q4 launch');
  programB = await program(B, 'B campaign');
  ledgerBefore = Number((await db().get('SELECT COUNT(*) AS n FROM usage_ledger')).n);
});
test.after(() => h.shutdown());

test('a budget is never spend: no actuals means none recorded, no forecast, no ROI', async () => {
  const base = { programId: programA, amount: 3000, currency: 'USD', periodStart: day(-9), periodEnd: day(20) };
  assert.equal((await api(A, 'POST', '/', { ...base, programId: programB })).status, 404, 'foreign campaign');
  assert.equal((await api(A, 'POST', '/', { ...base, periodEnd: day(-20) })).status, 400);
  assert.equal((await api(A, 'POST', '/', { ...base, currency: 'usd' })).status, 400);
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await api(member, 'POST', '/', base)).status, 403);

  const r = await api(A, 'POST', '/', base);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  budgetId = r.data.budget.id;
  const s = r.data.budget.summary;
  assert.deepEqual([s.budget.value, s.budget.status], [3000, 'budget']);
  assert.deepEqual([s.actualSpend.value, s.actualSpend.status], [0, 'none_recorded'], 'the budget (and the 9999 planning figure) are not spend');
  assert.equal(s.plannedToDate.status, 'plan');
  assert.equal(s.plannedToDate.value, 1000, '10 of 30 days at even pacing');
  assert.equal(s.pacing.status, 'no_data');
  assert.equal(s.forecast.status, 'unavailable');
  assert.equal(s.roi.status, 'unavailable');
  assert.equal((await api(A, 'POST', '/', base)).status, 409, 'one budget per campaign');
  assert.equal((await api(member, 'GET', `/${budgetId}`)).status, 200, 'members can view');
});

test('manual actual spend: same currency, not in the future, voided with a reason, audited', async () => {
  const entry = { date: day(-2), amount: 1500, currency: 'USD', description: 'Agency invoice', evidenceRef: 'INV-1001' };
  assert.equal((await api(A, 'POST', `/${budgetId}/spend`, { ...entry, currency: 'EUR' })).data.code, 'CURRENCY_MISMATCH');
  assert.equal((await api(A, 'POST', `/${budgetId}/spend`, { ...entry, date: day(3) })).data.code, 'FUTURE_SPEND');
  const wrong = await api(A, 'POST', `/${budgetId}/spend`, { ...entry, amount: 50, description: 'Typo' });
  const wrongId = wrong.data.budget.spend.find(e => e.description === 'Typo').id;
  assert.equal((await api(A, 'POST', `/${budgetId}/spend/${wrongId}/void`, {})).status, 400, 'void needs a reason');
  const voided = await api(A, 'POST', `/${budgetId}/spend/${wrongId}/void`, { reason: 'Entered by mistake' });
  assert.equal(voided.status, 200);
  assert.equal((await api(A, 'POST', `/${budgetId}/spend/${wrongId}/void`, { reason: 'again' })).status, 409);
  const r = await api(A, 'POST', `/${budgetId}/spend`, entry);
  const s = r.data.budget.summary;
  assert.deepEqual([s.actualSpend.value, s.actualSpend.status, s.actualSpend.bySource.manual], [1500, 'actual', 1500], 'voided entry excluded');
  assert.ok(r.data.budget.spend.find(e => e.id === wrongId).voided, 'voided entries stay visible');
  const audits = await db().all("SELECT action FROM audit_logs WHERE workspace_id = ? AND action LIKE 'budget.%' ORDER BY id", [A.workspaceId]);
  assert.ok(['budget.created', 'budget.spend_recorded', 'budget.spend_voided'].every(a => audits.some(x => x.action === a)));
});

test('pacing and forecast are labelled; alerts fire once and can be acknowledged', async () => {
  const b = (await api(A, 'GET', `/${budgetId}`)).data.budget;
  const s = b.summary;
  assert.equal(s.pacing.status, 'over', '1500 spent vs 1000 planned so far');
  assert.equal(s.pacing.ratio, 1.5);
  assert.deepEqual([s.forecast.status, s.forecast.value], ['forecast', 4500]);
  assert.match(s.forecast.method, /A projection, not spend/);
  const keys = b.alerts.map(a => a.key).sort();
  // no_actuals_7d fired when the budget was created 10 days into its period with nothing recorded.
  assert.deepEqual(keys, ['forecast_overrun', 'no_actuals_7d', 'threshold_50']);
  assert.match(b.alerts.find(a => a.key === 'forecast_overrun').message, /forecast, not actual/);
  await api(A, 'GET', `/${budgetId}`);
  assert.equal((await api(A, 'GET', `/${budgetId}`)).data.budget.alerts.length, 3, 'no duplicate alerts');
  const ack = await api(A, 'POST', `/${budgetId}/alerts/${b.alerts[0].id}/acknowledge`);
  assert.equal(ack.status, 200);
  assert.equal((await api(B, 'POST', `/${budgetId}/alerts/${b.alerts[1].id}/acknowledge`)).status, 404);
  const daily = b.daily;
  assert.equal(daily.length, 30);
  assert.equal(daily.find(d => d.date === day(-2)).actualCumulative, 1500);
  assert.equal(daily[daily.length - 1].actualCumulative, null, 'no actuals for future days');
});

test('ROI only from actual spend and revenue a person recorded', async () => {
  const rev = { date: day(-1), amount: 6000, currency: 'USD', description: 'Deal won: Acme', evidenceRef: 'CRM-42' };
  assert.equal((await api(A, 'POST', `/${budgetId}/revenue`, { ...rev, currency: 'GBP' })).data.code, 'CURRENCY_MISMATCH');
  const foreignLead = (await db().run("INSERT INTO leads (workspace_id, name, status) VALUES (?, 'B lead', 'Won')", [B.workspaceId])).lastID;
  assert.equal((await api(A, 'POST', `/${budgetId}/revenue`, { ...rev, leadId: foreignLead })).status, 404);
  const r = await api(A, 'POST', `/${budgetId}/revenue`, rev);
  const s = r.data.budget.summary;
  assert.deepEqual([s.revenue.value, s.revenue.status], [6000, 'recorded']);
  assert.deepEqual([s.roi.status, s.roi.value], ['available', 3]);
  assert.match(s.roi.basis, /recorded revenue 6000 − actual spend 1500/);

  const ov = await h.api('GET', '/api/v1/campaign-analytics/overview', { token: A.token });
  const p = ov.data.comparisons.programs.find(x => x.id === programA);
  assert.deepEqual([p.actualSpend.value, p.roi.value, p.budget.value], [1500, 3, 3000]);
});

test('Meta Ads spend syncs only with ads_read, idempotently, in the budget currency', async () => {
  const noAds = await h.createAccount(A.workspaceId, { scopes: ['pages_show_list', 'pages_manage_posts'] });
  const src = { provider: 'meta_ads', socialAccountId: noAds.id, adAccountId: 'act_123456789' };
  const denied = await api(A, 'POST', `/${budgetId}/sources`, src);
  assert.equal(denied.data.code, 'SPEND_NOT_AVAILABLE');
  assert.match(denied.data.error, /ads_read/);
  const manager = await h.addMember(A.workspaceId, 'Marketing Manager');
  const ads = await h.createAccount(A.workspaceId, { scopes: ['pages_show_list', 'ads_read'], secret: { access_token: 'page-token', user_access_token: 'user-token-SECRET', meta_user_id: 'u1' } });
  assert.equal((await api(manager, 'POST', `/${budgetId}/sources`, { ...src, socialAccountId: ads.id })).status, 403, 'needs integrations.manage');
  const conn = await api(A, 'POST', `/${budgetId}/sources`, { ...src, socialAccountId: ads.id });
  assert.equal(conn.status, 200, JSON.stringify(conn.data));
  const sourceId = conn.data.budget.summary.sources[0].id;
  assert.equal((await api(B, 'POST', `/${budgetId}/sources/${sourceId}/sync`)).status, 404);

  let spend = [{ date_start: day(-3), spend: '120.50', account_currency: 'USD' }, { date_start: day(-2), spend: '79.50', account_currency: 'USD' }];
  const calls = [];
  const mock = h.mockFetch([{ match: u => u.startsWith('https://graph.facebook.com/'), respond: (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return h.json(200, { data: spend }); } }]);
  try {
    let r = await api(A, 'POST', `/${budgetId}/sources/${sourceId}/sync`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.synced, 2);
    let s = r.data.budget.summary;
    assert.deepEqual([s.actualSpend.bySource.provider, s.actualSpend.value], [200, 1700]);
    // Re-sync with a corrected figure updates the day; nothing is duplicated.
    spend = [{ date_start: day(-3), spend: '100.00', account_currency: 'USD' }, { date_start: day(-2), spend: '79.50', account_currency: 'USD' }];
    r = await api(A, 'POST', `/${budgetId}/sources/${sourceId}/sync`);
    s = r.data.budget.summary;
    assert.equal(s.actualSpend.bySource.provider, 179.5);
    assert.equal(r.data.budget.spend.filter(e => e.sourceType === 'provider').length, 2);
    const prov = r.data.budget.spend.find(e => e.sourceType === 'provider');
    assert.equal((await api(A, 'POST', `/${budgetId}/spend/${prov.id}/void`, { reason: 'test' })).data.code, 'PROVIDER_ENTRY');

    spend = [{ date_start: day(-1), spend: '999.00', account_currency: 'EUR' }];
    const bad = await api(A, 'POST', `/${budgetId}/sources/${sourceId}/sync`);
    assert.equal(bad.data.code, 'CURRENCY_MISMATCH');
    const after = (await api(A, 'GET', `/${budgetId}`)).data.budget;
    assert.equal(after.summary.actualSpend.bySource.provider, 179.5, 'nothing imported in the wrong currency');
    assert.ok(after.alerts.some(a => a.key === `sync_error_${sourceId}`));
    assert.ok(!after.alerts.some(a => a.key.startsWith(`stale_${sourceId}`)), 'a freshly linked/synced source is not stale');
  } finally { mock.restore(); }
  assert.ok(calls.every(c => c.auth === 'Bearer user-token-SECRET' && !c.url.includes('user-token-SECRET')), 'token sent in a header, never in the URL');
  assert.match(calls[0].url, /\/act_123456789\/insights\?/);
});

test('budgets are private to the workspace and billing is untouched', async () => {
  for (const [m, p, b] of [['GET', `/${budgetId}`], ['PATCH', `/${budgetId}`, { amount: 1 }], ['POST', `/${budgetId}/spend`, { date: day(-1), amount: 1, currency: 'USD', description: 'x' }],
    ['POST', `/${budgetId}/revenue`, { date: day(-1), amount: 1, currency: 'USD', description: 'x' }], ['POST', `/${budgetId}/sources`, { provider: 'meta_ads', socialAccountId: 1, adAccountId: '123456' }]]) {
    assert.equal((await api(B, m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.ok(!(await api(B, 'GET', '/')).data.budgets.some(x => x.id === budgetId));
  assert.ok((await api(A, 'GET', '/')).data.budgets.some(x => x.id === budgetId));
  assert.equal((await h.api('GET', '/api/v1/budgets')).status, 401);
  const upd = await api(A, 'PATCH', `/${budgetId}`, { currency: 'EUR' });
  assert.equal(upd.data.code, 'HAS_SPEND', 'no silent currency change once spend exists');
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM usage_ledger')).n), ledgerBefore, 'no billing or usage records written');
});
