// battle.js — compatibile con il tuo battle.html
import {
  createGameState,
  applyAction,
  getValidAttackTargets
} from "./engine/core.js";

const DATA_URL = "data/cards.json";

let DB = null;
let STATE = null;

// MODE: null | { kind:"QUEUE_ATTACK", attackerUid } | { kind:"ABILITY", unitUid, slot, queue?:string[], picked?:object }
let MODE = null;
let SELECTED_UID = null;
let SELECTED_CARD_ID = null; // inspect mode for hand cards
let SELECTED_CARD_CTX = null; // { zone:'pactum', owner, idx } or null

/* =========================
   DOM helpers
   ========================= */
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================
   Data helpers
   ========================= */
function getCardById(cardId) {
  return DB?.cards?.find(c => c.id === cardId) || null;
}

function isPactumCard(card){
  if(!card) return false;
  const id = String(card.id||"").toLowerCase();
  const subtype = String(card.subtype||card.kind||card.group||"").toLowerCase();
  const name = String(card.name||"").toLowerCase();

  if(subtype.includes("pactum")) return true;

  // Treat VIGILIA / FATUM as Pactum-reserve cards
  if(id.includes("_vigilia") || id.includes("_fatum")) return true;
  if(name.includes("vigilia") || name.includes("fatum")) return true;

  const abilities = Array.isArray(card.abilities) ? card.abilities : [];
  for(const ab of abilities){
    const an = String(ab?.name||"").toLowerCase();
    const at = String(ab?.text||"").toLowerCase();
    if(an.includes("vigilia") || an.includes("fatum")) return true;
    if(at.includes("vigilia") || at.includes("fatum")) return true;
  }
  return false;
}


function getUnitByUid(uid) {
  if (!STATE) return null;
  for (const p of STATE.players) {
    for (const lane of ["front", "back"]) {
      for (const u of p.board[lane]) if (u && u.uid === uid) return u;
    }
  }
  return null;
}

function allBoardUids(owner) {
  const out = [];
  for (const lane of ["front", "back"]) {
    for (const u of STATE.players[owner].board[lane]) if (u) out.push(u.uid);
  }
  return out;
}

function isMyTurn(owner) {
  return owner === STATE.activePlayer && STATE.winner === null;
}

/* =========================
   Topbar status (Turno — Player — Fase — Gloria)
   ========================= */
function updateTurnLine() {
  const el = document.getElementById("turnLine");
  if (!el || !STATE) return;

  const w = STATE.winner;
  const g0 = STATE.players[0].gloria;
  const g1 = STATE.players[1].gloria;

  if (w !== null) {
    el.innerHTML = `VITTORIA: <strong>P${w}</strong> — Gloria P0:<strong>${g0}</strong> · P1:<strong>${g1}</strong>`;
    return;
  }

  el.innerHTML =
    `Turno <strong>${STATE.turn}</strong> — ` +
    `Player <strong>P${STATE.activePlayer}</strong> — ` +
    `Fase <strong>${STATE.phase}</strong> — ` +
    `Gloria P0:<strong>${g0}</strong> · P1:<strong>${g1}</strong>`;
  updateCommandPips();
}


function updateCommandPips() {
  if (!STATE) return;

  const total = 2;
  const leftOf = (pIndex) => (STATE.players?.[pIndex]?.perTurn?.commandActionsLeft ?? 0);

  // If you have per-player hosts (preferred)
  const host0 = document.getElementById("commandPipsP0");
  const host1 = document.getElementById("commandPipsP1");
  if (host0 || host1) {
    const mkPips = (left) => {
      const out = [];
      for (let i = 0; i < total; i++) {
        const on = i < Math.max(0, Math.min(total, left));
        out.push(`<span class="cmdpip ${on ? "is-on" : ""}"></span>`);
      }
      return out.join("");
    };
    if (host0) host0.innerHTML = mkPips(leftOf(0));
    if (host1) host1.innerHTML = mkPips(leftOf(1));
    return;
  }

  // Fallback: single shared host
  const host = document.getElementById("commandPips");
  if (!host) return;

  const mkGroup = (pIndex) => {
    const left = leftOf(pIndex);
    const pips = [];
    for (let i = 0; i < total; i++) {
      const on = i < Math.max(0, Math.min(total, left));
      pips.push(`<span class="cmdpip ${on ? "is-on" : ""}"></span>`);
    }
    return `
      <div class="cmdgroup">
        <span class="cmdlabel">P${pIndex} Comando</span>
        <span class="cmdpips" aria-hidden="true">${pips.join("")}</span>
      </div>
    `;
  };

  host.innerHTML = mkGroup(0) + mkGroup(1);
}




/* =========================
   Render
   ========================= */
function renderAll() {
  updateTurnLine();
  renderHand(0);
  renderHand(1);
  renderBoard(0);
  renderBoard(1);
  renderPactum(0);
  renderPactum(1);
  renderPiles();
  renderLog();

  if (MODE?.kind === "QUEUE_ATTACK") {
    highlightAttackTargets(MODE.attackerUid);
  } else if (MODE?.kind === "ABILITY") {
    highlightAbilityTargets(MODE);
  } else if (MODE?.kind === "PACTUM_ABILITY") {
    highlightPactumTargets(MODE);
  } else {
    clearHighlights();
  }

  if (SELECTED_UID) {
    refreshHud();
    positionHudToSelected();
  }

  syncEndTurnBtn();
}

function renderHand(pIndex) {
  const handEl = document.getElementById(pIndex === 0 ? "handP0" : "handP1");
  if (!handEl) return;

  handEl.innerHTML = "";
  const hand = STATE.players[pIndex].hand;

  hand.forEach((cardId, handIndex) => {
    const card = getCardById(cardId);
    if (!card) return;

    const cardEl = document.createElement("div");
    cardEl.className = "card";
    cardEl.draggable = (pIndex === STATE.activePlayer && STATE.phase === "COMMAND" && STATE.winner === null);
    cardEl.dataset.cardId = cardId;
    cardEl.dataset.type = card.type;
    cardEl.dataset.handIndex = String(handIndex);
    cardEl.dataset.owner = String(pIndex);

    const img = document.createElement("img");
    img.src = card.image?.startsWith("data/") ? card.image : `data/${card.image}`;
    img.alt = card.name;
    cardEl.appendChild(img);

    handEl.appendChild(cardEl);
  });
}

