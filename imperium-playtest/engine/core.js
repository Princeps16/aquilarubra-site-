// engine/core.js
// Versione aggiornata: abilità (active/passive), CD/uses, status, trigger base, movimento.
// Obiettivo: playtest veloce sul campo di battaglia con le carte che hai già in cards.json.

export function createEmptyPlayer() {
  return {
    deck: [],
    hand: [],
    discard: [],
    reserve: [],
    board: { front: [null, null, null], back: [null, null, null] },
    perTurn: { usedAbilities: {} }, // key: `${uid}:${slot}` => true (once per turn)
  };
}

export function createGameState(cardsDb, seed = 1) {
  return {
    version: "0.2",
    seed,
    cardsDb, // parsed JSON con { cards: [...] }
    turn: 1,
    activePlayer: 0,
    phase: "main",
    players: [createEmptyPlayer(), createEmptyPlayer()],
    log: [],
  };
}

/* =========================
   Utils base
   ========================= */

function log(state, msg) {
  state.log.push(msg);
}

function countUnits(player) {
  const b = player.board;
  return [...b.front, ...b.back].filter(Boolean).length;
}

function hasAnyFrontUnit(player) {
  return player.board.front.some(Boolean);
}

function allUnits(state) {
  const out = [];
  for (const p of state.players) {
    for (const lane of ["front", "back"]) {
      for (let i = 0; i < 3; i++) {
        const u = p.board[lane][i];
        if (u) out.push(u);
      }
    }
  }
  return out;
}

function getUnitByUid(state, uid) {
  for (const u of allUnits(state)) if (u.uid === uid) return u;
  return null;
}

function getOwnerUnit(state, uid) {
  const u = getUnitByUid(state, uid);
  if (!u) return null;
  return state.players[u.owner];
}

function getOpponent(state, ownerIndex) {
  return state.players[1 - ownerIndex];
}

function removeUnitFromBoard(state, unit) {
  const p = state.players[unit.owner];
  p.board[unit.lane][unit.slot] = null;
}

function placeUnitOnBoard(state, unit, lane, slot) {
  const p = state.players[unit.owner];
  p.board[lane][slot] = unit;
  unit.lane = lane;
  unit.slot = slot;
}

function getCard(state, cardId) {
  return state.cardsDb.cards.find((c) => c.id === cardId) || null;
}

function computeDamage(att, def, ctx = {}) {
  // Base: imp - def, minimo 1
  let atkImp = att.imp;

  // Attack mods "one-shot" (es. Gladio Addestrato, Ira Incatenata, Carica…)
  if (ctx.attackMod) {
    if (typeof ctx.attackMod.impMultiplier === "number") atkImp = atkImp * ctx.attackMod.impMultiplier;
    if (typeof ctx.attackMod.impBonus === "number") atkImp = atkImp + ctx.attackMod.impBonus;
  }

  // Ignore DEF
  const ignoreDef = !!(ctx.attackMod && ctx.attackMod.ignoreDef === true);
  const ignoreDefAmount = (ctx.attackMod && typeof ctx.attackMod.ignoreDefAmount === "number") ? ctx.attackMod.ignoreDefAmount : 0;

  const effDef = ignoreDef ? 0 : Math.max(0, def.def - ignoreDefAmount);
  return Math.max(1, atkImp - effDef);
}

/* =========================
   Status / flags helpers
   ========================= */

function ensureRuntimeFields(unit) {
  unit.flags ??= {};
  unit.statuses ??= [];
  unit.cooldowns ??= {}; // slot -> cdLeft
  unit.uses ??= {}; // slot -> usesLeft
  unit.attackMods ??= []; // array di mods consumabili sul prossimo attacco
}

function hasStatus(unit, status) {
  return (unit.statuses || []).some((s) => s.name === status);
}

function addStatus(unit, status, meta = {}) {
  ensureRuntimeFields(unit);
  if (hasStatus(unit, status)) return;
  unit.statuses.push({ name: status, ...meta });
}

function removeStatus(unit, status) {
  ensureRuntimeFields(unit);
  unit.statuses = (unit.statuses || []).filter((s) => s.name !== status);
}

function hasAnyNegativeStatus(unit) {
  // Per ora: consideriamo negativi FERITO, CORROTTO, MARCHIATO, PRIGIONIERO, ecc.
  const NEG = new Set(["FERITO", "CORROTTO", "MARCHIATO", "PRIGIONIERO"]);
  return (unit.statuses || []).some((s) => NEG.has(s.name));
}

