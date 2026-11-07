'use strict';
/* Kompte mobile : mêmes données que l'application PC, via Supabase.
   Les calculs (échéances, solde) reprennent exactement ceux de kompte.py. */

const SUPABASE_URL = 'https://fidtxsobgeadwjgvucho.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SMR6vAvqlnPqPkxTJxBdiQ_P6KboZZE'; // clé publique (protégée par RLS)
const POLL_MS = 15000;
const PAGE = 1000;

const TABLES = {
  comptes: ['id', 'id,name'],
  savings_accounts: ['id', 'id,compte_id,name,opening_cents'],
  items: ['id', 'id,compte_id,title,kind,category,total_cents,first_date,installments,frequency,created_at,vers_compte_id'],
  fixed_groups: ['id', 'id,compte_id,title,category,kind,day_of_month,vers_compte_id'],
  notes: ['id', 'id,compte_id,title,body,item_id,group_id,created_at,updated_at'],
  fixed_versions: ['id', 'id,group_id,amount_cents,start_month,end_month,day_of_month'],
  fixed_overrides: ['group_id', 'group_id,month,amount_cents'],
  savings_transfers: ['item_id', 'item_id,account_id'],
  fixed_savings_transfers: ['group_id', 'group_id,account_id'],
};

const DEFAULT_COLORS = {
  Revenus: '#4ADE80', Logement: '#6478D8', Factures: '#EAB308', Alimentation: '#F97316',
  Transport: '#A855F7', 'Véhicule': '#94A3B8', Loisirs: '#22D3EE', Shopping: '#EC4899',
  Abonnements: '#818CF8', 'Santé': '#FB7185', Animaux: '#D4A373', Vacances: '#2DD4BF',
  Cadeaux: '#F472B6', 'Épargne': '#10B981', Divers: '#9CA3AF',
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                'septembre', 'octobre', 'novembre', 'décembre'];

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const state = {
  all: null,        // tables + kv (réglages partagés), tous comptes confondus
  data: null,       // les mêmes, réduites au compte ouvert
  compte: null,     // numéro du compte ouvert (null : écran d'accueil)
  version: null,
  tab: 'dashboard',
  selected: todayIso().slice(0, 7),
  current: null,    // mois en cours à la dernière actualisation de l'écran
  query: '',
  cats: [],         // catégories choisies dans le filtre des transactions
  catsOpen: false,
  loading: false,
  syncError: false,
  email: '',
  checked: false,  // données en ligne lues au moins une fois depuis l'ouverture
};

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

// ------------------------------------------------------------------ outils
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad(n) { return String(n).padStart(2, '0'); }
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function monthShift(iso, offset) {
  const y = +iso.slice(0, 4), mo = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const total = y * 12 + mo - 1 + offset;
  const ny = Math.floor(total / 12), nm = total - ny * 12 + 1;
  return `${String(ny).padStart(4, '0')}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}
function nextMonth(ym) { return monthShift(ym + '-01', 1).slice(0, 7); }
function dueInMonth(ym, day) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  return `${ym}-${pad(Math.min(day, daysInMonth(y, m)))}`;
}
function frDate(iso) { return `${iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`; }
function monthLabel(ym) { const m = MONTHS[+ym.slice(5, 7) - 1]; return m[0].toUpperCase() + m.slice(1) + ' ' + ym.slice(0, 4); }
function euro(c) {
  const a = Math.abs(c);
  const whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${c < 0 ? '-' : ''}${whole},${pad(a % 100)} €`;
}
function amountText(c) { return `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)},${pad(Math.abs(c) % 100)}`; }
function utcStamp() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

/** Identifiant unique côté téléphone (le PC utilise les mêmes). */
let lastId = 0;
function newId() {
  lastId = Math.max(lastId + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
  return lastId;
}

/** Même règle que parse_amount() du PC : 1234,56 · 1 234,56 · 1.234,56 · 12 €. Renvoie des centimes. */
function parseAmount(value) {
  let text = String(value).trim();
  for (const junk of ['€', ' ', ' ', ' ', "'", '’']) text = text.split(junk).join('');
  if (!/^[+-]?[0-9.,]*[0-9][0-9.,]*$/.test(text)) throw new Error('Montant invalide.');
  let sign = '';
  if ('+-'.includes(text[0])) { sign = text[0]; text = text.slice(1); }
  const count = (c) => text.split(c).length - 1;
  let sep;
  if (text.includes(',') && text.includes('.')) {
    sep = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    text = text.split(sep === ',' ? '.' : ',').join('');
  } else if (count(',') > 1) { text = text.split(',').join(''); sep = null; }
  else if (count('.') > 1) { text = text.split('.').join(''); sep = null; }
  else if (/^\d{1,3}\.\d{3}$/.test(text)) { text = text.replace('.', ''); sep = null; } // « 1.500 » = mille cinq cents
  else sep = text.includes(',') ? ',' : text.includes('.') ? '.' : null;
  let whole = text, decimals = '';
  if (sep) {
    const i = text.indexOf(sep);
    whole = text.slice(0, i); decimals = text.slice(i + 1);
    if (decimals.includes(sep) || !/^\d+$/.test(decimals) || (whole && !/^\d+$/.test(whole))) throw new Error('Montant invalide.');
    if (decimals.length > 2) throw new Error('Maximum 2 chiffres après la virgule.');
  }
  whole = whole || '0';
  if (!/^\d+$/.test(whole) || whole.replace(/^0+/, '').length > 8) throw new Error('Montant invalide.');
  const cents = parseInt(whole, 10) * 100 + (decimals ? parseInt(decimals.padEnd(2, '0'), 10) : 0);
  if (cents >= 100000000 * 100) throw new Error('Montant invalide.');
  return sign === '-' ? -cents : cents;
}
function positiveCents(value) {
  let c;
  try { c = parseAmount(value); } catch (e) {
    if (e.message.includes('virgule')) throw e;
    throw new Error('Saisis un montant positif valide.');
  }
  if (c <= 0) throw new Error('Saisis un montant positif valide.');
  return c;
}

// --------------------------------------------------------------- catégories
function categories() {
  const saved = state.data && state.data.kv.categories;
  const list = [];
  if (saved && Array.isArray(saved.categories)) {
    const hasFlag = saved.categories.some((c) => c && typeof c === 'object' && 'savings' in c);
    for (const c of saved.categories) {
      const name = String(c.name || '').trim();
      if (!name || list.some((x) => x.name === name) || !/^#[0-9a-fA-F]{6}$/.test(String(c.color))) continue;
      list.push({ name, color: c.color, icon: c.icon || 'Divers', savings: hasFlag ? !!c.savings : name === 'Épargne' });
    }
  }
  if (list.length) return list;
  return Object.entries(DEFAULT_COLORS).map(([name, color]) => ({ name, color, icon: name, savings: name === 'Épargne' }));
}
function category(name) {
  return categories().find((c) => c.name === name) || { name, color: '#9CA3AF', icon: 'Divers', savings: false };
}
function iconSlug(icon) { return icon.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function catIcon(name) {
  const c = category(name);
  return `<span class="cat" style="--c:${c.color};--i:url('icons/cat/${iconSlug(c.icon)}.png')"></span>`;
}
// ------------------------------------------- carte à débit différé (= kompte.py)
// Un achat carte peut être prélevé jusqu'à ~2 mois après sa date.
const DEFERRED_LOOKBACK = 70;
let cardCache = { raw: undefined, map: {} };
/** {compte: {enabled, cutoff, debit, items: Set}} lu dans le réglage partagé « card ». */
function cardSettings() {
  const raw = state.all && state.all.kv.card;
  if (raw === cardCache.raw) return cardCache.map;
  const map = {};
  if (raw && typeof raw === 'object') {
    for (const [compte, c] of Object.entries(raw)) {
      if (!c || typeof c !== 'object') continue;
      const cutoff = Number(c.cutoff), debit = Number(c.debit);
      if (!Number.isInteger(cutoff) || !Number.isInteger(debit) || cutoff < 1 || cutoff > 28 || debit < 1 || debit > 31) continue;
      map[compte] = { enabled: c.enabled !== false, cutoff, debit,
                      items: new Set((Array.isArray(c.items) ? c.items : []).map(Number)) };
    }
  }
  cardCache = { raw, map };
  return map;
}
/** Réglage de la carte du compte, ou null s'il n'a pas de carte à débit différé. */
function cardConf(compteId) {
  const c = cardSettings()[compteId];
  return c && c.enabled ? c : null;
}
/** Vrai pour une dépense payée avec la carte à débit différé de son compte. */
function isCard(row) {
  if (row.id < 0 || row.kind !== 'Dépense') return false;
  const c = cardConf(row.compte_id);
  return !!c && c.items.has(row.id);
}
/** Dernier jour du relevé carte qui contient cette date (le jour d'arrêté). */
function cardCycleEnd(c, due) {
  const end = dueInMonth(due.slice(0, 7), c.cutoff);
  return due <= end ? end : dueInMonth(nextMonth(due.slice(0, 7)), c.cutoff);
}
/** Premier jour de prélèvement après l'arrêté du relevé. */
function cardDebit(c, due) {
  const end = cardCycleEnd(c, due);
  const debit = dueInMonth(end.slice(0, 7), c.debit);
  return debit > end ? debit : dueInMonth(nextMonth(end.slice(0, 7)), c.debit);
}
function deferredActive() {
  return Object.values(cardSettings()).some((c) => c.enabled && c.items.size);
}

/** Date où l'opération touche le solde : son échéance, ou pour un achat carte la date de prélèvement de son relevé. */
function debitDate(row, due) {
  return isCard(row) ? cardDebit(cardConf(row.compte_id), due) : due;
}

/** Échéances qui touchent le solde sur [start, end). */
function balanceEvents(start, end) {
  if (start >= end) return [];
  const first = deferredActive() ? addDays(start, -DEFERRED_LOOKBACK) : start;
  return occurrences(first, end).filter((e) => {
    const debit = debitDate(e.row, e.due);
    return start <= debit && debit < end;
  });
}

/** Opérations déjà passées mais pas encore prélevées : [[date du prélèvement, somme signée]]. */
function pendingByDate() {
  if (!deferredActive()) return [];
  const tomorrow = addDays(todayIso(), 1);
  const totals = {};
  for (const e of occurrences(addDays(todayIso(), -DEFERRED_LOOKBACK), tomorrow)) {
    const debit = debitDate(e.row, e.due);
    if (debit >= tomorrow) totals[debit] = (totals[debit] || 0) + signed(e);
  }
  return Object.entries(totals).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
function pendingDebits() { return pendingByDate().reduce((sum, [, v]) => sum + v, 0); }

/** Argent réellement disponible jusqu'à la fin de la période en cours :
    solde − achats pas encore prélevés − dépenses prévues d'ici là. */
function availableMoney(balance) {
  const tomorrow = addDays(todayIso(), 1);
  const periodEnd = monthPeriod(currentMonth())[1];
  let planned = 0;
  for (const e of occurrences(tomorrow, periodEnd)) if (e.row.kind === 'Dépense') planned += e.amount;
  return [balance + pendingDebits() - planned, addDays(periodEnd, -1)];
}

/** Ce qui restait à la fin du mois dernier : l'argent réel d'aujourd'hui (solde − achats pas encore prélevés)
    moins les opérations du mois en cours déjà passées. */
function carryOver(balance) {
  const today = todayIso();
  let passed = 0;
  for (const e of occurrences(...monthPeriod(currentMonth()))) if (e.due <= today) passed += signed(e);
  return balance + pendingDebits() - passed;
}

// ----------------------------------------------- « File ton salaire ! » (= kompte.py)
/** Jour où la paie est demandée : le début du mois, ou 3 jours après s'il tombe un samedi ou un dimanche. */
function payReminderDay(first) {
  const weekday = new Date(`${first}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? addDays(first, 3) : first;
}
/** Revenus fixes du compte ouvert versés le jour où commence son mois (la paie), pour ce mois civil. */
function salaryGroups(month) {
  const D = state.data, day = monthStart();
  const out = [];
  for (const g of D.fixed_groups) {
    if (g.kind !== 'Revenu' || g.received) continue;
    const v = D.fixed_versions.filter((x) => x.group_id === g.id && x.start_month <= month && (!x.end_month || x.end_month > month))
      .sort((a, b) => (a.start_month < b.start_month ? 1 : -1))[0];
    if (!v || v.day_of_month !== day) continue;
    const o = D.fixed_overrides.find((x) => x.group_id === g.id && x.month === month);
    out.push({ group: g, amount: o ? o.amount_cents : v.amount_cents });
  }
  return out;
}
/** La demande de paie à afficher maintenant, ou null. */
function payReminder() {
  // Seulement après une actualisation : le cache peut ignorer une paie renseignée sur le PC.
  if (!state.checked) return null;
  const ym = currentMonth();
  if (((state.all.kv.pay || {})[state.compte]) === ym || state.paySnoozed === `${state.compte}|${ym}`) return null;
  const first = monthPeriod(ym)[0];
  if (todayIso() < payReminderDay(first)) return null;
  const groups = salaryGroups(first.slice(0, 7));
  return groups.length ? { ym, first, month: first.slice(0, 7), groups } : null;
}
function paySheet(reminder) {
  state.paySnoozed = `${state.compte}|${reminder.ym}`; // « Plus tard » : à la prochaine ouverture
  openSheet(`
    <h3>File ton salaire !</h3>
    <p class="hint" style="text-align:center">Combien as-tu reçu pour ta paie du ${+reminder.first.slice(8, 10)} ${MONTHS[+reminder.first.slice(5, 7) - 1]} ?<br>
      Le montant remplace celui prévu, pour ce mois seulement.</p>
    ${reminder.groups.map((x, i) => `<label class="field" for="p-${i}">${esc(x.group.title)} (€)</label>
      <input class="input big" id="p-${i}" inputmode="decimal" autocomplete="off" value="${amountText(x.amount)}">`).join('')}
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Plus tard</button>
      <button type="submit" class="primary">Valider</button>
    </div>`, async (form) => {
    const values = reminder.groups.map((x, i) => [x.group, positiveCents(form.querySelector(`#p-${i}`).value)]);
    for (const [g, amount] of values) {
      await check(sb.from('fixed_overrides').upsert({ group_id: g.id, month: reminder.month, amount_cents: amount },
                                                     { onConflict: 'group_id,month' }));
    }
    const value = { ...(state.all.kv.pay || {}), [state.compte]: reminder.ym };
    await check(sb.from('kv_settings').upsert({ key: 'pay', value }, { onConflict: 'user_id,key' }));
    state.all.kv.pay = value;
  });
}

// ------------------------------------------- repas : midi ou restaurant (= kompte.py)
// Réglage partagé « meal_tags » : {transaction: 'midi' | 'resto'}, pour la catégorie Alimentation.
const MEALS = { midi: 'Repas du midi', resto: 'Restaurant' };
const MEAL_CATEGORY = 'Alimentation';
function mealOf(itemId) {
  const tags = state.all && state.all.kv.meal_tags;
  const tag = tags && typeof tags === 'object' ? tags[itemId] : null;
  return MEALS[tag] ? tag : null;
}
async function setMeal(itemId, tag) {
  const raw = state.all.kv.meal_tags && typeof state.all.kv.meal_tags === 'object' ? state.all.kv.meal_tags : {};
  if ((raw[itemId] || null) === tag) return;
  const value = { ...raw };
  if (tag) value[itemId] = tag; else delete value[itemId];
  state.all.kv.meal_tags = value;
  await check(sb.from('kv_settings').upsert({ key: 'meal_tags', value }, { onConflict: 'user_id,key' }));
}
/** Totaux du mois : {midi, resto} (dépenses Alimentation marquées). */
function mealTotals(events) {
  const totals = { midi: 0, resto: 0 };
  for (const e of events) {
    const tag = e.row.id > 0 && e.row.kind === 'Dépense' && e.row.category === MEAL_CATEGORY ? mealOf(e.row.id) : null;
    if (tag) totals[tag] += e.amount;
  }
  return totals;
}

/** Enregistre le réglage « card » (partagé avec le PC). */
async function saveCard(value) {
  state.all.kv.card = value;
  await check(sb.from('kv_settings').upsert({ key: 'card', value }, { onConflict: 'user_id,key' }));
}
/** Le réglage « card » avec cette transaction marquée (ou non) comme payée par carte. */
function cardWithItem(itemId, paid) {
  const raw = (state.all.kv.card && typeof state.all.kv.card === 'object') ? state.all.kv.card : {};
  const mine = raw[state.compte];
  if (!mine) return null;
  const items = new Set((mine.items || []).map(Number));
  if (items.has(itemId) === paid) return null;
  if (paid) items.add(itemId); else items.delete(itemId);
  return { ...raw, [state.compte]: { ...mine, items: [...items].sort((a, b) => a - b) } };
}

/** Résultat d'une ligne de note finissant par « = » : mêmes règles que quick_calc() du PC. */
function quickCalc(line) {
  const match = line.match(/([0-9€.,()+\-*/xX×÷%\s]+)=\s*$/);
  if (!match) return null;
  const text = match[1].replace(/[\s€]/g, '').replace(/,/g, '.').replace(/[xX×]/g, '*').replace(/÷/g, '/')
    .replace(/^[*/+.%)]+/, '');
  if (!/[0-9)%][+\-*/]/.test(text)) return null;
  const tokens = text.match(/\d+\.?\d*|\.\d+|[-+*/()%]/g) || [];
  if (tokens.join('') !== text) return null;
  let at = 0;
  const peek = () => tokens[at];
  const fail = () => { throw new Error('calcul'); };
  const factor = () => {
    const token = peek();
    let value;
    if (token === '-') { at += 1; return -factor(); }
    if (token === '(') {
      at += 1;
      value = expression();
      if (tokens[at++] !== ')') fail();
    } else if (token === undefined || '+*/)%'.includes(token)) fail();
    else { value = parseFloat(token); at += 1; }
    while (peek() === '%') { at += 1; value /= 100; }
    return value;
  };
  const term = () => {
    let value = factor();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[at++];
      const right = factor();
      if (op === '/' && right === 0) fail();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  function expression() {
    let value = term();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[at++];
      value = op === '+' ? value + term() : value - term();
    }
    return value;
  }
  let value;
  try { value = expression(); } catch (e) { return null; }
  if (at !== tokens.length || !(Math.abs(value) < 1e15)) return null;
  const cents = Math.floor(Math.abs(value) * 100 + 0.5);
  const sign = value < 0 && cents ? '-' : '';
  return `${sign}${Math.floor(cents / 100)}${cents % 100 ? `,${pad(cents % 100)}` : ''}`;
}

/** Opération sur un compte épargne : une dépense y verse de l'argent, un revenu en retire. */
function isSavings(cat, kind) { return (kind === 'Dépense' || kind === 'Revenu') && category(cat).savings; }

// ----------------------------------------------------- calculs (= kompte.py)
function fixedEvents(start, end) {
  const D = state.data;
  const overrides = new Map(D.fixed_overrides.map((o) => [`${o.group_id}|${o.month}`, o.amount_cents]));
  const groups = new Map(D.fixed_groups.map((g) => [g.id, g]));
  const out = [];
  for (const v of D.fixed_versions) {
    const g = groups.get(v.group_id);
    if (!g) continue;
    let ym = start.slice(0, 7) > v.start_month ? start.slice(0, 7) : v.start_month;
    let last = nextMonth(end.slice(0, 7));
    if (v.end_month && v.end_month < last) last = v.end_month;
    while (ym < last) {
      const due = dueInMonth(ym, v.day_of_month);
      if (start <= due && due < end) {
        const override = overrides.has(`${g.id}|${ym}`) ? overrides.get(`${g.id}|${ym}`) : null;
        const value = override === null ? v.amount_cents : override;
        if (value > 0) {
          out.push({ row: { id: -g.id, title: g.title, category: g.category, kind: g.kind, frequency: 'Mensuelle',
                            installments: 1, base_amount: v.amount_cents, override, received: g.received,
                            compte_id: g.compte_id, vers_compte_id: g.vers_compte_id }, due, amount: value });
        }
      }
      ym = nextMonth(ym);
    }
  }
  return out;
}

function occurrences(start, end) {
  const results = [];
  for (const row of state.data.items) {
    const base = row.first_date;
    if (!(base < end)) continue;
    if (row.frequency !== 'Unique') {
      const interval = { Mensuelle: 1, Trimestrielle: 3, Annuelle: 12 }[row.frequency];
      const months = (+start.slice(0, 4) - +base.slice(0, 4)) * 12 + (+start.slice(5, 7) - +base.slice(5, 7));
      let n = Math.max(0, Math.floor(months / interval) - 1);
      for (;;) {
        const due = monthShift(base, n * interval);
        if (due >= end) break;
        if (due >= start && due >= base) results.push({ row, due, amount: row.total_cents });
        n += 1;
      }
    } else {
      const count = row.installments;
      const q = Math.floor(row.total_cents / count), rem = row.total_cents % count;
      for (let n = 0; n < count; n++) {
        const due = monthShift(base, n);
        if (due >= end) break;
        if (start <= due) results.push({ row, due, amount: q + (n < rem ? 1 : 0) });
      }
    }
  }
  results.push(...fixedEvents(start, end));
  return results.sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : b.row.id - a.row.id));
}