function renderBoard(pIndex) {
  const slots = $all(`.slot[data-owner="${pIndex}"]`);
  for (const slotEl of slots) {
    const lane = slotEl.dataset.row; // front/back (reserve ignored)
    const col = Number(slotEl.dataset.col);

    if (lane !== "front" && lane !== "back") continue;

    const unit = STATE.players[pIndex].board[lane]?.[col] || null;

    slotEl.innerHTML = "";
    if (!unit) continue;

    const card = getCardById(unit.cardId);

    const uEl = document.createElement("div");
    uEl.className = "card on-board";
    uEl.dataset.uid = unit.uid;
    uEl.dataset.owner = String(unit.owner);
    uEl.dataset.lane = lane;
    uEl.dataset.col = String(col);

    const img = document.createElement("img");
    img.src = card?.image?.startsWith("data/") ? card.image : `data/${card?.image}`;
    img.alt = card?.name || unit.cardId;
    uEl.appendChild(img);

    // mini badge vit (optional, zero CSS required)
    const vit = document.createElement("div");
    vit.className = "vitBadge";
    vit.textContent = `${unit.vit}/${unit.vitMax}`;
    vit.style.position = "absolute";
    vit.style.right = "6px";
    vit.style.bottom = "6px";
    vit.style.padding = "2px 6px";
    vit.style.fontSize = "12px";
    vit.style.borderRadius = "10px";
    vit.style.background = "rgba(0,0,0,.55)";
    vit.style.color = "white";
    uEl.style.position = "relative";
    uEl.appendChild(vit);

    slotEl.appendChild(uEl);
  }
}

// Render delle carte Pactum (2 slot laterali per player)
function renderPactum(pIndex) {
  const root = document.getElementById(pIndex === 0 ? "pactumP0" : "pactumP1");
  if (!root) return;

  const slots = $all(`.pactumSlot[data-owner="${pIndex}"]`, root);
  const arr = STATE.players[pIndex].pactum || [null, null];

  for (const slotEl of slots) {
    const idx = Number(slotEl.dataset.idx);

    // conserva l'hint
    const hint = slotEl.querySelector(".zoneHint");
    slotEl.innerHTML = "";
    if (hint) slotEl.appendChild(hint);

    const cardId = arr[idx] || null;
    if (!cardId) continue;

    const card = getCardById(cardId);
    const cEl = document.createElement("div");
    cEl.className = "card pactum-on-board";
    cEl.dataset.owner = String(pIndex);
    cEl.dataset.zone = "pactum";
    cEl.dataset.idx = String(idx);
    cEl.dataset.cardId = cardId;

    const img = document.createElement("img");
    img.src = card?.image?.startsWith("data/") ? card.image : `data/${card?.image}`;
    img.alt = card?.name || cardId;
    cEl.appendChild(img);

    slotEl.appendChild(cEl);
  }
}

function renderPiles() {
  renderPile("deckP0", STATE.players[0].deck.length, true);
  renderPile("discardP0", STATE.players[0].discard.length, false);

  renderPile("deckP1", STATE.players[1].deck.length, true);
  renderPile("discardP1", STATE.players[1].discard.length, false);
}

function renderPile(id, count, faceDown) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `
    <div class="pile__top"></div>
    <div class="pile__count">${faceDown ? "Carte" : "Scarti"}: <strong>${count}</strong></div>
  `;
}

function renderLog() {
  const logEl = $("#log");
  if (!logEl) return;

  logEl.innerHTML = STATE.log
    .slice(-60)
    .map(l => `<div>${escapeHtml(l)}</div>`)
    .join("");
}

/* =========================
   End Turn button behaviour
   ========================= */
function syncEndTurnBtn() {
  const endBtn = $("#endTurnBtn");
  const cmdBtn = $("#toCommandBtn");

  // Vai a COMMAND: DRAW non esiste più (pesca automatica)
  if (cmdBtn) {
    cmdBtn.disabled = true;
    cmdBtn.style.display = "none";
  }

  // Fine Turno solo in ATTACK
  if (endBtn) {
    const enabledEnd = (STATE.winner === null && STATE.phase === "ATTACK" && STATE.activePlayer !== null);
    endBtn.disabled = !enabledEnd;
    endBtn.style.opacity = enabledEnd ? "1" : "0.5";
    endBtn.title = enabledEnd ? "" : "Vai prima in fase ATTACK (dal HUD) per finire il turno.";
  }
}

function endTurn() {
  if (STATE.winner !== null) return;
  if (STATE.phase !== "ATTACK") return;

  STATE = applyAction(STATE, { type: "END_TURN", player: STATE.activePlayer });
  MODE = null;
  clearHighlights();
  renderAll();

  if (SELECTED_UID) openHud(SELECTED_UID);
}

/* =========================
   HUD
   ========================= */
const HUD = {
  root: null,
  panel: null,
  title: null,
  stats: null,
  abilities: null,
  passives: null,
  close: null,
};