function isActivePrevented(state, unit) {
  // flag: preventActiveUntilTurnEnd (turn number) => se >= state.turn, bloccata
  ensureRuntimeFields(unit);
  const t = unit.flags.preventActiveUntilTurnEnd;
  return typeof t === "number" && t >= state.turn;
}

/* =========================
   Targeting helpers (minimi)
   ========================= */

function isAdjacent(a, b) {
  // adiacenza su griglia 3 colonne x 2 file: adiacenti = stessa lane e slot ±1, oppure stessa colonna e lane diversa
  if (!a || !b) return false;
  const sameCol = a.slot === b.slot;
  const sameLaneAdj = a.lane === b.lane && Math.abs(a.slot - b.slot) === 1;
  const sameColOtherLane = sameCol && a.lane !== b.lane;
  return sameLaneAdj || sameColOtherLane;
}

function anyAllyInPlayByNameId(state, owner, nameId) {
  // nameId semplificato: "claudia_rufa" matcha cardId che inizia con "claudia_rufa_"
  const prefix = `${nameId}_`;
  return allUnits(state).some((u) => u.owner === owner && u.cardId.startsWith(prefix));
}

function findUnitByNameId(state, owner, nameId) {
  const prefix = `${nameId}_`;
  return allUnits(state).find((u) => u.owner === owner && u.cardId.startsWith(prefix)) || null;
}

/* =========================
   Triggers / Emitter
   ========================= */

function getRulesBlocks(ability) {
  // ability.rules può essere object o array
  if (!ability || !ability.rules) return [];
  return Array.isArray(ability.rules) ? ability.rules : [ability.rules];
}

function checkCondition(state, self, ctx, cond) {
  if (!cond) return true;

  switch (cond.op) {
    case "SELF_IN_ZONE":
      return self.lane === (cond.zone === "FRONTLINE" ? "front" : "back");

    case "ALLY_IN_PLAY":
      // cond.nameId
      return anyAllyInPlayByNameId(state, self.owner, cond.nameId);

    case "HAS_ADJACENT_ALLY":
      return allUnits(state).some((u) => u.owner === self.owner && u.uid !== self.uid && isAdjacent(u, self) && (!cond.faction || uCardFaction(state, u) === cond.faction));

    case "MOVED_UNIT_IS_ENEMY":
      return ctx && ctx.movedUnit && ctx.movedUnit.owner !== self.owner;

    case "ATTACK_TARGET_NAMEID_IS": {
      const t = ctx?.target;
      if (!t) return false;
      return t.cardId.startsWith(`${cond.nameId}_`);
    }

    case "TARGET_IS_ENEMY":
      return !!(ctx?.target && ctx.target.owner !== self.owner);

    case "TARGET_FACTION_IS":
      return !!(ctx?.target && uCardFaction(state, ctx.target) === cond.faction);

    case "TARGET_HAS_CLASS":
      return !!(ctx?.target && (uCardClasses(state, ctx.target).includes(cond.class)));

    case "TARGET_VEL_LT_SELF_VEL":
      return !!(ctx?.target && ctx.target.vel < self.vel);

    case "IS_FIRST_ATTACKER_THIS_TURN":
      // per semplicità: flag globale sullo state
      return state._firstAttackThisTurnUid ? state._firstAttackThisTurnUid === self.uid : true;

    case "FLAG_IS_TRUE":
      return !!self.flags?.[cond.key];

    case "CONTROL_AT_LEAST": {
      const { count, who } = cond;
      let units = allUnits(state).filter((u) => (who === "ALLY" ? u.owner === self.owner : u.owner !== self.owner));
      if (cond.faction) units = units.filter((u) => uCardFaction(state, u) === cond.faction);
      if (cond.classes?.length) units = units.filter((u) => cond.classes.every((cl) => uCardClasses(state, u).includes(cl)));
      return units.length >= count;
    }

    case "AND":
      return (cond.args || []).every((c) => checkCondition(state, self, ctx, c));

    default:
      // cond non supportata -> la consideriamo false (meglio safe)
      return false;
  }
}

function uCardFaction(state, unit) {
  const card = getCard(state, unit.cardId);
  return card?.faction || null;
}
function uCardClasses(state, unit) {
  const card = getCard(state, unit.cardId);
  return card?.classes || [];
}

