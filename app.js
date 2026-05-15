const SUPABASE_URL      = 'https://bpcjduaxfcacmwluyemo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwY2pkdWF4ZmNhY213bHV5ZW1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2OTk2NTIsImV4cCI6MjA5NDI3NTY1Mn0._dPYTJRf7kl5nWuKRuPHtc1ezYh9lDGwLEapnfs9uPk';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── STATE ──────────────────────────────────────────────────────────────────
let txns = [];
let currentUser = null;
let currentType = 'income';
let catChartInstance = null;
let destChartInstance = null;
let budgetChartInstance = null;
let activeCurrency = localStorage.getItem('ba-currency') || 'JPY';
let authMode = 'signin';
let budgets = {};
let editingBudgetCat = null;
let subs = [];
let editingSubId = null;

const CURRENCIES = [
  { code: 'USD', symbol: '$',  name: 'USD' },
  { code: 'GBP', symbol: '£',  name: 'GBP' },
  { code: 'EUR', symbol: '€',  name: 'EUR' },
  { code: 'JPY', symbol: '¥',  name: 'JPY' },
  { code: 'AUD', symbol: 'A$', name: 'AUD' },
  { code: 'CAD', symbol: 'C$', name: 'CAD' },
  { code: 'CHF', symbol: 'Fr', name: 'CHF' },
  { code: 'INR', symbol: '₹',  name: 'INR' },
  { code: 'KRW', symbol: '₩',  name: 'KRW' },
  { code: 'CNY', symbol: '¥',  name: 'CNY' },
];

const DEST_COLORS = ['#9d4edd','#4cc9f0','#06d6a0','#f72585','#ffbe0b','#ff6b6b','#06b6d4','#8b5cf6','#f97316','#14b8a6'];

const CAT_COLORS = {
  Food: '#06d6a0', Transport: '#4cc9f0', Housing: '#9d4edd',
  Entertainment: '#f72585', Health: '#ffbe0b', Shopping: '#ff6b6b',
  Salary: '#06d6a0', Freelance: '#4cc9f0', Other: '#6666aa',
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── BUDGETS (Supabase) ─────────────────────────────────────────────────────
async function loadBudgets() {
  const { data } = await db.from('budgets').select('*').eq('user_id', currentUser.id).eq('currency', activeCurrency);
  budgets = {};
  if (data) data.forEach(row => { budgets[row.category] = Number(row.amount); });
}

// ── AUTH ───────────────────────────────────────────────────────────────────
async function init() {
  const { data: { session } } = await db.auth.getSession();
  if (session) { currentUser = session.user; await loadTransactions(); await loadSubscriptions(); await checkDueSubscriptions(); await showApp(); }
  else { showAuthScreen(); }

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      await loadTransactions();
      await loadSubscriptions();
      await checkDueSubscriptions();
      await showApp();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null; txns = []; subs = []; showAuthScreen();
    }
  });
}