// ---------------------------------------------------- début du mois (= kompte.py)
/** Jour où commence le mois du compte ouvert. */
function monthStart() {
  const raw = state.all && state.all.kv.month_start;
  const day = raw && typeof raw === 'object' ? raw[state.compte] : 1;
  return Number.isInteger(day) && day >= 1 && day <= 28 ? day : 1;
}

/** Période [début, fin) du mois : elle porte le nom du mois où elle a le plus de jours
    (jusqu'au 16, celui où elle commence ; ensuite, celui où elle finit). */
function monthPeriod(ym, day = monthStart()) {
  const base = day <= 16 ? ym : monthShift(`${ym}-01`, -1).slice(0, 7);
  const first = `${base}-${pad(day)}`;
  return [first, monthShift(first, 1)];
}

/** Le mois (AAAA-MM) dont la période contient cette date. */
function periodOf(iso, day = monthStart()) {
  const ym = iso.slice(0, 7);
  if (+iso.slice(8, 10) >= day) return day <= 16 ? ym : nextMonth(ym);
  return day > 16 ? ym : monthShift(`${ym}-01`, -1).slice(0, 7);
}

function currentMonth() { return periodOf(todayIso()); }

/** « Du 14 novembre au 13 décembre », ou rien pour un mois normal. */
function periodText(ym, day = monthStart()) {
  if (day <= 1) return '';
  const [first, after] = monthPeriod(ym, day);
  const last = addDays(after, -1);
  return `Du ${+first.slice(8, 10)} ${MONTHS[+first.slice(5, 7) - 1]} au ${+last.slice(8, 10)} ${MONTHS[+last.slice(5, 7) - 1]}`;
}
function periodHint() {
  const text = periodText(state.selected);
  return text ? `<p class="hint" style="text-align:center;margin:-6px 0 10px">${text}</p>` : '';
}

function summary(ym) {
  const events = occurrences(...monthPeriod(ym));
  const today = todayIso();
  let income = 0, out = 0, paid = 0;
  for (const e of events) {
    if (e.row.kind === 'Revenu') income += e.amount;
    else { out += e.amount; if (e.due <= today) paid += e.amount; }
  }
  return { income, out, paid, events };
}

const signed = (e) => (e.row.kind === 'Revenu' ? e.amount : -e.amount);

/** Soldes de référence par compte. Avant la v0.14, un seul solde : celui du premier compte. */
function balances() {
  const raw = state.all && state.all.kv.balance;
  if (!raw || typeof raw !== 'object') return {};
  if ('balance_cents' in raw) return state.all.comptes.length ? { [state.all.comptes[0].id]: raw } : {};
  return raw;
}

function balanceReference() {
  const b = balances()[state.compte];
  if (!b || typeof b !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(b.as_of || '') || !Number.isInteger(+b.balance_cents)) return null;
  return b;
}

function getBalance() {
  const data = balanceReference();
  if (!data) return null;
  const anchor = data.as_of, today = todayIso();
  if (anchor > today) return +data.balance_cents;
  const current = new Map();
  for (const e of balanceEvents(anchor, addDays(today, 1))) current.set(`${e.row.id}|${e.due}`, signed(e));
  let delta = 0;
  const baseline = data.baseline_events;
  if (baseline && typeof baseline === 'object' && !Array.isArray(baseline)) {
    for (const v of current.values()) delta += v;
    for (const [key, value] of Object.entries(baseline)) {
      const d = key.split('|').pop();
      if (d <= today) delta -= parseInt(value, 10);
    }
  } else {
    for (const [key, value] of current) if (key.split('|').pop() > anchor) delta += value;
  }
  return +data.balance_cents + delta;
}

