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
      list.push({ name, color: c.color, icon: c.icon || 'Divers', savings: hasFlag ? !!c.savings : name === 'Épargne',
                  subs: cleanSubs(c.subs) || DEFAULT_SUBS[name] || [] });
    }
  }
  if (list.length) return list;
  return Object.entries(DEFAULT_COLORS).map(([name, color]) => ({ name, color, icon: name, savings: name === 'Épargne',
                                                                  subs: DEFAULT_SUBS[name] || [] }));
}
function category(name) {
  return categories().find((c) => c.name === name) || { name, color: '#9CA3AF', icon: 'Divers', savings: false, subs: [] };
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

// ------------------------------------------------ catégories et sous-catégories (= kompte.py)
// Une catégorie : {name, color, icon, savings, subs: [{id, name}]} dans le réglage partagé « categories ».
// Une opération garde l'id de sa sous-catégorie dans « meal_tags » {transaction: id} (nom d'origine : les repas).
const DEFAULT_SUBS = { Alimentation: [{ id: 'midi', name: 'Repas du midi' }, { id: 'resto', name: 'Restaurant' }] };
const ICONS = Object.keys(DEFAULT_COLORS);
function cleanSubs(subs) {
  if (!Array.isArray(subs)) return null;
  const seen = new Set();
  return subs.filter((s) => s && typeof s.name === 'string' && s.name.trim() && s.id !== undefined && s.id !== null)
    .map((s) => ({ id: String(s.id), name: s.name.trim() }))
    .filter((s) => !seen.has(s.id) && seen.add(s.id));
}
function subsOf(categoryName) { return category(categoryName).subs || []; }
/** Sous-catégorie d'une opération (seulement si elle existe encore dans sa catégorie), sinon null. */
/** (Une échéance fixe a un numéro négatif : sa sous-catégorie est celle du montant fixe, réglage « fixed_subs ».) */
function subOf(row) {
  if (!row) return null;
  const tags = state.all && state.all.kv[row.id < 0 ? 'fixed_subs' : 'meal_tags'];
  const id = tags && typeof tags === 'object' ? tags[Math.abs(row.id)] : null;
  return id === null || id === undefined ? null : subsOf(row.category).find((s) => s.id === String(id)) || null;
}
/** Sous-catégorie d'une transaction, ou d'un montant fixe (fixed = true, numéro du montant fixe). */
async function setSub(itemId, subId, fixed = false) {
  const key = fixed ? 'fixed_subs' : 'meal_tags';
  const raw = state.all.kv[key] && typeof state.all.kv[key] === 'object' ? state.all.kv[key] : {};
  if ((raw[itemId] === undefined ? null : String(raw[itemId])) === subId) return;
  const value = { ...raw };
  if (subId) value[itemId] = subId; else delete value[itemId];
  state.all.kv[key] = value;
  await check(sb.from('kv_settings').upsert({ key, value }, { onConflict: 'user_id,key' }));
}
/** Enregistre la liste complète des catégories (partagée par tous les comptes et le PC). */
async function saveCategories(list) {
  const raw = state.all.kv.categories && typeof state.all.kv.categories === 'object' ? state.all.kv.categories : {};
  const value = { ...raw, categories: list.map((c) => ({ name: c.name, color: c.color, icon: c.icon, savings: !!c.savings,
                                                           subs: c.subs || [] })) };
  state.all.kv.categories = value;
  await check(sb.from('kv_settings').upsert({ key: 'categories', value }, { onConflict: 'user_id,key' }));
}

function categoriesSection() {
  return `<label class="field">Catégories (communes à tous les comptes)</label>
    <div class="list">${categories().map((c) => `<button type="button" class="row" data-category="${esc(c.name)}">
        ${catIcon(c.name)}
        <span class="body"><span class="title" style="color:${c.color}">${esc(c.name)}</span>
          <span class="sub">${c.subs.length ? esc(c.subs.map((s) => s.name).join(' · ')) : 'Pas de sous-catégorie'}${c.savings ? ' · épargne' : ''}</span></span>
      </button>`).join('')}</div>
    <button type="button" class="secondary wide" id="add-category" style="margin-top:8px">+ Nouvelle catégorie</button>`;
}

function subRow(s) {
  return `<div class="pocket-edit sub-edit" data-sub="${s ? esc(s.id) : ''}">
      <input class="input" placeholder="Nom (ex. Restaurant)" autocomplete="off" value="${s ? esc(s.name) : ''}">
      <button type="button" aria-label="Supprimer la sous-catégorie">✕</button>
    </div>`;
}

function categorySheet(original = null) {
  const c = original ? category(original) : { name: '', color: '#22D3EE', icon: 'Divers', savings: false, subs: [] };
  openSheet(`
    <h3>${original ? 'Modifier la catégorie' : 'Nouvelle catégorie'}</h3>
    <label class="field" for="c-name">Nom</label>
    <input class="input" id="c-name" autocomplete="off" value="${esc(c.name)}">
    <label class="field" for="c-icon">Pictogramme</label>
    <select class="input" id="c-icon">${ICONS.map((i) => `<option ${i === c.icon ? 'selected' : ''}>${esc(i)}</option>`).join('')}</select>
    <label class="field" for="c-color">Couleur</label>
    <input class="input color" id="c-color" type="color" value="${c.color.toLowerCase()}">
    <label class="check"><input type="checkbox" id="c-savings" ${c.savings ? 'checked' : ''}> Virements vers un compte épargne</label>
    <label class="field">Sous-catégories</label>
    <p class="hint">Facultatives : à choisir sur une opération de cette catégorie (ex. Restaurant). Elles peuvent avoir un budget.</p>
    <div id="c-subs">${c.subs.map(subRow).join('')}</div>
    <button type="button" class="secondary wide" id="c-add-sub" style="margin-top:8px">+ Ajouter une sous-catégorie</button>
    <p class="error-text"></p>
    <div class="actions">
      ${original ? '<button type="button" class="secondary danger" id="c-delete">Supprimer</button>' : ''}
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const name = form.querySelector('#c-name').value.trim();
    if (!name) throw new Error('Donne un nom à la catégorie.');
    const list = categories();
    if (name !== original && list.some((x) => x.name === name)) throw new Error('Ce nom existe déjà.');
    const subs = [...form.querySelectorAll('.sub-edit')].map((row) => {
      const subName = row.querySelector('input').value.trim();
      if (!subName) throw new Error('Donne un nom à chaque sous-catégorie (ou supprime-la).');
      return { id: row.dataset.sub || String(newId()), name: subName };
    });
    const entry = { name, color: form.querySelector('#c-color').value.toUpperCase(), icon: form.querySelector('#c-icon').value,
                    savings: form.querySelector('#c-savings').checked, subs };
    const next = original ? list.map((x) => (x.name === original ? entry : x)) : [...list, entry];
    if (original && name !== original) {
      // Renommage : l'historique suit (transactions, montants fixes de tous les comptes, budgets).
      await check(sb.from('items').update({ category: name }).eq('category', original));
      await check(sb.from('fixed_groups').update({ category: name }).eq('category', original));
      const budgets = state.all.kv.budgets && typeof state.all.kv.budgets === 'object' ? state.all.kv.budgets : null;
      if (budgets) {
        const renamed = Object.fromEntries(Object.entries(budgets).map(([compte, mine]) => [compte,
          mine && typeof mine === 'object' ? Object.fromEntries(Object.entries(mine).map(([k, v]) =>
            [k === original ? name : k.startsWith(`${original}|`) ? name + k.slice(original.length) : k, v])) : mine]));
        state.all.kv.budgets = renamed;
        await check(sb.from('kv_settings').upsert({ key: 'budgets', value: renamed }, { onConflict: 'user_id,key' }));
      }
    }
    await saveCategories(next);
  });
  const form = $('#sheet-form');
  const box = form.querySelector('#c-subs');
  box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.closest('.sub-edit').remove(); });
  form.querySelector('#c-add-sub').addEventListener('click', () => {
    box.insertAdjacentHTML('beforeend', subRow(null));
    box.lastElementChild.querySelector('input').focus();
  });
  if (original) {
    form.querySelector('#c-delete').addEventListener('click', async () => {
      const list = categories();
      const used = state.all.items.some((i) => i.category === original) || state.all.fixed_groups.some((g) => g.category === original);
      if (list.length <= 1) { form.querySelector('.error-text').textContent = 'Il faut garder au moins une catégorie.'; return; }
      if (used) {
        form.querySelector('.error-text').textContent = 'Cette catégorie contient des opérations. Change-les de catégorie avant de la supprimer.';
        return;
      }
      if (!confirm(`Supprimer « ${original} » ?`)) return;
      try {
        await saveCategories(list.filter((x) => x.name !== original));
        closeSheet();
        await refresh(true);
      } catch (e) {
        form.querySelector('.error-text').textContent = e.message;
      }
    });
  }
}

// ------------------------------------------------- budgets par catégorie (= kompte.py)
// Réglage partagé « budgets » : {compte: {catégorie: montant mensuel}} ; « Catégorie|id » vise une sous-catégorie.
// Dépensé = dépenses du mois déjà passées.
// Historique : chaque budget est une liste [[mois de début, montant]] (0 = plus de budget) ; une modification
// vaut à partir du mois en cours, les mois passés gardent le leur. Ancien format (un nombre) = depuis BUDGETS_SINCE.
// Report : ce qui n'est pas dépensé s'ajoute au mois suivant (cumulé) ; un dépassement n'est pas retiré.
const BUDGETS_SINCE = '2026-11';
function budgetVersions(compte) {
  const raw = state.all && state.all.kv.budgets;
  const mine = raw && typeof raw === 'object' && raw[compte] && typeof raw[compte] === 'object' ? raw[compte] : {};
  const out = {};
  for (const [key, v] of Object.entries(mine)) {
    const list = Number.isInteger(v) ? [[BUDGETS_SINCE, v]] : Array.isArray(v) ? v.filter((x) => Array.isArray(x)
      && typeof x[0] === 'string' && /^\d{4}-\d{2}$/.test(x[0]) && Number.isInteger(x[1]) && x[1] >= 0) : [];
    if (list.length) out[key] = [...list].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  return out;
}
/** Budget de base d'un mois (0 si aucun). */
function budgetAt(versions, ym) {
  let amount = 0;
  for (const [start, cents] of versions) if (start <= ym) amount = cents;
  return amount;
}
/** Budgets en vigueur pour ce mois : {clé: montant}. */
function budgetsOf(compte, ym = currentMonth()) {
  return Object.fromEntries(Object.entries(budgetVersions(compte)).map(([k, v]) => [k, budgetAt(v, ym)]).filter(([, c]) => c > 0));
}
function budgetLabel(key) {
  const i = key.indexOf('|');
  if (i < 0) return key;
  const sub = subsOf(key.slice(0, i)).find((s) => s.id === key.slice(i + 1));
  return sub ? sub.name : key.slice(i + 1);
}
/** Catégories qui peuvent avoir un budget : toutes sauf Revenus, et leurs sous-catégories. */
function budgetKeys() {
  const keys = [];
  for (const c of categories()) {
    if (c.name === 'Revenus') continue;
    keys.push(c.name, ...c.subs.map((s) => `${c.name}|${s.id}`));
  }
  return keys;
}
/** Dépenses déjà passées d'un mois, par catégorie et « catégorie|sous-catégorie ». */
function budgetSpent(ym) {
  const today = todayIso();
  const spent = {};
  for (const e of summary(ym).events) {
    if (e.row.kind !== 'Dépense' || e.due > today) continue;
    spent[e.row.category] = (spent[e.row.category] || 0) + e.amount;
    const sub = subOf(e.row);
    if (sub) {
      const key = `${e.row.category}|${sub.id}`;
      spent[key] = (spent[key] || 0) + e.amount;
    }
  }
  return spent;
}
/** [{key, label, base, carry, budget (= base + report), spent}] pour le mois choisi, dans l'ordre des catégories. */
function budgetRows(ym) {
  const versions = budgetVersions(state.compte);
  const order = budgetKeys();
  const spentCache = {};
  const spentOf = (m) => (spentCache[m] = spentCache[m] || budgetSpent(m));
  const rows = [];
  for (const key of Object.keys(versions).filter((k) => order.includes(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
    const list = versions[key];
    const base = budgetAt(list, ym);
    if (!base) continue;
    // Report cumulé depuis le premier mois du budget (jamais avant BUDGETS_SINCE).
    let carry = 0;
    let m = list[0][0] > BUDGETS_SINCE ? list[0][0] : BUDGETS_SINCE;
    while (m < ym) {
      const b = budgetAt(list, m);
      carry = b ? Math.max(0, b + carry - (spentOf(m)[key] || 0)) : 0;
      m = nextMonth(m);
    }
    rows.push({ key, label: budgetLabel(key), base, carry, budget: base + carry, spent: spentOf(ym)[key] || 0 });
  }
  return rows;
}
/** Barre de budget : verte, orange à partir de 80 %, rouge au-delà du budget. */
function budgetBar(spent, budget) {
  const ratio = budget > 0 ? spent / budget : 0;
  const color = ratio > 1 ? '--red' : ratio >= 0.8 ? '--orange' : '--green';
  return `<div class="bar"><span style="width:${Math.min(100, Math.round(ratio * 100))}%;background:var(${color})"></span></div>`;
}
/** Case du tableau de bord : les sous-budgets ne comptent pas dans le total (déjà dans Alimentation). */
function budgetTile(ym) {
  const rows = budgetRows(ym);
  if (!rows.length) {
    return `<button type="button" class="metric wide" id="budgets"><small>Budgets du mois ›</small>
      <b style="font-size:15px">Définir mes budgets par catégorie</b></button>`;
  }
  const main = rows.filter((r) => !r.key.includes('|'));
  const spent = main.reduce((t, r) => t + r.spent, 0);
  const budget = main.reduce((t, r) => t + r.budget, 0);
  const over = rows.filter((r) => r.spent > r.budget).length;
  return `<button type="button" class="metric wide" id="budgets">
      <small>Budgets du mois ›</small>
      <b>${euro(spent)} <span class="of">sur ${euro(budget)}</span></b>
      ${budgetBar(spent, budget)}
      <span class="carry" style="color:var(${over ? '--red' : '--muted'})">${over ? `${over} budget${over > 1 ? 's' : ''} dépassé${over > 1 ? 's' : ''}`
        : `Reste ${euro(Math.max(0, budget - spent))}`}</span>
    </button>`;
}

function budgetsSheet() {
  const ym = state.selected;
  const rows = budgetRows(ym);
  const lines = rows.map((r) => {
    const rest = r.budget - r.spent;
    return `<div class="budget ${r.key.includes('|') ? 'sub' : ''}">
        <div class="pocket-line"><span>${r.key.includes('|') ? '↳ ' + esc(r.label) : catIcon(r.key) + esc(r.label)}</span>
          <span>${euro(r.spent)} <span class="pct">/ ${euro(r.budget)}</span></span></div>
        ${budgetBar(r.spent, r.budget)}
        <small style="color:var(${rest < 0 ? '--red' : '--muted'})">${rest < 0 ? `Dépassé de ${euro(-rest)}` : `Reste ${euro(rest)}`}${r.carry ? ` · dont report ${euro(r.carry)}` : ''}</small>
      </div>`;
  }).join('');
  openSheet(`
    <h3>Budgets · ${monthLabel(ym)}</h3>
    <p class="hint" style="text-align:center">Dépenses déjà passées ce mois-ci, comparées à ton budget.
      Ce qui n'est pas dépensé s'ajoute au mois suivant (report).</p>
    ${lines || '<p class="empty">Aucun budget défini.</p>'}
    <button type="button" class="primary wide" id="b-edit" style="margin-top:14px">${rows.length ? 'Modifier les budgets' : 'Définir mes budgets'}</button>
    <div class="actions"><button type="button" class="secondary" data-close>Fermer</button></div>`, async () => {});
  $('#sheet-form').querySelector('#b-edit').addEventListener('click', budgetEditSheet);
}

function budgetEditSheet() {
  const now = currentMonth();
  const budgets = budgetsOf(state.compte, now);
  const fields = budgetKeys().map((key) => `<div class="pocket-split ${key.includes('|') ? 'sub' : ''}">
      <span>${key.includes('|') ? '↳ ' + esc(budgetLabel(key)) : catIcon(key) + esc(key)}</span>
      <input class="input" inputmode="decimal" autocomplete="off" placeholder="—" data-budget="${esc(key)}"
        value="${budgets[key] ? amountText(budgets[key]) : ''}"></div>`).join('');
  openSheet(`
    <h3>Mes budgets mensuels</h3>
    <p class="hint" style="text-align:center">Un montant par mois pour ${esc(compteName(state.compte))}. Laisse vide : pas de budget.<br>
      Les changements valent à partir de ${monthLabel(now).toLowerCase()} ; les mois passés gardent leurs budgets.</p>
    ${fields}
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Enregistrer</button>
    </div>`, async (form) => {
    const mine = budgetVersions(state.compte);
    for (const input of form.querySelectorAll('input[data-budget]')) {
      const key = input.dataset.budget;
      const cents = input.value.trim() ? positiveCents(input.value) : 0;
      const list = mine[key] || [];
      if (budgetAt(list, now) === cents) continue;
      // Nouveau montant à partir de ce mois : les mois d'avant restent intacts.
      mine[key] = [...list.filter(([start]) => start < now), [now, cents]];
    }
    const raw = state.all.kv.budgets && typeof state.all.kv.budgets === 'object' ? state.all.kv.budgets : {};
    const value = { ...raw, [state.compte]: mine };
    state.all.kv.budgets = value;
    await check(sb.from('kv_settings').upsert({ key: 'budgets', value }, { onConflict: 'user_id,key' }));
  });
}

// ------------------------------------------------ export Excel d'un mois (= export_month du PC)
// Fichier .xlsx écrit à la main (XML + zip sans compression) : aucune bibliothèque à charger.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/** Archive zip (méthode « stockée ») : [[nom, texte]] → Uint8Array. */
function zipFiles(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true); dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((t, p) => t + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Cellule : {t: texte} | {n: nombre, s: style} | {d: 'AAAA-MM-JJ'} ; styles 1 = gras, 2 = €, 3 = date, 4 = € gras. */
function sheetXml(rows, widths) {
  const col = (i) => { let s = ''; for (i += 1; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const cell = (c, r, i) => {
    if (c === null || c === undefined || c === '') return '';
    const ref = `${col(i)}${r}`;
    if (typeof c !== 'object') c = { t: c };
    if (c.d) return `<c r="${ref}" s="3"><v>${Math.round((Date.UTC(+c.d.slice(0, 4), +c.d.slice(5, 7) - 1, +c.d.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000)}</v></c>`;
    if (c.n !== undefined) return `<c r="${ref}" s="${c.s || 2}"><v>${(c.n / 100).toFixed(2)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${c.s ? ` s="${c.s}"` : ''}><is><t xml:space="preserve">${xmlEsc(c.t)}</t></is></c>`;
  };
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((c, i) => cell(c, r + 1, i)).join('')}</row>`).join('')}</sheetData>
</worksheet>`;
}
function workbookFiles(sheets) {
  const ns = 'http://schemas.openxmlformats.org/';
  return [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets>
${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${ns}package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="${ns}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${ns}spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths)]),
  ];
}

/** Les trois feuilles d'un mois : opérations, résumé, budgets (mêmes contenus que le PC). */
function monthSheets(ym) {
  const { income, out, events } = summary(ym);
  const B = (t) => ({ t, s: 1 });
  const ops = [[B('Date'), B('Description'), B('Catégorie'), B('Sous-catégorie'), B('Type'), B('Montant'), B('Détails')]];
  for (const e of [...events].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))) {
    const r = e.row;
    const details = [];
    if (r.id < 0) details.push('montant fixe');
    if (isCard(r)) details.push('carte');
    if (debitDate(r, e.due) !== e.due) details.push(`débit le ${frDate(debitDate(r, e.due))}`);
    if (transferNote(r)) details.push(transferNote(r));
    const sub = subOf(r);
    ops.push([{ d: e.due }, r.title, r.category, sub ? sub.name : '', r.kind, { n: signed(e) }, details.join(' · ')]);
  }
  const byCat = {};
  for (const e of events) if (e.row.kind === 'Dépense') byCat[e.row.category] = (byCat[e.row.category] || 0) + e.amount;
  const resume = [[B('Compte'), compteName(state.compte)], [B('Mois'), monthLabel(ym)],
    [B('Période'), periodText(ym) || 'Du 1er au dernier jour du mois'], [],
    [B('Revenus'), { n: income }], [B('Dépenses'), { n: out }], [B('Bilan du mois'), { n: income - out, s: 4 }], [],
    [B('Dépenses par catégorie'), B('Montant')],
    ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => [c, { n: v }])];
  const budgets = [[B('Budget'), B('Base'), B('Report'), B('Budget du mois'), B('Dépensé'), B('Reste')],
    ...budgetRows(ym).map((r) => [r.key.includes('|') ? `${r.key.split('|')[0]} › ${r.label}` : r.label,
      { n: r.base }, { n: r.carry }, { n: r.budget }, { n: r.spent }, { n: r.budget - r.spent }])];
  return [{ name: 'Opérations', rows: ops, widths: [12, 30, 16, 18, 10, 14, 34] },
          { name: 'Résumé', rows: resume, widths: [26, 34] },
          { name: 'Budgets', rows: budgets, widths: [30, 13, 13, 16, 13, 13] }];
}
function monthWorkbook(ym) { return zipFiles(workbookFiles(monthSheets(ym))); }

function exportSheet() {
  const now = currentMonth();
  const months = Array.from({ length: 25 }, (_, i) => monthShift(`${now}-01`, -i).slice(0, 7));
  openSheet(`
    <h3>Exporter un mois en Excel</h3>
    <p class="hint" style="text-align:center">Pour ${esc(compteName(state.compte))} : toutes les opérations du mois,
      un résumé (revenus, dépenses, catégories) et les budgets.</p>
    <label class="field" for="x-month">Mois</label>
    <select class="input" id="x-month">${months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('')}</select>
    <p class="error-text"></p>
    <div class="actions">
      <button type="button" class="secondary" data-close>Annuler</button>
      <button type="submit" class="primary">Créer le fichier</button>
    </div>`, async (form) => {
    const ym = form.querySelector('#x-month').value;
    const name = `Kompte ${compteName(state.compte)} ${ym}.xlsx`.replace(/[\\/:*?"<>|]/g, '-');
    const file = new File([monthWorkbook(ym)], name,
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await saveFile(file);
  });
}

/** iPhone / iPad (y compris un iPad qui se présente comme un Mac). */
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
/** Donne un fichier à l'utilisateur. iPhone : feuille de partage (« Enregistrer dans Fichiers », Mail…).
    Android et ordinateur : téléchargement, car Chrome refuse de partager un fichier Excel (« Permission denied »).
    Si le partage est refusé, on télécharge quand même. */
async function saveFile(file) {
  if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // partage annulé par l'utilisateur
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(isIOS() ? 'Fichier prêt : touche « Partager » pour l’enregistrer.' : 'Fichier enregistré dans Téléchargements.');
}

// ------------------------------------------------- vérification avec la banque
// Lecture d'un relevé téléchargé sur le site de la banque (OFX, QIF ou CSV), puis rapprochement automatique
// avec les opérations de Kompte : même montant, dates à 4 jours près. Rien n'est enregistré par l'import.
const checkState = { file: null, ops: null, balance: null, error: '' };

/** Texte d'un fichier : UTF-8, sinon Windows-1252 (cas courant des banques françaises). */
async function readBankFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
}
/** « -1 234,56 », « 1234.56 », « 12,5 € » → centimes (null si illisible). */
function bankCents(text) {
  if (text === undefined || text === null) return null;
  let s = String(text).replace(/[\s  €]/g, '').replace(/^\+/, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
/** « 06/11/2026 », « 06/11/26 », « 2026-11-06 », « 20261106 » → « 2026-11-06 » (null si illisible). */
function bankDate(text) {
  const s = String(text || '').trim();
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}
function parseOfx(text) {
  const tag = (block, name) => { const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i')); return m ? m[1].trim() : ''; };
  const ops = [];
  for (const block of text.split(/<STMTTRN>/i).slice(1)) {
    const body = block.split(/<\/STMTTRN>/i)[0];
    const date = bankDate(tag(body, 'DTPOSTED')), cents = bankCents(tag(body, 'TRNAMT'));
    const label = [tag(body, 'NAME'), tag(body, 'MEMO')].filter(Boolean).join(' · ');
    if (date && cents !== null) ops.push({ date, cents, label: label || 'Opération' });
  }
  let balance = null;
  const ledger = text.split(/<LEDGERBAL>/i)[1];
  if (ledger) {
    const cents = bankCents(tag(ledger, 'BALAMT')), date = bankDate(tag(ledger, 'DTASOF'));
    if (cents !== null) balance = { cents, date };
  }
  return { ops, balance };
}
function parseQif(text) {
  const ops = [];
  let cur = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const code = line[0], value = line.slice(1).trim();
    if (code === 'D') cur.date = bankDate(value.replace(/'/g, '/'));
    else if (code === 'T' || code === 'U') cur.cents = bankCents(value);
    else if (code === 'P') cur.label = value;
    else if (code === 'M' && !cur.label) cur.label = value;
    else if (code === '^') {
      if (cur.date && cur.cents !== null && cur.cents !== undefined) ops.push({ date: cur.date, cents: cur.cents, label: cur.label || 'Opération' });
      cur = {};
    }
  }
  return { ops, balance: null };
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const delim = [';', '\t', ','].map((d) => [d, (lines.slice(0, 15).join('\n').match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) || []).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const split = (line) => {
    const out = []; let cell = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
      else if (ch === delim && !quoted) { out.push(cell.trim()); cell = ''; }
      else cell += ch;
    }
    out.push(cell.trim());
    return out;
  };
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const headerAt = lines.findIndex((l) => /date/.test(norm(l)) && /(montant|debit|credit)/.test(norm(l)));
  if (headerAt < 0) return { ops: [], balance: null };
  const head = split(lines[headerAt]).map(norm);
  const find = (...words) => head.findIndex((h) => words.some((w) => h.includes(w)));
  const iDate = head.findIndex((h) => h.includes('date') && h.includes('op')) >= 0 ? head.findIndex((h) => h.includes('date') && h.includes('op')) : find('date');
  const iLabel = find('libelle', 'operation', 'description', 'intitule');
  const iAmount = find('montant');
  const iDebit = find('debit'), iCredit = find('credit');
  const ops = [];
  for (const line of lines.slice(headerAt + 1)) {
    const cells = split(line);
    const date = bankDate(cells[iDate]);
    if (!date) continue;
    let cents = iAmount >= 0 ? bankCents(cells[iAmount]) : null;
    if (cents === null && (iDebit >= 0 || iCredit >= 0)) {
      const debit = bankCents(cells[iDebit]), credit = bankCents(cells[iCredit]);
      if (debit) cents = -Math.abs(debit); else if (credit) cents = Math.abs(credit);
    }
    if (cents === null || cents === 0) continue;
    ops.push({ date, cents, label: (iLabel >= 0 ? cells[iLabel] : '').replace(/\s+/g, ' ') || 'Opération' });
  }
  return { ops, balance: null };
}
function parseBankFile(text) {
  if (/<OFX>|<STMTTRN>/i.test(text)) return parseOfx(text);
  if (/^!Type:/im.test(text)) return parseQif(text);
  return parseCsv(text);
}

/** Solde attendu par Kompte à la fin d'un jour donné (ce qui a déjà touché le compte). */
function balanceAt(day) {
  const now = getBalance();
  if (now === null) return null;
  const today = todayIso();
  if (day >= today) return now;
  let after = 0;
  for (const e of balanceEvents(addDays(day, 1), addDays(today, 1))) after += signed(e);
  return now - after;
}
/** Rapproche le relevé et Kompte. Les achats carte d'un même prélèvement forment une seule ligne, comme à la banque. */
function matchBank(ops) {
  const dates = ops.map((o) => o.date).sort();
  const from = dates[0], to = dates[dates.length - 1];
  const lines = [], cards = {};
  for (const e of balanceEvents(addDays(from, -5), addDays(to, 6))) {
    const debit = debitDate(e.row, e.due);
    if (isCard(e.row)) {
      const c = cards[debit] = cards[debit] || { date: debit, cents: 0, label: `Relevé carte du ${frDate(debit)}`, card: true };
      c.cents += signed(e);
    } else {
      lines.push({ date: debit, cents: signed(e), label: e.row.title, row: e.row });
    }
  }
  lines.push(...Object.values(cards));
  const free = new Set(lines.map((_, i) => i));
  const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  const matched = [], bankOnly = [];
  for (const op of [...ops].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    let best = -1;
    for (const i of free) {
      if (lines[i].cents !== op.cents || dayDiff(lines[i].date, op.date) > 4) continue;
      if (best < 0 || dayDiff(lines[i].date, op.date) < dayDiff(lines[best].date, op.date)) best = i;
    }
    if (best >= 0) { free.delete(best); matched.push({ bank: op, kompte: lines[best] }); } else bankOnly.push(op);
  }
  const kompteOnly = [...free].map((i) => lines[i]).filter((l) => l.date >= from && l.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { from, to, matched, bankOnly, kompteOnly };
}

function checkLine(date, label, cents, extra = '') {
  return `<div class="row static"><span class="body"><span class="title">${esc(label)}</span>
      <span class="sub">${frDate(date)}${extra}</span></span>
      <span class="amount ${cents >= 0 ? 'plus' : 'minus'}">${cents >= 0 ? '+' : ''}${euro(cents)}</span></div>`;
}

function renderCheck() {
  const balance = getBalance();
  const st = checkState;
  let result = '';
  if (st.error) result = `<p class="error-text" style="text-align:center">${esc(st.error)}</p>`;
  if (st.ops) {
    const r = matchBank(st.ops);
    const gap = st.balance && balance !== null ? st.balance.cents - balanceAt(st.balance.date || todayIso()) : null;
    result += `
      <div class="check-summary">
        <span><b>${esc(st.file)}</b> · du ${frDate(r.from)} au ${frDate(r.to)}</span>
        <span>✔ ${r.matched.length} opération${r.matched.length > 1 ? 's' : ''} retrouvée${r.matched.length > 1 ? 's' : ''}</span>
        <span class="${r.bankOnly.length ? 'warn' : ''}">➕ ${r.bankOnly.length} à la banque, pas dans Kompte</span>
        <span class="${r.kompteOnly.length ? 'warn' : ''}">⚠ ${r.kompteOnly.length} dans Kompte, pas à la banque</span>
        ${gap === null ? '' : `<span class="${gap ? 'bad' : 'good'}">${gap ? `Écart de solde au ${frDate(st.balance.date || todayIso())} : ${gap > 0 ? '+' : ''}${euro(gap)}` : 'Solde identique à la banque ✔'}</span>`}
      </div>
      ${r.bankOnly.length ? `<h3 class="check-title">À la banque, pas dans Kompte</h3>
        <div class="list">${r.bankOnly.map((o, i) => `<div class="row static"><span class="body"><span class="title">${esc(o.label)}</span>
          <span class="sub">${frDate(o.date)}</span></span>
          <span class="amount ${o.cents >= 0 ? 'plus' : 'minus'}">${o.cents >= 0 ? '+' : ''}${euro(o.cents)}</span>
          <button type="button" class="mini" data-bank-add="${i}">+ Ajouter</button></div>`).join('')}</div>` : ''}
      ${r.kompteOnly.length ? `<h3 class="check-title">Dans Kompte, pas à la banque</h3>
        <p class="note">Oubli, doublon, ou opération pas encore passée à la banque : touche-la pour la vérifier.</p>
        <div class="list">${r.kompteOnly.map((l) => l.row && l.row.id > 0
          ? `<button type="button" class="row" data-item="${l.row.id}" data-due="${l.date}"><span class="body"><span class="title">${esc(l.label)}</span><span class="sub">${frDate(l.date)}</span></span><span class="amount ${l.cents >= 0 ? 'plus' : 'minus'}">${l.cents >= 0 ? '+' : ''}${euro(l.cents)}</span></button>`
          : checkLine(l.date, l.label, l.cents, l.card ? ' · achats carte' : ' · montant fixe')).join('')}</div>` : ''}
      ${r.matched.length ? `<details class="check-ok"><summary>Voir les ${r.matched.length} opérations retrouvées</summary>
        <div class="list">${r.matched.map((m) => checkLine(m.bank.date, m.kompte.label, m.bank.cents, ` · banque : ${esc(m.bank.label)}`)).join('')}</div></details>` : ''}`;
  }
  view.innerHTML = `
    <h2>Vérifier avec la banque</h2>
    <label class="field" for="c-balance">Solde affiché par ta banque aujourd'hui (€)</label>
    <div class="row2"><input class="input big" id="c-balance" inputmode="decimal" autocomplete="off" placeholder="0,00">
      <button type="button" class="primary" id="c-compare">Comparer</button></div>
    <p class="hint" id="c-balance-result">${balance === null ? 'Renseigne d’abord le solde de ton compte sur le tableau de bord.'
      : `Kompte attend ${euro(balance)} (les achats carte comptent seulement quand ils sont prélevés).`}</p>
    <label class="field">Importer un relevé de la banque</label>
    <p class="hint">Sur le site de ta banque, télécharge tes opérations (format OFX de préférence, sinon CSV ou QIF),
      puis choisis le fichier ici. Kompte retrouve chaque opération par son montant et sa date.</p>
    <label class="secondary wide file-btn">Choisir un fichier…
      <input type="file" id="c-file" accept=".ofx,.qfx,.qif,.csv,.txt,application/x-ofx,text/csv" hidden></label>
    ${result}`;
}

/** Comparaison simple : solde tapé par l'utilisateur. */
function compareBalance() {
  const input = $('#c-balance'), out = $('#c-balance-result');
  const balance = getBalance();
  if (balance === null) return;
  let typed;
  try { typed = parseAmount(input.value); } catch (e) { out.textContent = 'Montant non compris.'; return; }
  const gap = typed - balance;
  out.innerHTML = gap === 0 ? '<b style="color:var(--green)">✔ Tout est juste : même solde que la banque.</b>'
    : `<b style="color:var(--red)">Écart de ${gap > 0 ? '+' : ''}${euro(gap)}</b> : la banque affiche ${euro(typed)}, Kompte attend ${euro(balance)}.
       ${gap < 0 ? 'Une dépense manque peut-être dans Kompte.' : 'Un revenu manque peut-être, ou une dépense a été notée en trop.'}
       Importe un relevé pour la retrouver.`;
}

async function importBankFile(file) {
  try {
    const parsed = parseBankFile(await readBankFile(file));
    Object.assign(checkState, { file: file.name, ops: parsed.ops.length ? parsed.ops : null, balance: parsed.balance,
      error: parsed.ops.length ? '' : 'Aucune opération trouvée dans ce fichier : essaie le format OFX, ou envoie-moi un exemple.' });
  } catch (e) {
    Object.assign(checkState, { file: null, ops: null, balance: null, error: 'Fichier illisible.' });
  }
  render();
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

// ------------------------------------------- « Combien il me reste ? » (Siri, supabase/combien_reste.sql)
// Le téléphone dépose dans le réglage « siri » le disponible et les budgets de chaque compte, calculés comme à
// l'écran. La fonction SQL lit ce résumé et y retire elle-même les dépenses ajoutées depuis (id > max_item).
/** JSON aux clés triées : Supabase renvoie les objets dans un autre ordre, la comparaison doit l'ignorer. */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function siriSummary() {
  const out = { max_item: state.all.items.reduce((m, i) => Math.max(m, i.id), 0) };
  const [data, current] = [state.data, state.compte];
  try {
    for (const c of state.all.comptes) {
      state.compte = c.id;
      state.data = scoped(c.id);
      const ym = currentMonth();
      const [start, end] = monthPeriod(ym);
      const entry = { day: todayIso(), start, end,
                      budgets: budgetRows(ym).map((r) => ({ key: r.key, label: r.label, budget: r.budget, spent: r.spent })) };
      const balance = getBalance();
      if (balance !== null) [entry.available, entry.until] = availableMoney(balance);
      out[c.id] = entry;
    }
  } finally {
    state.data = data;
    state.compte = current;
  }
  return out;
}
/** Met le résumé à jour en ligne s'il a changé (une fois par jour au plus, sauf nouvelle opération). */
async function saveSiriSummary() {
  if (!state.all || !state.all.comptes.length) return;
  const value = siriSummary();
  if (stableJson(value) === stableJson(state.all.kv.siri)) return;
  state.all.kv.siri = value;
  await check(sb.from('kv_settings').upsert({ key: 'siri', value }, { onConflict: 'user_id,key' }));
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
    try { await saveSiriSummary(); } catch (e) { /* facultatif : ne bloque jamais la synchro */ }
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
  else if (state.tab === 'check') renderCheck();
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
  if (subOf(r)) when += ` · ${subOf(r).name}`;
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
      ${metric('Déjà dépensé ›', paid, 'var(--text)', 'spending')}
      <div class="metric"><small>Bilan du mois</small><b style="color:var(--blue)">${euro(income - out)}</b>
        ${carry === null ? '' : `<span class="carry" style="color:var(${carry >= 0 ? '--green' : '--red'})">Report du mois dernier : ${carry > 0 ? '+' : ''}${euro(carry)}</span>`}</div>
      ${budgetTile(ym)}
    </div>
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

// ------------------------------------------------ répartition des dépenses du mois (graphique en anneau)
/** [{name, color, total, subs: [{name, total}], events}] du plus gros au plus petit. paidOnly : seulement le déjà passé. */
function spendingByCategory(ym, paidOnly) {
  const today = todayIso();
  const map = new Map();
  for (const e of summary(ym).events) {
    if (e.row.kind !== 'Dépense' || (paidOnly && e.due > today)) continue;
    const name = e.row.category;
    if (!map.has(name)) map.set(name, { name, color: category(name).color, total: 0, subs: new Map(), events: [] });
    const c = map.get(name);
    c.total += e.amount;
    c.events.push(e);
    const sub = subOf(e.row);
    const subName = sub ? sub.name : 'Sans sous-catégorie';
    c.subs.set(subName, (c.subs.get(subName) || 0) + e.amount);
  }
  return [...map.values()].sort((a, b) => b.total - a.total).map((c) => ({
    ...c, subs: [...c.subs].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total) }));
}
/** Anneau SVG (cercle de périmètre 100 : chaque part = son pourcentage). */
function donutSvg(parts, total, selected) {
  let at = 0;
  const arcs = parts.map((p) => {
    const pct = (p.total / total) * 100;
    const arc = `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="${p.color}" stroke-width="6"
      stroke-dasharray="${Math.max(0, pct - (parts.length > 1 ? 0.4 : 0)).toFixed(3)} ${(100 - pct + (parts.length > 1 ? 0.4 : 0)).toFixed(3)}"
      stroke-dashoffset="${(25 - at).toFixed(3)}" opacity="${selected && selected !== p.name ? 0.25 : 1}"/>`;
    at += pct;
    return arc;
  }).join('');
  const shown = selected ? parts.find((p) => p.name === selected) : null;
  return `<svg class="donut" viewBox="0 0 42 42" role="img" aria-label="Répartition des dépenses">
      <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--input)" stroke-width="6"/>${arcs}
      <text x="21" y="20" class="donut-sub">${esc(shown ? shown.name : 'Dépenses')}</text>
      <text x="21" y="25" class="donut-total">${euro(shown ? shown.total : total)}</text>
    </svg>`;
}
function spendingSheet(paidOnly = false, selected = null) {
  const ym = state.selected;
  const parts = spendingByCategory(ym, paidOnly);
  const total = parts.reduce((t, p) => t + p.total, 0);
  if (selected && !parts.some((p) => p.name === selected)) selected = null;
  const pct = (v) => (total ? `${Math.round((v / total) * 100)} %` : '');
  const rows = parts.map((p) => {
    const open = p.name === selected;
    const detail = !open ? '' : `<div class="pie-detail">
        ${p.subs.length > 1 || p.subs[0].name !== 'Sans sous-catégorie' ? p.subs.map((s) =>
          `<div class="pie-sub"><span>${esc(s.name)}</span><span>${euro(s.total)} · ${Math.round((s.total / p.total) * 100)} %</span></div>`).join('') : ''}
        <div class="list">${[...p.events].reverse().map(eventRow).join('')}</div>
      </div>`;
    return `<button type="button" class="row pie-row${open ? ' open' : ''}" data-pie-cat="${esc(p.name)}">
        ${catIcon(p.name)}
        <span class="body"><span class="title">${esc(p.name)}</span>
          <span class="sub">${p.events.length} opération${p.events.length > 1 ? 's' : ''} · ${pct(p.total)}</span></span>
        <span class="amount minus">${euro(p.total)}</span>
      </button>${detail}`;
  }).join('');
  openSheet(`
    <h3>Répartition des dépenses</h3>
    <p class="hint" style="text-align:center;margin-top:0">${monthLabel(ym)}</p>
    <div class="segmented pie-mode">
      <button type="button" data-pie-mode="all" class="${paidOnly ? '' : 'on'}">Tout le mois</button>
      <button type="button" data-pie-mode="paid" class="${paidOnly ? 'on' : ''}">Déjà dépensé</button>
    </div>
    ${total ? `${donutSvg(parts, total, selected)}
      <p class="hint" style="text-align:center">Touche une catégorie pour voir son détail.</p>
      <div class="list">${rows}</div>` : '<p class="empty">Aucune dépense pour ce mois.</p>'}
    <p class="error-text"></p>
    <div class="actions"><button type="button" class="primary" data-close>Fermer</button></div>`, async () => {});
  const form = $('#sheet-form');
  form.dataset.piePaid = paidOnly ? '1' : '';
  form.dataset.pieCat = selected || '';
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
    if (subOf(r)) details += ` · ${subOf(r).name}`;
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
          <span class="sub">${esc(g.category)}${subOf({ id: -g.id, category: g.category }) ? ` · ${esc(subOf({ id: -g.id, category: g.category }).name)}` : ''}${transferNote(g) ? ` · ${esc(transferNote(g))}` : ''}${version ? ` · le ${version.day_of_month} du mois` : ''}</span></span>
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
    ${categoriesSection()}
    <label class="field">Historique</label>
    <button type="button" class="secondary wide" id="export-month">Exporter un mois en Excel</button>
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
    const subBox = form.querySelector('#f-sub-box');
    if (subBox && subBox.dataset.cat !== c) {
      // Sous-catégories de la catégorie choisie ; on garde le choix si on revient sur la même.
      const keep = subBox.dataset.cat === undefined ? subBox.dataset.initial : '';
      subBox.dataset.cat = c;
      const subs = subsOf(c);
      subBox.hidden = !subs.length;
      subBox.querySelector('#f-sub').innerHTML = subs.map((x) =>
        `<button type="button" data-sub="${esc(x.id)}" class="${x.id === keep ? 'on' : ''}">${esc(x.name)}</button>`).join('');
    }
  };
  const subButtons = form.querySelector('#f-sub');
  if (subButtons) {
    subButtons.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sub]');
      if (!b) return;
      const on = !b.classList.contains('on'); // toucher à nouveau : décocher
      subButtons.querySelectorAll('button').forEach((x) => x.classList.toggle('on', on && x === b));
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
  await setSub(groupId, f.sub || null, true);
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
    <div id="f-sub-box" data-initial="${group && subOf({ id: -group.id, category: group.category }) ? esc(subOf({ id: -group.id, category: group.category }).id) : ''}" hidden>
      <label class="field">Sous-catégorie (facultatif)</label>
      <div class="segmented sub" id="f-sub"></div>
    </div>
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
    const subOn = form.querySelector('#f-sub .on');
    await saveFixed(group, { title, category: cat, kind: chosenKind, amount, start: start.slice(0, 7), day, accountId, target,
                             pocket: accountId === null ? null : chosenPocket(form, amount), sub: subOn ? subOn.dataset.sub : null });
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
        await setSub(group.id, null, true);
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
    <input class="input big" id="f-amount" inputmode="decimal" autocomplete="off" value="${editing ? amountText(item.total_cents) : preset && preset.amount ? amountText(preset.amount) : ''}">
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
    <div id="f-sub-box" data-initial="${editing && subOf(item) ? esc(subOf(item).id) : ''}" hidden>
      <label class="field">Sous-catégorie (facultatif)</label>
      <div class="segmented sub" id="f-sub"></div>
    </div>
    ${targetField(editing ? item.vers_compte_id : null)}
    ${cardConf(state.compte) ? `<label class="check" id="f-card-box"><input type="checkbox" id="f-card"
      ${(editing ? cardConf(state.compte).items.has(item.id) : true) ? 'checked' : ''}> Payé par carte (débit différé)</label>` : ''}
    <label class="field" for="f-date">${split ? 'Date du premier paiement' : 'Date'}</label>
    <input class="input" id="f-date" type="date" value="${editing ? item.first_date : (preset && preset.date) || todayIso()}">
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
    const subOn = form.querySelector('#f-sub .on');
    const sub = subOn ? subOn.dataset.sub : null;
    if (editing) {
      await check(sb.from('items').update({ ...fields, installments: n, frequency: item.frequency }).eq('id', item.id));
      await check(sb.from('savings_transfers').delete().eq('item_id', item.id));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: item.id, account_id: accountId }));
      await setPocketOf('items', item.id, pocketSplit);
      await setSub(item.id, sub);
      await check(sb.from('confirmations').delete().eq('item_id', item.id));
      if (cardBox) { const value = cardWithItem(item.id, paidByCard); if (value) await saveCard(value); }
    } else {
      const id = newId();
      await check(sb.from('items').insert({ id, compte_id: state.compte, ...fields, installments: 1, frequency: 'Unique', created_at: utcStamp() }));
      if (accountId !== null) await check(sb.from('savings_transfers').insert({ item_id: id, account_id: accountId }));
      if (pocketSplit !== null) await setPocketOf('items', id, pocketSplit);
      if (sub) await setSub(id, sub);
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
        await setSub(item.id, null);
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
  if (t.closest('#spending')) { spendingSheet(true); return; }
  const pieMode = t.closest('[data-pie-mode]');
  if (pieMode) { spendingSheet(pieMode.dataset.pieMode === 'paid', $('#sheet-form').dataset.pieCat || null); return; }
  const pieCat = t.closest('[data-pie-cat]');
  if (pieCat) {
    const form = $('#sheet-form');
    const name = pieCat.dataset.pieCat;
    const top = $('#sheet').querySelector('.sheet-panel');
    const scroll = top.scrollTop;
    spendingSheet(form.dataset.piePaid === '1', form.dataset.pieCat === name ? null : name);
    top.scrollTop = scroll;
    return;
  }
  if (t.closest('#budgets')) { budgetsSheet(); return; }
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
  if (t.closest('#add-category')) { categorySheet(); return; }
  if (t.closest('#export-month')) { exportSheet(); return; }
  if (t.closest('#c-compare')) { compareBalance(); return; }
  const bankAdd = t.closest('[data-bank-add]');
  if (bankAdd && checkState.ops) {
    const op = matchBank(checkState.ops).bankOnly[Number(bankAdd.dataset.bankAdd)];
    if (op) {
      transactionSheet(null, { kind: op.cents < 0 ? 'Dépense' : 'Revenu', amount: Math.abs(op.cents), date: op.date,
                               title: op.label.slice(0, 60), heading: 'Ajouter depuis la banque' });
    }
    return;
  }
  const catRow = t.closest('[data-category]');
  if (catRow) { categorySheet(catRow.dataset.category); return; }
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
  if (event.target.id === 'c-file' && event.target.files && event.target.files[0]) { importBankFile(event.target.files[0]); return; }
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