function showAuthScreen() {
  document.getElementById('app-wrap').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

async function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-wrap').style.display = 'flex';
  const now = new Date();
  document.getElementById('dash-title').textContent = `Overview — ${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
  buildCurrencySelects();
  await loadBudgets();
  render();
}

function switchTab(mode) {
  authMode = mode;
  document.getElementById('tab-signin').classList.toggle('active', mode === 'signin');
  document.getElementById('tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('confirm-wrap').style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('auth-submit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  document.getElementById('auth-password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  setAuthMsg('', false);
}

function setAuthMsg(text, isError = true) {
  const el = document.getElementById('auth-msg');
  el.textContent = text;
  el.className = 'auth-msg ' + (isError ? 'err' : 'ok');
}

async function handleAuth() {
  const email   = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const confirm  = document.getElementById('auth-confirm').value;
  if (!email || !password) { setAuthMsg('Email and password are required.'); return; }
  if (authMode === 'signup' && password !== confirm) { setAuthMsg('Passwords do not match.'); return; }

  const btn = document.getElementById('auth-submit');
  btn.disabled = true; btn.textContent = '…';

  const { data, error } = authMode === 'signin'
    ? await db.auth.signInWithPassword({ email, password })
    : await db.auth.signUp({ email, password });

  btn.disabled = false;
  btn.textContent = authMode === 'signin' ? 'Sign in' : 'Create account';

  if (error) { setAuthMsg(error.message); }
  else if (authMode === 'signup' && !data.session) {
    setAuthMsg('Check your email to confirm your account.', false);
  }
}

async function handleSignOut() { await db.auth.signOut(); }

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('auth-screen').style.display !== 'none') handleAuth();
});

// ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────
function localDateStr(year, month0, day) {
  const d = new Date(year, month0, day);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function advanceNextDue(sub, fromStr) {
  const d = new Date(fromStr + 'T00:00:00');
  if (sub.frequency === 'monthly') {
    return localDateStr(d.getFullYear(), d.getMonth() + 1, sub.day_of_month);
  }
  return localDateStr(d.getFullYear() + 1, sub.month_of_year - 1, sub.day_of_month);
}

function computeInitialNextDue(frequency, dayOfMonth, monthOfYear) {
  const todayStr = today();
  const now = new Date(todayStr + 'T00:00:00');
  if (frequency === 'monthly') {
    let d = localDateStr(now.getFullYear(), now.getMonth(), dayOfMonth);
    if (d < todayStr) d = localDateStr(now.getFullYear(), now.getMonth() + 1, dayOfMonth);
    return d;
  }
  let d = localDateStr(now.getFullYear(), monthOfYear - 1, dayOfMonth);
  if (d < todayStr) d = localDateStr(now.getFullYear() + 1, monthOfYear - 1, dayOfMonth);
  return d;
}

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

async function loadSubscriptions() {
  const { data } = await db.from('subscriptions').select('*').eq('user_id', currentUser.id).order('created_at');
  if (data) subs = data;
}

async function checkDueSubscriptions() {
  const todayStr = today();
  const due = subs.filter(s => s.next_due <= todayStr);
  if (!due.length) return;

  for (const s of due) {
    let d = s.next_due;
    const rows = [];
    let guard = 0;
    while (d <= todayStr && guard++ < 36) {
      rows.push({ description: s.name, amount: s.amount, cat: s.category, type: 'expense', date: d, currency: s.currency, user_id: currentUser.id });
      d = advanceNextDue(s, d);
    }
    if (rows.length) await db.from('transactions').insert(rows);
    await db.from('subscriptions').update({ next_due: d }).eq('id', s.id);
    s.next_due = d;
  }
  await loadTransactions();
}

function renderSubscriptions() {
  const el = document.getElementById('sub-list');
  const curSubs = subs.filter(s => s.currency === activeCurrency);

  const metricsEl = document.getElementById('sub-metrics');
  if (curSubs.length) {
    const todayStr = today();
    const monthlyCost = curSubs.reduce((sum, s) => {
      return sum + (s.frequency === 'monthly' ? s.amount : s.amount / 12);
    }, 0);
    const yearlyCost = curSubs.reduce((sum, s) => {
      return sum + (s.frequency === 'yearly' ? s.amount : s.amount * 12);
    }, 0);
    document.getElementById('sub-m-monthly').textContent = fmt(monthlyCost);
    document.getElementById('sub-m-yearly').textContent = fmt(yearlyCost);
    document.getElementById('sub-m-count').textContent = curSubs.length;
    metricsEl.style.display = 'grid';
  } else {
    metricsEl.style.display = 'none';
  }

  if (!curSubs.length) { el.innerHTML = '<div class="empty">No subscriptions yet. Add one!</div>'; return; }

  const todayStr = today();
  const in7 = new Date(); in7.setDate(in7.getDate() + 7);
  const in7Str = in7.toISOString().slice(0, 10);

  el.innerHTML = curSubs.map(s => {
    const color = CAT_COLORS[s.category] || '#888780';
    const freqText = s.frequency === 'monthly'
      ? `Monthly · ${ordinal(s.day_of_month)}`
      : `Yearly · ${MONTH_NAMES[s.month_of_year - 1].slice(0, 3)} ${ordinal(s.day_of_month)}`;
    const nextDue = s.next_due.slice(5).replace('-', '/');
    const dueSoon = s.next_due <= in7Str;
    const badge = dueSoon
      ? `<span class="badge badge-warn" style="font-size:10px">Due ${s.next_due === todayStr ? 'today' : 'soon'}</span>`
      : '';
    return `<div class="sub-card">
      <div class="sub-icon" style="background:${color}22"><i class="ti ti-repeat" style="color:${color};font-size:15px" aria-hidden="true"></i></div>
      <div class="sub-info">
        <div class="sub-name">${s.name} ${badge}</div>
        <div class="sub-meta">${freqText}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        <div class="txn-amount neg">${fmt(s.amount)}</div>
        <div class="txn-date">Next: ${nextDue}</div>
      </div>
      <button class="budget-edit-btn" onclick="openSubModal('${s.id}')" title="Edit"><i class="ti ti-pencil"></i></button>
    </div>`;
  }).join('');
}

function openSubModal(id) {
  editingSubId = id || null;
  const isEdit = !!id;
  const s = isEdit ? subs.find(x => x.id === id) : null;
  document.getElementById('sub-modal-title').textContent = isEdit ? 'Edit subscription' : 'Add subscription';
  document.getElementById('s-name').value = s ? s.name : '';
  document.getElementById('s-amount').value = s ? s.amount : '';
  document.getElementById('s-amount-label').textContent = 'Amount (' + getCur().symbol + ')';
  const sCats = Object.keys(budgets).sort();
  if (!sCats.includes('Other')) sCats.push('Other');
  document.getElementById('s-cat').innerHTML = sCats.map(c => `<option value="${c}">${c}</option>`).join('');
  document.getElementById('s-cat').value = s ? s.category : (sCats[0] || 'Other');
  document.getElementById('s-freq').value = s ? s.frequency : 'monthly';
  document.getElementById('s-day').value = s ? s.day_of_month : 1;
  document.getElementById('s-month').value = s ? (s.month_of_year || 1) : (new Date().getMonth() + 1);
  document.getElementById('s-delete-btn').style.display = isEdit ? 'block' : 'none';
  toggleSubFreq();
  document.getElementById('sub-modal').style.display = 'flex';
}
function closeSubModal() { document.getElementById('sub-modal').style.display = 'none'; }
function toggleSubFreq() {
  document.getElementById('s-month-wrap').style.display =
    document.getElementById('s-freq').value === 'yearly' ? 'block' : 'none';
}

async function saveSubscription() {
  const name       = document.getElementById('s-name').value.trim();
  const amount     = parseFloat(document.getElementById('s-amount').value);
  const category   = document.getElementById('s-cat').value;
  const frequency  = document.getElementById('s-freq').value;
  const day_of_month  = parseInt(document.getElementById('s-day').value);
  const month_of_year = parseInt(document.getElementById('s-month').value);
  if (!name || isNaN(amount) || !day_of_month) return;

  if (editingSubId) {
    const existing = subs.find(x => x.id === editingSubId);
    const billingChanged = existing.frequency !== frequency || existing.day_of_month !== day_of_month ||
      (frequency === 'yearly' && existing.month_of_year !== month_of_year);
    const patch = { name, amount, category, frequency, day_of_month, month_of_year: frequency === 'yearly' ? month_of_year : null };
    if (billingChanged) patch.next_due = computeInitialNextDue(frequency, day_of_month, month_of_year);
    const { error } = await db.from('subscriptions').update(patch).eq('id', editingSubId);
    if (error) { alert('Save failed: ' + error.message); return; }
    const idx = subs.findIndex(x => x.id === editingSubId);
    if (idx >= 0) subs[idx] = { ...subs[idx], ...patch };
  } else {
    const next_due = computeInitialNextDue(frequency, day_of_month, month_of_year);
    const payload = { name, amount, category, frequency, day_of_month, next_due, currency: activeCurrency, user_id: currentUser.id, month_of_year: frequency === 'yearly' ? month_of_year : null };
    const { data, error } = await db.from('subscriptions').insert(payload).select().single();
    if (error) { alert('Save failed: ' + error.message); return; }
    subs.push(data);
  }
  closeSubModal();
  renderSubscriptions();
}

async function deleteSubscription() {
  if (!editingSubId) return;
  const { error } = await db.from('subscriptions').delete().eq('id', editingSubId);
  if (!error) { subs = subs.filter(s => s.id !== editingSubId); closeSubModal(); renderSubscriptions(); }
}

// ── SUPABASE CRUD ──────────────────────────────────────────────────────────
function toDb(t) {
  return { description: t.desc, amount: t.amount, cat: t.cat, type: t.type, date: t.date, currency: t.currency, user_id: currentUser.id, destination: t.destination || null };
}
function fromDb(row) {
  return { id: row.id, desc: row.description, amount: Number(row.amount), cat: row.cat, type: row.type, date: row.date, currency: row.currency, destination: row.destination || null };
}

async function loadTransactions() {
  const { data } = await db.from('transactions').select('*').eq('user_id', currentUser.id).order('date', { ascending: false }).order('created_at', { ascending: false });
  if (data) txns = data.map(fromDb);
}

async function saveTransaction() {
  const desc        = document.getElementById('f-desc').value.trim();
  const destination = currentType === 'expense' ? document.getElementById('f-dest').value.trim() : '';
  const amount      = parseFloat(document.getElementById('f-amount').value);
  const cat         = document.getElementById('f-cat').value;
  const date        = document.getElementById('f-date').value;
  if (!desc || !amount || !date) return;

  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = '…';

  const { data, error } = await db.from('transactions')
    .insert(toDb({ desc, amount, cat, date, type: currentType, currency: activeCurrency, destination }))
    .select().single();

  btn.disabled = false; btn.textContent = 'Save';

  if (error) { alert('Save failed: ' + error.message); return; }
  txns.unshift(fromDb(data));
  document.getElementById('f-desc').value = '';
  document.getElementById('f-dest').value = '';
  document.getElementById('f-amount').value = '';
  closeModal();
  render();
}

async function deleteTransaction(id) {
  const { error } = await db.from('transactions').delete().eq('id', id);
  if (!error) { txns = txns.filter(t => t.id !== id); render(); }
}

// ── CURRENCY ───────────────────────────────────────────────────────────────
function getCur() { return CURRENCIES.find(c => c.code === activeCurrency) || CURRENCIES[0]; }

function fmt(n) {
  const c = getCur(), abs = Math.abs(n);
  return (c.code === 'JPY' || c.code === 'KRW')
    ? c.symbol + Math.round(abs).toLocaleString()
    : c.symbol + abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function today() { return new Date().toISOString().slice(0, 10); }

function buildCurrencySelects() {
  const opts = CURRENCIES.map(c => `<option value="${c.code}">${c.symbol} ${c.name}</option>`).join('');
  ['cur-select', 'cur-select-mob'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = opts; el.value = activeCurrency; }
  });
}

async function setCurrency(code) {
  activeCurrency = code;
  localStorage.setItem('ba-currency', code);
  ['cur-select', 'cur-select-mob'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = code;
  });
  document.getElementById('amount-label').textContent = 'Amount (' + getCur().symbol + ')';
  await loadBudgets();
  render();
}

// ── NAV ────────────────────────────────────────────────────────────────────
function navigateTo(page) {
  document.querySelectorAll('.nav-item, .bottom-nav-btn').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll(`[data-page="${page}"]`).forEach(x => x.classList.add('active'));
  document.getElementById('page-' + page).classList.add('active');
  if (page === 'dashboard') { renderChart(); renderDestChart(); }
}

document.querySelectorAll('.nav-item, .bottom-nav-btn').forEach(el => {
  el.addEventListener('click', () => navigateTo(el.dataset.page));
});

// ── TRANSACTION MODAL ──────────────────────────────────────────────────────
document.getElementById('f-date').value = today();
document.getElementById('openModal').addEventListener('click', openModal);

function openModal() {
  document.getElementById('amount-label').textContent = 'Amount (' + getCur().symbol + ')';
  document.getElementById('f-dest-wrap').style.display = currentType === 'expense' ? 'block' : 'none';
  setType(currentType);
  document.getElementById('modal').style.display = 'flex';
}
function closeModal() {
  document.getElementById('f-dest').value = '';
  document.getElementById('modal').style.display = 'none';
}

function setType(t) {
  currentType = t;
  document.getElementById('typeInc').className = 'type-btn' + (t === 'income' ? ' active-inc' : '');
  document.getElementById('typeExp').className = 'type-btn' + (t === 'expense' ? ' active-exp' : '');
  document.getElementById('f-dest-wrap').style.display = t === 'expense' ? 'block' : 'none';
  if (t === 'income') {
    document.getElementById('f-cat').innerHTML = '<option value="Salary">Salary</option><option value="Freelance">Freelance</option><option value="Other">Other</option>';
  } else {
    const cats = Object.keys(budgets).sort();
    if (!cats.includes('Other')) cats.push('Other');
    document.getElementById('f-cat').innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
  }
}

// ── BUDGET MODAL ───────────────────────────────────────────────────────────
function openBudgetModal(cat) {
  editingBudgetCat = cat || null;
  const isEdit = !!cat;
  document.getElementById('budget-modal-title').textContent = isEdit ? 'Edit budget' : 'Add budget';
  document.getElementById('b-cat').value = cat || '';
  document.getElementById('b-cat').disabled = isEdit;
  document.getElementById('b-amount').value = isEdit ? budgets[cat] : '';
  document.getElementById('b-amount-label').textContent = 'Monthly limit (' + getCur().symbol + ')';
  document.getElementById('b-delete-btn').style.display = isEdit ? 'block' : 'none';
  document.getElementById('budget-modal').style.display = 'flex';
}
function closeBudgetModal() { document.getElementById('budget-modal').style.display = 'none'; }

async function saveBudget() {
  const cat   = editingBudgetCat || document.getElementById('b-cat').value.trim();
  const limit = parseFloat(document.getElementById('b-amount').value);
  if (!cat || !limit) return;
  const { error } = await db.from('budgets')
    .upsert({ user_id: currentUser.id, category: cat, amount: limit, currency: activeCurrency },
            { onConflict: 'user_id,category,currency' });
  if (error) { alert('Save failed: ' + error.message); return; }
  budgets[cat] = limit;
  closeBudgetModal();
  render();
}

async function deleteBudget() {
  if (!editingBudgetCat) return;
  const { error } = await db.from('budgets')
    .delete()
    .eq('user_id', currentUser.id)
    .eq('category', editingBudgetCat)
    .eq('currency', activeCurrency);
  if (error) { alert('Delete failed: ' + error.message); return; }
  delete budgets[editingBudgetCat];
  closeBudgetModal();
  render();
}

// ── RENDER ─────────────────────────────────────────────────────────────────
function render() {
  const now = new Date();
  const thisMonth = txns.filter(t => {
    const d = new Date(t.date + 'T00:00:00');
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && t.currency === activeCurrency;
  });
  const income  = thisMonth.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = thisMonth.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const bal = income - expense;

  document.getElementById('m-balance').textContent = (bal < 0 ? '-' : '') + fmt(bal);
  document.getElementById('m-balance').style.color = bal < 0 ? '#f72585' : bal > 0 ? '#06d6a0' : 'var(--color-text-primary)';
  document.getElementById('m-income').textContent  = fmt(income);
  document.getElementById('m-expense').textContent = fmt(expense);

  const curTxns = txns.filter(t => t.currency === activeCurrency);
  renderTxnList('dash-txns', curTxns.slice(0, 5), false);
  renderTxnList('all-txns', curTxns, true);
  renderBudgets(thisMonth);
  renderBudgetChart();
  renderChart(thisMonth);
  renderDestChart(thisMonth);
  renderSubscriptions();
}

function txnHTML(t, showDelete) {
  const color = CAT_COLORS[t.cat] || '#888780';
  const icon  = t.type === 'income' ? 'ti-arrow-down' : 'ti-arrow-up';
  const del   = showDelete
    ? `<button class="txn-del" onclick="deleteTransaction('${t.id}')" title="Delete"><i class="ti ti-trash" aria-hidden="true"></i></button>`
    : '';
  return `<div class="txn-row">
    <div class="txn-icon" style="background:${color}22"><i class="ti ${icon}" style="color:${color};font-size:14px" aria-hidden="true"></i></div>
    <div class="txn-info"><div class="txn-name">${t.desc}</div><div class="txn-cat">${t.cat}${t.destination ? ' · ' + t.destination : ''}</div></div>
    <div class="txn-amount ${t.type === 'income' ? 'pos' : 'neg'}">${t.type === 'income' ? '+' : '-'}${fmt(t.amount)}</div>
    <div class="txn-date">${t.date.slice(5)}</div>
    ${del}
  </div>`;
}

function renderTxnList(id, list, showDelete) {
  const el = document.getElementById(id);
  el.innerHTML = list.length
    ? list.map(t => txnHTML(t, showDelete)).join('')
    : '<div class="empty">No transactions yet.</div>';
}

function renderBudgets(thisMonth) {
  const spent = {};
  thisMonth.filter(t => t.type === 'expense').forEach(t => { spent[t.cat] = (spent[t.cat] || 0) + t.amount; });
  const entries = Object.entries(budgets);

  const totalLimit = entries.reduce((s, [, v]) => s + v, 0);
  const totalSpent = entries.reduce((s, [cat]) => s + (spent[cat] || 0), 0);
  const remaining  = totalLimit - totalSpent;
  const hasBudgets = entries.length > 0;

  document.getElementById('budget-totals').style.display     = hasBudgets ? 'grid' : 'none';
  document.getElementById('budget-chart-card').style.display = hasBudgets ? 'block' : 'none';

  if (hasBudgets) {
    document.getElementById('bm-limit').textContent = fmt(totalLimit);
    document.getElementById('bm-spent').textContent = fmt(totalSpent);
    const remEl = document.getElementById('bm-remaining');
    remEl.textContent = (remaining < 0 ? '-' : '') + fmt(Math.abs(remaining));
    remEl.style.color = remaining < 0 ? '#f72585' : '#06d6a0';
    document.getElementById('bm-remaining-label').textContent = remaining < 0 ? 'Over budget' : 'Remaining';

    const sel  = document.getElementById('budget-cat-select');
    const prev = sel.value;
    sel.innerHTML = '<option value="all">All categories</option>' +
      Object.keys(budgets).sort().map(c => `<option value="${c}">${c}</option>`).join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  if (!entries.length) {
    document.getElementById('budget-list').innerHTML = '<div class="empty">No budgets yet. Add one!</div>';
    return;
  }
  document.getElementById('budget-list').innerHTML = entries.map(([cat, limit]) => {
    const s   = spent[cat] || 0;
    const pct = Math.min(100, Math.round(s / limit * 100));
    const color = pct >= 100 ? '#f72585' : pct >= 80 ? '#ffbe0b' : '#9d4edd';
    const badge = pct >= 100
      ? '<span class="badge badge-over">Over</span>'
      : pct >= 80
        ? '<span class="badge badge-warn">Near limit</span>'
        : '<span class="badge badge-ok">On track</span>';
    return `<div class="budget-card">
      <div class="budget-meta">
        <span class="budget-name">
          <button class="budget-edit-btn" onclick="openBudgetModal('${cat}')" title="Edit"><i class="ti ti-pencil"></i></button>
          ${cat}
        </span>
        <span style="display:flex;align-items:center;gap:8px">
          ${badge}
          <span class="budget-nums">${fmt(s)} / ${fmt(limit)}</span>
        </span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  }).join('');
}