function emit(state, trigger, ctx = {}) {
  for (const unit of allUnits(state)) {
    ensureRuntimeFields(unit);
    const card = getCard(state, unit.cardId);
    const abilities = card?.abilities || unit.abilities || [];

    for (const ability of abilities) {
      const blocks = getRulesBlocks(ability);
      for (const rb of blocks) {
        if (rb.trigger !== trigger) continue;
        if (!checkCondition(state, unit, ctx, rb.condition)) continue;
        runScript(state, unit, ctx, rb.script || []);
      }
    }
  }
}

/* =========================
   Script runner (minimo utile)
   ========================= */

function runScript(state, self, ctx, script) {
  for (const step of script) {
    if (!step || !step.op) continue;

    switch (step.op) {
      case "DAMAGE": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        const amount = resolveValue(step.amount, ctx);
        if (target) {
          target.vit -= amount;
          log(state, `→ ${self.uid} infligge ${amount} danni a ${target.uid} (vit=${target.vit}/${target.vitMax})`);
          if (target.vit <= 0) handleElimination(state, target, { source: self });
        }
        break;
      }

      case "HEAL": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        const amount = resolveValue(step.amount, ctx);
        if (target) {
          target.vit = Math.min(target.vitMax, target.vit + amount);
          log(state, `→ ${target.uid} cura ${amount} (vit=${target.vit}/${target.vitMax})`);
        } else if (step.target === "ALL_ALLIES_FILTERED") {
          const list = filterUnits(state, self, "ALLY", step.filter || {});
          for (const u of list) {
            u.vit = Math.min(u.vitMax, u.vit + amount);
          }
          log(state, `→ Cura di massa: +${amount} su ${list.length} unità`);
        }
        break;
      }

      case "MODIFY_STAT": {
        const amount = resolveValue(step.amount, ctx);
        const duration = step.duration || "PERMANENT";
        if (step.target === "ALL_ALLIES_FILTERED") {
          const list = filterUnits(state, self, "ALLY", step.filter || {});
          for (const u of list) applyBuffOrStat(u, step.stat, amount, duration);
          break;
        }
        if (step.target === "ALL_ENEMIES_FILTERED") {
          const list = filterUnits(state, self, "ENEMY", step.filter || {});
          for (const u of list) applyBuffOrStat(u, step.stat, amount, duration);
          break;
        }
        if (step.target === "ALLY_ADJACENT_MATCH") {
          const list = allUnits(state).filter((u) => u.owner === self.owner && u.uid !== self.uid && isAdjacent(u, self));
          const list2 = step.faction ? list.filter((u) => uCardFaction(state, u) === step.faction) : list;
          for (const u of list2) applyBuffOrStat(u, step.stat, amount, duration);
          break;
        }
        {
          const target = resolveTargetRef(state, self, ctx, step.target);
          if (target) applyBuffOrStat(target, step.stat, amount, duration);
        }
        break;
      }

      case "APPLY_STATUS": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (target) {
          // Immunità semplice: flag immunities = Set
          if (target.flags?.immunities && target.flags.immunities.includes(step.status)) {
            log(state, `→ ${target.uid} è immune a ${step.status}`);
          } else {
            addStatus(target, step.status);
            log(state, `→ STATUS ${step.status} applicato a ${target.uid}`);
          }
        }
        break;
      }

      case "REMOVE_STATUS": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (!target) break;
        if (step.status) {
          removeStatus(target, step.status);
          log(state, `→ Rimosso STATUS ${step.status} da ${target.uid}`);
        } else if (step.which === "ONE_NEGATIVE" || step.which === "ONE_NEGATIVE_APPLIED_LAST_TURN") {
          // semplificazione: rimuove il primo negativo trovato
          const NEG = ["FERITO", "CORROTTO", "MARCHIATO", "PRIGIONIERO"];
          const found = (target.statuses || []).find((s) => NEG.includes(s.name));
          if (found) {
            removeStatus(target, found.name);
            log(state, `→ Rimosso STATUS ${found.name} da ${target.uid}`);
          }
        }
        break;
      }

      case "PREVENT_ACTIVE": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (target) {
          // fino a fine turno avversario successivo -> turn corrente + 1
          target.flags.preventActiveUntilTurnEnd = state.turn + 1;
          log(state, `→ ${target.uid} non può usare abilità attive fino a fine turno ${state.turn + 1}`);
        }
        break;
      }

      case "IMMUNITY_STATUS": {
        // applica immunità statica mentre aura è attiva: qui la mettiamo come flag runtime "immunities"
        // NB: senza sistema aura-dinamico completo, questa resta finché l'effetto non viene "rimosso".
        // Per playtest va bene: le immunità si ricalcoleranno ad ogni render/emit aura se vuoi.
        const list = step.target === "ALL_ALLIES_FILTERED"
          ? filterUnits(state, self, "ALLY", step.filter || {})
          : [];
        for (const u of list) {
          ensureRuntimeFields(u);
          u.flags.immunities ??= [];
          if (!u.flags.immunities.includes(step.status)) u.flags.immunities.push(step.status);
        }
        break;
      }

      case "SET_FLAG": {
        ensureRuntimeFields(self);
        self.flags[step.key] = step.value;
        break;
      }

      case "SET_FLAG_ON_UNIT": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (target) {
          ensureRuntimeFields(target);
          target.flags[step.key] = step.value;
        }
        break;
      }

      case "ADD_ATTACK_MOD": {
        // aggiunge mod one-shot sul prossimo attacco (o this attack quando dichiarato)
        const source = resolveTargetRef(state, self, ctx, step.source === "TARGET" ? "TARGET" : "SELF") || self;
        ensureRuntimeFields(source);
        source.attackMods.push({
          ...step.mod,
          _duration: step.duration || "THIS_ATTACK_ONLY",
          _consumed: false,
        });
        break;
      }

      case "DRAW": {
        const me = state.players[self.owner];
        const n = resolveValue(step.amount, ctx);
        for (let i = 0; i < n; i++) {
          const top = me.deck.shift();
          if (top) me.hand.push(top);
        }
        break;
      }

      case "DISCARD_FROM_HAND": {
        const me = state.players[self.owner];
        const n = resolveValue(step.amount, ctx);
        // semplificazione: scarta le ultime n se non c'è UI di scelta
        for (let i = 0; i < n; i++) {
          const cardId = me.hand.pop();
          if (cardId) me.discard.push(cardId);
        }
        break;
      }

      case "PEEK_HAND_RANDOM": {
        // solo log / revealTo self: UI lo può mostrare
        const opp = getOpponent(state, self.owner);
        const n = step.count || 1;
        const picked = [];
        for (let i = 0; i < n; i++) {
          if (opp.hand.length === 0) break;
          const idx = Math.floor(Math.random() * opp.hand.length);
          picked.push(opp.hand[idx]);
        }
        log(state, `→ ${self.uid} sbircia mano avversaria: ${picked.join(", ") || "(vuota)"}`);
        break;
      }

      case "REVEAL_CARD": {
        // log-only: UI può gestire reveal vero
        log(state, `→ Carta rivelata: ${step.cardRef || "(ref)"} (gestione UI)`);
        break;
      }

      case "MOVE_CARD_FROM_HAND_TO_DECK": {
        // per "shuffle in" o "top"
        const opp = getOpponent(state, self.owner);
        const cardRef = step.cardRef;
        // qui non abbiamo l'oggetto cardRef, quindi: noop (serve UI+ref reale)
        log(state, `→ Spostamento carta mano→mazzo (richiede ref carta in UI): ${cardRef || ""}`);
        break;
      }

      case "SACRIFICE": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (target) handleElimination(state, target, { source: self, sacrifice: true });
        break;
      }

      case "SWAP_POSITION": {
        const a = resolveTargetRef(state, self, ctx, step.a);
        const b = resolveTargetRef(state, self, ctx, step.b);
        if (a && b && a.owner === b.owner) {
          const laneA = a.lane, slotA = a.slot;
          const laneB = b.lane, slotB = b.slot;
          const p = state.players[a.owner];
          p.board[laneA][slotA] = b;
          p.board[laneB][slotB] = a;
          a.lane = laneB; a.slot = slotB;
          b.lane = laneA; b.slot = slotA;
          log(state, `→ Scambio posizioni: ${a.uid} ⇄ ${b.uid}`);
          emit(state, "ON_UNIT_MOVE", { movedUnit: a, swappedWith: b });
        }
        break;
      }

      case "ALLOW_ATTACK_FROM_BACKLINE":
        // regola UI/targeting: qui è una "rule mod". La gestirà getValidAttackTargets (vedi sotto) usando flag.
        ensureRuntimeFields(self);
        self.flags.allowAttackFromBackline = true;
        self.flags.allowAttackTargets = step.allowedTargets || "ENEMY_FRONTLINE";
        break;

      case "UNTARGETABLE_BY_ENEMY_ABILITIES":
        ensureRuntimeFields(self);
        self.flags.untargetableByEnemyAbilities = true;
        break;

      case "IF": {
        const ok = evalScriptCondition(state, self, ctx, step.condition);
        if (ok) runScript(state, self, ctx, step.then || []);
        else runScript(state, self, ctx, step.else || []);
        break;
      }

      default:
        // op non supportata: ignora (per playtest)
        break;
    }
  }
}

