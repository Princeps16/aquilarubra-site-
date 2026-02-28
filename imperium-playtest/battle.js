// battle.js — versione corretta (HUD non blocca targeting + highlight affidabile + long-press zoom)
// NOTE: richiede CSS con #actionHud pointer-events:none e .hud__panel pointer-events:auto.

import { createGameState, applyAction, getValidAttackTargets } from "./engine/core.js";

const DATA_URL = "data/cards.json";

let DB = null;
let STATE = null;

// MODE: null | { kind:"ATTACK"|"ABILITY", attackerUid?, unitUid?, slot? }
let MODE = null;
let SELECTED_UID = null;

// HUD refs
const HUD = {
  root: null,
  panel: null,
  title: null,
  abilities: null,
  passives: null,
  close: null,
};

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

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

/* =========================
   BOOT
   ========================= */
(async function boot() {
  DB = await (await fetch(DATA_URL)).json();
  STATE = createGameState(DB, 1);

  // Playtest: seed mani se vuote
  if (STATE.players[0].hand.length === 0 && DB.cards.length) {
    const units = DB.cards.filter(c => c.type === "unit").map(c => c.id);
    STATE.players[0].hand = units.slice(0, 7);
    STATE.players[1].hand = units.slice(7, 14);
  }

  initHud();
  renderAll();
})();

/* =========================
   RENDER
   ========================= */
function renderAll() {
  renderHand(0);
  renderHand(1);
  renderBoard(0);
  renderBoard(1);
  renderLog();

  if (MODE?.kind === "ATTACK") {
    highlightAttackTargets(MODE.attackerUid);
  } else if (MODE?.kind === "ABILITY") {
    highlightAbilityTargets(MODE.unitUid, MODE.slot);
  } else {
    clearHighlights();
  }

  if (SELECTED_UID) {
    refreshHud();
    positionHudToSelected();
  }
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
    cardEl.draggable = (pIndex === STATE.activePlayer); // trascina solo il giocatore attivo
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
    const lane = slotEl.dataset.row; // front/back
    const col = Number(slotEl.dataset.col);
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

    slotEl.appendChild(uEl);
  }
}

/* =========================
   RULE HELPERS coerenti con engine
   ========================= */
function canAttack(unit) {
  if (!unit) return false;
  if (unit.flags?.attackedThisTurn) return false;
  return getValidAttackTargets(STATE, unit.uid).length > 0;
}

function canUseAbility(unit, slot) {
  if (!unit) return false;
  if (unit.flags?.disabledAbilities) return false;
  if (Array.isArray(unit.flags?.usedActiveSlots) && unit.flags.usedActiveSlots.includes(slot)) return false;
  return true;
}

/* =========================
   LOG
   ========================= */
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLog() {
  const logEl = $("#log");
  if (!logEl) return;

  logEl.innerHTML = STATE.log
    .slice(-30)
    .map(l => `<div>${escapeHtml(l)}</div>`)
    .join("");
}

/* =========================
   HUD
   ========================= */
