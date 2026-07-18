/* App logic */
'use strict';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const view = $('#view');

function h(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

const money = (n) => '฿' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayYM = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ymLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(LANG === 'th' ? 'th-TH' : 'en-US', { month: 'short', year: 'numeric' });
};
function addMonths(dateStr, n) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d;
}
function monthsBetween(startStr, end = new Date()) {
  const s = new Date(startStr);
  return (end.getFullYear() - s.getFullYear()) * 12 + (end.getMonth() - s.getMonth()) +
    (end.getDate() >= s.getDate() ? 0 : -1);
}
const fmtDate = (d) => (d instanceof Date ? d : new Date(d)).toLocaleDateString(LANG === 'th' ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short', year: '2-digit' });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const th = LANG === 'th';
  if (s < 60) return th ? 'เมื่อสักครู่' : 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + (th ? ' นาทีที่แล้ว' : 'm ago');
  const h2 = Math.floor(m / 60); if (h2 < 24) return h2 + (th ? ' ชม.ที่แล้ว' : 'h ago');
  const d = Math.floor(h2 / 24); if (d < 30) return d + (th ? ' วันที่แล้ว' : 'd ago');
  return new Date(iso).toLocaleDateString(th ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short' });
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ---------- installment math ----------
function computeInstallment(it, today = new Date()) {
  const rate = Number(it.interestRate) || 0;
  const total = (Number(it.principal) || 0) * (1 + rate / 100);
  const totalMonths = Number(it.totalMonths) || 1;
  const perMonth = it.perMonth ? Number(it.perMonth) : total / totalMonths;
  let paid;
  if (it.manualPaid != null && it.manualPaid !== '') paid = Number(it.manualPaid);
  else paid = monthsBetween(it.startDate, today) + 1; // first payment on start date
  paid = clamp(paid, 0, totalMonths);
  const left = totalMonths - paid;
  const remaining = perMonth * left;
  const endDate = addMonths(it.startDate, totalMonths - 1);
  const nextDue = left > 0 ? addMonths(it.startDate, paid) : null;
  return { total, perMonth, paid, left, remaining, endDate, nextDue, totalMonths, progress: paid / totalMonths };
}

// ---------- state ----------
const State = { screen: 'home', month: todayYM(), detailCardId: null, scrollToCardId: null, cards: [], spending: [], installments: [], transactions: [] };

async function refresh() {
  State.cards = await DB.cards.all();
  State.spending = await DB.spending.all();
  State.installments = await DB.installments.all();
  State.transactions = await DB.transactions.all();
}
const cardById = (id) => State.cards.find(c => c.id === id);
const cardColor = (i) => ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316', '#3b82f6'][i % 10];

// ---------- seeding ----------
async function seedIfNeeded() {
  const flag = await DB.meta.get('seeded');
  if (flag && flag.value) return;
  const S = window.SEED || {};
  const nameToId = {};
  let idx = 0;
  for (const c of (S.cards || [])) {
    const id = await DB.cards.save({ name: c.name, bank: c.name, stmtDate: c.stmtDate || null, dueDate: c.dueDate || null, qr: null, color: cardColor(idx++) });
    nameToId[c.name] = id;
  }
  // History up to and including May 2026 is already paid; current month onward is not.
  const PAID_THROUGH = '2026-05';
  for (const s of (S.spending || [])) {
    const cid = nameToId[s.card];
    if (!cid) continue;
    const paid = s.month <= PAID_THROUGH;
    await DB.spending.save({ cardId: cid, month: s.month, amount: s.amount, note: '', paid, paidDate: paid ? `${s.month}-28T00:00:00.000Z` : null });
  }
  for (const inc of (S.income || [])) await DB.income.save(inc.month, inc.amount);
  for (const it of (S.installments || [])) {
    await DB.installments.save({
      bank: it.bank, detail: it.detail, startDate: it.start,
      principal: it.amount, totalMonths: it.totalMonth, interestRate: 0,
      perMonth: it.perMonth || null, manualPaid: null,
    });
  }
  await DB.meta.set('seeded', true);
}

// ---------- screens ----------
const Screens = {};

Screens.home = async () => {
  const month = State.month;
  const inc = await DB.income.get(month);
  const income = inc ? inc.amount : 0;
  const monthSpend = State.spending.filter(s => s.month === month);
  const totalSpend = monthSpend.reduce((a, s) => a + (s.amount || 0), 0);
  const unpaid = monthSpend.filter(s => !s.paid).reduce((a, s) => a + (s.amount || 0), 0);
  const activeInst = State.installments.filter(i => {
    if (!i.startDate) return false;
    const startYM = i.startDate.slice(0, 7);
    const endDate = addMonths(i.startDate, Number(i.totalMonths) - 1);
    const endYM = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`;
    return month >= startYM && month <= endYM;
  });
  const loanLoad = activeInst.filter(i => Number(i.totalMonths) >= 36).reduce((a, i) => a + computeInstallment(i).perMonth, 0);
  const instLoad = activeInst.filter(i => Number(i.totalMonths) < 36).reduce((a, i) => a + computeInstallment(i).perMonth, 0);
  const totalCommit = totalSpend - instLoad;
  const netFree = income - loanLoad - totalSpend;

  const wrap = h('div', { class: 'screen' });
  wrap.append(monthPicker());

  const ls = await DB.meta.get('lastSync');
  wrap.append(h('button', { class: 'sync-line', onclick: () => triggerSync() }, [
    h('span', {}, '🔄 ' + (ls && ls.value ? t('home.lastSync') + ' ' + timeAgo(ls.value) : t('home.tapSync'))),
  ]));

  const stats = h('div', { class: 'stat-grid' }, [
    statCard(t('home.income'), money(income), 'income', () => editIncome()),
    statCard(t('home.spending'), money(totalSpend), 'spend'),
    statCard(t('home.due'), money(unpaid), 'due'),
    statCard(t('home.carLoan'), money(loanLoad), 'loan'),
    statCard(t('home.installmentLoad'), money(instLoad), 'inst'),
    statCard(t('home.totalCommit'), money(totalCommit), 'due'),
    statCard(t('home.netFree'), money(netFree), netFree >= 0 ? 'income' : 'due', null, true),
  ]);
  wrap.append(stats);

  // upcoming due (sorted by due day)
  const upcoming = State.cards
    .map(c => ({ c, sp: monthSpend.find(s => s.cardId === c.id && !s.paid) }))
    .filter(x => x.sp)
    .sort((a, b) => (a.c.dueDate || 99) - (b.c.dueDate || 99));
  wrap.append(sectionTitle(t('home.upcoming')));
  if (!upcoming.length) wrap.append(emptyNote(t('home.none')));
  upcoming.forEach(({ c, sp }) => {
    wrap.append(h('div', { class: 'row card-row', onclick: () => { State.scrollToCardId = c.id; go('pay'); } }, [
      cardDot(c),
      h('div', { class: 'row-main' }, [
        h('div', { class: 'row-title' }, c.name),
        h('div', { class: 'row-sub' }, c.dueDate ? `${t('pay.due')} ${t('pay.day')} ${c.dueDate}` : ''),
      ]),
      h('div', { class: 'row-amt' }, money(sp.amount)),
    ]));
  });

  // by card breakdown
  wrap.append(sectionTitle(t('home.byCard')));
  const byCard = State.cards.map(c => {
    const amt = monthSpend.filter(s => s.cardId === c.id).reduce((a, s) => a + s.amount, 0);
    return { c, amt };
  }).filter(x => x.amt > 0).sort((a, b) => b.amt - a.amt);
  if (!byCard.length) wrap.append(emptyNote(t('home.none')));
  const maxAmt = byCard[0]?.amt || 1;
  byCard.forEach(({ c, amt }) => {
    const pct = amt / maxAmt * 100;
    const sharePct = totalSpend ? Math.round(amt / totalSpend * 100) : 0;
    wrap.append(h('div', { class: 'bar-row' }, [
      h('div', { class: 'bar-label' }, [cardDot(c), h('span', {}, c.name), h('span', { class: 'bar-share' }, `${sharePct}%`)]),
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${pct}%;background:${c.color}` })),
      h('div', { class: 'bar-amt' }, money(amt)),
    ]));
  });

  return wrap;
};