function renderChart(thisMonth) {
  if (!thisMonth) {
    const now = new Date();
    thisMonth = txns.filter(t => {
      const d = new Date(t.date + 'T00:00:00');
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && t.currency === activeCurrency;
    });
  }
  const spent = {};
  thisMonth.filter(t => t.type === 'expense').forEach(t => { spent[t.cat] = (spent[t.cat] || 0) + t.amount; });
  const labels = Object.keys(spent);
  const data   = Object.values(spent);
  const colors = labels.map(l => CAT_COLORS[l] || '#888780');
  const canvas = document.getElementById('catChart');
  if (catChartInstance) { catChartInstance.destroy(); catChartInstance = null; }
  const legend = document.getElementById('chart-legend');
  if (!labels.length) { canvas.parentElement.style.display = 'none'; legend.innerHTML = ''; return; }
  canvas.parentElement.style.display = 'block';
  catChartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.label + ': ' + fmt(ctx.raw) } } },
    },
  });
  legend.innerHTML = labels.map((l, i) =>
    `<span style="display:flex;align-items:center;gap:4px;color:var(--color-text-secondary)">
      <span style="width:10px;height:10px;border-radius:2px;background:${colors[i]};flex-shrink:0"></span>
      ${l} ${fmt(data[i])}
    </span>`
  ).join('');
}

