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
    `Gloria P0:<strong>${g0}</strong> · P1:<strong>${g1}</strong>`;  updateCommandPips();
}


function updateCommandPips() {
  const host = document.getElementById("commandPips");
  if (!host || !STATE) return;

  const mk = (pIndex) => {
    const left = STATE.players?.[pIndex]?.perTurn?.commandActionsLeft ?? 0;
    const total = 2;
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

  host.innerHTML = mk(0) + mk(1);
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
  renderPiles();
  renderLog();

  if (MODE?.kind === "QUEUE_ATTACK") {
    highlightAttackTargets(MODE.attackerUid);
  } else if (MODE?.kind === "ABILITY") {
    highlightAbilityTargets(MODE);
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
  refreshHud();
  positionHudToSelected();
  HUD.root?.classList.add("is-open");
  HUD.root?.setAttribute("aria-hidden", "false");
}

function openCardHud(cardId) {
  SELECTED_UID = null;
  SELECTED_CARD_ID = cardId;
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

  if (cardEl.dataset.type !== "unit") return false;

  const lane = slotEl.dataset.row;
  const col = Number(slotEl.dataset.col);
  if (lane !== "front" && lane !== "back") return false;

  const me = STATE.players[cardOwner];
  const draggedId = cardEl.dataset.cardId;
  const dragged = getCardById(draggedId);
  if (!dragged) return false;

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

document.addEventListener("drop", (e) => {
  const slot = e.target.closest(".slot");
  if (!slot || !draggedCard) return;

  e.preventDefault();
  slot.classList.remove("is-over", "is-invalid");

  if (!canDrop(draggedCard, slot)) return;

  const lane = slot.dataset.row;
  const col = Number(slot.dataset.col);
  const handIndex = Number(draggedCard.dataset.handIndex);
  const owner = Number(draggedCard.dataset.owner);
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

function onPickTarget(targetUid) {
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
  STATE.players[0].deck = buildFactionDeck("LEGIO");
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
