const SUPABASE_URL      = 'https://bpcjduaxfcacmwluyemo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwY2pkdWF4ZmNhY213bHV5ZW1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2OTk2NTIsImV4cCI6MjA5NDI3NTY1Mn0._dPYTJRf7kl5nWuKRuPHtc1ezYh9lDGwLEapnfs9uPk';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── STATE ──────────────────────────────────────────────────────────────────
let txns = [];
let currentUser = null;
let currentType = 'income';
let catChartInstance = null;
let activeCurrency = localStorage.getItem('ba-currency') || 'JPY';
let authMode = 'signin';
let budgets = {};
let editingBudgetCat = null;

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

const CAT_COLORS = {
  Food: '#06d6a0', Transport: '#4cc9f0', Housing: '#9d4edd',
  Entertainment: '#f72585', Health: '#ffbe0b', Shopping: '#ff6b6b',
  Salary: '#06d6a0', Freelance: '#4cc9f0', Other: '#6666aa',
};

const BUDGETS_BASE_USD = { Food: 400, Transport: 150, Housing: 800, Entertainment: 200, Health: 100, Shopping: 250 };
const CURRENCY_MUL     = { USD: 1, GBP: 0.8, EUR: 0.93, JPY: 150, AUD: 1.55, CAD: 1.37, CHF: 0.9, INR: 83, KRW: 1330, CNY: 7.2 };
const MONTH_NAMES      = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── BUDGETS (localStorage) ─────────────────────────────────────────────────
function budgetKey() { return 'ba-budgets-' + activeCurrency; }

function loadBudgets() {
  const stored = localStorage.getItem(budgetKey());
  if (stored) return JSON.parse(stored);
  const mul = CURRENCY_MUL[activeCurrency] || 1;
  const defaults = {};
  Object.entries(BUDGETS_BASE_USD).forEach(([cat, base]) => { defaults[cat] = Math.round(base * mul); });
  return defaults;
}

function persistBudgets() { localStorage.setItem(budgetKey(), JSON.stringify(budgets)); }

// ── AUTH ───────────────────────────────────────────────────────────────────
async function init() {
  const { data: { session } } = await db.auth.getSession();
  if (session) { currentUser = session.user; await loadTransactions(); showApp(); }
  else { showAuthScreen(); }

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      await loadTransactions();
      showApp();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null; txns = []; showAuthScreen();
    }
  });
}

function showAuthScreen() {
  document.getElementById('app-wrap').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-wrap').style.display = 'flex';
  const now = new Date();
  document.getElementById('dash-title').textContent = `Overview — ${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
  budgets = loadBudgets();
  buildCurrencySelects();
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

// ── SUPABASE CRUD ──────────────────────────────────────────────────────────
function toDb(t) {
  return { description: t.desc, amount: t.amount, cat: t.cat, type: t.type, date: t.date, currency: t.currency, user_id: currentUser.id };
}
function fromDb(row) {
  return { id: row.id, desc: row.description, amount: Number(row.amount), cat: row.cat, type: row.type, date: row.date, currency: row.currency };
}

async function loadTransactions() {
  const { data } = await db.from('transactions').select('*').eq('user_id', currentUser.id).order('date', { ascending: false });
  if (data) txns = data.map(fromDb);
}

async function saveTransaction() {
  const desc   = document.getElementById('f-desc').value.trim();
  const amount = parseFloat(document.getElementById('f-amount').value);
  const cat    = document.getElementById('f-cat').value;
  const date   = document.getElementById('f-date').value;
  if (!desc || !amount || !date) return;

  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = '…';

  const { data, error } = await db.from('transactions')
    .insert(toDb({ desc, amount, cat, date, type: currentType, currency: activeCurrency }))
    .select().single();

  btn.disabled = false; btn.textContent = 'Save';

  if (error) { alert('Save failed: ' + error.message); return; }
  txns.unshift(fromDb(data));
  document.getElementById('f-desc').value = '';
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

function setCurrency(code) {
  activeCurrency = code;
  localStorage.setItem('ba-currency', code);
  ['cur-select', 'cur-select-mob'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = code;
  });
  document.getElementById('amount-label').textContent = 'Amount (' + getCur().symbol + ')';
  budgets = loadBudgets();
  render();
}

// ── NAV ────────────────────────────────────────────────────────────────────
function navigateTo(page) {
  document.querySelectorAll('.nav-item, .bottom-nav-btn').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll(`[data-page="${page}"]`).forEach(x => x.classList.add('active'));
  document.getElementById('page-' + page).classList.add('active');
  if (page === 'dashboard') renderChart();
}

document.querySelectorAll('.nav-item, .bottom-nav-btn').forEach(el => {
  el.addEventListener('click', () => navigateTo(el.dataset.page));
});

// ── TRANSACTION MODAL ──────────────────────────────────────────────────────
document.getElementById('f-date').value = today();
document.getElementById('openModal').addEventListener('click', openModal);

function openModal() {
  document.getElementById('amount-label').textContent = 'Amount (' + getCur().symbol + ')';
  document.getElementById('modal').style.display = 'flex';
}
function closeModal() { document.getElementById('modal').style.display = 'none'; }

function setType(t) {
  currentType = t;
  document.getElementById('typeInc').className = 'type-btn' + (t === 'income' ? ' active-inc' : '');
  document.getElementById('typeExp').className = 'type-btn' + (t === 'expense' ? ' active-exp' : '');
  document.getElementById('f-cat').innerHTML = t === 'income'
    ? '<option value="Salary">Salary</option><option value="Freelance">Freelance</option><option value="Other">Other</option>'
    : '<option value="Food">Food</option><option value="Transport">Transport</option><option value="Housing">Housing</option><option value="Entertainment">Entertainment</option><option value="Health">Health</option><option value="Shopping">Shopping</option><option value="Other">Other</option>';
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

function saveBudget() {
  const cat   = editingBudgetCat || document.getElementById('b-cat').value.trim();
  const limit = parseFloat(document.getElementById('b-amount').value);
  if (!cat || !limit) return;
  budgets[cat] = limit;
  persistBudgets();
  closeBudgetModal();
  render();
}

function deleteBudget() {
  if (!editingBudgetCat) return;
  delete budgets[editingBudgetCat];
  persistBudgets();
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
  renderChart(thisMonth);
}

function txnHTML(t, showDelete) {
  const color = CAT_COLORS[t.cat] || '#888780';
  const icon  = t.type === 'income' ? 'ti-arrow-down' : 'ti-arrow-up';
  const del   = showDelete
    ? `<button class="txn-del" onclick="deleteTransaction('${t.id}')" title="Delete"><i class="ti ti-trash" aria-hidden="true"></i></button>`
    : '';
  return `<div class="txn-row">
    <div class="txn-icon" style="background:${color}22"><i class="ti ${icon}" style="color:${color};font-size:14px" aria-hidden="true"></i></div>
    <div class="txn-info"><div class="txn-name">${t.desc}</div><div class="txn-cat">${t.cat}</div></div>
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

// ── BOOT ───────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
init();