function renderDestChart(thisMonth) {
  if (!thisMonth) {
    const now = new Date();
    thisMonth = txns.filter(t => {
      const d = new Date(t.date + 'T00:00:00');
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && t.currency === activeCurrency;
    });
  }
  const spent = {};
  thisMonth.filter(t => t.type === 'expense' && t.destination).forEach(t => {
    spent[t.destination] = (spent[t.destination] || 0) + t.amount;
  });
  const labels = Object.keys(spent);
  const data   = Object.values(spent);
  const colors = labels.map((_, i) => DEST_COLORS[i % DEST_COLORS.length]);
  const canvas = document.getElementById('destChart');
  if (destChartInstance) { destChartInstance.destroy(); destChartInstance = null; }
  const legend = document.getElementById('dest-chart-legend');
  if (!labels.length) {
    canvas.parentElement.style.display = 'none';
    legend.innerHTML = '<div class="empty" style="padding:1.5rem 0">No destination data yet.</div>';
    return;
  }
  canvas.parentElement.style.display = 'block';
  destChartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.label + ': ' + fmt(ctx.raw) } } },
    },
  });
  legend.innerHTML = labels.map((l, i) =>
    `<span style="display:flex;align-items:center;gap:4px;color:var(--color-text-secondary)">
      <span style="width:10px;height:10px;border-radius:2px;background:${colors[i]};flex-shrink:0"></span>
      ${l} ${fmt(data[i])}
    </span>`
  ).join('');
}

