const DATA_URL = "data/cards.json";

const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");

const factionFilterEl = document.getElementById("factionFilter");
const rarityFilterEl = document.getElementById("rarityFilter");
const searchInputEl = document.getElementById("searchInput");

let DB = null;
let ALL_CARDS = [];

/* =========================
   PREVIEW (click-to-zoom)
   ========================= */
const previewEl = document.getElementById("cardPreview");
const previewImgEl = document.getElementById("cardPreviewImg");

let PREVIEW_ROT = 0;

const closeBtn = document.querySelector(".card-preview__close");
const rotLeftBtn = document.getElementById("rotLeft");
const rotRightBtn = document.getElementById("rotRight");
const rotResetBtn = document.getElementById("rotReset");

function applyPreviewTransform() {
  if (!previewEl) return;
  previewEl.style.setProperty("--rot", `${PREVIEW_ROT}deg`);
}

function openPreview(src, alt = "") {
  if (!previewEl || !previewImgEl || !src) return;

  PREVIEW_ROT = 0;
  applyPreviewTransform();

  previewImgEl.src = src;
  previewImgEl.alt = alt;
  previewEl.classList.add("is-open");
  previewEl.setAttribute("aria-hidden", "false");
}

function closePreview() {
  if (!previewEl || !previewImgEl) return;
  previewEl.classList.remove("is-open");
  previewEl.setAttribute("aria-hidden", "true");
  previewImgEl.src = "";
  previewImgEl.alt = "";

  PREVIEW_ROT = 0;
  applyPreviewTransform();
}

// chiudi SOLO cliccando fuori dall’immagine
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

rotLeftBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  PREVIEW_ROT = (PREVIEW_ROT - 90) % 360;
  applyPreviewTransform();
});

rotRightBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  PREVIEW_ROT = (PREVIEW_ROT + 90) % 360;
  applyPreviewTransform();
});

rotResetBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  PREVIEW_ROT = 0;
  applyPreviewTransform();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePreview();
});
/* ========================= */

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function setStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg;
}

function rarityColor(rarity) {
  return DB?.rarities?.[rarity]?.color || "#666";
}

function factionColor(faction) {
  return DB?.factions?.[faction]?.color || "#888";
}

function cardImageSrc(card) {
  if (!card?.image) return null;
  return `data/${card.image}`;
}

/* =========================
   FILTER DROPDOWNS
   ========================= */
function populateFilters(db) {
  if (!db) return;

 // factions
if (factionFilterEl) {
  const factionKeys = [...new Set(db.cards.map(c => c.faction))].sort();

  for (const f of factionKeys) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    factionFilterEl.appendChild(opt);
  }
}

  // rarities (ordine per tier)
  if (rarityFilterEl) {
    const rarityKeys = Object.keys(db.rarities || {});
    rarityKeys.sort(
      (a, b) => (db.rarities[a]?.tier ?? 999) - (db.rarities[b]?.tier ?? 999)
    );

    for (const r of rarityKeys) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r.toUpperCase();
      rarityFilterEl.appendChild(opt);
    }
  }
}

/* =========================
   RENDER: STILE "SCHEDA INFO"
   ========================= */
function getStat(stats, key) {
  if (!stats) return null;
  return stats[key] ?? stats[key.toUpperCase()] ?? null;
}

