// deckstore.js — gestione 5 mazzi (localStorage)
// USO:
//   import { listDeckSlots, loadDeckSlot, saveDeckSlot, setActiveSlot, getActiveSlot, getActiveDeck, setSlotName } from "./deckstore.js";

const LS = {
  decks: "ari_decks_v1",
  active: "ari_deck_active_slot",
};

const DEFAULT_SLOTS = Array.from({ length: 5 }, (_, i) => ({
  name: `Deck ${i + 1}`,
  deck: {}, // { [cardId]: qty }
}));

function safeJson(raw, fallback){
  try{
    const v = JSON.parse(raw);
    return v ?? fallback;
  }catch{
    return fallback;
  }
}

function readState(){
  const raw = localStorage.getItem(LS.decks);
  const st = raw ? safeJson(raw, null) : null;

  if (!st || !Array.isArray(st.slots)) {
    const init = { version: 1, slots: DEFAULT_SLOTS };
    localStorage.setItem(LS.decks, JSON.stringify(init));
    return init;
  }

  const slots = st.slots.slice(0,5);
  while (slots.length < 5) slots.push(DEFAULT_SLOTS[slots.length]);
  st.slots = slots;
  return st;
}

function writeState(st){
  localStorage.setItem(LS.decks, JSON.stringify(st));
}

export function getActiveSlot(){
  const v = Number(localStorage.getItem(LS.active));
  if (!Number.isFinite(v)) return 0;
  return Math.min(4, Math.max(0, Math.floor(v)));
}

export function setActiveSlot(idx){
  const i = Math.min(4, Math.max(0, Math.floor(Number(idx) || 0)));
  localStorage.setItem(LS.active, String(i));
  return i;
}

export function listDeckSlots(){
  const st = readState();
  return st.slots.map((s, i) => ({
    index: i,
    name: String(s?.name || `Deck ${i+1}`),
    count: Object.values(s?.deck || {}).reduce((a,n)=>a+Number(n||0),0),
  }));
}

export function loadDeckSlot(idx){
  const st = readState();
  const i = Math.min(4, Math.max(0, Math.floor(Number(idx) || 0)));
  const slot = st.slots[i] || DEFAULT_SLOTS[i];
  return {
    index: i,
    name: String(slot?.name || `Deck ${i+1}`),
    deck: (slot?.deck && typeof slot.deck === "object") ? slot.deck : {},
  };
}

export function saveDeckSlot(idx, deckObj){
  const st = readState();
  const i = Math.min(4, Math.max(0, Math.floor(Number(idx) || 0)));
  const slot = st.slots[i] || DEFAULT_SLOTS[i];

  const clean = (deckObj && typeof deckObj === "object") ? deckObj : {};
  slot.deck = clean;
  st.slots[i] = slot;
  writeState(st);
}

export function setSlotName(idx, name){
  const st = readState();
  const i = Math.min(4, Math.max(0, Math.floor(Number(idx) || 0)));
  st.slots[i] = st.slots[i] || DEFAULT_SLOTS[i];
  st.slots[i].name = String(name || `Deck ${i+1}`).slice(0, 40);
  writeState(st);
}

export function getActiveDeck(){
  const slot = loadDeckSlot(getActiveSlot());
  return slot;
}

export function expandDeck(deckObj){
  const out = [];
  const deck = (deckObj && typeof deckObj === "object") ? deckObj : {};
  for (const [id, qty] of Object.entries(deck)){
    const n = Math.max(0, Math.floor(Number(qty)||0));
    for (let i=0;i<n;i++) out.push(id);
  }
  return out;
}