function initHud() {
  HUD.root = $("#actionHud");
  HUD.panel = $(".hud__panel");
  HUD.title = $("#hudTitle");
  HUD.stats = $("#hudStats");
  HUD.abilities = $("#hudAbilities");
  HUD.passives = $("#hudPassives");
  HUD.close = $("#hudClose");

  HUD.close?.addEventListener("click", closeHud);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      MODE = null;
      clearHighlights();
      closeHud();
      hidePreview();
      renderAll();
    }
  });

  HUD.panel?.addEventListener("click", (e) => {
    e.stopPropagation();

    const unit = getUnitByUid(SELECTED_UID);
    if (!unit) return;

    const toAttackBtn = e.target.closest("[data-action='to-attack']");
    if (toAttackBtn) {
      if (!isMyTurn(unit.owner)) return;
      if (STATE.phase !== "COMMAND") return;
      STATE = applyAction(STATE, { type: "TO_ATTACK_PHASE", player: STATE.activePlayer });
      MODE = null;
      renderAll();
      return;
    }

    const resolveBtn = e.target.closest("[data-action='resolve']");
    if (resolveBtn) {
      if (STATE.phase !== "ATTACK") return;
      STATE = applyAction(STATE, { type: "RESOLVE_ATTACKS", player: STATE.activePlayer });
      MODE = null;
      renderAll();
      return;
    }

const queueBtn = e.target.closest("[data-action='queue-attack']");
if (queueBtn) {
  if (!isMyTurn(unit.owner)) return;

  // AUTO: se sei in COMMAND, passa subito in ATTACK
  if (STATE.phase === "COMMAND") {
    STATE = applyAction(STATE, { type: "TO_ATTACK_PHASE", player: STATE.activePlayer });
  }
  if (STATE.phase !== "ATTACK") return;

  const card = getCardById(unit.cardId); // FIX: prima era undefined
  const targets = getValidAttackTargets(STATE, unit.uid);

  if (!targets.length) {
    STATE.log.push(`Nessun bersaglio valido per l'attacco (${card?.name || unit.cardId}).`);
    renderAll();
    return;
  }

  STATE.log.push(`Seleziona un bersaglio: ${card?.name || unit.cardId}`);
  MODE = { kind: "QUEUE_ATTACK", attackerUid: unit.uid };
  renderAll();
  return;
}

    const cancelBtn = e.target.closest("[data-action='cancel']");
    if (cancelBtn) {
      MODE = null;
      renderAll();
      return;
    }

    const activeBtn = e.target.closest("[data-action='active']");
    if (activeBtn) {
      const slot = Number(activeBtn.dataset.slot);
      const card = getCardById(unit.cardId);
      const ability = (card?.abilities || []).find(a => a.type === "active" && a.slot === slot);
      if (!ability) return;

      // targeting: se nel json hai rules.targeting come array (multi-target)
      const targeting = ability?.rules?.targeting;

      if (Array.isArray(targeting) && targeting.length) {
        MODE = { kind: "ABILITY", unitUid: unit.uid, slot, queue: targeting.map(t => t.id), picked: {} };
        closeHud();
        renderAll();
        return;
      }

      // euristica: se testo contiene “scegli/unità/bersaglio”
      const needsTarget = /scegli|unità|bersaglio/i.test(ability.text || "");
      if (needsTarget) {
        MODE = { kind: "ABILITY", unitUid: unit.uid, slot };
        closeHud();
        renderAll();
        return;
      }

      // no target
      STATE = applyAction(STATE, {
        type: "ACTIVATE_ABILITY",
        player: unit.owner,
        unitUid: unit.uid,
        slot,
        payload: {}
      });

      MODE = null;
      renderAll();
    }
  });
}

function openHud(uid) {
  SELECTED_UID = uid;
  SELECTED_CARD_ID = null;
  SELECTED_CARD_CTX = null;
  refreshHud();
  positionHudToSelected();
  HUD.root?.classList.add("is-open");
  HUD.root?.setAttribute("aria-hidden", "false");
}

function openCardHud(cardId, ctx = null) {
  SELECTED_UID = null;
  SELECTED_CARD_ID = cardId;
  SELECTED_CARD_CTX = ctx;
  refreshHud();
  // in inspect mode we don't anchor to a unit
  HUD.root?.classList.add("is-open");
  HUD.root?.setAttribute("aria-hidden", "false");
}

function closeHud() {
  HUD.root?.classList.remove("is-open");
  HUD.root?.setAttribute("aria-hidden", "true");
  SELECTED_UID = null;
  SELECTED_CARD_ID = null;
  SELECTED_CARD_CTX = null;
}

function getStats(unit) {
  const card = getCardById(unit.cardId);
  const b = card?.stats || {};
  return {
    vit: unit.vit ?? b.vit ?? 0,
    vitMax: unit.vitMax ?? b.vit ?? 0,
    imp: unit.imp ?? b.imp ?? 0,
    def: unit.def ?? b.def ?? 0,
    vel: unit.vel ?? b.vel ?? 0,
  };
}

function refreshHud() {
  // =========================
  // Inspect mode (hand cards)
  // =========================
  if (SELECTED_CARD_ID) {
    const card = getCardById(SELECTED_CARD_ID);
    if (!card) { closeHud(); return; }

    if (HUD.title) {
      const meta = [card.faction, card.rarity, card.class].filter(Boolean).join(" · ");
      HUD.title.textContent = meta ? `${card.name} — ${meta}` : (card.name || card.id);
    }

    const b = card.stats || {};
    const vitMax = b.vit ?? 0;
    const imp = b.imp ?? 0;
    const def = b.def ?? 0;
    const vel = b.vel ?? 0;

    if (HUD.stats) {
      HUD.stats.innerHTML = `
        <div class="hud__stat">VIT ${vitMax}/${vitMax}</div>
        <button type="button" class="hud__stat hud__attack" disabled>ATTACCO</button>
        <div class="hud__stat">IMP ${imp}</div>
        <div class="hud__stat">DEF ${def}</div>
        <div class="hud__stat">VEL ${vel}</div>
      `;
    }

    const actives = (card.abilities || []).filter(a => a.type === "active");
    const passives = (card.abilities || []).filter(a => a.type === "passive");

    if (HUD.abilities) {
      HUD.abilities.innerHTML = `
        ${actives.map(a => `
          <button type="button" class="hud__ability" disabled>
            <div class="hud__ability-title">A${a.slot} — ${escapeHtml(a.name || `Abilità ${a.slot}`)}</div>
            <div class="hud__ability-text">${escapeHtml(a.text || "")}</div>
          </button>
        `).join("")}
        <div class="hud__actionsRow"></div>
      `;
    }

    if (HUD.passives) {
      HUD.passives.innerHTML = passives.map(p => `
        <div class="hud__passive">
          <div class="hud__passive-title">◆ ${escapeHtml(p.name || "Passiva")}</div>
          <div class="hud__passive-text">${escapeHtml(p.text || "")}</div>
        </div>
      `).join("");
    }

    return;
  }

  // =========================
  // Unit HUD (board)
  // =========================
  const unit = getUnitByUid(SELECTED_UID);
  if (!unit) { closeHud(); return; }

  const card = getCardById(unit.cardId);
  const stats = getStats(unit);

  if (HUD.title) HUD.title.textContent = card?.name || unit.cardId;

  const pending = STATE.pendingAttacks?.length || 0;
  const canAttackPhase = (STATE.phase === "COMMAND" && isMyTurn(unit.owner));
  const canResolve = (STATE.phase === "ATTACK" && pending > 0 && isMyTurn(unit.owner));
  const canQueue = (STATE.phase === "ATTACK" && isMyTurn(unit.owner) && getValidAttackTargets(STATE, unit.uid).length > 0);

  if (HUD.stats) {
    HUD.stats.innerHTML = `
      <div class="hud__stat">VIT ${stats.vit}/${stats.vitMax}</div>
      <button type="button" class="hud__stat hud__attack" data-action="queue-attack" ${canQueue ? "" : "disabled"}>ATTACCO</button>
      <div class="hud__stat">IMP ${stats.imp}</div>
      <div class="hud__stat">DEF ${stats.def}</div>
      <div class="hud__stat">VEL ${stats.vel}</div>
    `;
  }

  const actives = (card?.abilities || []).filter(a => a.type === "active");
  const passives = (card?.abilities || []).filter(a => a.type === "passive");

  const phaseRow = (() => {
    if (!isMyTurn(unit.owner)) return "";
    if (STATE.phase === "COMMAND") {
      return `<button type="button" class="hud__btn hud__btn--primary" data-action="to-attack" ${canAttackPhase ? "" : "disabled"}>Vai a ATTACK</button>`;
    }
    if (STATE.phase === "ATTACK") {
      return `
        <button type="button" class="hud__btn hud__btn--primary" data-action="resolve" ${canResolve ? "" : "disabled"}>Risolvi Attacchi (${pending})</button>
        <button type="button" class="hud__btn" data-action="cancel" ${MODE ? "" : "disabled"}>Annulla</button>
      `;
    }
    return "";
  })();

  if (HUD.abilities) {
    HUD.abilities.innerHTML = `
      ${actives.map(a => `
        <button type="button" class="hud__ability" data-action="active" data-slot="${a.slot}">
          <div class="hud__ability-title">A${a.slot} — ${escapeHtml(a.name || `Abilità ${a.slot}`)}</div>
          <div class="hud__ability-text">${escapeHtml(a.text || "")}</div>
        </button>
      `).join("")}
      <div class="hud__actionsRow">${phaseRow}</div>
    `;
  }

  if (HUD.passives) {
    HUD.passives.innerHTML = passives.length ? `
      <div><strong>Passive</strong></div>
      ${passives.map(p => `<div class="hud__passive">• ${escapeHtml(p.name || "Passiva")} — <span class="hud__passive-text">${escapeHtml(p.text || "")}</span></div>`).join("")}
    ` : "";
  }
}