// ------------------------------------------------------------ données
async function check(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message || 'Erreur réseau');
  return data;
}

async function remoteVersion() {
  const rows = await check(sb.from('sync_state').select('version'));
  return rows.length ? rows[0].version : 0;
}

async function fetchTable(table) {
  const [order, cols] = TABLES[table];
  let rows = [];
  for (let from = 0; ; from += PAGE) {
    const batch = await check(sb.from(table).select(cols).order(order).range(from, from + PAGE - 1));
    rows = rows.concat(batch);
    if (batch.length < PAGE) return rows;
  }
}

/** Le contenu d'un seul compte : les calculs ci-dessus ne voient que lui. */
function scoped(compte) {
  const A = state.all;
  // Un virement n'est qu'une ligne : reçu ici, il change de sens.
  const seen = (r) => (r.compte_id === compte ? r
    : { ...r, received: true, kind: r.kind === 'Revenu' ? 'Dépense' : 'Revenu' });
  const mine = (r) => r.compte_id === compte || r.vers_compte_id === compte;
  const items = A.items.filter(mine).map(seen);
  const groups = A.fixed_groups.filter(mine).map(seen);
  const itemIds = new Set(items.map((r) => r.id));
  const groupIds = new Set(groups.map((r) => r.id));
  return {
    ...A,
    items,
    fixed_groups: groups,
    notes: A.notes.filter((r) => r.compte_id === compte),
    savings_accounts: A.savings_accounts.filter((r) => r.compte_id === compte),
    fixed_versions: A.fixed_versions.filter((r) => groupIds.has(r.group_id)),
    fixed_overrides: A.fixed_overrides.filter((r) => groupIds.has(r.group_id)),
    savings_transfers: A.savings_transfers.filter((r) => itemIds.has(r.item_id)),
    fixed_savings_transfers: (A.fixed_savings_transfers || []).filter((r) => groupIds.has(r.group_id)),
  };
}

function openCompte(compte) {
  state.compte = compte;
  if (compte !== null && !state.all.comptes.some((c) => c.id === compte)) state.compte = null;
  state.data = scoped(state.compte);
}

function balanceOf(compte) {
  const [data, current] = [state.data, state.compte];
  state.data = scoped(compte);
  state.compte = compte;
  try { return getBalance(); } finally { state.data = data; state.compte = current; }
}

async function loadAll() {
  const version = await remoteVersion();
  const names = Object.keys(TABLES);
  const [kvRows, ...tables] = await Promise.all([check(sb.from('kv_settings').select('key,value')),
                                                 ...names.map(fetchTable)]);
  const data = { kv: {} };
  names.forEach((name, i) => { data[name] = tables[i]; });
  for (const r of kvRows) data.kv[r.key] = r.value;
  state.all = data;
  openCompte(state.compte);
  state.version = version;
  try { localStorage.setItem('kompte-cache', JSON.stringify({ data, version, email: state.email })); } catch (e) { /* stockage indisponible */ }
}

async function refresh(force = false) {
  if (state.loading) return;
  state.loading = true;
  setSync('Synchronisation…');
  try {
    if (force || state.all === null || (await remoteVersion()) !== state.version) {
      await loadAll();
      render();
    }
    state.syncError = false;
    if (!state.checked) { state.checked = true; if (state.tab === 'dashboard') render(); }
    const now = new Date();
    setSync(`À jour · ${pad(now.getHours())}:${pad(now.getMinutes())}`);
  } catch (e) {
    state.syncError = true;
    setSync('Hors ligne', true);
    if (!state.checked) { state.checked = true; if (state.all && state.tab === 'dashboard') render(); }
  } finally {
    state.loading = false;
  }
}

function setSync(text, error = false) {
  const el = $('#sync');
  el.textContent = text;
  el.classList.toggle('error', error);
}

// ------------------------------------------------------------- affichage
function render() {
  if (!state.all) { view.innerHTML = '<p class="empty">Chargement…</p>'; return; }
  const home = state.compte === null;
  $('#tabs').hidden = home;
  $('#switch').hidden = home;
  $('#fab').hidden = true;
  if (home) { renderHome(); return; }
  // Le mois en cours suit la date et le réglage : l'affichage bascule tout seul.
  const current = currentMonth();
  if (state.current !== current) {
    if (state.selected === state.current) state.selected = current;
    state.current = current;
  }
  $('#switch').textContent = state.all.comptes.find((c) => c.id === state.compte).name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('#fab').hidden = state.tab !== 'dashboard'; // Transactions : lecture seule
  if (state.tab === 'transactions') renderTransactions();
  else if (state.tab === 'fixed') renderFixed();
  else if (state.tab === 'savings') renderSavings();
  else if (state.tab === 'account') renderAccount();
  else renderDashboard();
}

function renderHome() {
  const comptes = state.all.comptes;
  window.scrollTo(0, 0);
  if (!comptes.length) {
    view.innerHTML = `
      <h2>Comptes</h2>
      <p class="note" style="margin-top:0">Ouvre d'abord Kompte sur le PC et connecte-toi dans Paramètres › Synchronisation :
        tes données et ton premier compte arriveront ici tout seuls.</p>
      <div class="actions"><button type="button" class="secondary" id="logout">Se déconnecter</button></div>`;
    return;
  }
  const rows = comptes.map((c) => {
    const balance = balanceOf(c.id);
    const value = balance === null ? '' : `<span class="amount ${balance >= 0 ? 'plus' : 'minus'}">${euro(balance)}</span>`;
    return `<button type="button" class="row" data-compte="${c.id}">
        <span class="body"><span class="title">${esc(c.name)}</span>
          ${balance === null ? '<span class="sub">Solde non renseigné</span>' : ''}</span>${value}
      </button>`;
  }).join('');
  view.innerHTML = `
    <h2>Choisis un compte</h2>
    <div class="list">${rows}</div>
    <button type="button" class="primary wide" id="add-compte" style="margin-top:14px">+ Nouveau compte</button>
    <p class="note">Renommer ou supprimer un compte se fait sur le PC.</p>`;
}

function compteSheet() {
  openSheet(`
    <h3>Nouveau compte</h3>
    <label class="field" for="c-name">Nom (compte principal, compte commun…)</label>
    <input class="input" id="c-name" autocomplete="off">
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const name = form.querySelector('#c-name').value.trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    const same = (c) => c.name.toLocaleLowerCase('fr') === name.toLocaleLowerCase('fr');
    if (state.all.comptes.some(same)) throw new Error('Un compte porte déjà ce nom.');
    await check(sb.from('comptes').insert({ id: newId(), name }));
  });
  setTimeout(() => $('#sheet-form').querySelector('#c-name').focus(), 120);
}

function compteName(id) {
  const c = state.all.comptes.find((x) => x.id === id);
  return c ? c.name : '?';
}

/** « vers X » ou « depuis X » pour un virement entre comptes, sinon vide. */
function transferNote(r) {
  if (r.received) return `depuis ${compteName(r.compte_id)}`;
  return r.vers_compte_id ? `vers ${compteName(r.vers_compte_id)}` : '';
}

function eventRow(e) {
  const r = e.row;
  let when = frDate(e.due);
  if (transferNote(r)) when += ` · ${transferNote(r)}`;
  if (r.id < 0) {
    when += ' · fixe';
    if (r.override !== null && r.override !== undefined) when += ' (modifié ce mois)';
  }
  if (r.id > 0 && r.category === MEAL_CATEGORY && mealOf(r.id)) when += ` · ${MEALS[mealOf(r.id)].toLowerCase()}`;
  const plus = r.kind === 'Revenu';
  return `<button type="button" class="row" data-item="${r.id}" data-due="${e.due}">
      ${catIcon(r.category)}
      <span class="body"><span class="title">${esc(r.title)}</span>
        <span class="sub">${esc(when)} · ${esc(r.category)}</span></span>
      <span class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${euro(e.amount)}</span>
    </button>`;
}

function renderDashboard() {
  const balance = getBalance();
  const ref = balanceReference();
  const free = balance === null ? null : availableMoney(balance);
  const carry = balance === null || state.selected !== currentMonth() ? null : carryOver(balance);
  const ym = state.selected;
  const { income, out, paid, events } = summary(ym);
  const meals = mealTotals(events);
  const isToday = ym === currentMonth();
  const today = todayIso();
  // Seulement ce qui a déjà eu lieu, les 10 plus récentes (le détail est dans Transactions).
  const done = events.filter((e) => e.due <= today).slice(0, 10);
  const metric = (label, value, color, id = '') =>
    `<${id ? `button type="button" id="${id}"` : 'div'} class="metric"><small>${label}</small><b style="color:${color}">${euro(value)}</b></${id ? 'button' : 'div'}>`;
  view.innerHTML = `
    <button type="button" class="hero" id="balance">
      <small>SOLDE ACTUEL</small>
      <strong>${balance === null ? '— €' : euro(balance)}</strong>
      <span>${ref ? `Depuis le ${frDate(ref.as_of)} · touche pour modifier` : 'Touche ici pour saisir ton solde bancaire actuel'}</span>
      ${balance !== null ? pendingByDate().slice(0, 3).filter(([, v]) => v).map(([d, v]) =>
        `<span class="pending">À prélever le ${frDate(d)} : ${euro(-v)}</span>`).join('') : ''}
      ${free ? `<span class="free">Disponible jusqu’au ${+free[1].slice(8, 10)} ${MONTHS[+free[1].slice(5, 7) - 1]}
        <b style="color:var(${free[0] >= 0 ? '--green' : '--red'})">${euro(free[0])}</b>
        <em>solde − achats pas encore prélevés − dépenses prévues d’ici là</em></span>` : ''}
    </button>
    <div class="monthbar">
      <button type="button" class="icon-btn" data-month="-1" aria-label="Mois précédent">‹</button>
      <span class="label">${monthLabel(ym)}</span>
      <button type="button" class="icon-btn" data-month="1" aria-label="Mois suivant">›</button>
    </div>
    ${periodHint()}
    ${isToday ? '' : '<p style="text-align:center;margin:-6px 0 10px"><button type="button" class="chip" id="today">Revenir à aujourd’hui</button></p>'}
    <div class="metrics">
      ${metric('Revenus prévus', income, 'var(--green)')}
      ${metric('Dépenses prévues ›', out - paid, 'var(--red)', 'upcoming')}
      ${metric('Déjà dépensé', paid, 'var(--text)')}
      <div class="metric"><small>Bilan du mois</small><b style="color:var(--blue)">${euro(income - out)}</b>
        ${carry === null ? '' : `<span class="carry" style="color:var(${carry >= 0 ? '--green' : '--red'})">Report du mois dernier : ${carry > 0 ? '+' : ''}${euro(carry)}</span>`}</div>
    </div>
    ${meals.midi || meals.resto ? `<div class="meals"><small>Alimentation ce mois-ci</small>
      <span>Repas du midi <b>${euro(meals.midi)}</b></span><span>Restaurant <b>${euro(meals.resto)}</b></span></div>` : ''}
    <button type="button" class="notes-btn" id="notes">Notes${state.data.notes.length ? ` (${state.data.notes.length})` : ''}</button>
    <h2>Dernières opérations</h2>
    <div class="list">${done.map(eventRow).join('') || '<p class="empty">Aucune opération passée ce mois-ci.</p>'}</div>
    ${done.length ? '<p class="note">Toutes les opérations du mois : onglet Transactions.</p>' : ''}`;
  const reminder = $('#sheet').hidden ? payReminder() : null;
  if (reminder) paySheet(reminder);
}

// ------------------------------------------------------------------- notes
function fixedAmount(g) {
  const ym = todayIso().slice(0, 7);
  const versions = state.data.fixed_versions.filter((v) => v.group_id === g.id)
    .sort((a, b) => (a.start_month < b.start_month ? 1 : -1));
  const version = versions.find((v) => v.start_month <= ym && (!v.end_month || v.end_month > ym)) || versions[0];
  return version ? version.amount_cents : 0;
}

/** Ce qu'une note peut accompagner : mêmes règles que note_targets() du PC. */
function noteTargets() {
  const items = [...state.data.items].sort((a, b) => (a.first_date < b.first_date ? 1 : a.first_date > b.first_date ? -1 : b.id - a.id));
  return [
    ...items.map((r) => ({ key: `i${r.id}`, title: r.title, kind: r.kind, amount: r.total_cents, detail: frDate(r.first_date) })),
    ...state.data.fixed_groups.map((g) => ({ key: `g${g.id}`, title: g.title, kind: g.kind, amount: fixedAmount(g), detail: 'montant fixe' })),
  ];
}
const noteKey = (n) => (n.item_id !== null ? `i${n.item_id}` : n.group_id !== null ? `g${n.group_id}` : '');
const signedText = (t) => `${t.kind === 'Revenu' ? '+' : '−'}${euro(t.amount)}`;

function notesSheet() {
  const notes = [...state.data.notes].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id));
  const targets = noteTargets();
  const rows = notes.map((n) => {
    const link = targets.find((t) => t.key === noteKey(n));
    const preview = n.body.split(/\s+/).filter(Boolean).join(' ');
    // Colonne de droite uniquement pour une note associée : sinon, rien du tout.
    return `<button type="button" class="row" data-note="${n.id}">
        <span class="body"><span class="title">${esc(n.title || 'Note sans titre')}</span>
          ${preview ? `<span class="sub">${esc(preview)}</span>` : ''}</span>
        ${link ? `<span class="note-link"><span>${esc(link.title)}</span>
          <span class="amount ${link.kind === 'Revenu' ? 'plus' : 'minus'}">${signedText(link)}</span></span>` : ''}
      </button>`;
  }).join('');
  openSheet(`
    <h3>Notes</h3>
    <button type="button" class="primary wide" id="add-note">+ Nouvelle note</button>
    <div class="list">${rows || '<p class="empty">Aucune note pour ce compte.</p>'}</div>
    <p class="error-text"></p>
    <div class="actions"><button type="button" class="secondary" data-close>Fermer</button></div>`, async () => {});
}

function noteSheet(note) {
  const key = note ? noteKey(note) : '';
  const options = noteTargets().map((t) =>
    `<option value="${t.key}" ${t.key === key ? 'selected' : ''}>${esc(`${t.title} · ${t.detail} · ${signedText(t)}`)}</option>`).join('');
  openSheet(`
    <h3>${note ? 'Modifier la note' : 'Nouvelle note'}</h3>
    <label class="field" for="n-title">Titre</label>
    <input class="input" id="n-title" autocomplete="off" value="${note ? esc(note.title) : ''}">
    <label class="field" for="n-body">Texte</label>
    <textarea class="input" id="n-body" rows="7">${note ? esc(note.body) : ''}</textarea>
    <p class="hint">Calcul rapide : écris par exemple 12,50 + 30 = et le résultat s'ajoute tout seul.</p>
    <label class="field" for="n-link">Associer une transaction ou un montant fixe (facultatif)</label>
    <select class="input" id="n-link"><option value="">Aucun</option>${options}</select>
    <p class="error-text"></p>
    <div class="actions">
      ${note ? '<button type="button" class="secondary danger" id="n-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const title = form.querySelector('#n-title').value.trim();
    const body = form.querySelector('#n-body').value.trim();
    if (!title && !body) throw new Error('Écris un titre ou un texte.');
    const link = form.querySelector('#n-link').value;
    const fields = { title, body, updated_at: utcStamp(),
                     item_id: link[0] === 'i' ? Number(link.slice(1)) : null,
                     group_id: link[0] === 'g' ? Number(link.slice(1)) : null };
    if (note) await check(sb.from('notes').update(fields).eq('id', note.id));
    else await check(sb.from('notes').insert({ id: newId(), compte_id: state.compte, created_at: fields.updated_at, ...fields }));
  });
  const form = $('#sheet-form');
  const del = form.querySelector('#n-delete');
  if (del) {
    del.addEventListener('click', async () => {
      if (!confirm('Supprimer cette note ?')) return;
      try {
        await check(sb.from('notes').delete().eq('id', note.id));
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = e.message;
      }
    });
  }
}

