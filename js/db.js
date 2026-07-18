/* IndexedDB wrapper — on-device free storage */
const DB = (() => {
  const NAME = 'cardNotesPay';
  const VERSION = 2;
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cards'))
          db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('spending')) {
          const s = db.createObjectStore('spending', { keyPath: 'id', autoIncrement: true });
          s.createIndex('byCardMonth', ['cardId', 'month']);
          s.createIndex('byMonth', 'month');
        }
        if (!db.objectStoreNames.contains('income'))
          db.createObjectStore('income', { keyPath: 'month' });
        if (!db.objectStoreNames.contains('transactions')) {
          const tx = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          tx.createIndex('byCardMonth', ['cardId', 'month']);
          tx.createIndex('byCard', 'cardId');
        }
        if (!db.objectStoreNames.contains('installments'))
          db.createObjectStore('installments', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('meta'))
          db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode = 'readonly') {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }
  const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function getAll(store) { return done((await tx(store)).getAll()); }
  async function get(store, key) { return done((await tx(store)).get(key)); }
  async function put(store, val) { return done((await tx(store, 'readwrite')).put(val)); }
  async function add(store, val) { return done((await tx(store, 'readwrite')).add(val)); }
  async function del(store, key) { return done((await tx(store, 'readwrite')).delete(key)); }
  async function clear(store) { return done((await tx(store, 'readwrite')).clear()); }

  // ---- High level ----
  const cards = {
    all: () => getAll('cards'),
    get: (id) => get('cards', id),
    save: (c) => c.id ? put('cards', c) : add('cards', c),
    remove: (id) => del('cards', id),
  };
  const spending = {
    all: () => getAll('spending'),
    save: (s) => s.id ? put('spending', s) : add('spending', s),
    remove: (id) => del('spending', id),
    forMonth: async (month) => (await getAll('spending')).filter(s => s.month === month),
  };
  const income = {
    all: () => getAll('income'),
    get: (month) => get('income', month),
    save: (month, amount, items) => put('income', { month, amount, items: items || [] }),
  };
  const installments = {
    all: () => getAll('installments'),
    save: (i) => i.id ? put('installments', i) : add('installments', i),
    remove: (id) => del('installments', id),
  };
  const transactions = {
    all: () => getAll('transactions'),
    forCard: async (cardId) => (await getAll('transactions')).filter(t => t.cardId === cardId),
  };
  const meta = {
    get: (k) => get('meta', k),
    set: (k, v) => put('meta', { key: k, value: v }),
  };

  async function exportAll() {
    return {
      _app: 'CardNotesPay', _version: VERSION, _exportedAt: new Date().toISOString(),
      cards: await getAll('cards'),
      spending: await getAll('spending'),
      transactions: await getAll('transactions'),
      income: await getAll('income'),
      installments: await getAll('installments'),
      meta: await getAll('meta'),
    };
  }

  const STORES = ['cards', 'spending', 'transactions', 'income', 'installments', 'meta'];
  async function importAll(data) {
    // Preserve paid status before wiping spending.
    // Match by cardName+month (robust against cardId shifts on re-sync).
    const oldCards = await getAll('cards');
    const oldSpending = await getAll('spending');
    const cardNameById = Object.fromEntries(oldCards.map(c => [c.id, c.name]));
    const paidMap = {};
    for (const s of oldSpending) {
      if (s.paid) paidMap[`${cardNameById[s.cardId]}|${s.month}`] = s.paidDate || null;
    }

    // Cards, spending, transactions, meta: full replace
    for (const store of ['cards', 'spending', 'transactions', 'meta']) {
      await clear(store);
      for (const row of (data[store] || [])) await put(store, row);
    }

    // Restore paid status — sync data always has paid=false for current months
    const newCards = await getAll('cards');
    const cardNameByNewId = Object.fromEntries(newCards.map(c => [c.id, c.name]));
    const newSpending = await getAll('spending');
    for (const s of newSpending) {
      const key = `${cardNameByNewId[s.cardId]}|${s.month}`;
      if (!s.paid && paidMap.hasOwnProperty(key)) {
        s.paid = true;
        s.paidDate = paidMap[key];
        await put('spending', s);
      }
    }
    // Income: only overwrite if incoming data has records
    // (Mac sync always sends income:[] — preserve manually-entered income)
    if (data.income && data.income.length > 0) {
      await clear('income');
      for (const row of data.income) await put('income', row);
    }
    // Installments: replace but carry over user-entered notes by stable key
    // (Mac sync never has notes — match by bank+detail+startDate+totalMonths)
    {
      const existing = await getAll('installments');
      const notesByKey = {};
      for (const inst of existing) {
        if (inst.notes) {
          const key = `${inst.bank}|${inst.detail}|${inst.startDate}|${inst.totalMonths}`;
          notesByKey[key] = inst.notes;
        }
      }
      await clear('installments');
      for (const row of (data.installments || [])) {
        const key = `${row.bank}|${row.detail}|${row.startDate}|${row.totalMonths}`;
        if (notesByKey[key]) row.notes = notesByKey[key];
        await put('installments', row);
      }
    }
  }

  async function wipe() {
    for (const store of STORES) await clear(store);
  }

  return { open, cards, spending, transactions, income, installments, meta, exportAll, importAll, wipe, getAll, clear };
})();
