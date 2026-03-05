import { getOwned } from "./collection.js";
import {
  listDeckSlots,
  loadDeckSlot,
  saveDeckSlot,
  setActiveSlot,
  getActiveSlot,
  setSlotName,
} from "./deckstore.js";

const DATA_URL = "data/cards.json";
const DECK_SIZE = 30;

const ui = {
  status: document.getElementById("status"),
  grid: document.getElementById("cardsGrid"),
  deckList: document.getElementById("deckList"),
  deckCountPill: document.getElementById("deckCountPill"),
  slotPill: document.getElementById("slotPill"),
  warn: document.getElementById("deckWarnings"),
  ioBox: document.getElementById("ioBox"),

  faction: document.getElementById("factionFilter"),
  rarity: document.getElementById("rarityFilter"),
  type: document.getElementById("typeFilter"),
  search: document.getElementById("searchInput"),

  ownedOnlyBtn: document.getElementById("ownedOnlyBtn"),
  clearBtn: document.getElementById("clearDeckBtn"),
  exportBtn: document.getElementById("exportDeckBtn"),
  importBtn: document.getElementById("importDeckBtn"),

  deckSlot: document.getElementById("deckSlot"),
  deckName: document.getElementById("deckName"),
  setActiveBtn: document.getElementById("setActiveBtn"),
};

let DB = null;
let ALL = [];
let OWNED_ONLY = false;

let ACTIVE_SLOT = getActiveSlot();
let SLOT = loadDeckSlot(ACTIVE_SLOT);
let DECK = { ...(SLOT.deck || {}) };

function setStatus(t){ if(ui.status) ui.status.textContent = t || ""; }
function norm(s){ return String(s||"").trim().toLowerCase(); }
function asAll(v){
  const s = norm(v);
  if (!s || s === "all" || s === "tutte" || s === "tutti") return "ALL";
  return v;
}

function deckCount(){
  return Object.values(DECK).reduce((a,n)=>a+Number(n||0),0);
}
function copyLimit(card){
  return norm(card?.rarity) === "communis" ? 2 : 1;
}
function canAdd(card){
  const id = card.id;
  const owned = getOwned(id);
  const inDeck = Number(DECK[id] || 0);

  if (owned <= inDeck) return { ok:false, reason:"Non possiedi altre copie." };

  const lim = copyLimit(card);
  if (inDeck >= lim) return { ok:false, reason:`Limite copie: ${lim}.` };

  if (deckCount() >= DECK_SIZE) return { ok:false, reason:`Deck pieno (${DECK_SIZE}).` };

  return { ok:true };
}
function addToDeck(card){
  const chk = canAdd(card);
  if (!chk.ok) { ui.warn.textContent = chk.reason; return; }
  ui.warn.textContent = "";
  DECK[card.id] = Number(DECK[card.id]||0) + 1;
  saveCurrent();
}
function removeFromDeck(cardId){
  const v = Number(DECK[cardId]||0);
  if (v <= 1) delete DECK[cardId];
  else DECK[cardId] = v - 1;
  ui.warn.textContent = "";
  saveCurrent();
}

function saveCurrent(){
  saveDeckSlot(ACTIVE_SLOT, DECK);
  renderDeck();
  renderGrid();
  refreshSlotUI();
}

function cardImg(card){
  return card?.image ? `data/${card.image}` : "assets/card_back.png";
}

/* ============ Filters UI ============ */
function setAllOption(sel, label){
  if(!sel) return;
  sel.innerHTML = "";
  const o = document.createElement("option");
  o.value = "ALL";
  o.textContent = label;
  sel.appendChild(o);
  sel.value = "ALL";
}
function populateFilters(){
  setAllOption(ui.faction, "Tutte");
  setAllOption(ui.rarity, "Tutte");
  setAllOption(ui.type, "Tutti");

  const factions = [...new Set(ALL.map(c=>c.faction).filter(Boolean))].sort();
  for(const f of factions){
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    ui.faction.appendChild(o);
  }

  const rarities = Object.keys(DB.rarities||{});
  rarities.sort((a,b)=>(DB.rarities[a]?.tier??999)-(DB.rarities[b]?.tier??999) || a.localeCompare(b));
  for(const r of rarities){
    const o = document.createElement("option");
    o.value = r;
    o.textContent = String(r).toUpperCase();
    ui.rarity.appendChild(o);
  }

  const types = [...new Set(ALL.map(c=>norm(c.type)).filter(Boolean))].sort();
  for(const t of types){
    const o = document.createElement("option");
    o.value = t;
    o.textContent = t.toUpperCase();
    ui.type.appendChild(o);
  }
}

