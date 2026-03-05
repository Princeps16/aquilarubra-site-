// packs.js — Aquila Rubra Imperium (Pack Opening)
// NOTE: this file assumes packs.html ids: creditsBox, packCost, buyOpenBtn, grantBtn, revealGrid, status, packPanel, packImg

const LS = {
  credits: "ari_credits",
  collection: "ari_collection",
  packs: "ari_opened_packs",
  newCards: "ari_new_cards",
};

const DATA_URL = "data/cards.json";
const PACK_COST = 100;

const ui = {
  creditsBox: document.getElementById("creditsBox"),
  packCost: document.getElementById("packCost"),
  buyOpenBtn: document.getElementById("buyOpenBtn"),
  grantBtn: document.getElementById("grantBtn"),
  revealGrid: document.getElementById("revealGrid"),
  status: document.getElementById("status"),
  packPanel: document.getElementById("packPanel") || document.getElementById("packPanel") || document.getElementById("packPanel"),
  packImg: document.getElementById("packImg"),
};

if (ui.packCost) ui.packCost.textContent = String(PACK_COST);

// ---------------- storage helpers ----------------
function getCredits() {
  const v = Number(localStorage.getItem(LS.credits));
  return Number.isFinite(v) ? v : 0;
}
function setCredits(n) {
  localStorage.setItem(LS.credits, String(Math.max(0, Math.floor(n))));
  renderCredits();
}
function renderCredits() {
  if (!ui.creditsBox) return;
  ui.creditsBox.textContent = String(getCredits());
}

function getCollection() {
  try {
    return JSON.parse(localStorage.getItem(LS.collection) || "{}") || {};
  } catch {
    return {};
  }
}
function setCollection(obj) {
  localStorage.setItem(LS.collection, JSON.stringify(obj));
}
function addToCollection(cardId, qty = 1) {
  const col = getCollection();
  col[cardId] = (col[cardId] || 0) + qty;
  setCollection(col);
  return col[cardId];
}

function bumpPacksOpened() {
  const v = Number(localStorage.getItem(LS.packs)) || 0;
  localStorage.setItem(LS.packs, String(v + 1));
}

function getNewCards() {
  const raw = localStorage.getItem(LS.newCards);
  if (!raw) return [];
  try { return JSON.parse(raw) || []; } catch { return []; }
}
function markNewCard(cardId) {
  const arr = getNewCards();
  if (!arr.includes(cardId)) {
    arr.push(cardId);
    localStorage.setItem(LS.newCards, JSON.stringify(arr));
  }
}

// ---------------- ui helpers ----------------
function setStatus(msg) {
  if (ui.status) ui.status.textContent = msg || "";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------------- discovery toast (shown ONLY when flipped) ----------------
let _toastTimer = null;

function hideDiscoveryToast() {
  const toast = document.getElementById("discoveryToast");
  if (!toast) return;
  toast.classList.remove("is-on");
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
}

function showDiscoveryToast(card) {
  let toast = document.getElementById("discoveryToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "discoveryToast";
    toast.className = "discoveryToast";
    toast.innerHTML = `
      <div class="discoveryToast__img"><img alt=""></div>
      <div class="discoveryToast__body">
        <div class="discoveryToast__title"></div>
        <div class="discoveryToast__meta"></div>
        <div class="discoveryToast__hint muted">Aggiunta alla collezione</div>
      </div>
      <button class="discoveryToast__close" type="button">OK</button>
    `;
    document.body.appendChild(toast);
    toast.querySelector(".discoveryToast__close").addEventListener("click", hideDiscoveryToast);
  }

  const imgEl = toast.querySelector(".discoveryToast__img img");
  const titleEl = toast.querySelector(".discoveryToast__title");
  const metaEl = toast.querySelector(".discoveryToast__meta");

  const img = card?.image ? String(card.image).replace(/^\/+/, "") : "";
  const src1 = img ? `data/${img}` : "";
  const src2 = img ? `data/cards/${img}` : "";
  imgEl.src = src1 || src2 || "assets/card_back.png";
  imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = src2 || "assets/card_back.png"; };

  titleEl.textContent = `NUOVA CARTA: ${card?.name || card?.id || "-"}`;
  metaEl.textContent = `${String(card?.faction || "").toUpperCase()} · ${String(card?.rarity || "").toUpperCase()}`;

  toast.classList.add("is-on");

  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => hideDiscoveryToast(), 4200);
}