function resolveValue(v, ctx) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && v.ref) return ctx?.[v.ref] ?? 0;
  return 0;
}

function resolveTargetRef(state, self, ctx, ref) {
  if (!ref) return null;
  if (ref === "SELF") return self;
  if (ref === "TARGET") return ctx?.target || null;
  if (ref === "MOVED_UNIT") return ctx?.movedUnit || null;
  if (ref === "ELIMINATION_SOURCE_UNIT") return ctx?.eliminationSource || null;
  if (ref === "t1" || ref === "s1") return ctx?.[ref] || null;
  // Se ci passano un uid
  if (typeof ref === "string" && ref.startsWith("u_")) return getUnitByUid(state, ref);
  return null;
}

function filterUnits(state, self, side, filter) {
  let list = allUnits(state).filter((u) => (side === "ALLY" ? u.owner === self.owner : u.owner !== self.owner));
  if (filter.faction) list = list.filter((u) => uCardFaction(state, u) === filter.faction);
  if (filter.zone) list = list.filter((u) => u.lane === (filter.zone === "FRONTLINE" ? "front" : "back"));
  if (filter.hasStatus) list = list.filter((u) => hasStatus(u, filter.hasStatus));
  if (filter.sameLineAsSelf) list = list.filter((u) => u.lane === self.lane);
  if (filter.sameColumnAsSelf) list = list.filter((u) => u.slot === self.slot);
  if (filter.adjacentToSelf) list = list.filter((u) => u.uid !== self.uid && isAdjacent(u, self));
  if (filter.classes?.length) list = list.filter((u) => filter.classes.every((cl) => uCardClasses(state, u).includes(cl)));
  return list;
}