function positionHudToSelected() {
  if (!SELECTED_UID || !HUD.panel) return;
  const el = document.querySelector(`.card.on-board[data-uid="${SELECTED_UID}"]`);
  if (!el) return;

  const r = el.getBoundingClientRect();
  const gap = 12;
  const panelW = HUD.panel.offsetWidth || 280;
  const panelH = HUD.panel.offsetHeight || 140;

  let left = r.right + gap;
  let top = r.top + (r.height * 0.55) - (panelH * 0.5);

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (left + panelW > vw - 8) left = r.left - gap - panelW;
  top = Math.max(8, Math.min(vh - panelH - 8, top));

  HUD.panel.style.left = `${Math.round(left)}px`;
  HUD.panel.style.top = `${Math.round(top)}px`;
}

/* =========================
   Preview (usa #cardPreview)
   ========================= */
function showPreviewFromCardId(cardId) {
  const card = getCardById(cardId);
  if (!card) return;

  const wrap = $("#cardPreview");
  const img = $("#cardPreviewImg");
  if (!wrap || !img) return;

  img.src = card.image?.startsWith("data/") ? card.image : `data/${card.image}`;
  wrap.setAttribute("aria-hidden", "false");
  wrap.classList.add("is-open");
}
function hidePreview() {
  const wrap = $("#cardPreview");
  if (!wrap) return;
  wrap.setAttribute("aria-hidden", "true");
  wrap.classList.remove("is-open");
}

/* =========================
   Highlights
   ========================= */
function clearHighlights() {
  $all(".card.on-board").forEach(c => c.classList.remove("is-target"));
}

function highlightAttackTargets(attackerUid) {
  clearHighlights();
  const targets = getValidAttackTargets(STATE, attackerUid);
  for (const tid of targets) {
    const el = $(`.card.on-board[data-uid="${tid}"]`);
    if (el) el.classList.add("is-target");
  }
}

function highlightAbilityTargets(mode) {
  clearHighlights();

  const unit = getUnitByUid(mode.unitUid);
  if (!unit) return;

  const card = getCardById(unit.cardId);
  const ability = (card?.abilities || []).find(a => a.type === "active" && a.slot === mode.slot);
  const txt = ability?.text || "";

  let list = [];
  if (/nemic/i.test(txt)) list = allBoardUids(1 - unit.owner);
  else if (/alleat/i.test(txt)) list = allBoardUids(unit.owner);
  else list = allBoardUids(1 - unit.owner).concat(allBoardUids(unit.owner));

  list = list.filter(uid => {
    const t = getUnitByUid(uid);
    if (!t) return false;
    if (t.owner !== unit.owner && t.flags?.untargetableByEnemyAbilities) return false;
    return true;
  });

  for (const tid of list) {
    const el = $(`.card.on-board[data-uid="${tid}"]`);
    if (el) el.classList.add("is-target");
  }
}

/* =========================
   DND deploy: hand -> slot
   ========================= */
function baseIdFromCardId(cardId) {
  return String(cardId).replace(/_(communis|rara|insignis|mythica|aeterna|apex)$/i, "");
}
function rarityIndex(r) {
  switch (String(r).toLowerCase()) {
    case "communis": return 0;
    case "rara": return 1;
    case "insignis": return 2;
    case "mythica": return 3;
    case "aeterna": return 4;
    case "apex": return 5;
    default: return 0;
  }
}
function minTurnForRarity(r) {
  switch (String(r).toLowerCase()) {
    case "communis": return 1;
    case "rara": return 2;
    case "insignis": return 3;
    case "mythica": return 4;
    case "aeterna": return 5;
    case "apex": return 999;
    default: return 1;
  }
}

let draggedCard = null;