// ---------------- data ----------------
let DB = null;

async function loadCards() {
  if (DB) return DB;

  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Impossibile caricare ${DATA_URL} (${res.status})`);
  const json = await res.json();

  // support both { cards:[...] } and direct array
  const list = Array.isArray(json) ? json : (json.cards || []);
  DB = list.filter(Boolean);
  return DB;
}

function lower(s) { return String(s || "").toLowerCase(); }

function isSaga(card) {
  if (lower(card?.type) !== "event") return false;
  const k = lower(card?.eventKind || card?.event_kind || card?.kind);
  return k === "saga";
}

function rarityKey(card) {
  // saga is its own bucket
  if (isSaga(card)) return "saga";
  return lower(card?.rarity || "");
}

function pickOne(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------- pack rules ----------------
function generatePack(allCards) {
  const communis = allCards.filter(c => rarityKey(c) === "communis");
  const rara = allCards.filter(c => rarityKey(c) === "rara");

  const elite = allCards.filter(c => {
    const r = rarityKey(c);
    return r === "insignis" || r === "mythica" || r === "aeterna" || r === "saga";
  });

  const pulls = [];
  for (let i = 0; i < 3; i++) pulls.push(pickOne(communis));
  pulls.push(pickOne(rara));
  pulls.push(pickOne(elite));

  return pulls.filter(Boolean);
}

// ---------------- rendering ----------------
function tileClass(card) {
  const r = rarityKey(card) || "communis";
  return `r-${r}`;
}

function buildCardTile(card, owned, wasNew) {
  const el = document.createElement("div");
  el.className = `cardTile ${tileClass(card)}`;
  el.dataset.wasNew = wasNew ? "1" : "0";
  el.dataset.toastShown = "0";

  const img = card?.image ? String(card.image).replace(/^\/+/, "") : "";
  const src1 = img ? `data/${img}` : "";
  const src2 = img ? `data/cards/${img}` : "";
  const frontSrc = src1 || src2 || "assets/card_missing.png";
  const backSrc = "assets/card_back.png";

  const stats = card?.stats || {};
  const vit = stats.vit ?? "—";
  const imp = stats.imp ?? "—";
  const def = stats.def ?? "—";
  const vel = stats.vel ?? "—";

  const classes = Array.isArray(card?.classes) ? card.classes.join(", ") : "";

  const abil = Array.isArray(card?.abilities) ? card.abilities : [];
  const abilHtml = abil.slice(0, 3).map(a => {
    const t = (a.type || "").toUpperCase();
    const n = a.name || "";
    const lim = a.limit ? ` · ${a.limit}` : "";
    return `<li><span class="chip">${escapeHtml(t)}</span> ${escapeHtml(n)}${escapeHtml(lim)}</li>`;
  }).join("");

  el.innerHTML = `
    <div class="cardFlip" role="button" tabindex="0" aria-label="Gira carta">
      <img class="cardFlip__img" src="${backSrc}" data-back="${backSrc}" data-front="${frontSrc}" alt="Carta">
    </div>

    <div class="cardMeta">
      <div>
        <div class="cardName">${escapeHtml(card.name || card.id)}</div>
        <div>${escapeHtml(String(card.faction || "").toUpperCase())} · ${escapeHtml(String(card.type || "unit").toUpperCase())}</div>
        ${classes ? `<div class="muted">${escapeHtml(classes)}</div>` : ""}
      </div>
      <div style="text-align:right;">
        <div>${escapeHtml(String(rarityKey(card) || "").toUpperCase())}</div>
        <div class="muted">x${owned}</div>
      </div>
    </div>

    <div class="cardDetails">
      <div class="statRow">
        <div><span class="muted">VIT</span><b>${escapeHtml(vit)}</b></div>
        <div><span class="muted">IMP</span><b>${escapeHtml(imp)}</b></div>
        <div><span class="muted">DEF</span><b>${escapeHtml(def)}</b></div>
        <div><span class="muted">VEL</span><b>${escapeHtml(vel)}</b></div>
      </div>

      ${abilHtml ? `<ul class="abilList">${abilHtml}</ul>` : ""}
    </div>
  `;

  // robust fallback if image missing
  const imgEl = el.querySelector(".cardFlip__img");
  imgEl.addEventListener("error", () => {
    if (imgEl.dataset.fallbackDone) return;
    imgEl.dataset.fallbackDone = "1";
    imgEl.src = src2 || "assets/card_missing.png";
  });

  const flip = el.querySelector(".cardFlip");

  const flipToFront = () => {
    const img = el.querySelector('.cardFlip__img');
    const goingFront = !el.classList.contains('is-flipped');

    // blocca spam click durante animazione
    if (el.classList.contains('is-flipping')) return;

    // avvia animazione flip (CSS su .cardTile.is-flipping .cardFlip)
    el.classList.add('is-flipping');

    // swap a metà rotazione
    window.setTimeout(() => {
      img.src = goingFront ? img.dataset.front : img.dataset.back;
      el.classList.toggle('is-flipped', goingFront);

      // toast solo quando vai al fronte, una sola volta
      if (goingFront && el.dataset.wasNew === '1' && el.dataset.toastShown !== '1') {
        el.dataset.toastShown = '1';
        showDiscoveryToast(card);
      }
    }, 260);

    // fine animazione
    window.setTimeout(() => {
      el.classList.remove('is-flipping');
    }, 540);
  };

  flip.addEventListener("click", flipToFront);
  flip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flipToFront(); }
  });

  return el;
}

function renderPulls(pulls) {
  ui.revealGrid.innerHTML = "";

  pulls.forEach((card, i) => {
    setTimeout(() => {
      const before = (getCollection()[card.id] || 0);
      const owned = addToCollection(card.id, 1);

      const wasNew = before === 0;
      if (wasNew) markNewCard(card.id);

      const el = buildCardTile(card, owned, wasNew);
      ui.revealGrid.appendChild(el);
    }, i * 240);
  });
}

// ---------------- main flow ----------------
async function init() {
  renderCredits();
  setStatus("");

  // default credits for fresh users (optional)
  if (!localStorage.getItem(LS.credits)) setCredits(600);

  let allCards = [];
  try {
    allCards = await loadCards();
  } catch (e) {
    setStatus(String(e.message || e));
    if (ui.buyOpenBtn) ui.buyOpenBtn.disabled = true;
  }

  if (ui.grantBtn) {
    ui.grantBtn.addEventListener("click", () => {
      setCredits(getCredits() + 500);
      setStatus("Crediti aggiunti (test).");
    });
  }

  if (ui.buyOpenBtn) {
    ui.buyOpenBtn.addEventListener("click", () => {
      hideDiscoveryToast();

      const c = getCredits();
      if (c < PACK_COST) {
        setStatus("Crediti insufficienti.");
        return;
      }

      ui.buyOpenBtn.disabled = true;

      setCredits(c - PACK_COST);
      bumpPacksOpened();
      setStatus("Apertura pacchetto...");

      if (ui.packPanel) {
        ui.packPanel.classList.remove("is-opened");
        ui.packPanel.classList.add("is-opening");
      }

      const pulls = generatePack(allCards);

      // shake time
      setTimeout(() => {
        if (ui.packPanel) {
          ui.packPanel.classList.remove("is-opening");
          ui.packPanel.classList.add("is-opened");
        }

        renderPulls(pulls);

        // re-enable when reveal done
        setTimeout(() => {
          ui.buyOpenBtn.disabled = false;
          setStatus("Pacchetto aperto. Carte aggiunte alla collezione.");
        }, pulls.length * 240 + 500);
      }, 650);
    });
  }
}

init();