/** Dépenses qui restent à payer dans le mois (touche sur « Dépenses prévues »). */
function upcomingSheet() {
  const today = todayIso();
  const events = summary(state.selected).events.filter((e) => e.row.kind === 'Dépense' && e.due > today).reverse();
  const total = events.reduce((sum, e) => sum + e.amount, 0);
  openSheet(`
    <h3>Dépenses prévues</h3>
    <p class="hint" style="text-align:center;margin-top:0">${monthLabel(state.selected)} · encore ${euro(total)} à payer</p>
    <div class="list" style="margin-top:12px">${events.map(eventRow).join('') || '<p class="empty">Plus aucune dépense prévue ce mois-ci.</p>'}</div>
    <p class="error-text"></p>
    <div class="actions"><button type="button" class="primary" data-close>Fermer</button></div>`, async () => {});
}

/** Toutes les opérations du mois choisi (année puis mois, chacun avec ses flèches). Lecture seule. */
function renderTransactions() {
  const ym = state.selected;
  const { events } = summary(ym);
  // Toutes les catégories, y compris celles créées à la main ou supprimées depuis.
  const known = categories().map((c) => c.name);
  const extra = [...new Set(events.map((e) => e.row.category))].filter((n) => !known.includes(n)).sort((a, b) => a.localeCompare(b, 'fr'));
  const names = [...known, ...extra];
  state.cats = state.cats.filter((n) => names.includes(n));
  const chosen = state.cats;
  const needle = state.query.toLowerCase();
  const shown = events.filter((e) => (!chosen.length || chosen.includes(e.row.category))
    && (!needle || e.row.title.toLowerCase().includes(needle)
    || e.row.category.toLowerCase().includes(needle) || amountText(e.amount).includes(needle.replace('.', ','))));
  const income = shown.reduce((sum, e) => sum + (e.row.kind === 'Revenu' ? e.amount : 0), 0);
  const out = shown.reduce((sum, e) => sum + (e.row.kind === 'Revenu' ? 0 : e.amount), 0);
  const filterLabel = !chosen.length ? 'Catégories : toutes'
    : chosen.length === 1 ? `Catégorie : ${esc(chosen[0])}` : `Catégories : ${chosen.length} choisies`;
  const filterGrid = !state.catsOpen ? '' : `<div class="cats filter-cats">${names.map((n) => {
    const c = category(n);
    return `<button type="button" data-filter-cat="${esc(n)}" class="${chosen.includes(n) ? 'on' : ''}" style="--c:${c.color}">
       ${catIcon(n)}<span>${esc(n)}</span></button>`;
  }).join('')}</div>`;
  const rows = shown.map((e) => {
    const r = e.row;
    const plus = r.kind === 'Revenu';
    let details = `${r.category} · ${frDate(e.due)}`;
    if (transferNote(r)) details += ` · ${transferNote(r)}`;
    if (isCard(r)) details += ' · carte';
    if (r.id > 0 && r.category === MEAL_CATEGORY && mealOf(r.id)) details += ` · ${MEALS[mealOf(r.id)].toLowerCase()}`;
    if (debitDate(r, e.due) !== e.due) details += ` · débit le ${frDate(debitDate(r, e.due))}`;
    if (r.id < 0) details += ' · fixe';
    else if (r.installments > 1) {
      const index = (+e.due.slice(0, 4) - +r.first_date.slice(0, 4)) * 12 + (+e.due.slice(5, 7) - +r.first_date.slice(5, 7));
      details += ` · ${index + 1}/${r.installments}`;
    } else if (r.frequency !== 'Unique') details += ` · ${r.frequency.toLowerCase()}`;
    return `<button type="button" class="row" data-item="${r.id}" data-due="${e.due}">
        ${catIcon(r.category)}
        <span class="body"><span class="title">${esc(r.title)}</span><span class="sub">${esc(details)}</span></span>
        <span class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${euro(e.amount)}</span>
      </button>`;
  }).join('');
  const month = MONTHS[+ym.slice(5, 7) - 1];
  view.innerHTML = `
    <div class="monthbar year">
      <button type="button" class="icon-btn" data-month="-12" aria-label="Année précédente">‹</button>
      <span class="label">${ym.slice(0, 4)}</span>
      <button type="button" class="icon-btn" data-month="12" aria-label="Année suivante">›</button>
    </div>
    <div class="monthbar">
      <button type="button" class="icon-btn" data-month="-1" aria-label="Mois précédent">‹</button>
      <span class="label">${month[0].toUpperCase() + month.slice(1)}</span>
      <button type="button" class="icon-btn" data-month="1" aria-label="Mois suivant">›</button>
    </div>
    ${periodHint()}
    <div class="totals"><span class="plus">+${euro(income)}</span><span class="minus">−${euro(out)}</span>
      <span>= ${euro(income - out)}</span></div>
    <input class="search" id="search" type="search" placeholder="Rechercher dans le mois…" value="${esc(state.query)}">
    <div class="filter-bar">
      <button type="button" class="filter-btn" id="cat-filter">${filterLabel} ${state.catsOpen ? '▲' : '▼'}</button>
      ${chosen.length ? '<button type="button" class="chip" id="cat-reset">Tout afficher</button>' : ''}
    </div>
    ${filterGrid}
    <div class="list">${rows || `<p class="empty">${state.query || chosen.length ? 'Aucune opération trouvée.' : 'Aucune opération ce mois-ci.'}</p>`}</div>`;
}

/** Montants fixes : toucher une ligne pour la modifier, changer un seul mois, l'arrêter ou la supprimer. */
function renderFixed() {
  const ym = todayIso().slice(0, 7);
  // Même ordre que sur le PC ; un montant fixe tout neuf arrive en tête.
  const order = (state.all.kv.fixed_order || {})[state.compte];
  const rank = new Map((Array.isArray(order) ? order : []).map((id, i) => [id, i]));
  const place = (g) => (rank.has(g.id) ? rank.get(g.id) : -1);
  const groups = [...state.data.fixed_groups].sort((a, b) => place(a) - place(b) || b.id - a.id);
  const rows = groups.map((g) => {
    const version = state.data.fixed_versions.filter((v) => v.group_id === g.id && v.start_month <= ym
      && (!v.end_month || v.end_month > ym)).sort((a, b) => (a.start_month < b.start_month ? 1 : -1))[0];
    const plus = g.kind === 'Revenu';
    return `<button type="button" class="row" data-fixed="${g.id}">
        ${catIcon(g.category)}
        <span class="body"><span class="title">${esc(g.title)}</span>
          <span class="sub">${esc(g.category)}${transferNote(g) ? ` · ${esc(transferNote(g))}` : ''}${version ? ` · le ${version.day_of_month} du mois` : ''}</span></span>
        ${version ? `<span class="amount ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${euro(version.amount_cents)}</span>`
    : '<span class="sub">Pas actif ce mois-ci</span>'}
      </button>`;
  }).join('');
  view.innerHTML = `
    <h2>Montants fixes</h2>
    <button type="button" class="primary wide" id="add-fixed">+ Ajouter un montant fixe</button>
    <div class="list">${rows || '<p class="empty">Aucun montant fixe enregistré.</p>'}</div>
    <p class="note">Touche un montant fixe pour le modifier, changer un seul mois ou l'arrêter.</p>`;
}

// ------------------------------------------------------ épargne (= accounts_page du PC)
// Poches d'épargne (= kompte.py) : réglage partagé « savings_pockets »
// {accounts: {compte épargne: [{id, name, start}]}, items: {transaction: poche}, groups: {montant fixe: poche}}.
// Une poche = son montant de départ + les virements qui lui sont attribués ; le reste du compte est « Non réparti ».
function pocketsData() {
  const raw = state.all && state.all.kv.savings_pockets;
  const ok = raw && typeof raw === 'object';
  const part = (key) => (ok && raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key]) ? raw[key] : {});
  return { accounts: part('accounts'), items: part('items'), groups: part('groups') };
}
function pocketsOf(accountId) {
  const list = pocketsData().accounts[accountId];
  return Array.isArray(list) ? list.filter((p) => p && Number.isFinite(Number(p.id)) && typeof p.name === 'string')
    .map((p) => ({ id: Number(p.id), name: p.name, start: Number.isInteger(p.start) ? p.start : 0 })) : [];
}
/** Répartition d'un virement (transaction 'items' ou montant fixe 'groups') dans les poches du compte :
    [[poche, montant signé]]. Réglage = une poche (tout le virement) ou {poche: montant} ; si les montants
    dépassent le virement (mois fixe plus petit), ils sont réduits en proportion. Le reste est non réparti. */