function applyBuffOrStat(unit, stat, amount, duration) {
  ensureRuntimeFields(unit);
  if (duration === "PERMANENT" || !duration) {
    unit[stat] += amount;
    if (stat === "vit") {
      unit.vitMax += amount;
      unit.vit += amount;
    }
    return;
  }
  // buff temporaneo: salva e applica subito
  unit.buffs ??= [];
  unit.buffs.push({ stat, amount, expires: duration });
  unit[stat] += amount;
}

/* Condizioni usate dentro IF (script) */
function evalScriptCondition(state, self, ctx, cond) {
  if (!cond) return false;
  switch (cond.op) {
    case "TARGET_HAS_ANY_NEGATIVE_STATUS":
      return !!(ctx?.target && hasAnyNegativeStatus(ctx.target));
    case "CARD_TYPE_IS":
    case "CARD_SUBTYPE_IS":
    case "CARD_IS_UNIT":
    case "CARD_RARITY_IN":
    case "CARD_FACTION_IN":
      // Queste richiedono un sistema cardRef vero (UI/runner avanzato). Per playtest, false.
      return false;
    case "TARGET_IS_ADJACENT_TO_SELF":
      return !!(ctx?.target && isAdjacent(ctx.target, self));
    case "CONTROL_AT_LEAST":
      return checkCondition(state, self, ctx, cond);
    case "AND":
      return (cond.args || []).every((c) => evalScriptCondition(state, self, ctx, c));
    default:
      return false;
  }
}

/* =========================
   Eliminazioni
   ========================= */

function handleElimination(state, unit, meta = {}) {
  const owner = state.players[unit.owner];
  const opp = state.players[1 - unit.owner];
  const card = getCard(state, unit.cardId);

  removeUnitFromBoard(state, unit);
  owner.discard.push(unit.cardId);

  log(state, `✖ ${unit.uid} eliminata → discard`);

  // trigger "ON_UNIT_ELIMINATED" (per Lilith, Marcello…)
  emit(state, "ON_UNIT_ELIMINATED", {
    eliminatedUnit: unit,
    eliminationSource: meta.source || null,
    eliminatedCard: card,
    eliminatedOwner: unit.owner,
  });

  // trigger "ON_ALLY_ELIMINATED" dal punto di vista degli alleati (es. Marcello rara)
  // Emit generico: le condition/controller useranno ctx
  emit(state, "ON_ALLY_ELIMINATED", {
    eliminatedUnit: unit,
    eliminationSource: meta.source || null,
    eliminatedCard: card,
    eliminatedOwner: unit.owner,
  });

  // Lato avversario: possono voler reagire a "enemy eliminated" in futuro.
  emit(state, "ON_ENEMY_ELIMINATED", {
    eliminatedUnit: unit,
    eliminationSource: meta.source || null,
    eliminatedCard: card,
    eliminatedOwner: unit.owner,
  });

  // Se eliminazione avviene in attacco, l'opp già gestisce nel flusso.
  void opp;
}