Screens.pay = async () => {
  const month = State.month;
  const wrap = h('div', { class: 'screen' });
  wrap.append(monthPicker());
  const monthSpend = State.spending.filter(s => s.month === month);
  const totalDue = monthSpend.filter(s => !s.paid).reduce((a, s) => a + s.amount, 0);
  wrap.append(h('div', { class: 'banner' }, [
    h('span', {}, t('pay.totalDue')),
    h('strong', {}, money(totalDue)),
  ]));

  const cardsWithSpend = State.cards
    .map(c => ({ c, sp: monthSpend.find(s => s.cardId === c.id) }))
    .filter(x => x.sp && x.sp.amount > 0)
    .sort((a, b) => (a.c.dueDate || 99) - (b.c.dueDate || 99));

  if (!cardsWithSpend.length) wrap.append(emptyNote(t('home.none')));
  cardsWithSpend.forEach(({ c, sp }) => {
    const paid = sp.paid;
    const txCount = State.transactions.filter(x => x.cardId === c.id && x.month === month).length;
    const card = h('div', { class: 'pay-card' + (paid ? ' is-paid' : ''), 'data-card-id': c.id }, [
      h('div', { class: 'pay-head' }, [
        cardDot(c),
        h('div', { class: 'row-main' }, [
          h('div', { class: 'row-title' }, c.name),
          h('div', { class: 'row-sub' }, c.dueDate ? `${t('pay.due')} ${t('pay.day')} ${c.dueDate} · ${t('pay.stmt')} ${c.stmtDate || '-'}` : ''),
        ]),
        h('div', { class: 'row-amt big' }, money(sp.amount)),
      ]),
      // View this month's transactions
      txCount ? h('button', { class: 'btn ghost block tx-view', onclick: () => showMonthTx(c, month) },
        `📋 ${t('pay.viewTx')} (${txCount})`) : null,
      // QR shown inline by default once uploaded; tap to enlarge / change / remove
      c.qr ? h('div', { class: 'pay-qr', onclick: () => showQR(c) }, [
        h('img', { src: c.qr, class: 'pay-qr-img', alt: 'QR' }),
        h('div', { class: 'muted small center' }, '👆 ' + t('pay.scanToPay')),
      ]) : null,
      h('div', { class: 'pay-actions' }, [
        c.qr ? null
          : h('button', { class: 'btn ghost', onclick: () => uploadQRForCard(c) }, '⬆ ' + t('cards.uploadQR')),
        h('button', {
          class: 'btn ' + (paid ? 'paid-tag' : 'primary'),
          onclick: async () => { sp.paid = !sp.paid; sp.paidDate = sp.paid ? new Date().toISOString() : null; await DB.spending.save(sp); await rerender(); }
        }, paid ? '✓ ' + t('pay.paid') : t('pay.markPaid')),
      ]),
    ]);
    wrap.append(card);
  });
  return wrap;
};

// Sync: if the local sync server is reachable, read Gmail live (one tap);
// otherwise fall back to importing the JSON file by hand.
function fetchTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

const syncBase = () => (localStorage.getItem('syncUrl') || '').trim().replace(/\/+$/, '');
const syncUrl = (path) => { const b = syncBase(); return b ? b + '/' + path : path; };
const cloudDataUrl = () => (localStorage.getItem('cloudDataUrl') || '').trim();

async function triggerSync() {
  let server = false;
  try { server = (await fetchTimeout(syncUrl('api/ping'), 2500)).ok; } catch (_) {}
  if (server) return autoSync();
  if (cloudDataUrl()) return loadFromCloud();
  showSyncSheet();
}