function canDrop(cardEl, slotEl) {
  if (!cardEl || !slotEl) return false;
  if (STATE.winner !== null) return false;
  if (STATE.phase !== "COMMAND") return false;

  const cardOwner = Number(cardEl.dataset.owner);
  const slotOwner = Number(slotEl.dataset.owner);

  if (slotOwner !== cardOwner) return false;
  if (cardOwner !== STATE.activePlayer) return false;
  if (!isMyTurn(cardOwner)) return false;

  const dragType = cardEl.dataset.type;
  if (dragType !== "unit" && dragType !== "event") return false;

  const me = STATE.players[cardOwner];
  const draggedId = cardEl.dataset.cardId;
  const dragged = getCardById(draggedId);
  if (!dragged) return false;

  const zone = slotEl.dataset.zone || "board";
  const idx = Number(slotEl.dataset.idx);

  // Pactum slots accept only Vigilia/Fatum event cards
  if (zone === "pactum") {
    if (dragType !== "event") return false;
    if (!isPactumCard(dragged)) return false;
    if (idx !== 0 && idx !== 1) return false;

    // costa 1 azione comando
    if (me.perTurn?.commandActionsLeft <= 0) return false;

    if (!me.pactum) me.pactum = [null, null];
    const existing = me.pactum[idx] || null;
    return !existing; // solo slot libero
  }



  const lane = slotEl.dataset.row;
  const col = Number(slotEl.dataset.col);
  if (lane !== "front" && lane !== "back") return false;

  const existing = me.board?.[lane]?.[col] || null;

  // Slot vuoto: deploy standard (engine gestisce turni/copie/azioni)
  if (!existing) return true;

  // Slot pieno: consentito SOLO se è un'ASCESA (rarità immediatamente successiva, stesso personaggio)
  if (STATE.turn === 1) return false;
  if (me.perTurn?.commandActionsLeft <= 0) return false;
  if (me.perTurn?.ascendUsed) return false;

  const fromCard = getCardById(existing.cardId);
  if (!fromCard) return false;

  const sameBase = baseIdFromCardId(fromCard.id) === baseIdFromCardId(dragged.id);
  const nextStep = rarityIndex(dragged.rarity) === rarityIndex(fromCard.rarity) + 1;
  const turnOk = STATE.turn >= minTurnForRarity(dragged.rarity);

  return sameBase && nextStep && turnOk;
}

document.addEventListener("dragstart", (e) => {
  const card = e.target.closest("#handP0 .card, #handP1 .card");
  if (!card) return;

  const owner = Number(card.dataset.owner);
  if (!isMyTurn(owner)) return;
  if (STATE.phase !== "COMMAND") return;

  draggedCard = card;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", card.dataset.cardId || "card");
});

document.addEventListener("dragend", () => {
  draggedCard = null;
  $all(".slot").forEach(s => s.classList.remove("is-over", "is-invalid"));
});

/* =========================
   Mobile touch/pointer drag (mano -> slot)
   ========================= */
let TOUCH_DND = null; // { cardEl, ghostEl, overSlot, startX, startY, moved }
let TOUCH_PICK = null; // fallback tap-to-place on mobile

function __clearTouchPick(){
  TOUCH_PICK = null;
  document.querySelectorAll("#battlefield .hand .card.is-picked").forEach(el => el.classList.remove("is-picked"));
  document.querySelectorAll(".slot.is-over, .slot.is-invalid").forEach(el => el.classList.remove("is-over","is-invalid"));
}

function __markTouchTargets(cardEl){
  document.querySelectorAll(".slot.is-over, .slot.is-invalid").forEach(el => el.classList.remove("is-over","is-invalid"));
  if(!cardEl) return;
  document.querySelectorAll(".slot").forEach(slot => {
    const ok = canDrop(cardEl, slot);
    if (ok) slot.classList.add("is-over");
  });
}

function __createGhost(cardEl){
  const img = cardEl.querySelector("img");
  const g = document.createElement("div");
  g.className = "touchGhost";
  g.style.position = "fixed";
  g.style.left = "0px";
  g.style.top = "0px";
  g.style.transform = "translate(-9999px,-9999px)";
  g.style.zIndex = "9999";
  g.style.pointerEvents = "none";
  g.style.width = "140px";
  g.style.maxWidth = "40vw";
  g.style.borderRadius = "14px";
  g.style.boxShadow = "0 18px 50px rgba(0,0,0,.55)";
  g.style.overflow = "hidden";
  g.style.background = "rgba(0,0,0,.25)";
  const gi = document.createElement("img");
  gi.src = img?.getAttribute("src") || "";
  gi.alt = img?.alt || "";
  gi.style.width = "100%";
  gi.style.height = "auto";
  gi.draggable = false;
  g.appendChild(gi);
  document.body.appendChild(g);
  return g;
}

function __updateTouchOver(slot){
  if(TOUCH_DND?.overSlot && TOUCH_DND.overSlot !== slot){
    TOUCH_DND.overSlot.classList.remove("is-over","is-invalid");
  }
  TOUCH_DND.overSlot = slot;
  if(!slot) return;

  const ok = canDrop(TOUCH_DND.cardEl, slot);
  slot.classList.add(ok ? "is-over" : "is-invalid");
}

document.addEventListener("pointerdown", (e) => {
  // solo touch/pen, solo carte in mano
  if (e.pointerType === "mouse") return;

  const card = e.target.closest(".card");
  if (!card) return;
  if (card.dataset.zone !== "hand") return;

  // Solo se è possibile giocare
  const owner = Number(card.dataset.owner);
  if (STATE?.winner != null) return;
  if (!STATE?.players?.[owner]) return;
  if (STATE.phase !== "COMMAND") return;
  if (!isMyTurn(owner)) return;
  if (owner !== STATE.activePlayer) return;

  TOUCH_PICK = card;
  document.querySelectorAll("#battlefield .hand .card.is-picked").forEach(el => el.classList.remove("is-picked"));
  card.classList.add("is-picked");
  __markTouchTargets(card);

  TOUCH_DND = {
    cardEl: card,
    ghostEl: null,
    overSlot: null,
    startX: e.clientX,
    startY: e.clientY,
    moved: false
  };
  try { card.setPointerCapture(e.pointerId); } catch {}
}, { passive: true });

document.addEventListener("pointermove", (e) => {
  if (!TOUCH_DND) return;
  const dx = e.clientX - TOUCH_DND.startX;
  const dy = e.clientY - TOUCH_DND.startY;

  // se l'utente inizia a muovere, consideriamo drag e annulliamo eventuale long-press zoom
  if (!TOUCH_DND.moved && (Math.abs(dx) + Math.abs(dy)) > 10) {
    TOUCH_DND.moved = true;
    __cancelZoomHold();
    TOUCH_DND.ghostEl = __createGhost(TOUCH_DND.cardEl);
  }

  if (!TOUCH_DND.moved) return;

  e.preventDefault();

  // muovi ghost
  const g = TOUCH_DND.ghostEl;
  if (g) {
    g.style.transform = `translate(${e.clientX - 70}px, ${e.clientY - 90}px)`;
  }

  // trova slot sotto il dito
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const slot = el?.closest?.(".slot") || null;
  __updateTouchOver(slot);
}, { passive: false });

