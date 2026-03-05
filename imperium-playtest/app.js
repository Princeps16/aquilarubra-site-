import { getOwned, isNew, clearNew, getShards } from "./collection.js";

const DATA_URL = "data/cards.json";

const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");

const factionFilterEl = document.getElementById("factionFilter");
const rarityFilterEl = document.getElementById("rarityFilter");
const typeFilterEl = document.getElementById("typeFilter");
const ownedFilterEl = document.getElementById("ownedFilter");
const searchInputEl = document.getElementById("searchInput");

let DB = null;
let ALL_CARDS = [];

/* =========================
   PREVIEW (flip front/back)
========================= */
const previewEl = document.getElementById("cardPreview");
const closeBtn = document.querySelector(".card-preview__close");

const flipStageEl = document.getElementById("flipStage");
const flipCardEl = document.getElementById("flipCard");
const frontImgEl = document.getElementById("cardPreviewFront");
const backImgEl = document.getElementById("cardPreviewBack");

let flipDragging = false;
let startX = 0;
let currentDeg = 0;
let committedSide = "front";

// helper: retro
function cardBackSrc(card) {
  if (card?.backImage) return `data/${card.backImage}`;
  return "assets/card_back.png";
}

function setFlipDeg(deg, withTransition = false) {
  if (!flipCardEl) return;
  flipCardEl.style.transition = withTransition ? "transform 180ms ease" : "none";
  flipCardEl.style.setProperty("--ry", `${deg}deg`);
  currentDeg = deg;
}

function cardImageSrc(card) {
  if (!card?.image) return null;
  return `data/${card.image}`;
}

function openPreview(card) {
  clearNew(card.id);
  if (!previewEl || !frontImgEl || !backImgEl) return;

  const frontSrc = cardImageSrc(card);
  frontImgEl.src = frontSrc || "";
  frontImgEl.alt = card?.name || "Carta";

  backImgEl.src = cardBackSrc(card);
  backImgEl.alt = `${card?.name || "Carta"} (retro)`;

  committedSide = "front";
  setFlipDeg(0, true);

  previewEl.classList.add("is-open");
  previewEl.setAttribute("aria-hidden", "false");
}

function closePreview() {
  if (!previewEl) return;
  previewEl.classList.remove("is-open");
  previewEl.setAttribute("aria-hidden", "true");
  committedSide = "front";
  setFlipDeg(0, false);
}

if (previewEl) {
  previewEl.addEventListener("click", (e) => {
    if (e.target === previewEl) closePreview();
  });
}
closeBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  closePreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePreview();
});

// drag flip
function onStart(e) {
  if (!flipStageEl || !flipCardEl) return;
  flipDragging = true;
  startX = (e.touches ? e.touches[0].clientX : e.clientX);
  const base = committedSide === "front" ? 0 : 180;
  setFlipDeg(base, false);
}
function onMove(e) {
  if (!flipDragging || !flipCardEl) return;
  const x = (e.touches ? e.touches[0].clientX : e.clientX);
  const dx = x - startX;
  const deltaDeg = (dx / 200) * 180;
  const base = committedSide === "front" ? 0 : 180;
  let deg = base + deltaDeg;
  deg = Math.max(-30, Math.min(210, deg));
  setFlipDeg(deg, false);
}
function onEnd() {
  if (!flipDragging || !flipCardEl) return;
  flipDragging = false;
  const goBack = currentDeg > 90;
  committedSide = goBack ? "back" : "front";
  setFlipDeg(goBack ? 180 : 0, true);
}
flipStageEl?.addEventListener("touchstart", onStart, { passive: true });
flipStageEl?.addEventListener("touchmove", onMove, { passive: true });
flipStageEl?.addEventListener("touchend", onEnd);

flipStageEl?.addEventListener("mousedown", onStart);
window.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onEnd);

/* =========================
   UTILS
========================= */
function normalize(s) {
  return String(s || "").trim().toLowerCase();
}
function setStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
}

function rarityColor(rarity) {
  return DB?.rarities?.[rarity]?.color || "#666";
}
function factionColor(faction) {
  return DB?.factions?.[faction]?.color || "#888";
}

function setAllOption(selectEl, label) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "ALL";
  opt.textContent = label;
  selectEl.appendChild(opt);
  selectEl.value = "ALL";
}