function pocketParts(kind, id, accountId, cents) {
  const value = pocketsData()[kind][id];
  const valid = new Set(pocketsOf(accountId).map((p) => p.id));
  if (typeof value === 'number' || (typeof value === 'string' && value !== '')) {
    return valid.has(Number(value)) ? [[Number(value), cents]] : [];
  }
  if (!value || typeof value !== 'object') return [];
  const parts = Object.entries(value).map(([p, c]) => [Number(p), c])
    .filter(([p, c]) => valid.has(p) && Number.isInteger(c) && c > 0);
  const sum = parts.reduce((t, [, c]) => t + c, 0);
  const whole = Math.abs(cents);
  const sign = cents < 0 ? -1 : 1;
  return parts.map(([p, c]) => [p, sign * (sum > whole ? Math.floor((c * whole) / sum) : c)]);
}
async function savePockets(value) {
  const raw = state.all.kv.savings_pockets && typeof state.all.kv.savings_pockets === 'object' ? state.all.kv.savings_pockets : {};
  const full = { ...raw, ...value };
  state.all.kv.savings_pockets = full;
  await check(sb.from('kv_settings').upsert({ key: 'savings_pockets', value: full }, { onConflict: 'user_id,key' }));
}
/** Enregistre la répartition d'un virement : null (non réparti) ou {poche: montant}. */
async function setPocketOf(kind, id, split) {
  const d = pocketsData();
  const current = d[kind][id] === undefined ? null : d[kind][id];
  if (JSON.stringify(current) === JSON.stringify(split)) return;
  const map = { ...d[kind] };
  if (split === null) delete map[id]; else map[id] = split;
  await savePockets({ [kind]: map });
}

/** Virements d'un compte épargne jusqu'à aujourd'hui : [{kind, id, cents}]. */
function accountMoves(accountId) {
  const through = todayIso();
  const moves = [];
  for (const t of state.data.savings_transfers) {
    if (t.account_id !== accountId) continue;
    const item = state.all.items.find((i) => i.id === t.item_id);
    if (item && item.first_date <= through) {
      moves.push({ kind: 'items', id: item.id, cents: item.kind === 'Dépense' ? item.total_cents : -item.total_cents });
    }
  }
  const groups = new Set(state.data.fixed_savings_transfers.filter((t) => t.account_id === accountId).map((t) => t.group_id));
  if (groups.size) {
    for (const e of fixedEvents('0000-01-01', addDays(through, 1))) {
      if (groups.has(-e.row.id)) moves.push({ kind: 'groups', id: -e.row.id, cents: e.row.kind === 'Dépense' ? e.amount : -e.amount });
    }
  }
  return moves;
}
/** Solde d'un compte épargne (= Store.account_balance) : solde initial + virements jusqu'à aujourd'hui. */
function accountBalance(accountId) {
  const account = state.data.savings_accounts.find((a) => a.id === accountId);
  if (!account) return 0;
  return accountMoves(accountId).reduce((sum, m) => sum + m.cents, account.opening_cents);
}
/** Total réel du compte, chaque poche et le non réparti (= Store.account_split). */
function accountSplit(accountId) {
  const total = accountBalance(accountId);
  const pockets = pocketsOf(accountId).map((p) => ({ ...p, cents: p.start }));
  const byId = new Map(pockets.map((p) => [p.id, p]));
  for (const m of accountMoves(accountId)) {
    for (const [pocket, cents] of pocketParts(m.kind, m.id, accountId, m.cents)) byId.get(pocket).cents += cents;
  }
  return { total, pockets, rest: total - pockets.reduce((sum, p) => sum + p.cents, 0) };
}

/** Répartition entre les poches, sous le compte épargne d'un virement (caché si le compte n'a pas de poche). */
function pocketField(initial) {
  return `<div id="f-pocket-box" data-initial="${esc(JSON.stringify(initial === undefined ? null : initial))}" hidden>
      <label class="field" id="f-pocket-label">Répartir dans les poches</label>
      <div id="f-pocket-rows"></div>
      <p class="hint" id="f-pocket-rest"></p>
    </div>`;
}
function wirePocket(form) {
  const account = form.querySelector('#f-account');
  const box = form.querySelector('#f-pocket-box');
  if (!account || !box) return;
  const amountInput = form.querySelector('#f-amount') || form.querySelector('#x-amount');
  const rows = box.querySelector('#f-pocket-rows');
  const restLine = box.querySelector('#f-pocket-rest');
  const amountNow = () => { try { return parseAmount(amountInput.value); } catch (e) { return null; } };
  const showRest = () => {
    const amount = amountNow();
    let used = 0;
    for (const input of rows.querySelectorAll('input')) { try { used += input.value.trim() ? parseAmount(input.value) : 0; } catch (e) { /* saisie en cours */ } }
    if (amount === null) { restLine.textContent = ''; return; }
    const rest = amount - used;
    const out = (form.querySelector('#f-kind .on') || {}).dataset?.kind === 'Revenu';
    restLine.textContent = rest >= 0 ? `${out ? 'Pris dans le non réparti' : 'Non réparti'} : ${euro(rest)}`
      : `Les poches dépassent le montant de ${euro(-rest)}`;
    restLine.style.color = rest >= 0 ? '' : 'var(--red)';
  };
  const fill = () => {
    const list = pocketsOf(Number(account.value));
    let initial = null;
    try { initial = JSON.parse(box.dataset.initial || 'null'); } catch (e) { initial = null; }
    const amounts = {};
    if (typeof initial === 'number' || typeof initial === 'string') amounts[Number(initial)] = amountInput.value.trim(); // ancien réglage : tout le virement
    else if (initial && typeof initial === 'object') for (const [p, c] of Object.entries(initial)) amounts[Number(p)] = amountText(c);
    box.hidden = !list.length;
    rows.innerHTML = list.map((p) => `<div class="pocket-split"><span>${esc(p.name)}</span>
        <input class="input" inputmode="decimal" autocomplete="off" placeholder="0,00" data-pocket="${p.id}" value="${esc(amounts[p.id] || '')}"></div>`).join('');
    showRest();
  };
  account.addEventListener('change', () => { box.dataset.initial = 'null'; fill(); });
  rows.addEventListener('input', showRest);
  if (amountInput) amountInput.addEventListener('input', showRest);
  form.addEventListener('pocket-kind', showRest);
  fill();
}
/** Répartition choisie : null (tout en non réparti) ou {poche: montant} ; refuse plus que le virement. */
function chosenPocket(form, amount) {
  const box = form.querySelector('#f-pocket-box');
  if (!box || box.hidden) return null;
  const split = {};
  let used = 0;
  for (const input of box.querySelectorAll('input[data-pocket]')) {
    if (!input.value.trim()) continue;
    const cents = parseAmount(input.value);
    if (cents < 0) throw new Error('Un montant de poche ne peut pas être négatif.');
    if (cents > 0) { split[input.dataset.pocket] = cents; used += cents; }
  }
  if (used > amount) throw new Error(`Les poches (${euro(used)}) dépassent le montant du virement (${euro(amount)}).`);
  return used ? split : null;
}

/** Une ligne de poche avec sa barre de remplissage (part du total réel du compte). */
function pocketLine(name, cents, total, cls = '') {
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((cents * 100) / total))) : 0;
  return `<div class="pocket ${cls} ${cents < 0 ? 'minus' : ''}">
      <div class="pocket-line"><span>${esc(name)}<span class="pct">${pct} %</span></span><span>${euro(cents)}</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>`;
}

function renderSavings() {
  const accounts = [...state.data.savings_accounts].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  const cards = accounts.map((a) => {
    const split = accountSplit(a.id);
    const lines = split.pockets.length
      ? split.pockets.map((p) => pocketLine(p.name, p.cents, split.total)).join('') + pocketLine('Non réparti', split.rest, split.total, 'rest')
      : '';
    return `<div class="saving">
        <button type="button" class="saving-head" data-saving="${a.id}">
          ${catIcon('Épargne')}<span class="title">${esc(a.name)}</span><span class="amount">${euro(split.total)}</span>
        </button>
        ${lines}
        <div class="actions saving-actions">
          <button type="button" class="secondary" data-deposit="${a.id}">+ Verser</button>
          <button type="button" class="secondary" data-withdraw="${a.id}">− Retirer</button>
        </div>
      </div>`;
  }).join('');
  view.innerHTML = `
    <h2>Épargne</h2>
    <button type="button" class="primary wide" id="add-saving">+ Ajouter un compte épargne</button>
    <div class="list">${cards || '<p class="empty">Aucun compte épargne. Ajoute un compte pour y affecter tes virements.</p>'}</div>
    <p class="note">Le montant à droite est le solde réel du compte. Touche un compte pour le diviser en poches.
      « Verser » ajoute de l'argent (une dépense sur ton compte courant), « Retirer » en reprend (un revenu) ;
      dans les deux cas tu choisis les poches concernées. Les opérations futures comptent seulement à leur date.</p>`;
}

function pocketRow(p) {
  return `<div class="pocket-edit" data-pocket="${p ? p.id : ''}">
      <input class="input" placeholder="Nom (ex. Vacances)" autocomplete="off" value="${p ? esc(p.name) : ''}">
      <input class="input" inputmode="decimal" placeholder="Départ €" autocomplete="off" value="${p ? amountText(p.start) : '0'}">
      <button type="button" aria-label="Supprimer la poche">✕</button>
    </div>`;
}