async function autoSync() {
  openModal(t('sync.title'), [
    h('div', { class: 'sync-loading' }, [h('div', { class: 'spinner' }), h('div', { class: 'muted' }, t('sync.reading'))]),
  ]);
  try {
    const resp = await fetchTimeout(syncUrl('api/sync'), 190000, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error((data && data.error) || 'sync failed');
    await DB.importAll(data);
    await DB.meta.set('lastSync', new Date().toISOString());
    await rerender('home');
    closeModal();
    const months = (data.spending || []).map(s => s.month).filter(Boolean).sort();
    toast('✓ ' + (months.length ? ymLabel(months[months.length - 1]) : '✓'));
  } catch (e) {
    openModal(t('sync.title'), [
      h('div', { class: 'muted small mb' }, '⚠ ' + (e.message || e)),
      h('div', { class: 'muted small mb' }, t('sync.errHint')),
      ...syncButtons(),
    ]);
  }
}

async function loadFromCloud() {
  const url = cloudDataUrl();
  if (!url) return showSyncSheet();
  openModal(t('sync.title'), [
    h('div', { class: 'sync-loading' }, [h('div', { class: 'spinner' }), h('div', { class: 'muted' }, t('sync.cloudLoading'))]),
  ]);
  try {
    const resp = await fetchTimeout(url, 30000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    await DB.importAll(data);
    await DB.meta.set('lastSync', new Date().toISOString());
    await rerender('home');
    closeModal();
    const months = (data.spending || []).map(s => s.month).filter(Boolean).sort();
    toast('✓ ' + (months.length ? ymLabel(months[months.length - 1]) : '✓'));
  } catch (e) {
    openModal(t('sync.title'), [
      h('div', { class: 'muted small mb' }, '⚠ ' + (e.message || e)),
      h('div', { class: 'muted small mb' }, t('sync.errHint')),
      ...syncButtons(),
    ]);
  }
}

function syncButtons() {
  const fileIn = h('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: (e) => { closeModal(); importData(e); } });
  const btns = [
    h('button', { class: 'btn primary block', onclick: () => fileIn.click() }, '⬆ ' + t('sync.import')),
    h('button', { class: 'btn block', style: 'margin-top:10px', onclick: () => { closeModal(); exportData(); } }, '⬇ ' + t('sync.export')),
    fileIn,
  ];
  if (cloudDataUrl()) {
    btns.unshift(h('button', { class: 'btn primary block', style: 'margin-bottom:10px',
      onclick: () => loadFromCloud() }, '☁ ' + t('sync.cloud')));
  }
  return btns;
}

function showSyncSheet() {
  openModal(t('sync.title'), [h('div', { class: 'muted small mb' }, t('sync.desc')), ...syncButtons()]);
}

Screens.installments = async () => {
  const wrap = h('div', { class: 'screen' });
  const comps = State.installments.map(it => ({ it, c: computeInstallment(it) }));
  const toYM = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const isCC = x => Number(x.it.totalMonths) < 36;
  // Mirror Home tab: active = startYM <= State.month <= endYM (same month filter)
  const dueThisMonth = x => x.it.startDate &&
    State.month >= x.it.startDate.slice(0, 7) && State.month <= toYM(x.c.endDate);
  const ccMonthly   = comps.filter(x => dueThisMonth(x) && isCC(x)).reduce((a, x) => a + x.c.perMonth, 0);
  const ccRemaining = comps.filter(x => isCC(x)).reduce((a, x) => a + x.c.remaining, 0);
  const loanMonthly   = comps.filter(x => dueThisMonth(x) && !isCC(x)).reduce((a, x) => a + x.c.perMonth, 0);
  const loanRemaining = comps.filter(x => !isCC(x)).reduce((a, x) => a + x.c.remaining, 0);
  wrap.append(h('div', { class: 'stat-grid two' }, [
    statCard(t('inst.ccMonthly'),      money(ccMonthly),    'inst'),
    statCard(t('inst.ccRemaining'),    money(ccRemaining),  'inst'),
    statCard(t('inst.loanMonthly'),    money(loanMonthly),  'loan'),
    statCard(t('inst.loanRemaining'),  money(loanRemaining),'due'),
  ]));
  wrap.append(h('button', { class: 'btn primary block', onclick: () => editInstallment() }, '＋ ' + t('inst.add')));
  wrap.append(h('div', { class: 'note-line' }, '⏱ ' + t('inst.autoNote')));

  const activeComps = comps.filter(x => x.c.left > 0 || toYM(x.c.endDate) >= State.month);
  const doneComps   = comps.filter(x => x.c.left <= 0 && toYM(x.c.endDate) < State.month);

  const renderCard = ({ it, c }, done) => h('div', { class: 'inst-card' + (done ? ' done' : ''), onclick: () => editInstallment(it) }, [
    h('div', { class: 'inst-head' }, [
      h('div', {}, [
        h('div', { class: 'row-title' }, `${it.bank}`),
        h('div', { class: 'row-sub' }, it.detail || ''),
      ]),
      h('div', { class: 'inst-perm' }, [
        h('div', { class: 'row-amt big' }, money(c.perMonth)),
        h('div', { class: 'row-sub' }, '/' + t('inst.monthsUnit')),
      ]),
    ]),
    h('div', { class: 'prog' }, h('div', { class: 'prog-fill', style: `width:${c.progress * 100}%` })),
    h('div', { class: 'inst-meta' }, [
      chip(`${c.paid}/${c.totalMonths} ${t('inst.monthsUnit')}`),
      done ? chip('✓ ' + t('inst.done'), 'ok') : chip(`${t('inst.left')} ${c.left} ${t('inst.monthsUnit')}`),
      done ? null : chip(`${t('inst.remaining')} ${money(c.remaining)}`),
      Number(it.interestRate) ? chip(`${it.interestRate}%`) : chip(t('inst.zeroPct'), 'ok'),
      chip(`${t('inst.end')} ${fmtDate(c.endDate)}`),
    ]),
    it.notes ? h('div', { class: 'inst-notes' }, it.notes) : null,
  ]);

  if (!activeComps.length) wrap.append(emptyNote(t('home.none')));
  activeComps.sort((a, b) => a.c.left - b.c.left).forEach(x => wrap.append(renderCard(x, false)));

  if (doneComps.length) {
    const details = h('details', { style: 'margin-top:12px' }, [
      h('summary', { style: 'cursor:pointer;padding:8px 0;color:var(--muted);font-size:.9em' },
        `▸ ${doneComps.length} completed installment${doneComps.length > 1 ? 's' : ''}`),
    ]);
    doneComps.sort((a, b) => b.c.endDate - a.c.endDate).forEach(x => details.append(renderCard(x, true)));
    wrap.append(details);
  }

  return wrap;
};

Screens.cards = async () => {
  const wrap = h('div', { class: 'screen' });
  wrap.append(h('button', { class: 'btn primary block', onclick: () => editCard() }, '＋ ' + t('cards.add')));
  if (!State.cards.length) wrap.append(emptyNote(t('home.none')));
  State.cards.forEach(c => {
    const txCount = State.transactions.filter(t => t.cardId === c.id).length;
    wrap.append(h('div', { class: 'row card-row', onclick: () => openCardDetail(c.id) }, [
      cardDot(c, true),
      h('div', { class: 'row-main' }, [
        h('div', { class: 'row-title' }, c.name),
        h('div', { class: 'row-sub' }, [
          c.dueDate ? `${t('cards.due')} ${c.dueDate}` : '',
          c.stmtDate ? ` · ${t('cards.stmt')} ${c.stmtDate}` : '',
          c.qr ? ' · 📷 QR' : '',
          txCount ? ` · ${txCount} ${t('tx.count')}` : '',
        ].join('')),
      ]),
      iconBtn('✎', () => editCard(c)),
      h('span', { class: 'chev' }, '›'),
    ]));
  });
  return wrap;
};

function openCardDetail(id) { State.detailCardId = id; go('cardDetail'); }

Screens.cardDetail = async () => {
  const wrap = h('div', { class: 'screen' });
  const c = cardById(State.detailCardId);
  if (!c) { wrap.append(emptyNote('—')); return wrap; }
  wrap.append(h('div', { class: 'detail-bar' }, [
    h('button', { class: 'btn small ghost', onclick: () => go('cards') }, '‹ ' + t('nav.cards')),
    h('button', { class: 'btn small', onclick: () => editCard(c) }, '✎ ' + t('common.edit')),
  ]));
  wrap.append(h('div', { class: 'row' }, [
    cardDot(c, true),
    h('div', { class: 'row-main' }, [
      h('div', { class: 'row-title' }, c.name),
      h('div', { class: 'row-sub' }, [
        c.dueDate ? `${t('cards.due')} ${c.dueDate}` : '',
        c.stmtDate ? ` · ${t('cards.stmt')} ${c.stmtDate}` : '',
      ].join('')),
    ]),
    c.qr ? h('button', { class: 'btn small ghost', onclick: () => showQR(c) }, '📷') : null,
  ]));

  const txs = State.transactions.filter(x => x.cardId === c.id);
  const months = [...new Set([
    ...txs.map(x => x.month),
    ...State.spending.filter(s => s.cardId === c.id).map(s => s.month),
  ])].filter(Boolean).sort().reverse();
  if (!months.length) { wrap.append(emptyNote(t('tx.none'))); return wrap; }

  for (const m of months) {
    const sp = State.spending.find(s => s.cardId === c.id && s.month === m);
    const mtx = txs.filter(x => x.month === m).sort((a, b) => txDateKey(b) - txDateKey(a));
    wrap.append(h('div', { class: 'tx-month' }, [
      h('span', {}, ymLabel(m)),
      sp ? h('strong', {}, money(sp.amount)) : h('span', {}, ''),
    ]));
    if (!mtx.length) wrap.append(h('div', { class: 'muted small tx-empty' }, t('tx.none')));
    mtx.forEach(x => {
      const credit = x.amount < 0;
      wrap.append(h('div', { class: 'tx-row' }, [
        h('div', { class: 'tx-date' }, (x.date || '').slice(0, 5)),
        h('div', { class: 'tx-desc' }, x.desc || ''),
        h('div', { class: 'tx-amt' + (credit ? ' credit' : '') }, (credit ? '+' : '') + money(Math.abs(x.amount))),
      ]));
    });
  }
  return wrap;
};
function txDateKey(x) {
  const m = (x.date || '').match(/(\d{2})\/(\d{2})/);
  return m ? Number(m[2]) * 100 + Number(m[1]) : 0;
}

Screens.settings = async () => {
  const wrap = h('div', { class: 'screen' });
  // language
  wrap.append(sectionTitle(t('settings.lang')));
  wrap.append(h('div', { class: 'seg' }, [
    segBtn('ไทย', LANG === 'th', () => switchLang('th')),
    segBtn('English', LANG === 'en', () => switchLang('en')),
  ]));
  // sync server
  wrap.append(sectionTitle(t('settings.sync')));
  wrap.append(h('div', { class: 'muted small mb' }, t('settings.syncDesc')));
  const syncInput = h('input', { class: 'input', type: 'url', inputmode: 'url', autocapitalize: 'off',
    autocorrect: 'off', spellcheck: 'false', placeholder: 'http://MacbookAir.local:8787',
    value: localStorage.getItem('syncUrl') || '' });
  wrap.append(syncInput);
  wrap.append(h('div', { class: 'two-col', style: 'margin-top:10px' }, [
    h('button', { class: 'btn primary', onclick: async () => {
      const v = syncInput.value.trim().replace(/\/+$/, '');
      if (v) localStorage.setItem('syncUrl', v); else localStorage.removeItem('syncUrl');
      // quick reachability check
      try {
        const ok = (await fetchTimeout(syncUrl('api/ping'), 3000)).ok;
        toast(ok ? '✓ ' + t('settings.syncOk') : '⚠ ' + t('settings.syncBad'));
      } catch (_) { toast('⚠ ' + t('settings.syncBad')); }
    } }, t('common.save')),
    h('button', { class: 'btn', onclick: () => { localStorage.removeItem('syncUrl'); syncInput.value = ''; toast('✓'); } }, t('settings.syncClear')),
  ]));

  // cloud data URL (for iPhone — fetches pre-built JSON from GitHub or any HTTPS URL)
  wrap.append(sectionTitle(t('settings.cloud')));
  wrap.append(h('div', { class: 'muted small mb' }, t('settings.cloudDesc')));
  const cloudInput = h('input', { class: 'input', type: 'url', inputmode: 'url', autocapitalize: 'off',
    autocorrect: 'off', spellcheck: 'false',
    placeholder: 'https://raw.githubusercontent.com/…/data.json',
    value: localStorage.getItem('cloudDataUrl') || '' });
  wrap.append(cloudInput);
  wrap.append(h('div', { class: 'two-col', style: 'margin-top:10px' }, [
    h('button', { class: 'btn primary', onclick: () => {
      const v = cloudInput.value.trim();
      if (v) localStorage.setItem('cloudDataUrl', v); else localStorage.removeItem('cloudDataUrl');
      toast('✓');
    }}, t('common.save')),
    h('button', { class: 'btn', onclick: () => { localStorage.removeItem('cloudDataUrl'); cloudInput.value = ''; toast('✓'); } }, t('settings.syncClear')),
  ]));

  // backup
  wrap.append(sectionTitle(t('settings.backup')));
  wrap.append(h('div', { class: 'muted small mb' }, t('settings.exportXlsxDesc')));
  wrap.append(h('button', { class: 'btn primary block', onclick: exportExcel }, '📊 ' + t('settings.exportXlsx')));
  wrap.append(h('div', { class: 'muted small mb', style: 'margin-top:10px' }, t('settings.exportDesc')));
  wrap.append(h('button', { class: 'btn block', onclick: exportData }, '⬇ ' + t('settings.export')));
  const fileIn = h('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: importData });
  wrap.append(h('button', { class: 'btn block', onclick: () => fileIn.click() }, '⬆ ' + t('settings.import')));
  wrap.append(fileIn);
  // danger
  wrap.append(sectionTitle(t('settings.danger')));
  wrap.append(h('div', { class: 'muted small mb' }, t('settings.dangerDesc')));
  wrap.append(h('button', { class: 'btn block', onclick: async () => { await DB.meta.set('seeded', false); await DB.wipe(); await seedIfNeeded(); await rerender('home'); toast('✓'); } }, '↻ ' + t('settings.reseed')));
  wrap.append(h('button', { class: 'btn danger block', onclick: async () => { if (confirm(t('common.confirmDelete'))) { await DB.wipe(); await rerender('home'); toast(t('common.deleted')); } } }, '🗑 ' + t('settings.danger')));
  // about
  wrap.append(sectionTitle(t('settings.about')));
  wrap.append(h('div', { class: 'muted small' }, t('settings.aboutText')));
  return wrap;
};

// ---------- small UI builders ----------
function monthPicker() {
  const prev = h('button', { class: 'mp-btn', onclick: () => shiftMonth(-1) }, '‹');
  const next = h('button', { class: 'mp-btn', onclick: () => shiftMonth(1) }, '›');
  const lbl = h('button', { class: 'mp-label', onclick: () => {
    const inp = h('input', { type: 'month', value: State.month, class: 'hidden-month' });
    inp.addEventListener('change', () => { State.month = inp.value; rerender(); });
    inp.click(); inp.showPicker && inp.showPicker();
  } }, ymLabel(State.month));
  return h('div', { class: 'monthpicker' }, [prev, lbl, next]);
}
function shiftMonth(d) {
  let [y, m] = State.month.split('-').map(Number);
  let idx = (m - 1) + d;                 // 0-indexed month + delta
  y += Math.floor(idx / 12);
  m = ((idx % 12) + 12) % 12 + 1;        // wrap, back to 1-indexed
  State.month = `${y}-${String(m).padStart(2, '0')}`;
  rerender();
}
function statCard(label, value, kind, onclick, full) {
  return h('div', { class: 'stat ' + (kind || '') + (onclick ? ' click' : ''), onclick,
    style: full ? 'grid-column:1/-1' : undefined }, [
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
  ]);
}
function sectionTitle(txt) { return h('h2', { class: 'section-title' }, txt); }
function emptyNote(txt) { return h('div', { class: 'empty' }, txt); }
function cardDot(c, big) { return h('span', { class: 'cdot' + (big ? ' big' : ''), style: `background:${c.color || '#888'}` }, (c.name || '?').slice(0, 1)); }
function chip(txt, kind) { return h('span', { class: 'chip ' + (kind || '') }, txt); }
function field(label, input) { return h('label', { class: 'field' }, [h('span', { class: 'field-label' }, label), input]); }
function iconBtn(txt, onclick) { return h('button', { class: 'icon-btn small', onclick: (e) => { e.stopPropagation(); onclick(e); } }, txt); }
function segBtn(txt, active, onclick) { return h('button', { class: 'seg-btn' + (active ? ' active' : ''), onclick }, txt); }

// ---------- modals ----------
function openModal(title, bodyEls, footerEls) {
  const host = $('#modalHost');
  host.innerHTML = '';
  const sheet = h('div', { class: 'sheet' }, [
    h('div', { class: 'sheet-head' }, [h('h3', {}, title), h('button', { class: 'icon-btn', onclick: closeModal }, '✕')]),
    h('div', { class: 'sheet-body' }, bodyEls),
    footerEls ? h('div', { class: 'sheet-foot' }, footerEls) : null,
  ]);
  host.append(h('div', { class: 'backdrop', onclick: closeModal }), sheet);
  host.classList.remove('hidden');
}
function closeModal() { const host = $('#modalHost'); host.classList.add('hidden'); host.innerHTML = ''; }

// Transactions for one card in one month (opened from the Pay tab).
function showMonthTx(card, month) {
  const txs = State.transactions.filter(x => x.cardId === card.id && x.month === month)
    .sort((a, b) => txDateKey(b) - txDateKey(a));
  const sp = State.spending.find(s => s.cardId === card.id && s.month === month);
  const body = [
    h('div', { class: 'tx-month' }, [h('span', {}, ymLabel(month)), sp ? h('strong', {}, money(sp.amount)) : h('span', {}, '')]),
  ];
  if (!txs.length) body.push(emptyNote(t('tx.none')));
  txs.forEach(x => {
    const credit = x.amount < 0;
    body.push(h('div', { class: 'tx-row' }, [
      h('div', { class: 'tx-date' }, (x.date || '').slice(0, 5)),
      h('div', { class: 'tx-desc' }, x.desc || ''),
      h('div', { class: 'tx-amt' + (credit ? ' credit' : '') }, (credit ? '+' : '') + money(Math.abs(x.amount))),
    ]));
  });
  openModal(card.name, body);
}

function showQR(c) {
  openModal(c.name, [
    h('div', { class: 'qr-wrap' }, [
      h('img', { src: c.qr, class: 'qr-img', alt: 'QR' }),
      h('div', { class: 'muted small center' }, t('pay.scanToPay')),
    ]),
  ], [
    h('button', { class: 'btn danger', onclick: async () => { c.qr = null; await DB.cards.save(c); closeModal(); await rerender(); toast('✓'); } }, '🗑 ' + t('cards.removeQR')),
    h('button', { class: 'btn', onclick: async () => { const d = await pickImage(); if (d) { c.qr = d; await DB.cards.save(c); await rerender(); showQR(c); toast('✓'); } } }, t('cards.changeQR')),
  ]);
}

async function editIncome() {
  const cur = await DB.income.get(State.month);
  const initItems = (cur && cur.items && cur.items.length) ? cur.items : [{ label: '', amount: cur ? cur.amount : 0 }];
  let items = initItems.map(x => ({ ...x }));

  const list = h('div', { class: 'income-list' });
  const totalEl = h('div', { class: 'income-total' });

  const updateTotal = () => {
    const total = items.reduce((a, x) => a + (parseFloat(x.amount) || 0), 0);
    totalEl.textContent = '= ' + money(total);
  };
  const renderItems = () => {
    list.innerHTML = '';
    items.forEach((item, idx) => {
      const labelInp = h('input', { class: 'input income-label-inp', type: 'text', value: item.label, placeholder: t('home.incomeLabel') });
      const amtInp = h('input', { class: 'input income-amt-inp', type: 'number', inputmode: 'decimal', value: item.amount || '', placeholder: '0.00' });
      labelInp.addEventListener('input', () => { item.label = labelInp.value; });
      // updateTotal only — do NOT call renderItems() here; rebuilding the list kills iOS keyboard focus
      amtInp.addEventListener('input', () => { item.amount = parseFloat(amtInp.value) || 0; updateTotal(); });
      const row = h('div', { class: 'income-row' }, [
        labelInp, amtInp,
        items.length > 1 ? h('button', { class: 'btn small ghost income-del', onclick: () => { items.splice(idx, 1); renderItems(); } }, '✕') : null,
      ]);
      list.append(row);
    });
    updateTotal();
  };
  renderItems();

  const addBtn = h('button', { class: 'btn ghost block', onclick: () => { items.push({ label: '', amount: 0 }); renderItems(); } }, t('home.addIncome'));

  openModal(t('home.setIncome') + ' · ' + ymLabel(State.month), [list, addBtn, totalEl], [
    h('button', { class: 'btn', onclick: closeModal }, t('common.cancel')),
    h('button', { class: 'btn primary', onclick: async () => {
      const total = items.reduce((a, x) => a + (parseFloat(x.amount) || 0), 0);
      await DB.income.save(State.month, total, items.filter(x => x.label || x.amount));
      closeModal(); await rerender();
    }}, t('common.save')),
  ]);
}

// Opens the device file/camera picker and resolves to a downscaled data URL (or null).
// Must run synchronously inside a user gesture (iOS requirement) — the input is
// created and clicked before the returned promise is awaited.
function pickImage() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => resolve(inp.files && inp.files[0] ? await readImageAsDataURL(inp.files[0]) : null);
    inp.click();
  });
}

// Upload / attach a scan-to-pay QR image to a card from anywhere.
async function uploadQRForCard(card) {
  const data = await pickImage();
  if (!data) return;
  card.qr = data;
  await DB.cards.save(card);
  await rerender();
  toast('✓');
}

function readImageAsDataURL(file, maxW = 720) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const cv = document.createElement('canvas');
        cv.width = img.width * scale; cv.height = img.height * scale;
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

function editCard(card) {
  const c = card || { name: '', bank: '', stmtDate: '', dueDate: '', qr: null, color: cardColor(State.cards.length) };
  const name = h('input', { class: 'input', value: c.name || '', placeholder: 'KBANK / SCB ...' });
  const stmt = h('input', { class: 'input', type: 'number', min: 1, max: 31, value: c.stmtDate || '', placeholder: t('cards.dayOfMonth') });
  const due = h('input', { class: 'input', type: 'number', min: 1, max: 31, value: c.dueDate || '', placeholder: t('cards.dayOfMonth') });
  let qrData = c.qr;
  const qrPreview = h('div', { class: 'qr-mini' }, qrData ? h('img', { src: qrData }) : h('span', { class: 'muted small' }, '—'));
  const qrFile = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async (e) => {
    if (e.target.files[0]) { qrData = await readImageAsDataURL(e.target.files[0]); qrPreview.innerHTML = ''; qrPreview.append(h('img', { src: qrData })); }
  } });

  const body = [
    field(t('cards.name'), name),
    h('div', { class: 'two-col' }, [field(t('cards.stmt'), stmt), field(t('cards.due'), due)]),
    field(t('cards.qr'), h('div', { class: 'qr-edit' }, [
      qrPreview,
      h('div', { class: 'qr-edit-btns' }, [
        h('button', { class: 'btn small', onclick: () => qrFile.click() }, qrData ? t('cards.changeQR') : t('cards.uploadQR')),
        qrData ? h('button', { class: 'btn small ghost', onclick: () => { qrData = null; qrPreview.innerHTML = '<span class="muted small">—</span>'; } }, t('cards.removeQR')) : null,
      ]),
      qrFile,
    ])),
  ];
  const foot = [
    card ? h('button', { class: 'btn danger', onclick: async () => { if (confirm(t('common.confirmDelete'))) { await DB.cards.remove(c.id); closeModal(); await rerender(); } } }, t('common.delete')) : null,
    h('button', { class: 'btn', onclick: closeModal }, t('common.cancel')),
    h('button', { class: 'btn primary', onclick: async () => {
      if (!name.value.trim()) { toast(t('common.required')); return; }
      await DB.cards.save({ ...c, name: name.value.trim(), bank: name.value.trim(),
        stmtDate: stmt.value ? Number(stmt.value) : null, dueDate: due.value ? Number(due.value) : null, qr: qrData });
      closeModal(); await rerender();
    } }, t('common.save')),
  ];
  openModal(card ? t('common.edit') : t('cards.add'), body, foot);
}

