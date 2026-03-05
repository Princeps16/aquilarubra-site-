const COLLECTION_KEY = "ari_collection";
const NEW_KEY = "ari_new_cards";
const SHARDS_KEY = "ari_shards";

/* =========================
   COLLECTION
========================= */

export function getCollection() {
  const raw = localStorage.getItem(COLLECTION_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export function setCollection(obj) {
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(obj || {}));
}

export function getOwned(cardId) {
  const col = getCollection();
  return Number(col[cardId] || 0);
}

export function addCard(cardId, qty = 1) {
  const col = getCollection();
  col[cardId] = Number(col[cardId] || 0) + Number(qty || 0);
  if (col[cardId] < 0) col[cardId] = 0;
  setCollection(col);
  return col[cardId];
}

export function removeCard(cardId, qty = 1) {
  return addCard(cardId, -Number(qty || 0));
}

/* =========================
   NEW (discovery)
========================= */

export function markNew(cardId){
  const raw = localStorage.getItem(NEW_KEY);
  const arr = raw ? safeJson(raw, []) : [];
  if (!arr.includes(cardId)) {
    arr.push(cardId);
    localStorage.setItem(NEW_KEY, JSON.stringify(arr));
  }
}

export function isNew(cardId){
  const raw = localStorage.getItem(NEW_KEY);
  if (!raw) return false;
  const arr = safeJson(raw, []);
  return Array.isArray(arr) && arr.includes(cardId);
}

export function clearNew(cardId){
  const raw = localStorage.getItem(NEW_KEY);
  if (!raw) return;
  const arr = safeJson(raw, []).filter(id => id !== cardId);
  localStorage.setItem(NEW_KEY, JSON.stringify(arr));
}

/* =========================
   SHARDS (crafting)
========================= */

export const SHARD_VALUE = {
  communis: 5,
  rara: 20,
  insignis: 80,
  mythica: 250,
  aeterna: 800,
};

export const SHARD_COST = {
  communis: 20,
  rara: 80,
  insignis: 320,
  mythica: 1000,
  aeterna: 3200,
};

export function getShards(){
  const v = Number(localStorage.getItem(SHARDS_KEY));
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

export function setShards(n){
  localStorage.setItem(SHARDS_KEY, String(Math.max(0, Math.floor(Number(n) || 0))));
}

export function addShards(n){
  const v = getShards() + Math.floor(Number(n) || 0);
  setShards(v);
  return v;
}

export function spendShards(cost){
  const c = Math.floor(Number(cost) || 0);
  const v = getShards();
  if (v < c) return false;
  setShards(v - c);
  return true;
}

function safeJson(raw, fallback){
  try{
    const v = JSON.parse(raw);
    return v ?? fallback;
  }catch{
    return fallback;
  }
}