function savingSheet(account = null) {
  const pockets = account ? pocketsOf(account.id) : [];
  openSheet(`
    <h3>${account ? 'Modifier le compte' : 'Nouveau compte épargne'}</h3>
    <label class="field" for="a-name">Nom du compte</label>
    <input class="input" id="a-name" autocomplete="off" value="${account ? esc(account.name) : ''}">
    <label class="field" for="a-opening">Solde initial (€)</label>
    <input class="input big" id="a-opening" inputmode="decimal" autocomplete="off" value="${account ? amountText(account.opening_cents) : '0'}">
    <p class="hint">Ce qu'il y avait sur le compte avant les virements enregistrés dans Kompte.</p>
    <label class="field">Poches</label>
    <p class="hint">Divise le compte pour voir où va ton épargne. Le départ est ce que la poche contient déjà ;
      ensuite chaque virement choisi pour elle s'y ajoute. Le reste du compte apparaît en « Non réparti ».</p>
    <div id="a-pockets">${pockets.map(pocketRow).join('')}</div>
    <button type="button" class="secondary wide" id="a-add-pocket" style="margin-top:8px">+ Ajouter une poche</button>
    <p class="error-text"></p>
    <div class="actions">
      ${account ? '<button type="button" class="secondary danger" id="a-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const name = form.querySelector('#a-name').value.trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    const opening = parseAmount(form.querySelector('#a-opening').value);
    const list = [...form.querySelectorAll('.pocket-edit')].map((row) => {
      const [label, start] = row.querySelectorAll('input');
      const pocketName = label.value.trim();
      if (!pocketName) throw new Error('Donne un nom à chaque poche (ou supprime-la).');
      return { id: Number(row.dataset.pocket) || newId(), name: pocketName, start: parseAmount(start.value) };
    });
    const accountId = account ? account.id : newId();
    if (account) await check(sb.from('savings_accounts').update({ name, opening_cents: opening }).eq('id', accountId));
    else await check(sb.from('savings_accounts').insert({ id: accountId, compte_id: state.compte, name, opening_cents: opening }));
    // Une poche supprimée rend ses virements au « Non réparti ».
    const d = pocketsData();
    const kept = new Set(list.map((p) => p.id));
    const removed = new Set(pockets.filter((p) => !kept.has(p.id)).map((p) => p.id));
    const clean = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => {
      if (v && typeof v === 'object') {
        const left = Object.fromEntries(Object.entries(v).filter(([p]) => !removed.has(Number(p))));
        return [k, Object.keys(left).length ? left : null];
      }
      return [k, removed.has(Number(v)) ? null : v];
    }).filter(([, v]) => v !== null));
    const accounts = { ...d.accounts };
    if (list.length) accounts[accountId] = list; else delete accounts[accountId];
    if (list.length || pockets.length) await savePockets({ accounts, items: clean(d.items), groups: clean(d.groups) });
  });
  const form = $('#sheet-form');
  const box = form.querySelector('#a-pockets');
  box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.closest('.pocket-edit').remove(); });
  form.querySelector('#a-add-pocket').addEventListener('click', () => {
    box.insertAdjacentHTML('beforeend', pocketRow(null));
    box.lastElementChild.querySelector('input').focus();
  });
  if (account) {
    form.querySelector('#a-delete').addEventListener('click', async () => {
      const used = state.data.savings_transfers.some((t) => t.account_id === account.id)
        || state.data.fixed_savings_transfers.some((t) => t.account_id === account.id);
      if (used) {
        form.querySelector('.error-text').textContent = 'Ce compte possède des virements. Supprime ou réaffecte-les avant de supprimer le compte.';
        return;
      }
      if (!confirm(`Supprimer le compte épargne « ${account.name} » ?`)) return;
      try {
        await check(sb.from('savings_accounts').delete().eq('id', account.id));
        const accounts = { ...pocketsData().accounts };
        if (accounts[account.id]) { delete accounts[account.id]; await savePockets({ accounts }); }
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = 'Suppression impossible : ce compte possède peut-être des virements.';
      }
    });
  }
  if (!account) setTimeout(() => form.querySelector('#a-name').focus(), 120);
}

function renderAccount() {
  const saved = cardSettings()[state.compte];
  const card = saved || { enabled: false, cutoff: 19, debit: 31 };
  view.innerHTML = `
    <h2>Réglages</h2>
    <p class="note" style="margin-top:0">Connecté avec ${esc(state.email)}.<br>
      Les modifications faites ici apparaissent sur le PC en quelques secondes, et inversement.</p>
    <label class="field" for="month-start">Début du mois pour ${esc(compteName(state.compte))}</label>
    <select class="input" id="month-start">
      ${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${d === monthStart() ? 'selected' : ''}>Le ${d === 1 ? '1er' : d}</option>`).join('')}
    </select>
    <p class="hint">${monthLabel(currentMonth())} : ${(periodText(currentMonth()) || 'Du 1er au dernier jour du mois').replace('Du', 'du')}.
      Le mois porte le nom de celui où il a le plus de jours.</p>
    <label class="field" for="card-cutoff">Carte à débit différé</label>
    <select class="input" id="card-enabled">
      <option value="0" ${card.enabled ? '' : 'selected'}>Pas de carte à débit différé</option>
      <option value="1" ${card.enabled ? 'selected' : ''}>Oui, j'ai une carte à débit différé</option>
    </select>
    ${card.enabled ? `<div class="row2">
      <select class="input" id="card-cutoff" style="margin-top:8px">
        ${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${d === card.cutoff ? 'selected' : ''}>Arrêté le ${d}</option>`).join('')}
      </select>
      <select class="input" id="card-debit" style="margin-top:8px">
        ${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${d === card.debit ? 'selected' : ''}>Prélevé le ${d === 31 ? 'dernier jour' : d}</option>`).join('')}
      </select></div>
      <p class="hint">Relevé en cours : achats du ${frDate(addDays(monthShift(cardCycleEnd(card, todayIso()), -1), 1))}
        au ${frDate(cardCycleEnd(card, todayIso()))}, prélevés le ${frDate(cardDebit(card, cardCycleEnd(card, todayIso())))}.
        Coche « Payé par carte » sur chaque achat.</p>` : ''}
    <p class="note">La modification des montants fixes, les comptes épargne et les catégories se font sur le PC ;
      ils sont pris en compte ici dans les calculs.</p>
    <div class="actions">
      <button type="button" class="secondary" id="password-change">Changer le mot de passe</button>
      <button type="button" class="secondary" id="logout">Se déconnecter</button>
    </div>`;
}

function renderLogin(message = '') {
  $('#tabs').hidden = true;
  $('#fab').hidden = true;
  $('#switch').hidden = true;
  setSync('');
  view.innerHTML = `
    <form class="login" id="login" novalidate>
      <h1>Connexion</h1>
      <p>Utilise le même compte que dans Kompte sur le PC (Paramètres › Synchronisation).</p>
      <label class="field" for="email">E-mail</label>
      <input class="input" id="email" type="email" autocomplete="username" required>
      <label class="field" for="password">Mot de passe</label>
      <input class="input" id="password" type="password" autocomplete="current-password" required>
      <p class="error-text" id="login-error">${esc(message)}</p>
      <div class="actions"><button class="primary" type="submit">Se connecter</button></div>
    </form>`;
}

// --------------------------------------------------------- fenêtres de saisie
function openSheet(html, onSubmit) {
  const form = $('#sheet-form');
  form.innerHTML = html;
  $('#sheet').hidden = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const error = form.querySelector('.error-text');
    const submit = form.querySelector('.primary');
    error.textContent = '';
    submit.disabled = true;
    try {
      await onSubmit(form);
      closeSheet();
      await refresh(true);
    } catch (e) {
      error.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  };
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-form').innerHTML = ''; }

function categoryPicker(selected) {
  return `<div class="cats" id="cats">${categories().map((c) =>
    `<button type="button" data-cat="${esc(c.name)}" class="${c.name === selected ? 'on' : ''}" style="--c:${c.color}">
       ${catIcon(c.name)}<span>${esc(c.name)}</span></button>`).join('')}</div>`;
}

function accountOptions(selectedId) {
  const accounts = [...state.data.savings_accounts].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  return accounts.map((a) => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')
    || '<option value="">Aucun compte</option>';
}

/** Choix de l'autre compte d'un virement (rien s'il n'y a qu'un compte). */
function targetField(selectedId) {
  const others = state.all.comptes.filter((c) => c.id !== state.compte);
  if (!others.length) return '';
  return `<label class="field" for="f-target">Virement avec un autre compte</label>
    <select class="input" id="f-target">
      <option value="">Aucun</option>
      ${others.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <p class="hint">Une dépense ici sera un revenu sur l'autre compte, et inversement.</p>`;
}

/** Numéro de l'autre compte choisi. Un virement épargne reste sur son compte. */
function chosenTarget(form, accountId) {
  const select = form.querySelector('#f-target');
  const target = select ? Number(select.value) || null : null;
  if (target !== null && accountId !== null) throw new Error('Un virement épargne ne peut pas aller aussi vers un autre compte.');
  return target;
}

/** Boutons Type et Catégorie ; le compte épargne n'apparaît que pour un virement. */
function wirePickers(form, split = false) {
  const refreshAccount = () => {
    const k = form.querySelector('#f-kind .on').dataset.kind;
    const c = form.querySelector('#cats .on').dataset.cat;
    form.querySelector('#f-account-box').hidden = !(isSavings(c, k) && !split);
    // Un revenu dans l'épargne = un retrait : l'argent quitte le compte épargne.
    const out = k === 'Revenu';
    form.querySelector('#f-account-label').textContent = out ? 'Retirer du compte épargne' : 'Compte épargne destinataire';
    const pocketLabel = form.querySelector('#f-pocket-label');
    if (pocketLabel) pocketLabel.textContent = out ? 'Prendre dans les poches' : 'Répartir dans les poches';
    form.dispatchEvent(new Event('pocket-kind'));
    const meal = form.querySelector('#f-meal-box');
    if (meal) meal.hidden = !(c === MEAL_CATEGORY && k === 'Dépense');
  };
  const mealBox = form.querySelector('#f-meal');
  if (mealBox) {
    mealBox.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-meal]');
      if (!b) return;
      const on = !b.classList.contains('on'); // toucher à nouveau : décocher
      mealBox.querySelectorAll('button').forEach((x) => x.classList.toggle('on', on && x === b));
    });
  }
  wirePocket(form);
  form.querySelector('#f-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b || b.disabled) return;
    form.querySelectorAll('#f-kind button').forEach((x) => x.classList.toggle('on', x === b));
    refreshAccount();
  });
  form.querySelector('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]');
    if (!b) return;
    form.querySelectorAll('#cats button').forEach((x) => x.classList.toggle('on', x === b));
    refreshAccount();
  });
  refreshAccount();
}

// --------------------------------------------- montants fixes (mêmes règles que kompte.py)
function fixedHistory(groupId) {
  return state.data.fixed_versions.filter((v) => v.group_id === groupId)
    .sort((a, b) => (a.start_month < b.start_month ? -1 : 1));
}
function fixedVersionAt(groupId, ym) {
  return fixedHistory(groupId).filter((v) => v.start_month <= ym && (!v.end_month || v.end_month > ym)).pop() || null;
}
/** Mois de fin si le montant fixe a été arrêté, sinon null. */
function fixedStoppedSince(groupId) {
  const rows = fixedHistory(groupId);
  return rows.length && rows.every((v) => v.end_month) ? rows.map((v) => v.end_month).sort().pop() : null;
}
function fixedOverride(groupId, ym) {
  const o = state.data.fixed_overrides.find((x) => x.group_id === groupId && x.month === ym);
  return o ? o.amount_cents : null;
}
function fixedGroup(id) { return state.data.fixed_groups.find((g) => g.id === id); }

/** Crée ou modifie un montant fixe (= Store.save_fixed) : le nom, le type et la catégorie valent pour tous
    les mois ; le montant et le jour seulement à partir de « start », et seulement s'ils changent vraiment. */
async function saveFixed(group, f) {
  let groupId;
  if (!group) {
    groupId = newId();
    await check(sb.from('fixed_groups').insert({ id: groupId, compte_id: state.compte, vers_compte_id: f.target, title: f.title,
                                                 category: f.category, kind: f.kind, day_of_month: f.day }));
    await check(sb.from('fixed_versions').insert({ id: newId(), group_id: groupId, amount_cents: f.amount,
                                                   start_month: f.start, end_month: null, day_of_month: f.day }));
  } else {
    groupId = group.id;
    await check(sb.from('fixed_groups').update({ title: f.title, category: f.category, kind: f.kind, day_of_month: f.day,
                                                 vers_compte_id: f.target }).eq('id', groupId));
    const current = fixedVersionAt(groupId, f.start);
    const stopped = fixedStoppedSince(groupId);
    const unchanged = current && current.amount_cents === f.amount && current.day_of_month === f.day
      && (stopped === null || stopped > f.start);
    if (!unchanged) {
      // Nouveau montant à partir de ce mois : les mois d'avant restent intacts.
      await check(sb.from('fixed_versions').delete().eq('group_id', groupId).gte('start_month', f.start));
      await check(sb.from('fixed_versions').update({ end_month: f.start }).eq('group_id', groupId).lt('start_month', f.start)
        .or(`end_month.is.null,end_month.gt.${f.start}`));
      await check(sb.from('fixed_versions').insert({ id: newId(), group_id: groupId, amount_cents: f.amount,
                                                     start_month: f.start, end_month: null, day_of_month: f.day }));
    }
  }
  await check(sb.from('fixed_savings_transfers').delete().eq('group_id', groupId));
  if (f.accountId !== null) await check(sb.from('fixed_savings_transfers').insert({ group_id: groupId, account_id: f.accountId }));
  await setPocketOf('groups', groupId, f.accountId === null ? null : f.pocket);
}