/* =========================
   Target attacco (aggiornato con regola Aela)
   ========================= */

export function getValidAttackTargets(state, attackerUid) {
  const att = getUnitByUid(state, attackerUid);
  if (!att) return [];
  const opponent = state.players[1 - att.owner];

  const oppHasFront = hasAnyFrontUnit(opponent);

  // Regola base: se avversario ha front, si può colpire solo front. Altrimenti back.
  let targetLane = oppHasFront ? "front" : "back";

  // Eccezione: se att è in back ma ha allowAttackFromBackline (Aela), può comunque attaccare FRONT
  if (att.lane === "back" && att.flags?.allowAttackFromBackline) {
    targetLane = "front";
  }

  return opponent.board[targetLane].filter(Boolean).map((u) => u.uid);
}

/* =========================
   Azioni legali (aggiunte abilità + move)
   ========================= */

export function getLegalActions(state) {
  const pIndex = state.activePlayer;
  const me = state.players[pIndex];
  const actions = [];

  // PLAY_UNIT (come prima)
  for (let hi = 0; hi < me.hand.length; hi++) {
    const cardId = me.hand[hi];
    const card = state.cardsDb.cards.find((c) => c.id === cardId);
    if (!card || card.type !== "unit") continue;
    if (countUnits(me) >= 6) continue;

    for (const lane of ["front", "back"]) {
      for (let slot = 0; slot < 3; slot++) {
        if (me.board[lane][slot] === null) {
          actions.push({ type: "PLAY_UNIT", player: pIndex, handIndex: hi, lane, slot });
        }
      }
    }
  }

  // ATTACK: unità in front e (eccezione Aela backline)
  for (const lane of ["front", "back"]) {
    for (const u of me.board[lane]) {
      if (!u) continue;
      ensureRuntimeFields(u);

      const canAttack =
        (u.lane === "front" || u.flags?.allowAttackFromBackline) &&
        !u.flags?.attackedThisTurn;

      if (!canAttack) continue;

      const targets = getValidAttackTargets(state, u.uid);
      for (const tid of targets) {
        actions.push({ type: "ATTACK", player: pIndex, attackerUid: u.uid, targetUid: tid });
      }
    }
  }

  // ACTIVATE_ABILITY (solo validazione base; targeting lo gestisce UI)
  for (const u of allUnits(state).filter((x) => x.owner === pIndex)) {
    ensureRuntimeFields(u);
    const card = getCard(state, u.cardId);
    const abs = card?.abilities || [];
    for (const a of abs) {
      if (a.type !== "active") continue;
      const slot = a.slot;
      const cdLeft = u.cooldowns[slot] ?? 0;
      const usesLeft = u.uses[slot] ?? null;

      if (isActivePrevented(state, u)) continue;
      if (cdLeft > 0) continue;
      if (usesLeft !== null && usesLeft <= 0) continue;
      if (me.perTurn.usedAbilities[`${u.uid}:${slot}`]) continue;

      actions.push({ type: "ACTIVATE_ABILITY", player: pIndex, unitUid: u.uid, slot });
    }
  }

  // MOVE (serve per testare Tito Silano / scambi / Vex)
  // Per ora: spostamento semplice in uno slot vuoto (stessa lane o altra).
  for (const u of allUnits(state).filter((x) => x.owner === pIndex)) {
    for (const lane of ["front", "back"]) {
      for (let slot = 0; slot < 3; slot++) {
        if (me.board[lane][slot] !== null) continue;
        actions.push({ type: "MOVE", player: pIndex, unitUid: u.uid, lane, slot });
      }
    }
  }

  actions.push({ type: "END_TURN", player: pIndex });

  return actions;
}

/* =========================
   UID
   ========================= */

let UID_COUNTER = 1;
function newUid() {
  return `u_${UID_COUNTER++}`;
}