/* =========================
   FILTERS
========================= */
function populateFilters(db) {
  if (!db) return;

  setAllOption(factionFilterEl, "Tutte");
  setAllOption(rarityFilterEl, "Tutte");
  setAllOption(typeFilterEl, "Tutti");
  setAllOption(ownedFilterEl, "Tutte");

  // factions from cards
  if (factionFilterEl) {
    const factionKeys = [...new Set((db.cards || []).map(c => c.faction).filter(Boolean))].sort();
    for (const f of factionKeys) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f;
      factionFilterEl.appendChild(opt);
    }
  }

  // rarities ordered by tier (fallback alpha)
  if (rarityFilterEl) {
    const rarityKeys = Object.keys(db.rarities || {});
    rarityKeys.sort((a, b) => (db.rarities[a]?.tier ?? 999) - (db.rarities[b]?.tier ?? 999) || a.localeCompare(b));
    for (const r of rarityKeys) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = String(r).toUpperCase();
      rarityFilterEl.appendChild(opt);
    }
  }

  // types from cards
  if (typeFilterEl) {
    const types = [...new Set((db.cards || []).map(c => String(c.type || "").toLowerCase()).filter(Boolean))].sort();
    for (const t of types) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t.toUpperCase();
      typeFilterEl.appendChild(opt);
    }
  }

  // owned filter fixed options
  if (ownedFilterEl) {
    const opt1 = document.createElement("option");
    opt1.value = "OWNED";
    opt1.textContent = "Solo possedute";
    ownedFilterEl.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = "MISSING";
    opt2.textContent = "Solo mancanti";
    ownedFilterEl.appendChild(opt2);
  }
}

/* =========================
   RENDER
========================= */
function getStat(stats, key) {
  if (!stats) return null;
  return stats[key] ?? stats[key.toUpperCase()] ?? null;
}

function renderCard(card) {
  const wrap = document.createElement("article");
  wrap.className = "ccard";

  const qtyOwned = getOwned(card.id);
  if (qtyOwned === 0) wrap.classList.add("is-locked");

  wrap.dataset.id = card?.id || "";
  wrap.dataset.faction = card?.faction || "";
  wrap.dataset.rarity = card?.rarity || "";

  wrap.style.setProperty("--factionColor", factionColor(card?.faction));
  wrap.style.setProperty("--rarityColor", rarityColor(card?.rarity));

  const rarityBar = document.createElement("div");
  rarityBar.className = "ccard__rarityBar";
  rarityBar.style.background = rarityColor(card?.rarity);
  wrap.appendChild(rarityBar);

  // image
  const imgWrap = document.createElement("div");
  imgWrap.className = "ccard__imgWrap";

  const owned = getOwned(card.id);
  const src = owned > 0 ? cardImageSrc(card) : "assets/card_back.png";

  if (src) {
    const img = document.createElement("img");
    img.alt = `${card?.name || "Carta"} (${card?.id || "-"})`;
    img.src = src;
    img.loading = "lazy";
    img.draggable = false;

    imgWrap.style.cursor = "zoom-in";
    imgWrap.addEventListener("click", (e) => {
      e.stopPropagation();
      openPreview(card);
    });

    img.onerror = () => {
      imgWrap.innerHTML = "";
      const fb = document.createElement("div");
      fb.className = "card__imgFallback";
      fb.textContent = `Immagine non trovata:\n${src}`;
      imgWrap.appendChild(fb);
    };

    imgWrap.appendChild(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "card__imgFallback";
    fb.textContent = "Nessuna immagine";
    imgWrap.appendChild(fb);
  }

  wrap.appendChild(imgWrap);

  // meta
  const meta = document.createElement("div");
  meta.className = "ccard__meta";

  const nameEl = document.createElement("h3");
  nameEl.className = "ccard__name";
  nameEl.textContent = card?.name || "-";
  meta.appendChild(nameEl);

  if (isNew(card.id)) {
    const badge = document.createElement("div");
    badge.className = "ccard__new";
    badge.textContent = "NEW";
    wrap.appendChild(badge);
  }

  if (qtyOwned > 0) {
    const ownedEl = document.createElement("div");
    ownedEl.className = "ccard__owned";
    ownedEl.textContent = "x" + qtyOwned;
    meta.appendChild(ownedEl);
  }

  const typeEl = document.createElement("div");
  typeEl.className = "ccard__type ccard__type--under";
  typeEl.textContent = `${String(card?.type || "").toUpperCase()} · ${String(card?.rarity || "").toUpperCase()}`;
  meta.appendChild(typeEl);

  const chips = document.createElement("div");
  chips.className = "ccard__chips";

  const factionChip = document.createElement("span");
  factionChip.className = "chip chip--faction";
  factionChip.textContent = card?.faction || "-";
  chips.appendChild(factionChip);

  for (const cls of card?.classes || []) {
    const c = document.createElement("span");
    c.className = "chip";
    c.textContent = cls;
    chips.appendChild(c);
  }
  meta.appendChild(chips);

  // stats
  const statsWrap = document.createElement("div");
  statsWrap.className = "ccard__stats";

  const rows = [
    ["VIT", getStat(card?.stats, "vit")],
    ["IMP", getStat(card?.stats, "imp")],
    ["DEF", getStat(card?.stats, "def")],
    ["VEL", getStat(card?.stats, "vel")],
  ];

  for (const [k, v] of rows) {
    const box = document.createElement("div");
    box.className = "stat";

    const kEl = document.createElement("span");
    kEl.textContent = k;

    const vEl = document.createElement("b");
    vEl.textContent = v ?? "-";

    box.appendChild(kEl);
    box.appendChild(vEl);
    statsWrap.appendChild(box);
  }

  const statsToggle = document.createElement("button");
  statsToggle.type = "button";
  statsToggle.className = "ccard__toggle ccard__toggle--stats";
  statsToggle.textContent = "Stats";
  statsToggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.toggle("stats-open");
  });

  meta.appendChild(statsToggle);
  meta.appendChild(statsWrap);

  // abilities
  const abilitiesToggle = document.createElement("button");
  abilitiesToggle.type = "button";
  abilitiesToggle.className = "ccard__toggle ccard__toggle--abilities";
  abilitiesToggle.textContent = "Abilità";
  abilitiesToggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.toggle("abilities-open");
  });
  meta.appendChild(abilitiesToggle);

  const abilitiesWrap = document.createElement("div");
  abilitiesWrap.className = "ccard__abilities";

  for (const ab of card?.abilities || []) {
    const sec = document.createElement("section");
    sec.className = "ccard__ability";

    const head = document.createElement("div");
    head.className = "ability__head";

    const title = document.createElement("div");
    title.className = "ability__title";
    title.textContent = ab?.name || "Abilità";

    const tags = document.createElement("div");
    tags.className = "ability__tags";

    if (ab?.limit) {
      const t = document.createElement("span");
      t.className = "atag atag--limit";
      t.textContent = ab.limit;
      tags.appendChild(t);
    }

    head.appendChild(title);
    head.appendChild(tags);

    const text = document.createElement("p");
    text.className = "ability__text";
    text.textContent = ab?.text || "";

    sec.appendChild(head);
    sec.appendChild(text);
    abilitiesWrap.appendChild(sec);
  }

  meta.appendChild(abilitiesWrap);
  wrap.appendChild(meta);

  return wrap;
}