function editInstallment(it) {
  const x = it || { bank: '', detail: '', startDate: todayYM() + '-01', principal: '', totalMonths: 6, interestRate: 0, manualPaid: '' };
  const bank = h('input', { class: 'input', value: x.bank || '', placeholder: 'SCB / KBANK ...' });
  const detail = h('input', { class: 'input', value: x.detail || '', placeholder: t('inst.detail') });
  const start = h('input', { class: 'input', type: 'date', value: (x.startDate || '').slice(0, 10) });
  const principal = h('input', { class: 'input', type: 'number', inputmode: 'decimal', value: x.principal || '', placeholder: '0.00' });
  const months = h('select', { class: 'input' }, [3, 4, 6, 9, 10, 12, 18, 24, 36].map(m => h('option', { value: m, selected: Number(x.totalMonths) === m }, m + ' ' + t('inst.monthsUnit'))));
  const rate = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', value: x.interestRate || 0, placeholder: '0' });
  const manual = h('input', { class: 'input', type: 'number', min: 0, value: x.manualPaid ?? '', placeholder: 'auto' });
  const notes = h('textarea', { class: 'input', rows: 3, placeholder: t('inst.notesPlaceholder'), style: 'resize:none' });
  notes.value = x.notes || '';

  const preview = h('div', { class: 'inst-preview' });
  function upd() {
    const tmp = { startDate: start.value, principal: parseFloat(principal.value) || 0, totalMonths: Number(months.value), interestRate: parseFloat(rate.value) || 0, manualPaid: manual.value === '' ? null : Number(manual.value) };
    const c = computeInstallment(tmp);
    preview.innerHTML = '';
    preview.append(
      h('div', { class: 'pv-row' }, [h('span', {}, t('inst.permonth')), h('strong', {}, money(c.perMonth))]),
      h('div', { class: 'pv-row' }, [h('span', {}, t('inst.total')), h('span', {}, money(c.total))]),
      h('div', { class: 'pv-row' }, [h('span', {}, `${t('inst.paid')} / ${t('inst.left')}`), h('span', {}, `${c.paid} / ${c.left} ${t('inst.monthsUnit')}`)]),
      h('div', { class: 'pv-row' }, [h('span', {}, t('inst.remaining')), h('strong', {}, money(c.remaining))]),
      h('div', { class: 'pv-row' }, [h('span', {}, t('inst.end')), h('span', {}, fmtDate(c.endDate))]),
    );
  }
  [start, principal, months, rate, manual].forEach(el => el.addEventListener('input', upd));
  setTimeout(upd, 0);

  const body = [
    h('div', { class: 'two-col' }, [field(t('inst.bank'), bank), field(t('inst.months'), months)]),
    field(t('inst.detail'), detail),
    h('div', { class: 'two-col' }, [field(t('inst.principal') + ' (฿)', principal), field(t('inst.rate'), rate)]),
    h('div', { class: 'two-col' }, [field(t('inst.start'), start), field(t('inst.paid') + ' (' + t('common.optional') + ')', manual)]),
    field(t('inst.notes'), notes),
    preview,
  ];
  const foot = [
    it ? h('button', { class: 'btn danger', onclick: async () => { if (confirm(t('common.confirmDelete'))) { await DB.installments.remove(x.id); closeModal(); await rerender(); } } }, t('common.delete')) : null,
    h('button', { class: 'btn', onclick: closeModal }, t('common.cancel')),
    h('button', { class: 'btn primary', onclick: async () => {
      if (!bank.value.trim() || !principal.value) { toast(t('common.required')); return; }
      await DB.installments.save({ ...x, bank: bank.value.trim(), detail: detail.value.trim(),
        startDate: start.value, principal: parseFloat(principal.value), totalMonths: Number(months.value),
        interestRate: parseFloat(rate.value) || 0, manualPaid: manual.value === '' ? null : Number(manual.value),
        perMonth: null, notes: notes.value.trim() || null });
      closeModal(); await rerender();
    } }, t('common.save')),
  ];
  openModal(it ? t('common.edit') : t('inst.add'), body, foot);
}