function renderBudgetChart() {
  const now          = new Date();
  const year         = now.getFullYear();
  const month        = now.getMonth();
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const todayDay     = now.getDate();
  const sel          = document.getElementById('budget-cat-select');
  const selectedCat  = sel ? sel.value : 'all';

  const monthTxns = txns.filter(t => {
    const d = new Date(t.date + 'T00:00:00');
    return d.getMonth() === month && d.getFullYear() === year &&
           t.currency === activeCurrency && t.type === 'expense';
  });
  const filtered = selectedCat === 'all' ? monthTxns : monthTxns.filter(t => t.cat === selectedCat);

  const dailySpend = new Array(daysInMonth).fill(0);
  filtered.forEach(t => { dailySpend[new Date(t.date + 'T00:00:00').getDate() - 1] += t.amount; });

  let running = 0;
  const cumulativeData = dailySpend.map((v, i) => {
    if (i >= todayDay) return null;
    running += v;
    return running;
  });

  const limit = selectedCat === 'all'
    ? Object.values(budgets).reduce((s, v) => s + v, 0)
    : (budgets[selectedCat] || 0);

  const labels     = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const budgetLine = new Array(daysInMonth).fill(limit);

  const canvas = document.getElementById('budgetChart');
  if (budgetChartInstance) { budgetChartInstance.destroy(); budgetChartInstance = null; }

  budgetChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Spending',
          data: cumulativeData,
          borderColor: '#9d4edd',
          backgroundColor: 'rgba(157,78,221,0.12)',
          fill: true, tension: 0.3,
          pointRadius: 2, pointHoverRadius: 4,
          borderWidth: 2, spanGaps: false,
        },
        {
          label: 'Budget limit',
          data: budgetLine,
          borderColor: '#f72585',
          borderDash: [5, 5],
          borderWidth: 1.5,
          pointRadius: 0, fill: false, tension: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.raw ?? 0) } },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#6666aa', font: { size: 11 }, maxTicksLimit: 8 } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#6666aa', font: { size: 11 }, callback: v => fmt(v) } },
      },
    },
  });
}

// ── BOOT ───────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
init();