/* ============ Slot UI ============ */
function refreshSlotUI(){
  const slots = listDeckSlots();
  if (ui.deckSlot){
    ui.deckSlot.innerHTML = "";
    for (const s of slots){
      const opt = document.createElement("option");
      opt.value = String(s.index);
      opt.textContent = `${s.name} (${s.count}/${DECK_SIZE})`;
      ui.deckSlot.appendChild(opt);
    }
    ui.deckSlot.value = String(ACTIVE_SLOT);
  }

  if (ui.deckName){
    const slot = loadDeckSlot(ACTIVE_SLOT);
    ui.deckName.value = slot.name;
  }

  if (ui.slotPill){
    const activeMark = ACTIVE_SLOT === getActiveSlot() ? " (ATTIVO)" : "";
    ui.slotPill.textContent = `Slot: ${ACTIVE_SLOT + 1}${activeMark}`;
  }
}

function switchSlot(idx){
  ACTIVE_SLOT = Math.min(4, Math.max(0, Math.floor(Number(idx)||0)));
  SLOT = loadDeckSlot(ACTIVE_SLOT);
  DECK = { ...(SLOT.deck || {}) };
  ui.warn.textContent = "";
  refreshSlotUI();
  renderDeck();
  renderGrid();
}

/* ============ Render Grid ============ */
function passesFilters(card){
  const f = asAll(ui.faction?.value);
  const r = asAll(ui.rarity?.value);
  const t = asAll(ui.type?.value);
  const q = norm(ui.search?.value);

  if (f !== "ALL" && card.faction !== f) return false;
  if (r !== "ALL" && card.rarity !== r) return false;
  if (t !== "ALL" && norm(card.type) !== norm(t)) return false;
  if (OWNED_ONLY && getOwned(card.id) <= 0) return false;
  if (q && !norm(card.name).includes(q) && !norm(card.id).includes(q)) return false;

  return true;
}

function renderGrid(){
  if(!ui.grid) return;
  ui.grid.innerHTML = "";
  const frag = document.createDocumentFragment();

  for(const card of ALL){
    if(!passesFilters(card)) continue;

    const owned = getOwned(card.id);
    const inDeck = Number(DECK[card.id]||0);

    const el = document.createElement("article");
    el.className = "dcard";
    if (owned <= 0) el.classList.add("is-locked");
    if (inDeck > 0) el.classList.add("is-in-deck");

    el.innerHTML = `
      <div class="dcard__img"><img src="${cardImg(card)}" alt=""></div>
      <div class="dcard__name">${card.name || card.id}</div>
      <div class="dcard__meta">
        <span>${String(card.faction||"").toUpperCase()} · ${String(card.rarity||"").toUpperCase()}</span>
        <span class="dcard__qty">x${inDeck} / ${owned}</span>
      </div>
    `;

    el.addEventListener("click", ()=> addToDeck(card));
    frag.appendChild(el);
  }

  ui.grid.appendChild(frag);
}

/* ============ Render Deck ============ */
function renderDeck(){
  if(!ui.deckList) return;

  const count = deckCount();
  ui.deckCountPill.textContent = `Deck: ${count} / ${DECK_SIZE}`;

  ui.deckList.innerHTML = "";

  const cardsInDeck = Object.keys(DECK)
    .map(id => ({ id, qty: Number(DECK[id]||0), card: ALL.find(c=>c.id===id) }))
    .filter(x => x.card);

  cardsInDeck.sort((a,b)=>{
    const ta = DB.rarities?.[a.card.rarity]?.tier ?? 999;
    const tb = DB.rarities?.[b.card.rarity]?.tier ?? 999;
    if (ta !== tb) return ta - tb;
    return String(a.card.name||"").localeCompare(String(b.card.name||""));
  });

  for(const x of cardsInDeck){
    const row = document.createElement("div");
    row.className = "deckRow";
    row.innerHTML = `
      <div>
        <div class="deckRow__name">${x.card.name || x.id} <span class="muted">x${x.qty}</span></div>
        <div class="deckRow__meta">${String(x.card.faction||"").toUpperCase()} · ${String(x.card.rarity||"").toUpperCase()} · ${String(x.card.type||"").toUpperCase()}</div>
      </div>
      <button class="deckRow__btn" data-act="add">+</button>
      <button class="deckRow__btn" data-act="rem">−</button>
    `;
    row.querySelector('[data-act="add"]').addEventListener("click",(e)=>{ e.stopPropagation(); addToDeck(x.card); });
    row.querySelector('[data-act="rem"]').addEventListener("click",(e)=>{ e.stopPropagation(); removeFromDeck(x.id); });
    ui.deckList.appendChild(row);
  }

  ui.warn.textContent = count === DECK_SIZE ? "" : `Mancano ${DECK_SIZE - count} carte.`;
}