// ---------- export to Excel ----------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function exportExcel() {
  const cards = State.cards;
  const spending = State.spending;
  const incomeList = await DB.income.all();
  const incomeByMonth = Object.fromEntries(incomeList.map(i => [i.month, i.amount]));

  // ---- Sheet 1: Paid (CARD) — month x card matrix (mirrors original) ----
  const months = Array.from(new Set([
    ...spending.map(s => s.month), ...incomeList.map(i => i.month),
  ])).sort();
  const amt = (cardId, month) => spending.filter(s => s.cardId === cardId && s.month === month).reduce((a, s) => a + (s.amount || 0), 0);

  const paidRows = [];
  paidRows.push(['INCOME', 'Month', ...cards.map(c => c.name), 'TOTAL']);
  paidRows.push(['Salary', 'stmt date', ...cards.map(c => c.stmtDate || ''), '']);
  paidRows.push(['', 'due date', ...cards.map(c => c.dueDate || ''), '']);
  for (const m of months) {
    const row = [incomeByMonth[m] ?? '', m];
    let total = 0;
    for (const c of cards) { const v = amt(c.id, m); row.push(v || ''); total += v; }
    row.push(total || '');
    paidRows.push(row);
  }

  // ---- Sheet 2: Installment (computed live) ----
  const instRows = [['Bank', 'Detail', 'Start', 'Amount', 'Per month', 'Interest %', 'Total Months', 'Paid', 'Left Month', 'Remaining', 'Last payment']];
  for (const it of State.installments) {
    const c = computeInstallment(it);
    instRows.push([
      it.bank || '', it.detail || '', (it.startDate || '').slice(0, 10),
      Number(it.principal) || 0, round2(c.perMonth), Number(it.interestRate) || 0,
      c.totalMonths, c.paid, c.left, round2(c.remaining),
      c.endDate.toISOString().slice(0, 10),
    ]);
  }

  // ---- Sheet 3: Spending (flat list) ----
  const spendRows = [['Card', 'Month', 'Amount', 'Note', 'Paid', 'Paid date']];
  spending.slice().sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
    .forEach(s => {
      const c = cardById(s.cardId);
      spendRows.push([c ? c.name : '?', s.month, Number(s.amount) || 0, s.note || '',
        s.paid ? 'Yes' : 'No', s.paidDate ? s.paidDate.slice(0, 10) : '']);
    });

  // ---- Sheet 4: Cards ----
  const cardRows = [['Card / Bank', 'Statement day', 'Due day', 'Has QR', 'Total spent']];
  for (const c of cards) {
    const total = spending.filter(s => s.cardId === c.id).reduce((a, s) => a + s.amount, 0);
    cardRows.push([c.name, c.stmtDate || '', c.dueDate || '', c.qr ? 'Yes' : 'No', round2(total)]);
  }

  const blob = XLSX.write([
    { name: 'Paid (CARD)', rows: paidRows },
    { name: 'Installment', rows: instRows },
    { name: 'Spending', rows: spendRows },
    { name: 'Cards', rows: cardRows },
  ]);
  downloadBlob(blob, `card-notes-${todayYM()}.xlsx`);
  toast('✓');
}
const round2 = (n) => Math.round((n || 0) * 100) / 100;