function __endTouchDnD(){
  if(!TOUCH_DND) return;

  // drop se valido
  if (TOUCH_DND.moved && TOUCH_DND.overSlot && canDrop(TOUCH_DND.cardEl, TOUCH_DND.overSlot)) {
    __performDrop(TOUCH_DND.cardEl, TOUCH_DND.overSlot);
  } else {
    // pulizia highlight
    if (TOUCH_DND.overSlot) TOUCH_DND.overSlot.classList.remove("is-over","is-invalid");
  }

  if (TOUCH_DND.ghostEl) TOUCH_DND.ghostEl.remove();
  if (TOUCH_DND.overSlot) TOUCH_DND.overSlot.classList.remove("is-over","is-invalid");
  TOUCH_DND = null;
  __clearTouchPick();
}

document.addEventListener("pointerup", __endTouchDnD, { passive: true });
document.addEventListener("pointercancel", __endTouchDnD, { passive: true });


document.addEventListener("pointerup", (e) => {
  if (e.pointerType === "mouse") return;
  const slot = e.target.closest?.(".slot");
  if (!slot) {
    const onHandCard = e.target.closest?.("#battlefield .hand .card");
    if (!onHandCard && !TOUCH_DND?.moved) __clearTouchPick();
    return;
  }
  const cardEl = TOUCH_PICK || TOUCH_DND?.cardEl;
  if (!cardEl) return;
  if (TOUCH_DND?.moved) return;
  if (!canDrop(cardEl, slot)) return;
  __performDrop(cardEl, slot);
  __clearTouchPick();
}, { passive: true });

document.addEventListener("dragover", (e) => {
  const slot = e.target.closest(".slot");
  if (!slot || !draggedCard) return;

  const ok = canDrop(draggedCard, slot);
  if (ok) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    slot.classList.add("is-over");
    slot.classList.remove("is-invalid");
  } else {
    slot.classList.add("is-invalid");
    slot.classList.remove("is-over");
  }
});

function __performDrop(cardEl, slotEl){
  if(!cardEl || !slotEl) return;
  if(!canDrop(cardEl, slotEl)) return;

  // owner/handIndex servono sia per board che per pactum
  const handIndex = Number(cardEl.dataset.handIndex);
  const owner = Number(cardEl.dataset.owner);

  const zone = slotEl.dataset.zone || "board";
  const idx = Number(slotEl.dataset.idx);

  if (zone === "pactum") {
    const me = STATE.players[owner];
    const cardId = me.hand?.[handIndex] || cardEl.dataset.cardId;
    if (!me.pactum) me.pactum = [null, null];
    me.pactum[idx] = cardId;

    // Consuma 1 Azione Comando (coerente con canDrop)
    if (me.perTurn && typeof me.perTurn.commandActionsLeft === "number") {
      me.perTurn.commandActionsLeft = Math.max(0, me.perTurn.commandActionsLeft - 1);
    }

    // remove from hand
    if (Array.isArray(me.hand)) me.hand.splice(handIndex, 1);

    MODE = null;
    clearHighlights();
    renderAll();
    return;
  }

  const lane = slotEl.dataset.row;
  const col = Number(slotEl.dataset.col);
  const existing = STATE.players[owner].board?.[lane]?.[col] || null;

  if (existing) {
    // ASCESA: carta sopra la versione precedente nello stesso slot
    STATE = applyAction(STATE, {
      type: "ASCEND",
      player: owner,
      fromUid: existing.uid,
      handIndex
    });
  } else {
    // DEPLOY standard su slot vuoto
    STATE = applyAction(STATE, {
      type: "PLAY_UNIT",
      player: owner,
      handIndex,
      lane,
      slot: col
    });
  }

  MODE = null;
  clearHighlights();
  renderAll();
}

document.addEventListener("drop", (e) => {
  const slot = e.target.closest(".slot");
  if (!slot || !draggedCard) return;

  e.preventDefault();
  slot.classList.remove("is-over", "is-invalid");

  __performDrop(draggedCard, slot);
});


/* =========================
   Click logic (board + preview)
   ========================= */
document.addEventListener("click", (e) => {
  // click su preview per chiuderlo
  if (e.target.closest("#cardPreview")) {
    hidePreview();
    return;
  }

  // se clicchi dentro HUD non chiudere nulla
  if (e.target.closest(".hud__panel")) return;

  const cardEl = e.target.closest(".card.on-board");
  const handCard = e.target.closest(".hand .card");

  // In modalità target-pick: click su unità = scegli target
  if (MODE && cardEl) {
    e.preventDefault();
    e.stopPropagation();
    onPickTarget(cardEl.dataset.uid);
    return;
  }

  // click su carta in mano: HUD (solo lettura)
  // (ALT+click apre la preview grande, se ti serve)
  if (!MODE && handCard) {
    const cardId = handCard.dataset.cardId;
    if (e.altKey) {
      showPreviewFromCardId(cardId);
    } else {
      openCardHud(cardId);
    }
    return;
  }

  // click su unità: HUD
  if (!MODE && cardEl) {
    openHud(cardEl.dataset.uid);
    return;
  }

  // click vuoto: chiudi HUD e cancella MODE
  if (MODE) {
    MODE = null;
    renderAll();
  } else if (SELECTED_UID || SELECTED_CARD_ID) {
    closeHud();
    renderAll();
  }
});

/* =========================
   Press & hold zoom (mano + campo + pactum)
   ========================= */
let __zoomTimer = null;
let __zoomCard = null;
let __zoomStart = null;

function __getZoomOverlay(){
  let ov = document.getElementById("zoomOverlay");
  if(!ov){
    ov = document.createElement("div");
    ov.id = "zoomOverlay";
    ov.innerHTML = '<div class="zoomWrap"><div class="zoomCard"><img id="zoomImg" alt=""></div><div id="zoomInfo" class="zoomInfo" role="note" aria-label="Info carta"></div></div>';
    document.body.appendChild(ov);
  }
  return ov;
}
function __cardIdFromEl(cardEl){
  if(!cardEl) return null;
  const direct = cardEl.dataset?.cardId;
  if(direct) return direct;

  const uid = cardEl.dataset?.uid;
  if(uid){
    const u = getUnitByUid(uid);
    if(u?.cardId) return u.cardId;
  }

  // pactum cards
  const zone = cardEl.dataset?.zone;
  if(zone === "pactum" && cardEl.dataset?.cardId) return cardEl.dataset.cardId;

  return null;
}