function renderCard(card) {
  const wrap = document.createElement("article");
  wrap.className = "ccard";
  wrap.dataset.id = card?.id || "";
  wrap.dataset.faction = card?.faction || "";
  wrap.dataset.rarity = card?.rarity || "";

  wrap.style.setProperty("--factionColor", factionColor(card?.faction));
  wrap.style.setProperty("--rarityColor", rarityColor(card?.rarity));

  // barra rarità
  const rarityBar = document.createElement("div");
  rarityBar.className = "ccard__rarityBar";
  rarityBar.style.background = rarityColor(card?.rarity);
  wrap.appendChild(rarityBar);

  // immagine
  const imgWrap = document.createElement("div");
  imgWrap.className = "ccard__imgWrap";

  const src = cardImageSrc(card);
  if (src) {
    const img = document.createElement("img");
    img.alt = `${card?.name || "Carta"} (${card?.id || "-"})`;
    img.src = src;
    img.loading = "lazy";
    img.draggable = false;

    imgWrap.style.cursor = "zoom-in";
    imgWrap.addEventListener("click", (e) => {
      e.stopPropagation();
      openPreview(img.src, img.alt);
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

/* ===== NOME ===== */
const nameEl = document.createElement("h3");
nameEl.className = "ccard__name";
nameEl.textContent = card?.name || "-";
meta.appendChild(nameEl);

/* ===== TYPE + RARITÀ SOTTO ===== */
const typeEl = document.createElement("div");
typeEl.className = "ccard__type ccard__type--under";
typeEl.textContent = `${String(card?.type || "").toUpperCase()} · ${String(card?.rarity || "").toUpperCase()}`;
meta.appendChild(typeEl);

/* ===== CHIPS ===== */
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
   
/* ===== STATS WRAP ===== */
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

/* ===== TOGGLE STATS ===== */
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
meta.appendChild(statsWrap);   // <<< QUESTA RIGA MANCAVA

/* ===== TOGGLE ABILITÀ ===== */
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

/* ===== ABILITIES WRAP ===== */
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

/* =========================
   GRID + FILTRI
   ========================= */
function renderGrid(cards) {
  if (!gridEl) return;
  gridEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of cards) frag.appendChild(renderCard(c));
  gridEl.appendChild(frag);
}

function applyFilters() {
  const f = factionFilterEl?.value || "ALL";
  const r = rarityFilterEl?.value || "ALL";
  const q = normalize(searchInputEl?.value);

  const filtered = ALL_CARDS.filter((c) => {
    if (f !== "ALL" && c.faction !== f) return false;
    if (r !== "ALL" && c.rarity !== r) return false;
    if (q && !normalize(c.name).includes(q) && !normalize(c.id).includes(q))
      return false;
    return true;
  });

  renderGrid(filtered);
  setStatus(`Carte: ${filtered.length} / ${ALL_CARDS.length}`);
}

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
    searchInputEl?.addEventListener("input", applyFilters);
  } catch (err) {
    console.error(err);
    setStatus(`Errore caricamento: ${String(err?.message || err)}`);
  }
}

boot();

/* ====== Battle stuff (lasciato com'è) ====== */
function createEmptySlots() {
  const zones = ["playerFront", "playerBack", "enemyFront", "enemyBack"];

  zones.forEach((zoneId) => {
    const zone = document.getElementById(zoneId);
    if (!zone) return;

    zone.innerHTML = "";
    for (let i = 0; i < 3; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.textContent = "Vuoto";
      zone.appendChild(slot);
    }
  });
}

function canDrop(cardEl, slotEl) {
  if (slotEl.querySelector(".card")) return false;

  const row = slotEl.dataset.row;
  const type = cardEl.dataset.type;
  const subtype = cardEl.dataset.subtype; // pactum / reactio / ictus

  // UNITÀ solo in front/back
  if ((row === "front" || row === "back") && type !== "unit") return false;

  // EVENTI solo in reserve
  if (row === "reserve") {
    if (type !== "event") return false;

    // Ictus NON va in campo
    if (subtype === "ictus") return false;

    // Limite Pactum: max 2 attivi per owner
    if (subtype === "pactum") {
      const owner = cardEl.dataset.owner;
      const pactumInCampo = document.querySelectorAll(
        `.slot[data-owner="${owner}"][data-row="reserve"] .card[data-subtype="pactum"]`
      ).length;
      if (pactumInCampo >= 2) return false;
    }

    return true; // Pactum e Reactio ok
  }

  return true;
}
/* =========================
   VIEW MODE SWITCH
========================= */

const gridBtn = document.getElementById("gridViewBtn");
const detailBtn = document.getElementById("detailViewBtn");
const mainGrid = document.getElementById("grid");

function setGridMode() {
  mainGrid.classList.remove("detail-mode");
  mainGrid.classList.add("grid-mode");
  gridBtn.classList.add("active");
  detailBtn.classList.remove("active");
}

function setDetailMode() {
  mainGrid.classList.remove("grid-mode");
  mainGrid.classList.add("detail-mode");
  detailBtn.classList.add("active");
  gridBtn.classList.remove("active");
}

if (gridBtn && detailBtn) {
  gridBtn.addEventListener("click", setGridMode);
  detailBtn.addEventListener("click", setDetailMode);
}

/* default */
setGridMode();