// ---------- backup ----------
async function exportData() {
  const data = await DB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `card-notes-backup-${todayYM()}.json` });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('✓');
}
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.cards && !data.installments) throw new Error('bad');
    await DB.importAll(data);
    await DB.meta.set('lastSync', new Date().toISOString());
    await rerender('home');
    toast('✓');
  } catch (_) { toast('✗ invalid file'); }
  e.target.value = '';
}

// ---------- navigation / render ----------
async function go(screen) { State.screen = screen; await rerender(screen); }
async function rerender(screen) {
  const isNavigation = screen && screen !== State.screen;
  const savedScroll = isNavigation ? 0 : view.scrollTop;
  if (screen) State.screen = screen;
  await refresh();
  applyStaticI18n();
  $('#screenTitle').textContent = State.screen === 'cardDetail'
    ? (cardById(State.detailCardId)?.name || t('tx.title'))
    : t('title.' + State.screen);
  $$('#tabbar .tab').forEach(b => b.classList.toggle('active', b.dataset.screen === State.screen));
  view.innerHTML = '';
  const el = await (Screens[State.screen] || Screens.home)();
  view.append(el);
  if (State.scrollToCardId && State.screen === 'pay') {
    const target = view.querySelector(`[data-card-id="${State.scrollToCardId}"]`);
    if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.classList.add('highlight'); setTimeout(() => target.classList.remove('highlight'), 1500); }
    State.scrollToCardId = null;
  } else {
    view.scrollTop = savedScroll;
  }
}
function applyStaticI18n() {
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $('#langBtn').textContent = LANG === 'th' ? 'TH' : 'EN';
  document.documentElement.lang = LANG;
}
async function switchLang(l) { setLang(l); await rerender(); }

// One-time data migrations for installs that were seeded before a rule changed.
async function runMigrations() {
  const m = await DB.meta.get('paidThrough2026-05');
  if (m && m.value) return;
  const all = await DB.spending.all();
  for (const s of all) {
    if (s.month <= '2026-05' && !s.paid) {
      s.paid = true;
      s.paidDate = s.paidDate || `${s.month}-28T00:00:00.000Z`;
      await DB.spending.save(s);
    }
  }
  await DB.meta.set('paidThrough2026-05', true);
}

// ---------- boot ----------
async function boot() {
  await DB.open();
  await seedIfNeeded();
  await runMigrations();
  $$('#tabbar .tab').forEach(b => b.addEventListener('click', () => {
    if (b.id === 'syncTab') return triggerSync();
    go(b.dataset.screen);
  }));
  $('#langBtn').addEventListener('click', () => switchLang(LANG === 'th' ? 'en' : 'th'));
  $('#settingsBtn').addEventListener('click', () => go('settings'));
  await rerender('home');
}
boot();