function __buildZoomInfo(cardId, unitUid=null){
  const card = getCardById(cardId);
  if(!card) return "";

  const meta = [card.faction, card.rarity, card.class, card.type].filter(Boolean).join(" · ");

  let statsHtml = "";
  if(card.type === "unit"){
    if(unitUid){
      const u = getUnitByUid(unitUid);
      const s = u ? getStats(u) : (card.stats||{});
      const vit = u ? s.vit : (card.stats?.vit ?? 0);
      const vitMax = u ? s.vitMax : (card.stats?.vit ?? 0);
      statsHtml = `
        <div class="stats">
          <div class="stat">VIT ${vit}/${vitMax}</div>
          <div class="stat">IMP ${s.imp ?? (card.stats?.imp ?? 0)}</div>
          <div class="stat">DEF ${s.def ?? (card.stats?.def ?? 0)}</div>
          <div class="stat">VEL ${s.vel ?? (card.stats?.vel ?? 0)}</div>
        </div>
      `;
    } else {
      const b = card.stats || {};
      const vitMax = b.vit ?? 0;
      statsHtml = `
        <div class="stats">
          <div class="stat">VIT ${vitMax}/${vitMax}</div>
          <div class="stat">IMP ${b.imp ?? 0}</div>
          <div class="stat">DEF ${b.def ?? 0}</div>
          <div class="stat">VEL ${b.vel ?? 0}</div>
        </div>
      `;
    }
  }

  const actives = (card.abilities || []).filter(a => a.type === "active");
  const passives = (card.abilities || []).filter(a => a.type === "passive");

  const activesHtml = actives.length ? `
    <div class="sectTitle">Attive</div>
    ${actives.map(a => `
      <div class="ab">
        <div class="abTitle">A${escapeHtml(a.slot ?? "")} — ${escapeHtml(a.name || "Abilità")}</div>
        <div class="abText">${escapeHtml(a.text || "")}</div>
      </div>
    `).join("")}
  ` : "";

  const passivesHtml = passives.length ? `
    <div class="sectTitle">Passive</div>
    ${passives.map(p => `
      <div class="ab">
        <div class="abTitle">◆ ${escapeHtml(p.name || "Passiva")}</div>
        <div class="abText">${escapeHtml(p.text || "")}</div>
      </div>
    `).join("")}
  ` : "";

  return `
    <h3>${escapeHtml(card.name || card.id)}</h3>
    <div class="meta">${escapeHtml(meta)}</div>
    ${statsHtml}
    ${activesHtml}
    ${passivesHtml}
  `;
}

function __showZoomOverlay(cardEl){
  const imgEl = cardEl.querySelector("img");
  const src = imgEl?.getAttribute("src");
  if(!src) return;

  const ov = __getZoomOverlay();
  const zi = ov.querySelector("#zoomImg");
  const info = ov.querySelector("#zoomInfo");

  zi.src = src;
  zi.alt = imgEl?.alt || "";

  const cardId = __cardIdFromEl(cardEl);
  const unitUid = cardEl.dataset?.uid || null;

  if(info){
    info.innerHTML = cardId ? __buildZoomInfo(cardId, unitUid) : "";
  }

  ov.classList.add("is-on");
  ov.setAttribute("aria-hidden","false");
}
function __hideZoomOverlay(){
  const ov = document.getElementById("zoomOverlay");
  if(!ov) return;
  ov.classList.remove("is-on");
  ov.setAttribute("aria-hidden","true");
  const zi = ov.querySelector("#zoomImg");
  if(zi) zi.src = "";
}


function __clearZoom() {
  if (__zoomTimer) {
    clearTimeout(__zoomTimer);
    __zoomTimer = null;
  }
  if (__zoomCard) {
    __zoomCard = null;
  }
  __hideZoomOverlay();
  __zoomStart = null;
}

function __cancelZoomHold() {
  __clearZoom();
}

document.addEventListener("pointerdown", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;

  // Solo tasto sinistro (mouse) o touch/pen
  if (e.pointerType === "mouse" && e.button !== 0) return;

  __clearZoom();
  __zoomCard = card;
  __zoomStart = { x: e.clientX, y: e.clientY };

  // Zoom dopo una breve pressione (evita conflitto con drag)
  __zoomTimer = setTimeout(() => {
    if (__zoomCard) __showZoomOverlay(__zoomCard);
    __zoomTimer = null;
  }, 180);
});

document.addEventListener("pointermove", (e) => {
  if (!__zoomTimer || !__zoomStart) return;
  const dx = e.clientX - __zoomStart.x;
  const dy = e.clientY - __zoomStart.y;
  if ((dx * dx + dy * dy) > (8 * 8)) {
    // se inizi a trascinare/spostare, annulla lo zoom
    clearTimeout(__zoomTimer);
    __zoomTimer = null;
    __zoomCard = null;
    __zoomStart = null;
  }
});

document.addEventListener("pointerup", __clearZoom);
document.addEventListener("pointercancel", __clearZoom);

// Se parte un drag vero e proprio, chiudi eventuale zoom
document.addEventListener("dragstart", () => {
  __clearZoom();
});

// tap/click sullo sfondo dello zoom per chiuderlo subito
document.addEventListener("pointerdown", (e) => {
  const ov = document.getElementById("zoomOverlay");
  if(!ov || !ov.classList.contains("is-on")) return;
  if(e.target === ov) __clearZoom();
}, {capture:true});

function onPickTarget(targetUid) {
  if (MODE?.kind === "PACTUM_ABILITY") {
    const { owner, idx, slot } = MODE;
    MODE = null;
    STATE = applyAction(STATE, { type: "ACTIVATE_PACTUM", player: owner, idx, slot, payload: { targetUid } });
    renderAll();
    return;
  }

  if (!MODE) return;

  // ===== QUEUE ATTACK =====
  if (MODE.kind === "QUEUE_ATTACK") {
    const attacker = getUnitByUid(MODE.attackerUid);
    if (!attacker) return;

    STATE = applyAction(STATE, {
      type: "QUEUE_ATTACK",
      player: attacker.owner,
      attackerUid: attacker.uid,
      targetUid
    });

    // esci dalla modalità target-pick
    MODE = null;

    renderAll();

    // opzionale: riapri HUD dell'attaccante per continuare fluido
    openHud(attacker.uid);
    return;
  }

  // ===== ABILITY TARGETING =====
  if (MODE.kind === "ABILITY") {
    const unit = getUnitByUid(MODE.unitUid);
    if (!unit) return;

    // multi-target guidato da queue
    if (MODE.queue?.length) {
      const id = MODE.queue[0];
      MODE.picked[id] = targetUid;
      MODE.queue.shift();

      if (MODE.queue.length) {
        renderAll();
        return;
      }

      STATE = applyAction(STATE, {
        type: "ACTIVATE_ABILITY",
        player: unit.owner,
        unitUid: unit.uid,
        slot: MODE.slot,
        payload: { targets: MODE.picked }
      });

      MODE = null;
      renderAll();
      return;
    }

    // single target
    STATE = applyAction(STATE, {
      type: "ACTIVATE_ABILITY",
      player: unit.owner,
      unitUid: unit.uid,
      slot: MODE.slot,
      payload: { targetUid }
    });

    MODE = null;
    renderAll();
  }
}

