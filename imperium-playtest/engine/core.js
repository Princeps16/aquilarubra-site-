// engine/core.js

export function createEmptyPlayer() {
  return {
    deck: [],
    hand: [],
    discard: [],
    reserve: [],
    board: { front: [null,null,null], back: [null,null,null] },
    perTurn: { usedAbilities: {} }, // key: `${uid}:${slot}` => true
  };
}

export function createGameState(cardsDb, seed = 1) {
  return {
    version: "0.1",
    seed,
    cardsDb, // parsed JSON
    turn: 1,
    activePlayer: 0,
    phase: "main",
    players: [createEmptyPlayer(), createEmptyPlayer()],
    log: [],
  };
}

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

function getUnitByUid(state, uid) {
  for (const p of state.players) {
    for (const lane of ["front","back"]) {
      for (let i=0;i<3;i++) {
        const u = p.board[lane][i];
        if (u && u.uid === uid) return u;
      }
    }
  }
  return null;
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

function computeDamage(att, def) {
  return Math.max(1, att.imp - def.def);
}

export function getValidAttackTargets(state, attackerUid) {
  const att = getUnitByUid(state, attackerUid);
  if (!att) return [];
  const opponent = state.players[1 - att.owner];

  const targetLane = hasAnyFrontUnit(opponent) ? "front" : "back";
  return opponent.board[targetLane].filter(Boolean).map(u => u.uid);
}

export function getLegalActions(state) {
  const pIndex = state.activePlayer;
  const me = state.players[pIndex];
  const actions = [];

  // PLAY_UNIT: per ora tutte le carte type=unit sono giocabili senza costo
  // (se vuoi limitare per turno, lo aggiungiamo dopo)
  for (let hi=0; hi<me.hand.length; hi++) {
    const cardId = me.hand[hi];
    const card = state.cardsDb.cards.find(c => c.id === cardId);
    if (!card || card.type !== "unit") continue;

    if (countUnits(me) >= 6) continue;

    for (const lane of ["front","back"]) {
      for (let slot=0; slot<3; slot++) {
        if (me.board[lane][slot] === null) {
          actions.push({ type:"PLAY_UNIT", player:pIndex, handIndex:hi, lane, slot });
        }
      }
    }
  }

  // ATTACK: solo unità in front
  for (const u of me.board.front) {
    if (!u) continue;
    // (regola semplice: 1 attacco per turno per unità)
    if (u.flags?.attackedThisTurn) continue;

    const targets = getValidAttackTargets(state, u.uid);
    for (const tid of targets) {
      actions.push({ type:"ATTACK", player:pIndex, attackerUid:u.uid, targetUid:tid });
    }
  }

  // ACTIVATE_ABILITY: placeholder: lo abilitiamo quando colleghiamo effects
  // Qui puoi già mettere la validazione oncePerTurn:
  // for unit in board -> for ability slot if active -> if not used => push action

  return actions;
}

let UID_COUNTER = 1;
function newUid() { return `u_${UID_COUNTER++}`; }

export function applyAction(state, action) {
  const next = structuredClone(state); // semplice e sicuro per playtest
  const me = next.players[action.player];
  const opp = next.players[1 - action.player];

  if (action.type === "PLAY_UNIT") {
    const cardId = me.hand[action.handIndex];
    const card = next.cardsDb.cards.find(c => c.id === cardId);
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
      flags: { summonedThisTurn: true, attackedThisTurn: false },
    };

    placeUnitOnBoard(next, unit, action.lane, action.slot);
    log(next, `P${action.player} gioca ${card.name} in ${action.lane}[${action.slot}]`);

    // trigger ENTER: lo colleghiamo dopo con sistema effetti
    // per ora: solo log
    const enterAbility = card.abilities?.find(a => a.type === "enter");
    if (enterAbility) {
      log(next, `→ Trigger ENTER: ${enterAbility.name}`);
    }

    return next;
  }

  if (action.type === "ATTACK") {
    const att = getUnitByUid(next, action.attackerUid);
    const def = getUnitByUid(next, action.targetUid);
    if (!att || !def) return next;

    // vincoli attacco
    if (att.owner !== action.player) return next;
    if (att.lane !== "front") return next;
    if (att.flags?.attackedThisTurn) return next;

    // vincolo targeting (front shield)
    const validTargets = getValidAttackTargets(next, att.uid);
    if (!validTargets.includes(def.uid)) return next;

    const dmg = computeDamage(att, def);
    def.vit -= dmg;
    att.flags.attackedThisTurn = true;

    log(next, `P${action.player} attacca: ${att.uid} → ${def.uid} per ${dmg} danni (vit=${def.vit}/${def.vitMax})`);

    if (def.vit <= 0) {
      // muore
      removeUnitFromBoard(next, def);
      opp.discard.push(def.cardId);
      log(next, `✖ ${def.uid} eliminata → discard`);
    }
    return next;
  }

  if (action.type === "END_TURN") {
    // pulizia fine turno: reset attackedThisTurn, usedAbilities, ecc.
    for (let p=0; p<2; p++) {
      const pl = next.players[p];
      pl.perTurn.usedAbilities = {};
      for (const lane of ["front","back"]) {
        for (const u of pl.board[lane]) {
          if (!u) continue;
          u.flags.attackedThisTurn = false;
          u.flags.summonedThisTurn = false;
        }
      }
    }
    next.activePlayer = 1 - next.activePlayer;
    next.turn += 1;
    log(next, `--- Turno ${next.turn} (P${next.activePlayer}) ---`);
    return next;
  }

  return next;
}