function initHud() {
  HUD.root = document.getElementById("actionHud");
  if (!HUD.root) return;

  HUD.panel = HUD.root.querySelector(".hud__panel");
  HUD.title = document.getElementById("hudTitle");
  HUD.abilities = document.getElementById("hudAbilities");
  HUD.passives = document.getElementById("hudPassives");
  HUD.close = document.getElementById("hudClose");

  HUD.close?.addEventListener("click", closeHud);

  // ESC: chiude hud + annulla targeting
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      MODE = null;
      clearHighlights();
      closeHud();
      renderAll();
    }
  });

  // delega click della HUD su panel (una volta)
  if (HUD.panel && !HUD.panel.__bound) {
    HUD.panel.__bound = true;

    HUD.panel.addEventListener("click", (e) => {
      // impedisce che il click “risalga” e venga visto dal click globale
      e.stopPropagation();

      const unit = getUnitByUid(SELECTED_UID);
      if (!unit) return;

      const attackBtn = e.target.closest("[data-action='attack']");
      if (attackBtn) {
        e.preventDefault();
        if (!canAttack(unit)) return;
        MODE = { kind: "ATTACK", attackerUid: unit.uid };
        renderAll();
        return;
      }

      const cancelBtn = e.target.closest("[data-action='cancel']");
      if (cancelBtn) {
        e.preventDefault();
        MODE = null;
        renderAll();
        return;
      }

      const activeBtn = e.target.closest("[data-action='active']");
      if (activeBtn) {
        e.preventDefault();

        const slot = Number(activeBtn.dataset.slot);
        if (!canUseAbility(unit, slot)) return;

        const card = getCardById(unit.cardId);
        const ability = (card?.abilities || []).find(a => a.type === "active" && a.slot === slot);
        if (!ability) return;

        const needsTarget = /Scegli|unità/i.test(ability.text || "");
        if (needsTarget) {
          MODE = { kind: "ABILITY", unitUid: unit.uid, slot };
          renderAll();
          return;
        }

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

  window.addEventListener("resize", () => { if (SELECTED_UID) positionHudToSelected(); });
  window.addEventListener("scroll",  () => { if (SELECTED_UID) positionHudToSelected(); }, { passive: true });
}

function openHud(uid) {
  if (!HUD.root) return;
  SELECTED_UID = uid;
  refreshHud();
  positionHudToSelected();
  HUD.root.classList.add("is-open");
  HUD.root.setAttribute("aria-hidden", "false");
}

function closeHud() {
  if (!HUD.root) return;
  HUD.root.classList.remove("is-open");
  HUD.root.setAttribute("aria-hidden", "true");
  SELECTED_UID = null;
}

function getComputedStats(unit) {
  const base = getCardById(unit.cardId);
  const b = base?.stats || base?.baseStats || {};
  const vitMax = Number(b.vit ?? b.VIT ?? 0);
  const impBase = Number(b.imp ?? b.IMP ?? 0);
  const defBase = Number(b.def ?? b.DEF ?? 0);
  const velBase = Number(b.vel ?? b.VEL ?? 0);

  const vit = typeof unit.vit === "number" ? unit.vit : vitMax;

  const imp = typeof unit.imp === "number" ? unit.imp : impBase;
  const def = typeof unit.def === "number" ? unit.def : defBase;
  const vel = typeof unit.vel === "number" ? unit.vel : velBase;

  return { vit, vitMax, imp, def, vel };
}

function refreshHud() {
  if (!HUD.root || !HUD.panel) return;

  const unit = getUnitByUid(SELECTED_UID);
  if (!unit) { closeHud(); return; }

  const card = getCardById(unit.cardId);
  const stats = getComputedStats(unit);

  if (HUD.title) HUD.title.textContent = card?.name || unit.cardId || "Unità";

  // stats (IMP cliccabile)
  let statsWrap = HUD.panel.querySelector(".hud__stats");
  if (!statsWrap) {
    statsWrap = document.createElement("div");
    statsWrap.className = "hud__stats";
    const titleEl = HUD.panel.querySelector(".hud__title");
    if (titleEl) titleEl.insertAdjacentElement("afterend", statsWrap);
    else HUD.panel.prepend(statsWrap);
  }

  const atkOk = canAttack(unit);

  statsWrap.innerHTML = `
    <div class="hud__stat">VIT ${stats.vit}/${stats.vitMax}</div>
    <button type="button"
      class="hud__stat hud__attack ${atkOk ? "is-enabled" : "is-disabled"}"
      data-action="attack"
      ${atkOk ? "" : "disabled"}
    >IMP ${stats.imp}</button>
    <div class="hud__stat">DEF ${stats.def}</div>
    <div class="hud__stat">VEL ${stats.vel}</div>
  `;

  const actives = (card?.abilities || []).filter(a => a.type === "active");
  const passives = (card?.abilities || []).filter(a => a.type === "passive");

  if (HUD.abilities) {
    const activesHtml = actives.map(a => {
      const usable = canUseAbility(unit, a.slot);
      const cls = usable ? "hud__ability is-enabled" : "hud__ability is-disabled";
      const name = escapeHtml(a.name || `Abilità ${a.slot}`);
      const text = escapeHtml(a.text || "");
      return `
        <button type="button" class="${cls}" data-action="active" data-slot="${a.slot}">
          <div class="hud__ability-title">A${a.slot} — ${name}</div>
          <div class="hud__ability-text">${text}</div>
        </button>
      `;
    }).join("");

    HUD.abilities.innerHTML = `
      ${activesHtml}
      <div class="hud__actionsRow">
        <button type="button"
          class="hud__btn hud__btn--primary ${atkOk ? "is-enabled" : "is-disabled"}"
          data-action="attack"
          ${atkOk ? "" : "disabled"}
        >Attacca</button>

        <button type="button"
          class="hud__btn ${MODE ? "is-enabled" : "is-disabled"}"
          data-action="cancel"
          ${MODE ? "" : "disabled"}
        >Annulla</button>
      </div>
    `;
  }

  if (HUD.passives) {
    HUD.passives.innerHTML = passives.length ? `
      <div><strong>Passive</strong></div>
      ${passives.map(p => {
        const name = escapeHtml(p.name || "Passiva");
        const text = escapeHtml(p.text || "");
        return `<div class="hud__passive">• ${name}${text ? ` — <span class="hud__passive-text">${text}</span>` : ""}</div>`;
      }).join("")}
    ` : "";
  }
}

function positionHudToSelected() {
  if (!HUD.panel || !SELECTED_UID) return;

  const el = document.querySelector(`.card.on-board[data-uid="${SELECTED_UID}"]`);
  if (!el) return;

  const r = el.getBoundingClientRect();
  const gap = 12;
  const panelW = HUD.panel.offsetWidth || 260;
  const panelH = HUD.panel.offsetHeight || 120;

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
   DND: mano -> board = PLAY_UNIT
   ========================= */
let draggedCard = null;

function canDrop(cardEl, slotEl) {
  if (!cardEl || !slotEl) return false;
  if (slotEl.querySelector(".card")) return false;

  const cardOwner = Number(cardEl.dataset.owner);
  const slotOwner = Number(slotEl.dataset.owner);

  // Regola ferrea: puoi giocare SOLO nel tuo campo
  if (slotOwner !== cardOwner) return false;

  // E solo se sei il player attivo
  if (cardOwner !== STATE.activePlayer) return false;

  const lane = slotEl.dataset.row;
  const type = cardEl.dataset.type;

  if ((lane === "front" || lane === "back") && type !== "unit") return false;

  return true;
}

document.addEventListener("dragstart", (e) => {
  const card = e.target.closest("#handP0 .card, #handP1 .card");
  if (!card) return;

  // Non permettere drag se non è del giocatore attivo
  const owner = Number(card.dataset.owner);
  if (owner !== STATE.activePlayer) return;

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

  STATE = applyAction(STATE, {
    type: "PLAY_UNIT",
    player: owner,
    handIndex,
    lane,
    slot: col
  });

  MODE = null;
  clearHighlights();
  renderAll();
});

/* =========================
   UNICO CLICK HANDLER GLOBALE
   ========================= */
document.addEventListener("click", (e) => {
  // click dentro HUD panel: gestito lì
  if (e.target.closest(".hud__panel")) return;

  // quando MODE è attivo, click su carta = pick target (NON aprire HUD bersaglio)
  const cardEl = e.target.closest(".card.on-board");
  if (MODE && cardEl) {
    e.preventDefault();
    e.stopPropagation();
    onPickTarget(cardEl.dataset.uid);
    return;
  }

  // click su carta senza MODE -> apri HUD
  if (!MODE && cardEl) {
    openHud(cardEl.dataset.uid);
    return;
  }

  // click fuori: se in MODE annulla; altrimenti chiude HUD
  if (MODE) {
    MODE = null;
    renderAll();
  } else if (SELECTED_UID) {
    closeHud();
    renderAll();
  }
});

function onPickTarget(targetUid) {
  if (!MODE) return;

  if (MODE.kind === "ATTACK") {
    const attacker = getUnitByUid(MODE.attackerUid);
    if (!attacker) return;

    STATE = applyAction(STATE, {
      type: "ATTACK",
      player: attacker.owner,
      attackerUid: attacker.uid,
      targetUid
    });

    MODE = null;
    renderAll();
    return;
  }

  if (MODE.kind === "ABILITY") {
    const unit = getUnitByUid(MODE.unitUid);
    if (!unit) return;

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
   HIGHLIGHTS
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

function highlightAbilityTargets(unitUid, slot) {
  clearHighlights();

  const unit = getUnitByUid(unitUid);
  if (!unit) return;

  const card = getCardById(unit.cardId);
  const ability = (card?.abilities || []).find(a => a.type === "active" && a.slot === slot);
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
   LONG-PRESS ZOOM
   ========================= */
let pressTimer = null;
let pressedCard = null;
let startX = 0;
let startY = 0;

document.addEventListener("pointerdown", (e) => {
  if (MODE) return;
  if (e.button !== 0) return;
  if (e.target.closest(".hud__panel")) return;

  const cardEl = e.target.closest("#battlefield .card.on-board");
  if (!cardEl) return;

  pressedCard = cardEl;
  startX = e.clientX;
  startY = e.clientY;

  pressTimer = window.setTimeout(() => {
    if (!pressedCard) return;

    document.querySelectorAll("#battlefield .card.on-board.is-zoom").forEach(el => {
      if (el !== pressedCard) el.classList.remove("is-zoom");
    });

    pressedCard.classList.toggle("is-zoom");
  }, 260);
});

function clearPress() {
  if (pressTimer) window.clearTimeout(pressTimer);
  pressTimer = null;
  pressedCard = null;
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
   END TURN (evento esterno)
   ========================= */
window.addEventListener("BATTLE_END_TURN", () => {
  if (!STATE) return;
  STATE = applyAction(STATE, { type: "END_TURN", player: STATE.activePlayer });
  MODE = null;
  renderAll();
  if (SELECTED_UID) openHud(SELECTED_UID);
});