/* ============ Export/Import (slot) ============ */
function exportDeck(){
  const payload = { version: 1, size: DECK_SIZE, slot: ACTIVE_SLOT, name: ui.deckName?.value || SLOT.name, deck: DECK };
  ui.ioBox.value = JSON.stringify(payload, null, 2);
}

function importDeck(){
  try{
    const raw = ui.ioBox.value.trim();
    if (!raw) return;
    const obj = JSON.parse(raw);
    const deckObj = obj.deck && typeof obj.deck === "object" ? obj.deck : null;
    if (!deckObj) throw new Error("Formato non valido: manca deck.");

    const clean = {};
    for(const [id,qty] of Object.entries(deckObj)){
      const card = ALL.find(c=>c.id===id);
      if (!card) continue;
      const lim = copyLimit(card);
      const q = Math.max(0, Math.min(lim, Math.floor(Number(qty)||0)));
      if (q > 0) clean[id] = q;
    }

    let total = Object.values(clean).reduce((a,n)=>a+n,0);
    if (total > DECK_SIZE){
      const ids = Object.keys(clean);
      ids.sort((a,b)=>{
        const ca = ALL.find(c=>c.id===a);
        const cb = ALL.find(c=>c.id===b);
        const ta = DB.rarities?.[ca.rarity]?.tier ?? 999;
        const tb = DB.rarities?.[cb.rarity]?.tier ?? 999;
        return tb - ta;
      });
      while(total > DECK_SIZE){
        const id = ids[ids.length-1];
        clean[id]--;
        if (clean[id] <= 0) { delete clean[id]; ids.pop(); }
        total--;
      }
    }

    DECK = clean;
    saveCurrent();
    ui.warn.textContent = "";
  }catch(e){
    ui.warn.textContent = `Import fallito: ${e.message || e}`;
  }
}

/* ============ Boot ============ */
async function boot(){
  setStatus("Caricamento database carte...");
  const res = await fetch("data/cards.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  DB = await res.json();
  ALL = Array.isArray(DB.cards) ? DB.cards : [];

  populateFilters();
  setStatus("");

  refreshSlotUI();
  renderDeck();
  renderGrid();

  ui.faction?.addEventListener("change", renderGrid);
  ui.rarity?.addEventListener("change", renderGrid);
  ui.type?.addEventListener("change", renderGrid);
  ui.search?.addEventListener("input", renderGrid);

  ui.ownedOnlyBtn?.addEventListener("click", ()=>{
    OWNED_ONLY = !OWNED_ONLY;
    ui.ownedOnlyBtn.textContent = OWNED_ONLY ? "Mostra tutte" : "Solo possedute";
    renderGrid();
  });

  ui.clearBtn?.addEventListener("click", ()=>{
    DECK = {};
    saveCurrent();
    ui.warn.textContent = "";
  });

  ui.exportBtn?.addEventListener("click", exportDeck);
  ui.importBtn?.addEventListener("click", importDeck);

  ui.deckSlot?.addEventListener("change", (e)=> switchSlot(e.target.value));

  ui.deckName?.addEventListener("input", ()=>{
    setSlotName(ACTIVE_SLOT, ui.deckName.value);
    refreshSlotUI();
  });

  ui.setActiveBtn?.addEventListener("click", ()=>{
    setActiveSlot(ACTIVE_SLOT);
    refreshSlotUI();
  });
}

boot().catch(err=>{
  console.error(err);
  setStatus(`Errore: ${String(err?.message||err)}`);
});