function renderGrid(cards) {
  if (!gridEl) return;
  gridEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of cards) frag.appendChild(renderCard(c));
  gridEl.appendChild(frag);
}


function asAll(v){
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "ALL";
  if (s === "all") return "ALL";
  if (s === "tutte" || s === "tutti") return "ALL";
  return v;
}


function updateTopStats(){
  const progressPill = document.getElementById("progressPill");
  const shardsPill = document.getElementById("shardsPill");
  if (progressPill) {
    const ownedUnique = ALL_CARDS.reduce((acc,c)=> acc + (getOwned(c.id) > 0 ? 1 : 0), 0);
    progressPill.textContent = `${ownedUnique} / ${ALL_CARDS.length}`;
  }
  if (shardsPill) {
    shardsPill.textContent = `Shards: ${getShards()}`;
  }
}

function applyFilters() {
  const f = asAll(factionFilterEl?.value || "ALL");
  const r = asAll(rarityFilterEl?.value || "ALL");
  const t = asAll(typeFilterEl?.value || "ALL");
  const tNorm = String(t).trim().toLowerCase();
  const o = asAll(ownedFilterEl?.value || "ALL");
  const q = normalize(searchInputEl?.value);

  const filtered = ALL_CARDS.filter((c) => {
    if (f !== "ALL" && c.faction !== f) return false;
    if (r !== "ALL" && c.rarity !== r) return false;
    if (t !== "ALL" && String(c.type || "").toLowerCase() !== tNorm) return false;

    const ownedQty = getOwned(c.id);
    if (o === "OWNED" && ownedQty <= 0) return false;
    if (o === "MISSING" && ownedQty > 0) return false;

    if (q && !normalize(c.name).includes(q) && !normalize(c.id).includes(q)) return false;
    return true;
  });

  renderGrid(filtered);
  setStatus(`Carte: ${filtered.length} / ${ALL_CARDS.length}`);
  updateTopStats();
}

/* =========================
   VIEW MODE SWITCH
========================= */
const gridBtn = document.getElementById("gridViewBtn");
const detailBtn = document.getElementById("detailViewBtn");
const mainGrid = document.getElementById("grid");

function setGridMode() {
  mainGrid?.classList.remove("detail-mode");
  mainGrid?.classList.add("grid-mode");
  gridBtn?.classList.add("active");
  detailBtn?.classList.remove("active");
}
function setDetailMode() {
  mainGrid?.classList.remove("grid-mode");
  mainGrid?.classList.add("detail-mode");
  detailBtn?.classList.add("active");
  gridBtn?.classList.remove("active");
}
gridBtn?.addEventListener("click", setGridMode);
detailBtn?.addEventListener("click", setDetailMode);

/* =========================
   BOOT
========================= */
async function boot() {
  setStatus("Caricamento database carte...");
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DB = await res.json();

    ALL_CARDS = Array.isArray(DB.cards) ? DB.cards : [];
    populateFilters(DB);
    applyFilters();

    factionFilterEl?.addEventListener("change", applyFilters);
    rarityFilterEl?.addEventListener("change", applyFilters);
    typeFilterEl?.addEventListener("change", applyFilters);
    ownedFilterEl?.addEventListener("change", applyFilters);
    searchInputEl?.addEventListener("input", applyFilters);

    setGridMode();
  } catch (err) {
    console.error(err);
    setStatus(`Errore caricamento: ${String(err?.message || err)}`);
  }
}
boot();