function fixedSheet(group = null) {
  const names = categories().map((c) => c.name);
  const ym = todayIso().slice(0, 7);
  const current = group ? (fixedVersionAt(group.id, ym) || fixedHistory(group.id).pop() || null) : null;
  const transfer = group ? state.data.fixed_savings_transfers.find((t) => t.group_id === group.id) : null;
  const kind = group ? group.kind : 'Dépense';
  const stopped = group ? fixedStoppedSince(group.id) : null;
  openSheet(`
    <h3>${group ? 'Modifier le montant fixe' : 'Nouveau montant fixe'}</h3>
    ${stopped ? `<p class="hint" style="text-align:center">Arrêté depuis ${monthLabel(stopped).toLowerCase()} : enregistrer un montant le relance.</p>` : ''}
    <label class="field" for="x-amount">Montant mensuel (€)</label>
    <input class="input big" id="x-amount" inputmode="decimal" autocomplete="off" value="${current ? amountText(current.amount_cents) : ''}">
    <label class="field" for="x-title">Description</label>
    <input class="input" id="x-title" autocomplete="off" value="${group ? esc(group.title) : ''}">
    <label class="field">Type</label>
    <div class="segmented" id="f-kind">
      <button type="button" data-kind="Dépense" class="${kind === 'Dépense' ? 'on' : ''}">Dépense</button>
      <button type="button" data-kind="Revenu" class="${kind === 'Revenu' ? 'on' : ''}">Revenu</button>
    </div>
    <label class="field">Catégorie</label>
    ${categoryPicker(group ? group.category : (names.includes('Factures') ? 'Factures' : names[0]))}
    <div id="f-account-box" hidden>
      <label class="field" for="f-account" id="f-account-label">Compte épargne destinataire</label>
      <select class="input" id="f-account">${accountOptions(transfer ? transfer.account_id : null)}</select>
      ${pocketField(group ? pocketsData().groups[group.id] : null)}
    </div>
    ${targetField(group ? group.vers_compte_id : null)}
    <label class="field" for="x-day">Jour du mois (1 à 31)</label>
    <input class="input" id="x-day" inputmode="numeric" value="${current ? current.day_of_month : 1}">
    <label class="field" for="x-start">${group ? 'Nouveau montant et jour à partir de' : 'À partir de'}</label>
    <input class="input" id="x-start" type="date" value="${ym}-01">
    ${group ? `<p class="hint">Le nom, le type et la catégorie valent pour tous les mois. Le montant et le jour changent à partir
      de cette date : les mois d'avant et les mois modifiés un par un sont conservés.</p>
      <div class="actions">
        <button type="button" class="secondary" id="x-month">Un seul mois…</button>
        <button type="button" class="secondary" id="x-stop">Arrêter…</button>
      </div>` : ''}
    <p class="error-text"></p>
    <div class="actions">
      ${group ? '<button type="button" class="secondary danger" id="x-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const title = form.querySelector('#x-title').value.trim();
    if (!title) throw new Error('Saisis une description.');
    const amount = positiveCents(form.querySelector('#x-amount').value);
    const start = form.querySelector('#x-start').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('Date invalide.');
    const day = Number(form.querySelector('#x-day').value.trim());
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Jour du mois : entre 1 et 31.');
    const chosenKind = form.querySelector('#f-kind .on').dataset.kind;
    const cat = form.querySelector('#cats .on').dataset.cat;
    let accountId = null;
    if (isSavings(cat, chosenKind)) {
      accountId = Number(form.querySelector('#f-account').value) || null;
      if (accountId === null) throw new Error('Crée d\'abord un compte épargne (onglet Épargne).');
    }
    const target = chosenTarget(form, accountId);
    await saveFixed(group, { title, category: cat, kind: chosenKind, amount, start: start.slice(0, 7), day, accountId, target,
                             pocket: accountId === null ? null : chosenPocket(form, amount) });
  });
  const form = $('#sheet-form');
  wirePickers(form);
  if (group) {
    form.querySelector('#x-month').addEventListener('click', () => fixedMonthSheet(group, ym));
    form.querySelector('#x-stop').addEventListener('click', () => stopFixedSheet(group));
    form.querySelector('#x-delete').addEventListener('click', async () => {
      if (!confirm(`Supprimer « ${group.title} » et TOUT son historique ?\n\nLes mois passés disparaissent aussi et le solde `
                   + 'est recalculé. Pour ne plus le compter à partir d\'un mois, utilise plutôt « Arrêter ».')) return;
      try {
        await check(sb.from('fixed_groups').delete().eq('id', group.id));
        await setPocketOf('groups', group.id, null);
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = e.message;
      }
    });
  }
  setTimeout(() => form.querySelector('#x-amount').focus(), 120);
}

/** Changer le montant d'un seul mois (= fixed_month_dialog du PC). */
function fixedMonthSheet(group, ym) {
  const version = fixedVersionAt(group.id, ym);
  const override = fixedOverride(group.id, ym);
  const usual = version ? version.amount_cents : null;
  const shown = override !== null ? override : usual;
  let info = 'Ce montant fixe n’est pas actif ce mois-là.';
  if (version) {
    const due = frDate(dueInMonth(ym, version.day_of_month));
    info = override === null ? `Montant habituel : ${euro(usual)} · échéance le ${due}`
      : `Ce mois : ${override === 0 ? 'pas de paiement' : `modifié à ${euro(override)}`}<br>Montant habituel : ${euro(usual)} · échéance le ${due}`;
  }
  openSheet(`
    <h3>${esc(group.title)}</h3>
    <p class="hint" style="text-align:center">Change le montant d'un seul mois : les autres mois ne bougent pas.</p>
    <div class="monthbar">
      <button type="button" class="icon-btn" id="m-prev" aria-label="Mois précédent">‹</button>
      <span class="label">${monthLabel(ym)}</span>
      <button type="button" class="icon-btn" id="m-next" aria-label="Mois suivant">›</button>
    </div>
    <label class="field" for="m-amount">Montant pour ce mois (€)</label>
    <input class="input big" id="m-amount" inputmode="decimal" autocomplete="off" value="${shown === null ? '' : amountText(shown)}" ${version ? '' : 'disabled'}>
    <p class="hint" style="text-align:center${override !== null ? ';color:var(--orange)' : ''}">${info}</p>
    ${version ? `<div class="actions">
      <button type="button" class="secondary" id="m-skip">Pas de paiement ce mois</button>
      ${override !== null ? `<button type="button" class="secondary" id="m-reset">Rétablir ${euro(usual)}</button>` : ''}
    </div>` : ''}
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" id="m-all">Tous les mois…</button>
      <button type="submit" class="primary" ${version ? '' : 'disabled'}>Enregistrer ce mois</button>
    </div>`, async (form) => {
    const raw = form.querySelector('#m-amount').value.trim();
    const value = raw === '' || /^0+([,.]0*)?$/.test(raw) ? 0 : positiveCents(raw);
    await setFixedMonth(group, ym, value === usual ? null : value);
  });
  const form = $('#sheet-form');
  form.querySelector('#m-prev').addEventListener('click', () => fixedMonthSheet(group, monthShift(`${ym}-01`, -1).slice(0, 7)));
  form.querySelector('#m-next').addEventListener('click', () => fixedMonthSheet(group, monthShift(`${ym}-01`, 1).slice(0, 7)));
  form.querySelector('#m-all').addEventListener('click', () => fixedSheet(group));
  const quick = async (value) => {
    try {
      await setFixedMonth(group, ym, value);
      closeSheet();
      await refresh(true);
    } catch (e) {
      form.querySelector('.error-text').textContent = e.message;
    }
  };
  const skip = form.querySelector('#m-skip'); if (skip) skip.addEventListener('click', () => quick(0));
  const reset = form.querySelector('#m-reset'); if (reset) reset.addEventListener('click', () => quick(null));
}
/** Montant d'un seul mois (0 = pas de paiement) ; null rétablit le montant habituel. */
async function setFixedMonth(group, ym, value) {
  if (value === null) await check(sb.from('fixed_overrides').delete().eq('group_id', group.id).eq('month', ym));
  else await check(sb.from('fixed_overrides').upsert({ group_id: group.id, month: ym, amount_cents: value }, { onConflict: 'group_id,month' }));
}

/** Arrêter un montant fixe à partir d'un mois (= Store.stop_fixed) : les mois d'avant sont conservés. */
function stopFixedSheet(group) {
  const next = nextMonth(todayIso().slice(0, 7));
  openSheet(`
    <h3>Arrêter « ${esc(group.title)} »</h3>
    <p class="hint" style="text-align:center">Les mois précédents sont conservés (historique et solde).<br>
      Plus aucune échéance à partir du mois choisi.</p>
    <label class="field" for="s-start">Plus d'échéance à partir du</label>
    <input class="input" id="s-start" type="date" value="${next}-01">
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Arrêter</button>
    </div>`, async (form) => {
    const start = form.querySelector('#s-start').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('Date invalide.');
    const ym = start.slice(0, 7);
    if (!confirm(`Plus d'échéance à partir de ${monthLabel(ym).toLowerCase()} ?`)) throw new Error('Arrêt annulé.');
    await check(sb.from('fixed_versions').delete().eq('group_id', group.id).gte('start_month', ym));
    await check(sb.from('fixed_versions').update({ end_month: ym }).eq('group_id', group.id).or(`end_month.is.null,end_month.gt.${ym}`));
    await check(sb.from('fixed_overrides').delete().eq('group_id', group.id).gte('month', ym));
  });
}

/** preset (nouvelle transaction) : {kind, category, account, title} — ex. verser ou retirer depuis l'onglet Épargne. */
function transactionSheet(item, preset = null) {
  const editing = !!item;
  const split = editing && item.installments > 1;
  const transfer = editing ? state.data.savings_transfers.find((t) => t.item_id === item.id)
    : (preset && preset.account ? { account_id: preset.account } : null);
  const kind = editing ? item.kind : (preset && preset.kind) || 'Dépense';
  const cat = editing ? item.category : (preset && preset.category)
    || (categories().find((c) => c.name === 'Alimentation') || categories()[0]).name;
  const html = `
    <h3>${editing ? 'Modifier la transaction' : (preset && preset.heading) || 'Nouvelle transaction'}</h3>
    <label class="field" for="f-amount">Montant (€)</label>
    <input class="input big" id="f-amount" inputmode="decimal" autocomplete="off" value="${editing ? amountText(item.total_cents) : ''}">
    <label class="field" for="f-title">Description</label>
    <input class="input" id="f-title" autocomplete="off" value="${editing ? esc(item.title) : esc((preset && preset.title) || '')}">
    <label class="field">Type</label>
    <div class="segmented" id="f-kind">
      <button type="button" data-kind="Dépense" class="${kind === 'Dépense' ? 'on' : ''}" ${split ? 'disabled' : ''}>Dépense</button>
      <button type="button" data-kind="Revenu" class="${kind === 'Revenu' ? 'on' : ''}" ${split ? 'disabled' : ''}>Revenu</button>
    </div>
    <label class="field">Catégorie</label>
    ${categoryPicker(cat)}
    <div id="f-account-box" hidden>
      <label class="field" for="f-account" id="f-account-label">Compte épargne destinataire</label>
      <select class="input" id="f-account">${accountOptions(transfer ? transfer.account_id : null)}</select>
      ${pocketField(editing ? pocketsData().items[item.id] : null)}
    </div>
    <div id="f-meal-box" hidden>
      <label class="field">Type de repas (facultatif)</label>
      <div class="segmented meal" id="f-meal">
        ${Object.entries(MEALS).map(([tag, label]) => `<button type="button" data-meal="${tag}" class="${editing && mealOf(item.id) === tag ? 'on' : ''}">${label}</button>`).join('')}
      </div>
    </div>
    ${targetField(editing ? item.vers_compte_id : null)}
    ${cardConf(state.compte) ? `<label class="check" id="f-card-box"><input type="checkbox" id="f-card"
      ${(editing ? cardConf(state.compte).items.has(item.id) : true) ? 'checked' : ''}> Payé par carte (débit différé)</label>` : ''}
    <label class="field" for="f-date">${split ? 'Date du premier paiement' : 'Date'}</label>
    <input class="input" id="f-date" type="date" value="${editing ? item.first_date : todayIso()}">
    ${split ? `<label class="field" for="f-count">Nombre de mensualités</label>
      <input class="input" id="f-count" inputmode="numeric" value="${item.installments}">` : ''}
    ${editing && item.frequency !== 'Unique' ? `<p class="hint">Répétition : ${esc(item.frequency)}</p>` : ''}
    <p class="error-text"></p>
    <div class="actions">
      ${editing ? '<button type="button" class="secondary danger" id="f-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`;

  openSheet(html, async (form) => {
    const title = form.querySelector('#f-title').value.trim();
    const total = positiveCents(form.querySelector('#f-amount').value);
    if (!title) throw new Error(editing ? 'La description est obligatoire.' : 'Saisis une description.');
    const due = form.querySelector('#f-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Date invalide.');
    const kindValue = form.querySelector('#f-kind .on').dataset.kind;
    const catValue = form.querySelector('#cats .on').dataset.cat;
    let n = 1;
    if (split) {
      n = Number(form.querySelector('#f-count').value.trim());
      if (!Number.isInteger(n)) throw new Error('Nombre de mensualités : saisis un nombre entier.');
      if (n < 2 || n > 120) throw new Error('Nombre de mensualités : entre 2 et 120.');
      if (n > total) throw new Error('Montant trop faible pour ce nombre de mensualités.');
    }
    let accountId = null;
    if (isSavings(catValue, kindValue)) {
      if (n > 1) throw new Error('Les virements épargne ne peuvent pas être fractionnés.');
      accountId = Number(form.querySelector('#f-account').value) || null;
      if (accountId === null) throw new Error('Crée d\'abord un compte épargne (onglet Épargne).');
    }
    const fields = { title, kind: kindValue, category: catValue, total_cents: total, first_date: due,
                     vers_compte_id: chosenTarget(form, accountId) };
    const cardBox = form.querySelector('#f-card');
    const paidByCard = !!cardBox && cardBox.checked && kindValue === 'Dépense' && accountId === null && fields.vers_compte_id === null;
    const pocketSplit = accountId === null ? null : chosenPocket(form, total); // vérifiée avant d'enregistrer
    const mealOn = form.querySelector('#f-meal .on');
    const meal = catValue === MEAL_CATEGORY && kindValue === 'Dépense' && mealOn ? mealOn.dataset.meal : null;
    if (editing) {
      await check(sb.from('items').update({ ...fields, installments: n, frequency: item.frequency }).eq('id', item.id));
      await check(sb.from('savings_transfers').delete().eq('item_id', item.id));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: item.id, account_id: accountId }));
      await setPocketOf('items', item.id, pocketSplit);
      await setMeal(item.id, meal);
      await check(sb.from('confirmations').delete().eq('item_id', item.id));
      if (cardBox) { const value = cardWithItem(item.id, paidByCard); if (value) await saveCard(value); }
    } else {
      const id = newId();
      await check(sb.from('items').insert({ id, compte_id: state.compte, ...fields, installments: 1, frequency: 'Unique', created_at: utcStamp() }));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: id, account_id: accountId }));
      if (pocketSplit !== null) await setPocketOf('items', id, pocketSplit);
      if (meal) await setMeal(id, meal);
      if (paidByCard) { const value = cardWithItem(id, true); if (value) await saveCard(value); }
    }
  });

  const form = $('#sheet-form');
  wirePickers(form, split);
  const del = form.querySelector('#f-delete');
  if (del) {
    del.addEventListener('click', async () => {
      if (!confirm('Supprimer cette transaction et toutes ses échéances ?')) return;
      try {
        await check(sb.from('items').delete().eq('id', item.id));
        await setPocketOf('items', item.id, null);
        await setMeal(item.id, null);
        const value = cardWithItem(item.id, false);
        if (value) await saveCard(value);
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = e.message;
      }
    });
  }
  if (!editing) setTimeout(() => form.querySelector('#f-amount').focus(), 120);
}

