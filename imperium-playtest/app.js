const DATA_URL = "data/cards.json";

const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");

const factionFilterEl = document.getElementById("factionFilter");
const rarityFilterEl = document.getElementById("rarityFilter");
const searchInputEl = document.getElementById("searchInput");

let DB = null;
let ALL_CARDS = [];

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function populateFilters(db) {
  // factions
  const factionKeys = Object.keys(db.factions || {});
  factionKeys.sort();
  for (const f of factionKeys) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    factionFilterEl.appendChild(opt);
  }

  // rarities
  const rarityKeys = Object.keys(db.rarities || {});
  rarityKeys.sort((a, b) => (db.rarities[a]?.tier ?? 999) - (db.rarities[b]?.tier ?? 999));
  for (const r of rarityKeys) {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    rarityFilterEl.appendChild(opt);
  }
}

function rarityColor(rarity) {
  return DB?.rarities?.[rarity]?.color || "#666";
}

function factionColor(faction) {
  return DB?.factions?.[faction]?.color || "#888";
}

function makeChip(text, color = null) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = text;
  if (color) {
    span.style.borderColor = color;
  }
  return span;
}

function cardImageSrc(card) {
  // card.image is relative to /data/
  // Example: "cards/minervina_aiuto.png" -> "data/cards/minervina_aiuto.png"
  if (!card.image) return null;
  return `data/${card.image}`;
}

function renderCard(card) {
  const wrap = document.createElement("article");
  wrap.className = "card";

  const rarityBar = document.createElement("div");
  rarityBar.className = "card__rarityBar";
  rarityBar.style.background = rarityColor(card.rarity);
  wrap.appendChild(rarityBar);

  const imgWrap = document.createElement("div");
  imgWrap.className = "card__imgWrap";

  const src = cardImageSrc(card);
  if (src) {
    const img = document.createElement("img");
    img.alt = `${card.name} (${card.id})`;
    img.src = src;
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

  const body = document.createElement("div");
  body.className = "card__body";

  const titleRow = document.createElement("div");
  titleRow.className = "card__titleRow";

  const nameEl = document.createElement("div");
  nameEl.className = "card__name";
  nameEl.textContent = card.name;

  const metaEl = document.createElement("div");
  metaEl.className = "card__meta";
  metaEl.textContent = `${card.type} • ${card.rarity}`;

  titleRow.appendChild(nameEl);
  titleRow.appendChild(metaEl);

  body.appendChild(titleRow);

  const chips = document.createElement("div");
  chips.className = "chips";

  chips.appendChild(makeChip(card.faction, factionColor(card.faction)));

  for (const cls of card.classes || []) {
    chips.appendChild(makeChip(cls));
  }

  body.appendChild(chips);

  const stats = card.stats || {};
  const statsWrap = document.createElement("div");
  statsWrap.className = "stats";

  const statKeys = [
    ["VIT", stats.vit],
    ["IMP", stats.imp],
    ["DEF", stats.def],
    ["VEL", stats.vel],
  ];

  for (const [k, v] of statKeys) {
    const box = document.createElement("div");
    box.className = "stat";
    const kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "v";
    vEl.textContent = (v ?? "-");
    box.appendChild(kEl);
    box.appendChild(vEl);
    statsWrap.appendChild(box);
  }

  body.appendChild(statsWrap);

  const abilities = document.createElement("div");
  abilities.className = "abilities";

  for (const ab of card.abilities || []) {
    const a = document.createElement("div");
    a.className = "ability";

    const an = document.createElement("div");
    an.className = "an";
    an.textContent = `${ab.slot ?? ""} ${ab.name || "Abilità"}`.trim();

    const at = document.createElement("div");
    at.className = "at";
    const bits = [];
    if (ab.type) bits.push(ab.type);
    if (ab.limit) bits.push(ab.limit);
    at.textContent = bits.join(" • ");

    const ax = document.createElement("div");
    ax.className = "ax";
    ax.textContent = ab.text || "";

    a.appendChild(an);
    if (bits.length) a.appendChild(at);
    a.appendChild(ax);

    abilities.appendChild(a);
  }

  body.appendChild(abilities);

  wrap.appendChild(body);

  return wrap;
}

function applyFilters() {
  const f = factionFilterEl.value;
  const r = rarityFilterEl.value;
  const q = normalize(searchInputEl.value);

  const filtered = ALL_CARDS.filter(c => {
    if (f !== "ALL" && c.faction !== f) return false;
    if (r !== "ALL" && c.rarity !== r) return false;
    if (q && !normalize(c.name).includes(q) && !normalize(c.id).includes(q)) return false;
    return true;
  });

  renderGrid(filtered);
  setStatus(`Carte: ${filtered.length} / ${ALL_CARDS.length}`);
}

function renderGrid(cards) {
  gridEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of cards) {
    frag.appendChild(renderCard(c));
  }
  gridEl.appendChild(frag);
}

async function boot() {
  setStatus("Caricamento database carte...");
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DB = await res.json();
    ALL_CARDS = Array.isArray(DB.cards) ? DB.cards : [];

    populateFilters(DB);
    applyFilters();

    factionFilterEl.addEventListener("change", applyFilters);
    rarityFilterEl.addEventListener("change", applyFilters);
    searchInputEl.addEventListener("input", applyFilters);

  } catch (err) {
    console.error(err);
    setStatus(`Errore caricamento: ${String(err.message || err)}`);
  }
}

boot();