/* =========================
   Long-press / right-click preview (board)
   ========================= */
let pressTimer = null;
let pressedUid = null;
let startX = 0;
let startY = 0;

document.addEventListener("contextmenu", (e) => {
  const cardEl = e.target.closest(".card.on-board");
  if (!cardEl) return;
  e.preventDefault();
  const u = getUnitByUid(cardEl.dataset.uid);
  if (u) showPreviewFromCardId(u.cardId);
});

document.addEventListener("pointerdown", (e) => {
  if (MODE) return;
  if (e.button !== 0) return;
  if (e.target.closest(".hud__panel")) return;

  const cardEl = e.target.closest(".card.on-board");
  if (!cardEl) return;

  pressedUid = cardEl.dataset.uid;
  startX = e.clientX;
  startY = e.clientY;

  pressTimer = window.setTimeout(() => {
    const u = getUnitByUid(pressedUid);
    if (u) showPreviewFromCardId(u.cardId);
  }, 260);
});

function clearPress() {
  if (pressTimer) window.clearTimeout(pressTimer);
  pressTimer = null;
  pressedUid = null;
}

document.addEventListener("pointerup", clearPress);
document.addEventListener("pointercancel", clearPress);
document.addEventListener("pointermove", (e) => {
  if (!pressTimer) return;
  const dx = Math.abs(e.clientX - startX);
  const dy = Math.abs(e.clientY - startY);
  if (dx + dy > 8) clearPress();
});

/* =========================
   Window event from battle.html endTurnBtn
   ========================= */
window.addEventListener("BATTLE_END_TURN", () => endTurn());

/* =========================
   Log Dock (apribile con click)
   ========================= */
function initLogDock() {
  const dock = document.getElementById("logDock");
  const toggle = document.getElementById("logToggle");
  if (!dock || !toggle) return;

  const setOpen = (open) => {
    dock.classList.toggle("is-open", open);
    dock.classList.toggle("is-closed", !open);
    dock.setAttribute("aria-expanded", open ? "true" : "false");
  };

  // default: chiuso
  setOpen(false);

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!dock.classList.contains("is-open"));
    // scrolla in fondo quando apri
    if (dock.classList.contains("is-open")) {
      const logEl = document.getElementById("log");
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  });
}


/* =========================
   Boot
   ========================= */
(async function boot() {
  DB = await (await fetch(DATA_URL)).json();
  STATE = createGameState(DB, 1);

  const DECK_SIZE = 30;
  const OPENING_HAND = 5;

  // indicizza cards per id (veloce e sicuro)
  const byId = Object.create(null);
  for (const c of (DB.cards || [])) byId[c.id] = c;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function buildFactionDeck(faction) {
    const pool = (DB.cards || []).filter(c =>
      c.type === "unit" &&
      c.faction === faction &&
      (c.rarity === "communis" || c.rarity === "rara")
    );

    if (!pool.length) {
      throw new Error(`Pool vuoto per ${faction} (unit + communis/rara). Controlla faction/rarity in cards.json`);
    }

    const deck = [];
    let i = 0;
    while (deck.length < DECK_SIZE) {
      deck.push(pool[i % pool.length].id);
      i++;
    }
    return shuffle(deck);
  }

  function ensurePlayerArrays(p) {
    if (!Array.isArray(p.hand)) p.hand = [];
    if (!Array.isArray(p.discard)) p.discard = [];
    if (!Array.isArray(p.deck)) p.deck = [];
  }

  function drawOpeningHandWithCommunis(player, size) {
    ensurePlayerArrays(player);

    const deck = player.deck;
    const hand = player.hand;

    const communisIndex = deck.findIndex(id => byId[id]?.rarity === "communis");
    if (communisIndex !== -1) {
      hand.push(deck.splice(communisIndex, 1)[0]);
    }

    while (hand.length < size && deck.length) {
      hand.push(deck.shift());
    }
  }

  // init arrays
  ensurePlayerArrays(STATE.players[0]);
  ensurePlayerArrays(STATE.players[1]);

  // mazzi
  // Usa il deck salvato (Deck Builder) se presente. Altrimenti fallback su deck fazione.
  const activeDeck = (window.ARI_ACTIVE_DECK && Array.isArray(window.ARI_ACTIVE_DECK.list))
    ? window.ARI_ACTIVE_DECK
    : null;

  if (activeDeck && activeDeck.list.length) {
    STATE.players[0].deck = shuffle(activeDeck.list.slice());
  } else {
    STATE.players[0].deck = buildFactionDeck("LEGIO");
  }

  // P1: per ora deck fazione (in futuro puoi aggiungere selettore)
  STATE.players[1].deck = buildFactionDeck("HELVETII");

  // reset mani
  STATE.players[0].hand = [];
  STATE.players[1].hand = [];

  drawOpeningHandWithCommunis(STATE.players[0], OPENING_HAND);
  drawOpeningHandWithCommunis(STATE.players[1], OPENING_HAND);

  initHud();
  initLogDock();
  renderAll();

  window.addEventListener("resize", () => {
    if (SELECTED_UID) positionHudToSelected();
  });

  window.addEventListener("scroll", () => {
    if (SELECTED_UID) positionHudToSelected();
  }, { passive: true });

})();
function highlightPactumTargets(mode) {
  clearHighlights();
  const t = mode.targeting || {};
  const who = String(t.who || "ENEMY").toUpperCase();
  const zone = String(t.zone || "ANY").toUpperCase();

  const me = mode.owner;
  const other = me === 0 ? 1 : 0;
  const targetPlayer = (who === "ALLY" || who === "SELF") ? me : other;

  const lanes = [];
  if (zone.includes("FRONT")) lanes.push("front");
  else if (zone.includes("BACK")) lanes.push("back");
  else lanes.push("front","back");

  for (const lane of lanes) {
    for (let col=0; col<3; col++) {
      const uid = STATE.players[targetPlayer].board?.[lane]?.[col];
      if (!uid) continue;
      const el = document.querySelector(`.card.on-board[data-uid="${uid}"]`);
      if (el) el.classList.add("is-target");
    }
  }
}