function balanceSheet() {
  const ref = balanceReference();
  openSheet(`
    <h3>Solde de référence</h3>
    <p class="hint" style="text-align:center">Indique ton solde à une date précise.<br>
      Les opérations suivantes actualiseront automatiquement le solde.</p>
    <label class="field" for="b-amount">Montant (€)</label>
    <input class="input big" id="b-amount" inputmode="decimal" autocomplete="off" value="${ref ? amountText(+ref.balance_cents) : ''}">
    <label class="field" for="b-date">Date du solde de référence</label>
    <input class="input" id="b-date" type="date" max="${todayIso()}" value="${ref ? ref.as_of : todayIso()}">
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const amount = parseAmount(form.querySelector('#b-amount').value);
    const anchor = form.querySelector('#b-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error('Date invalide.');
    if (anchor > todayIso()) throw new Error('La date de référence ne peut pas être dans le futur.');
    await loadAll(); // photographie à partir des données les plus récentes
    const baseline = {};
    for (const e of balanceEvents(anchor, addDays(todayIso(), 1))) baseline[`${e.row.id}|${e.due}`] = signed(e);
    const value = { ...balances(), [state.compte]: { balance_cents: amount, as_of: anchor, baseline_events: baseline, version: 3 } };
    await check(sb.from('kv_settings').upsert({ key: 'balance', value }, { onConflict: 'user_id,key' }));
  });
}

function passwordSheet() {
  openSheet(`
    <h3>Changer le mot de passe</h3>
    <p class="hint" style="text-align:center">Valable aussi sur le PC.</p>
    <label class="field" for="p-current">Mot de passe actuel</label>
    <input class="input" id="p-current" type="password" autocomplete="current-password">
    <label class="field" for="p-new">Nouveau mot de passe</label>
    <input class="input" id="p-new" type="password" autocomplete="new-password">
    <label class="field" for="p-confirm">Confirmer le nouveau mot de passe</label>
    <input class="input" id="p-confirm" type="password" autocomplete="new-password">
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Changer</button>
    </div>`, async (form) => {
    const current = form.querySelector('#p-current').value;
    const password = form.querySelector('#p-new').value;
    if (!current || !password) throw new Error('Remplis tous les champs.');
    if (password.length < 6) throw new Error('Le nouveau mot de passe doit faire au moins 6 caractères.');
    if (password !== form.querySelector('#p-confirm').value) throw new Error('Les deux nouveaux mots de passe ne correspondent pas.');
    const { error: authError } = await sb.auth.signInWithPassword({ email: state.email, password: current });
    if (authError) throw new Error('Le mot de passe actuel est incorrect.');
    const { error } = await sb.auth.updateUser({ password });
    if (error) {
      const text = (error.message || '').toLowerCase();
      if (text.includes('different')) throw new Error("Le nouveau mot de passe doit être différent de l'ancien.");
      if (text.includes('least') || text.includes('weak')) throw new Error('Mot de passe trop faible : au moins 6 caractères.');
      throw new Error(error.message);
    }
    toast('Mot de passe changé.');
  });
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ------------------------------------------------------------- événements
document.addEventListener('click', async (event) => {
  const t = event.target;
  if (t.closest('[data-close]')) { closeSheet(); return; }
  const tab = t.closest('#tabs button');
  if (tab) { state.tab = tab.dataset.tab; window.scrollTo(0, 0); render(); return; }
  if (t.closest('#fab')) { transactionSheet(null); return; }
  if (t.closest('#sync')) { refresh(true); return; }
  if (t.closest('#switch')) { openCompte(null); render(); return; }
  if (t.closest('#add-compte')) { compteSheet(); return; }
  const compte = t.closest('[data-compte]');
  if (compte) {
    openCompte(Number(compte.dataset.compte));
    state.tab = 'dashboard';
    state.selected = currentMonth();
    state.current = state.selected;
    state.query = '';
    state.cats = [];
    render();
    return;
  }
  if (t.closest('#balance')) { balanceSheet(); return; }
  if (t.closest('#upcoming')) { upcomingSheet(); return; }
  if (t.closest('#notes')) { notesSheet(); return; }
  if (t.closest('#add-note')) { noteSheet(null); return; }
  const noteRow = t.closest('[data-note]');
  if (noteRow) {
    const note = state.data.notes.find((n) => n.id === Number(noteRow.dataset.note));
    if (note) noteSheet(note);
    return;
  }
  if (t.closest('#cat-filter')) { state.catsOpen = !state.catsOpen; render(); return; }
  if (t.closest('#cat-reset')) { state.cats = []; render(); return; }
  const filterCat = t.closest('[data-filter-cat]');
  if (filterCat) {
    const name = filterCat.dataset.filterCat;
    state.cats = state.cats.includes(name) ? state.cats.filter((n) => n !== name) : [...state.cats, name];
    render();
    return;
  }
  if (t.closest('#today')) { state.selected = currentMonth(); render(); return; }
  if (t.closest('#add-fixed')) { fixedSheet(); return; }
  if (t.closest('#add-saving')) { savingSheet(); return; }
  const move = t.closest('[data-deposit], [data-withdraw]');
  if (move) {
    const out = !!move.dataset.withdraw;
    const accountId = Number(move.dataset.withdraw || move.dataset.deposit);
    const savingsCat = (categories().find((c) => c.savings) || { name: 'Épargne' }).name;
    transactionSheet(null, { kind: out ? 'Revenu' : 'Dépense', category: savingsCat, account: accountId,
                             title: out ? 'Retrait épargne' : 'Virement épargne',
                             heading: out ? 'Retirer de l’épargne' : 'Verser sur l’épargne' });
    return;
  }
  const savingRow = t.closest('[data-saving]');
  if (savingRow) {
    const account = state.data.savings_accounts.find((a) => a.id === Number(savingRow.dataset.saving));
    if (account) savingSheet(account);
    return;
  }
  const fixedRow = t.closest('[data-fixed]');
  if (fixedRow) {
    const group = fixedGroup(Number(fixedRow.dataset.fixed));
    if (group && group.received) { toast(`Ce virement se modifie depuis ${compteName(group.compte_id)}.`); return; }
    if (group) fixedSheet(group);
    return;
  }
  if (t.closest('#password-change')) { passwordSheet(); return; }
  if (t.closest('#logout')) {
    if (!confirm('Se déconnecter de Kompte sur ce téléphone ?')) return;
    await sb.auth.signOut();
    try { localStorage.removeItem('kompte-cache'); } catch (e) { /* rien */ }
    state.all = null;
    state.data = null;
    state.compte = null;
    state.email = '';
    renderLogin();
    return;
  }
  const month = t.closest('[data-month]');
  if (month) { state.selected = monthShift(state.selected + '-01', +month.dataset.month).slice(0, 7); render(); return; }
  const row = t.closest('[data-item]');
  if (row) {
    const id = Number(row.dataset.item);
    if (id < 0) {
      const group = fixedGroup(-id);
      if (group && group.received) { toast(`Ce virement se modifie depuis ${compteName(group.compte_id)}.`); return; }
      if (group) fixedMonthSheet(group, (row.dataset.due || todayIso()).slice(0, 7));
      return;
    }
    const item = state.data.items.find((i) => i.id === id);
    if (item && item.received) { toast(`Ce virement se modifie depuis ${compteName(item.compte_id)}.`); return; }
    if (item) transactionSheet(item);
  }
});

// Le début du mois s'applique tout de suite, puis part en ligne.
document.addEventListener('change', async (event) => {
  if (['card-enabled', 'card-cutoff', 'card-debit'].includes(event.target.id)) {
    const raw = (state.all.kv.card && typeof state.all.kv.card === 'object') ? state.all.kv.card : {};
    const mine = raw[state.compte] || { enabled: false, cutoff: 19, debit: 31, items: [] };
    const field = { 'card-enabled': 'enabled', 'card-cutoff': 'cutoff', 'card-debit': 'debit' }[event.target.id];
    const v = field === 'enabled' ? event.target.value === '1' : Number(event.target.value);
    const value = { ...raw, [state.compte]: { ...mine, [field]: v } };
    state.all.kv.card = value;
    render();
    try {
      await saveCard(value);
    } catch (e) {
      toast('Enregistrement impossible : réessaie.');
      refresh(true);
    }
    return;
  }
  if (event.target.id !== 'month-start') return;
  const value = { ...(state.all.kv.month_start || {}), [state.compte]: Number(event.target.value) };
  state.all.kv.month_start = value;
  render();
  try {
    await check(sb.from('kv_settings').upsert({ key: 'month_start', value }, { onConflict: 'user_id,key' }));
  } catch (e) {
    toast('Enregistrement impossible : réessaie.');
    refresh(true);
  }
});

let searchTimer = null;
// Notes : « 12,50 + 30 = » reçoit son résultat dès que le = est tapé.
document.addEventListener('input', (event) => {
  const box = event.target;
  if (box.id !== 'n-body' || (event.inputType || '').startsWith('delete')) return;
  const caret = box.selectionStart;
  const line = box.value.slice(box.value.lastIndexOf('\n', caret - 1) + 1, caret);
  if (!line.endsWith('=')) return;
  const result = quickCalc(line);
  if (result !== null) box.setRangeText(` ${result}`, caret, caret, 'end');
});

document.addEventListener('input', (event) => {
  if (event.target.id !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    const pos = event.target.selectionStart;
    render();
    const input = $('#search');
    input.focus();
    input.setSelectionRange(pos, pos);
  }, 300);
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'login') return;
  event.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const error = $('#login-error');
  if (!email || !password) { error.textContent = 'Saisis ton e-mail et ton mot de passe.'; return; }
  error.textContent = '';
  const { data, error: authError } = await sb.auth.signInWithPassword({ email, password });
  if (authError) {
    error.textContent = /invalid/i.test(authError.message) ? 'E-mail ou mot de passe incorrect.' : authError.message;
    return;
  }
  state.tab = 'dashboard';
  startApp(data.session);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.email) refresh();
});

function startApp(session) {
  state.email = session.user.email;
  render();
  refresh(state.all === null);
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const { data } = await sb.auth.getSession();
  if (!data.session) { renderLogin(); return; }
  try {
    const cache = JSON.parse(localStorage.getItem('kompte-cache') || 'null');
    if (cache && cache.email === data.session.user.email && cache.data.comptes) {
      state.all = cache.data;
      openCompte(null);
      state.version = cache.version;
    }
  } catch (e) { /* cache illisible : on recharge */ }
  startApp(data.session);
}

setInterval(() => { if (document.visibilityState === 'visible' && state.email) refresh(); }, POLL_MS);
boot();