/* =========================
   ApplyAction (aggiornato)
   ========================= */

export function applyAction(state, action) {
  const next = structuredClone(state);
  const me = next.players[action.player];
  const opp = next.players[1 - action.player];

  // Helper per event: reset first-attack flag ad ogni nuovo turno
  next._firstAttackThisTurnUid ??= null;

  if (action.type === "PLAY_UNIT") {
    const cardId = me.hand[action.handIndex];
    const card = next.cardsDb.cards.find((c) => c.id === cardId);
    if (!card || card.type !== "unit") return next;

    if (countUnits(me) >= 6) return next;
    if (me.board[action.lane][action.slot] !== null) return next;

    // rimuovi da mano
    me.hand.splice(action.handIndex, 1);

    // crea unit runtime
    const unit = {
      uid: newUid(),
      cardId,
      owner: action.player,
      lane: action.lane,
      slot: action.slot,
      vitMax: card.stats.vit,
      vit: card.stats.vit,
      imp: card.stats.imp,
      def: card.stats.def,
      vel: card.stats.vel,
      abilities: card.abilities || [],
      statuses: [],
      cooldowns: {},
      uses: {},
      attackMods: [],
      buffs: [],
      flags: { summonedThisTurn: true, attackedThisTurn: false },
    };

    // init cd/uses
    for (const ab of unit.abilities) {
      if (ab?.slot == null) continue;
      if (typeof ab.cd === "number") unit.cooldowns[ab.slot] = 0;
      if (ab.uses?.perGame != null) unit.uses[ab.slot] = ab.uses.perGame;
    }

    placeUnitOnBoard(next, unit, action.lane, action.slot);
    log(next, `P${action.player} gioca ${card.name} in ${action.lane}[${action.slot}]`);

    // trigger ON_DEPLOY
    emit(next, "ON_DEPLOY", { unit, player: action.player });

    // applica subito le RULE_MOD / AURA per stabilizzare flags (Aela backline ecc.)
    emit(next, "RULE_MOD", { unit });
    emit(next, "AURA", { unit });

    return next;
  }

  if (action.type === "MOVE") {
    const unit = getUnitByUid(next, action.unitUid);
    if (!unit) return next;
    if (unit.owner !== action.player) return next;
    if (me.board[action.lane][action.slot] !== null) return next;

    // sposta
    me.board[unit.lane][unit.slot] = null;
    placeUnitOnBoard(next, unit, action.lane, action.slot);

    log(next, `P${action.player} muove ${unit.uid} → ${action.lane}[${action.slot}]`);

    emit(next, "ON_UNIT_MOVE", { movedUnit: unit });
    emit(next, "AURA", { movedUnit: unit });
    emit(next, "RULE_MOD", { movedUnit: unit });

    return next;
  }

  if (action.type === "ATTACK") {
    const att = getUnitByUid(next, action.attackerUid);
    const def = getUnitByUid(next, action.targetUid);
    if (!att || !def) return next;

    ensureRuntimeFields(att);
    ensureRuntimeFields(def);

    // vincoli attacco
    if (att.owner !== action.player) return next;
    const canAttack = (att.lane === "front" || att.flags?.allowAttackFromBackline) && !att.flags?.attackedThisTurn;
    if (!canAttack) return next;

    // vincolo targeting (front shield o back se front vuota)
    const validTargets = getValidAttackTargets(next, att.uid);
    if (!validTargets.includes(def.uid)) return next;

    // first-attack marker
    if (!next._firstAttackThisTurnUid) next._firstAttackThisTurnUid = att.uid;

    // trigger ON_ATTACK_DECLARE (per mod/flag consumabili)
    emit(next, "ON_ATTACK_DECLARE", { attacker: att, target: def });

    // calcola eventuale mod one-shot dalla lista (prendiamo il primo non consumato)
    const mod = (att.attackMods || []).find((m) => !m._consumed) || null;
    const dmg = computeDamage(att, def, { attackMod: mod });

    def.vit -= dmg;
    att.flags.attackedThisTurn = true;

    if (mod) mod._consumed = true;

    log(next, `P${action.player} attacca: ${att.uid} → ${def.uid} per ${dmg} danni (vit=${def.vit}/${def.vitMax})`);

    // trigger ON_ATTACK_HIT
    emit(next, "ON_ATTACK_HIT", { attacker: att, target: def });

    if (def.vit <= 0) {
      handleElimination(next, def, { source: att });
    }

    return next;
  }

  if (action.type === "ACTIVATE_ABILITY") {
    const unit = getUnitByUid(next, action.unitUid);
    if (!unit) return next;
    if (unit.owner !== action.player) return next;

    ensureRuntimeFields(unit);

    const card = getCard(next, unit.cardId);
    const ability = (card?.abilities || []).find((a) => a.type === "active" && a.slot === action.slot);
    if (!ability) return next;

    // blocchi
    if (isActivePrevented(next, unit)) return next;

    // cd/uses/once per turn
    const slot = ability.slot;
    const cdLeft = unit.cooldowns[slot] ?? 0;
    if (cdLeft > 0) return next;

    const usesLeft = unit.uses[slot] ?? null;
    if (usesLeft !== null && usesLeft <= 0) return next;

    const usedKey = `${unit.uid}:${slot}`;
    if (me.perTurn.usedAbilities[usedKey]) return next;

    // cost (es. discard 1)
    if (ability.rules?.cost?.op === "DISCARD_FROM_HAND") {
      const n = ability.rules.cost.amount || 1;
      if (me.hand.length < n) return next;
      // scarto semplice: ultime n (UI poi lo farà scegliere)
      for (let i = 0; i < n; i++) {
        const c = me.hand.pop();
        if (c) me.discard.push(c);
      }
      log(next, `→ Cost: scarta ${n} carta/e`);
    }

    // targeting: il battle.js deve passare payload.targetUid quando serve
    const payload = action.payload || {};
    const target = payload.targetUid ? getUnitByUid(next, payload.targetUid) : null;

    // Se target è richiesto e non c'è, non esegue
    // (Per ora: lascia passare abilità senza target se script non lo usa.)
    const ctx = { target };

    // esegue tutte le rules blocks che hanno trigger ACTIVE_MANUAL
    const blocks = getRulesBlocks(ability).filter((b) => b.trigger === "ACTIVE_MANUAL");
    for (const rb of blocks) {
      if (!checkCondition(next, unit, ctx, rb.condition)) continue;
      // targeting specifico (non obbligatorio qui; lo gestisce UI)
      runScript(next, unit, ctx, rb.script || []);
    }

    // set perTurn used
    me.perTurn.usedAbilities[usedKey] = true;

    // applica cooldown dalla carta (abilità ha cd numerico nel JSON)
    const cd = typeof ability.cd === "number" ? ability.cd : null;
    if (cd != null) unit.cooldowns[slot] = cd;

    // decrement uses perGame
    if (usesLeft !== null) unit.uses[slot] = usesLeft - 1;

    log(next, `P${action.player} usa abilità: ${card?.name || unit.cardId} [slot ${slot}]`);

    return next;
  }

  if (action.type === "END_TURN") {
    // Fine turno: scala CD, scadenza buff temporanei, reset perTurn.
    for (let p = 0; p < 2; p++) {
      const pl = next.players[p];
      pl.perTurn.usedAbilities = {};
      for (const lane of ["front", "back"]) {
        for (const u of pl.board[lane]) {
          if (!u) continue;
          ensureRuntimeFields(u);

          // reset
          u.flags.attackedThisTurn = false;
          u.flags.summonedThisTurn = false;

          // tick cooldowns
          for (const k of Object.keys(u.cooldowns)) {
            u.cooldowns[k] = Math.max(0, (u.cooldowns[k] || 0) - 1);
          }

          // rimuovi buff "UNTIL_END_OF_TURN"
          if (u.buffs && u.buffs.length) {
            const keep = [];
            for (const b of u.buffs) {
              if (b.expires === "UNTIL_END_OF_TURN") {
                u[b.stat] -= b.amount;
              } else {
                keep.push(b);
              }
            }
            u.buffs = keep;
          }

          // pulizia attackMods consumati
          u.attackMods = (u.attackMods || []).filter((m) => !m._consumed);
        }
      }
    }

    // turn switch
    next.activePlayer = 1 - next.activePlayer;
    next.turn += 1;
    next._firstAttackThisTurnUid = null;

    log(next, `--- Turno ${next.turn} (P${next.activePlayer}) ---`);

    // start turn triggers per player attivo
    emit(next, "TURN_START_SELF", { player: next.activePlayer });

    // ricalcola aura/rule mod
    emit(next, "RULE_MOD", { player: next.activePlayer });
    emit(next, "AURA", { player: next.activePlayer });

    return next;
  }

  return next;
}
