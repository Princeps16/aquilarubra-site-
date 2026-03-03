// engine/core.js
// Aquila Rubra Imperium — Core v1.0
// Implementa: turni (DRAW/COMMAND/ATTACK/END), condizioni vittoria (Gloria/Dominio),
// schieramento con limiti, ascesa, combattimento con ordine risoluzione + schivata,
// status base, abilità active/passive con trigger+script (subset utile al playtest),
// aura/rule_mod senza stacking infinito.

export function createEmptyPlayer() {
  return {
    deck: [],
    hand: [],
    discard: [],
    pactum: [], // max 2 (placeholder)
    board: { front: [null, null, null], back: [null, null, null] },

    gloria: 0,
    dominanceCounter: 0, // 0..2

    perTurn: {
      commandActionsLeft: 0,
      unitsDeployed: 0,
      ascendUsed: false,
      actioUsed: false,
      pactumUsed: false,
      usedAbilities: {}, // `${uid}:${slot}` => true
    },
  };
}

export function createGameState(cardsDb, seed = 1) {
  const state = {
    version: "1.0",
    seed,
    cardsDb,
    turn: 1,
    activePlayer: 0,
    phase: "DRAW", // DRAW -> COMMAND -> ATTACK -> END
    players: [createEmptyPlayer(), createEmptyPlayer()],
    pendingAttacks: [], // [{attackerUid,targetUid}]
    log: [],
    winner: null, // 0|1
    _uidToCardId: {}, // uid -> cardId (persistente per log/UI)
  };

  log(state, `--- Turno 1 (P0) ---`);
  // setup perTurn per P0
  startTurn(state);
  return state;
}

/* =========================
   Utility base
   ========================= */

function log(state, msg) {
  state.log.push(msg);
}

function getCard(state, cardId) {
  return state.cardsDb.cards.find((c) => c.id === cardId) || null;
}

function rememberUid(state, unit) {
  if (!state._uidToCardId) state._uidToCardId = {};
  state._uidToCardId[unit.uid] = unit.cardId;
}

function unitLabel(state, uid) {
  // prova prima la mappa persistente (copre anche unità eliminate)
  const cardId = state._uidToCardId ? state._uidToCardId[uid] : null;
  if (cardId) {
    const c = getCard(state, cardId);
    if (c?.name) return c.name;
  }
  // fallback: cerca in campo
  const u = getUnitByUid(state, uid);
  if (u) {
    const c = getCard(state, u.cardId);
    return c?.name || uid;
  }
  return uid;
}


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
    // Apex: condizioni speciali (per ora non deploy diretto)
    case "apex": return 999;
    default: return 1;
  }
}

function hasLowerRarityVersion(state, cardId) {
  const card = getCard(state, cardId);
  if (!card || card.type !== "unit") return false;

  const myTier = rarityIndex(card.rarity);
  if (myTier <= 0) return false; // communis non ha “inferiori”

  const base = baseIdFromCardId(cardId);

  // se nel DB esiste una carta unità con stesso baseId e rarità inferiore → è parte di una scala
  return state.cardsDb.cards.some(c =>
    c && c.type === "unit" &&
    baseIdFromCardId(c.id) === base &&
    rarityIndex(c.rarity) < myTier
  );
}

function gloriaForRarity(r) {
  switch (String(r).toLowerCase()) {
    case "communis": return 0;
    case "rara": return 1;
    case "insignis": return 2;
    case "mythica": return 3;
    case "aeterna": return 4;
    case "apex": return 6;
    default: return 0;
  }
}

function countUnits(player) {
  return [...player.board.front, ...player.board.back].filter(Boolean).length;
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

function getOpponentIndex(owner) {
  return 1 - owner;
}

function removeUnitFromBoard(state, unit) {
  state.players[unit.owner].board[unit.lane][unit.slot] = null;
}

function placeUnitOnBoard(state, unit, lane, slot) {
  const p = state.players[unit.owner];
  p.board[lane][slot] = unit;
  unit.lane = lane;
  unit.slot = slot;
}

/* =========================
   Runtime fields + status
   ========================= */

function ensureRuntimeFields(unit) {
  unit.flags ??= {};
  unit.statuses ??= [];
  unit.cooldowns ??= {}; // slot -> cdLeft
  unit.uses ??= {}; // slot -> usesLeft
  unit.attackMods ??= []; // next-attack one-shots
  unit.buffs ??= []; // temporary stat changes that must be reverted
  unit._baseStats ??= null; // snapshot card stats
  unit._derived ??= false;
}

function hasStatus(unit, name) {
  return (unit.statuses || []).some((s) => s.name === name);
}

function addStatus(unit, name, meta = {}) {
  ensureRuntimeFields(unit);
  if (hasStatus(unit, name)) return;
  unit.statuses.push({ name, ...meta });
}

function removeStatus(unit, name) {
  ensureRuntimeFields(unit);
  unit.statuses = (unit.statuses || []).filter((s) => s.name !== name);
}

function hasDiscipline(unit) {
  // "DISCIPLINA" come status o flag (se in futuro)
  return hasStatus(unit, "DISCIPLINA") || unit.flags?.discipline === true;
}

function applyStatusToStats(unit, stats) {
  // Disciplina: immunità a Corrotto/Prigioniero (non li applica)
  // Nota: l'immunità la facciamo “bloccante” quando si prova ad applicare lo status.
  let out = { ...stats };

  if (hasStatus(unit, "FERITO")) out.vel = Math.max(0, out.vel - 2);
  if (hasStatus(unit, "CORROTTO")) out.imp = Math.max(0, out.imp - 2);

  return out;
}

function isActivePrevented(state, unit) {
  ensureRuntimeFields(unit);
  const t = unit.flags.preventActiveUntilTurnEnd;
  return typeof t === "number" && t >= state.turn;
}

function isAttackPrevented(state, unit) {
  ensureRuntimeFields(unit);
  const t = unit.flags.preventAttackUntilTurnEnd;
  return typeof t === "number" && t >= state.turn;
}

function getEffectiveStats(state, unit) {
  ensureRuntimeFields(unit);
  if (!unit._baseStats) {
    const card = getCard(state, unit.cardId);
    unit._baseStats = card?.stats ? { ...card.stats } : { vit: unit.vitMax, imp: unit.imp, def: unit.def, vel: unit.vel };
  }

  // base from snapshot + permanent modifications already baked into unit.{imp,def,vel,vitMax}?
  // Per coerenza: trattiamo unit.{imp,def,vel,vitMax} come “current raw”,
  // ma aura/rulemod useranno resetDerivedStats() prima di ricalcolare.
  const raw = { imp: unit.imp, def: unit.def, vel: unit.vel, vitMax: unit.vitMax };

  return applyStatusToStats(unit, raw);
}

/* =========================
   Aura/RuleMod safe (no stacking)
   ========================= */

function resetDerivedStatsAndFlags(state) {
  for (const u of allUnits(state)) {
    ensureRuntimeFields(u);

    // reset rule-mod flags
    delete u.flags.allowAttackFromBackline;
    delete u.flags.allowAttackTargets;
    delete u.flags.untargetableByEnemyAbilities;
    if (u.flags.immunities) u.flags.immunities = [];

    // revert temporary buffs that are tagged "DERIVED"
    if (u.buffs && u.buffs.length) {
      const keep = [];
      for (const b of u.buffs) {
        if (b.expires === "DERIVED") {
          u[b.stat] -= b.amount;
          if (b.stat === "vit") {
            u.vitMax -= b.amount;
            u.vit = Math.min(u.vit, u.vitMax);
          }
        } else {
          keep.push(b);
        }
      }
      u.buffs = keep;
    }
  }
}

function applyBuff(unit, stat, amount, expires) {
  ensureRuntimeFields(unit);
  unit.buffs.push({ stat, amount, expires });
  unit[stat] += amount;

  if (stat === "vit") {
    unit.vitMax += amount;
    unit.vit = Math.min(unit.vit + amount, unit.vitMax);
  }
}

/* =========================
   Targeting helpers (board)
   ========================= */

function isAdjacent(a, b) {
  if (!a || !b) return false;
  const sameCol = a.slot === b.slot;
  const sameLaneAdj = a.lane === b.lane && Math.abs(a.slot - b.slot) === 1;
  const sameColOtherLane = sameCol && a.lane !== b.lane;
  return sameLaneAdj || sameColOtherLane;
}

function anyAllyInPlayByNameId(state, owner, nameId) {
  const prefix = `${nameId}_`;
  return allUnits(state).some((u) => u.owner === owner && String(u.cardId).startsWith(prefix));
}

function uCardFaction(state, unit) {
  return getCard(state, unit.cardId)?.faction || null;
}
function uCardClasses(state, unit) {
  return getCard(state, unit.cardId)?.classes || [];
}
function uCardRarity(state, unit) {
  return getCard(state, unit.cardId)?.rarity || null;
}

/* =========================
   Conditions
   ========================= */

function getRulesBlocks(ability) {
  if (!ability || !ability.rules) return [];
  return Array.isArray(ability.rules) ? ability.rules : [ability.rules];
}

function checkCondition(state, self, ctx, cond) {
  if (!cond) return true;

  switch (cond.op) {
    case "SELF_IN_ZONE":
      return self.lane === (cond.zone === "FRONTLINE" ? "front" : "back");

    case "ALLY_IN_PLAY":
      return anyAllyInPlayByNameId(state, self.owner, cond.nameId);

    case "HAS_ADJACENT_ALLY":
      return allUnits(state).some((u) => u.owner === self.owner && u.uid !== self.uid && isAdjacent(u, self) && (!cond.faction || uCardFaction(state, u) === cond.faction));

    case "MOVED_UNIT_IS_ENEMY":
      return !!(ctx?.movedUnit && ctx.movedUnit.owner !== self.owner);

    case "ATTACK_TARGET_NAMEID_IS": {
      const t = ctx?.target;
      return !!t && String(t.cardId).startsWith(`${cond.nameId}_`);
    }

    case "ATTACK_TARGET_IS": {
      const t = ctx?.target;
      return !!t && String(t.cardId).startsWith(`${cond.nameId}_`);
    }

    case "TARGET_IS_ENEMY":
      return !!(ctx?.target && ctx.target.owner !== self.owner);

    case "TARGET_FACTION_IS":
      return !!(ctx?.target && uCardFaction(state, ctx.target) === cond.faction);

    case "TARGET_HAS_CLASS":
      return !!(ctx?.target && uCardClasses(state, ctx.target).includes(cond.class));

    case "TARGET_HAS_STATUS":
      return !!(ctx?.target && hasStatus(ctx.target, cond.status));

    case "SELF_VEL_GT_TARGET_VEL":
      return !!(ctx?.target && getEffectiveStats(state, self).vel > getEffectiveStats(state, ctx.target).vel);

    case "TARGET_VEL_LT_SELF_VEL":
      return !!(ctx?.target && getEffectiveStats(state, ctx.target).vel < getEffectiveStats(state, self).vel);

    case "IS_FIRST_ATTACKER_THIS_TURN":
      return state._firstAttackThisTurnUid ? state._firstAttackThisTurnUid === self.uid : true;

    case "FLAG_IS_TRUE":
      return !!self.flags?.[cond.key];

    case "IS_ONLY_UNIT_ON_FIELD": {
      const units = allUnits(state);
      return units.length === 1 && units[0].uid === self.uid;
    }

    case "CONTROL_AT_LEAST": {
      const { count, who } = cond;
      let units = allUnits(state).filter((u) => (who === "ALLY" ? u.owner === self.owner : u.owner !== self.owner));
      if (cond.faction) units = units.filter((u) => uCardFaction(state, u) === cond.faction);
      if (cond.classes?.length) units = units.filter((u) => cond.classes.every((cl) => uCardClasses(state, u).includes(cl)));
      return units.length >= count;
    }

    case "ADJACENT_ALLIES_MATCH": {
      return allUnits(state).some((u) => {
        if (u.owner !== self.owner) return false;
        if (u.uid === self.uid) return false;
        if (!isAdjacent(u, self)) return false;
        if (cond.faction && uCardFaction(state, u) !== cond.faction) return false;
        if (cond.rarityIn?.length) {
          const r = uCardRarity(state, u);
          if (!cond.rarityIn.includes(r)) return false;
        }
        return true;
      });
    }

    case "ALLY_MATCH": {
      const e = ctx?.eliminatedUnit;
      if (!e) return false;
      if (e.owner !== self.owner) return false;
      if (cond.faction && uCardFaction(state, e) !== cond.faction) return false;
      return true;
    }

    case "ELIMINATED_UNIT_HAS_STATUS": {
      const e = ctx?.eliminatedUnit;
      return !!e && hasStatus(e, cond.status);
    }

    case "ELIMINATED_UNIT_FLAG_IS_TRUE": {
      const e = ctx?.eliminatedUnit;
      return !!e && !!e.flags?.[cond.key];
    }

    case "ONCE_PER_TURN": {
      state._oncePerTurn ??= {};
      const token = `${self.uid}:${cond.key}:${state.turn}:${state.activePlayer}`;
      if (state._oncePerTurn[token]) return false;
      state._oncePerTurn[token] = true;
      return true;
    }

    case "AND":
      return (cond.args || []).every((c) => checkCondition(state, self, ctx, c));

    default:
      return false;
  }
}

/* =========================
   Trigger emitter
   ========================= */

function emit(state, trigger, ctx = {}, opts = {}) {
  // Continuous effects are wiped/reapplied in batch via reapplyContinuous();
  if (!opts.noReset && (trigger === "AURA" || trigger === "RULE_MOD" || trigger === "PASSIVE")) {
    resetDerivedStatsAndFlags(state);
  }

  for (const unit of allUnits(state)) {
    ensureRuntimeFields(unit);
    const card = getCard(state, unit.cardId);
    const abilities = card?.abilities || unit.abilities || [];

    for (const ability of abilities) {
      const blocks = getRulesBlocks(ability);
      for (const rb of blocks) {
        if (rb.trigger !== trigger) continue;
        if (!checkCondition(state, unit, ctx, rb.condition)) continue;
        runScript(state, unit, ctx, rb.script || [], trigger);
      }
    }
  }
}

function reapplyContinuous(state, ctx = {}) {
  // Reset once, then apply all continuous triggers without resetting each time.
  resetDerivedStatsAndFlags(state);
  emit(state, "RULE_MOD", ctx, { noReset: true });
  emit(state, "AURA", ctx, { noReset: true });
  emit(state, "PASSIVE", ctx, { noReset: true });
}

/* =========================
   Script runner (subset)
   ========================= */

function resolveTargetRef(state, self, ctx, ref) {
  if (!ref) return null;
  if (ref === "SELF") return self;
  if (ref === "TARGET") return ctx?.target || null;
  if (ref === "MOVED_UNIT") return ctx?.movedUnit || null;
  if (ref === "ELIMINATION_SOURCE_UNIT") return ctx?.eliminationSource || null;
  if (ref === "t1" || ref === "t2" || ref === "s1") return ctx?.[ref] || null;
  if (typeof ref === "string" && ref.startsWith("u_")) return getUnitByUid(state, ref);
  return null;
}

function resolveValue(v, ctx) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && v.ref) return ctx?.[v.ref] ?? 0;
  return 0;
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

function runScript(state, self, ctx, script, sourceTrigger = null) {
  for (const step of script) {
    if (ctx._halt) break;
    if (!step || !step.op) continue;

    switch (step.op) {
      case "DAMAGE": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        const amount = resolveValue(step.amount, ctx);
        if (target) {
          target.vit -= amount;
          log(state, `→ ${unitLabel(state, self.uid)} infligge ${amount} a ${unitLabel(state, target.uid)} (vit=${target.vit}/${target.vitMax})`);
          if (target.vit <= 0) handleElimination(state, target, { source: self });
        }
        break;
      }

      case "HEAL": {
        const amount = resolveValue(step.amount, ctx);
        if (step.target === "ALL_ALLIES_FILTERED") {
          const list = filterUnits(state, self, "ALLY", step.filter || {});
          for (const u of list) u.vit = Math.min(u.vitMax, u.vit + amount);
          log(state, `→ Cura di massa +${amount} su ${list.length} unità`);
          break;
        }
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (target) {
          target.vit = Math.min(target.vitMax, target.vit + amount);
          log(state, `→ ${target.uid} cura ${amount} (vit=${target.vit}/${target.vitMax})`);
        }
        break;
      }

      case "MODIFY_STAT": {
        const amount = resolveValue(step.amount, ctx);
        const duration = step.duration || "PERMANENT";
        const stat = step.stat;

        // Derived aura: treat as DERIVED so we can wipe/reapply safely
        const derived = (sourceTrigger === "AURA" || sourceTrigger === "RULE_MOD" || sourceTrigger === "PASSIVE");

        const apply = (u) => {
          if (!u) return;
          ensureRuntimeFields(u);

          // IMPORTANTISSIMO: le passive AURA/RULE_MOD non devono accumularsi.
          // Qualsiasi MODIFY_STAT "PERMANENT" lanciata da AURA/RULE_MOD/PASSIVE viene trattata come DERIVED
          // (si ricalcola ogni volta che il board cambia).
          if (duration === "PERMANENT") {
            if (derived) {
              applyBuff(u, stat, amount, "DERIVED");
              return;
            }

            u[stat] += amount;
            if (stat === "vit") {
              u.vitMax += amount;
              u.vit = Math.min(u.vit + amount, u.vitMax);
            }
            return;
          }

          const expires =
            duration === "UNTIL_END_OF_TURN" ? "UNTIL_END_OF_TURN"
              : duration === "DERIVED" ? "DERIVED"
                : duration;

          applyBuff(u, stat, amount, derived ? "DERIVED" : expires);
        };

        if (step.target === "ALL_ALLIES_FILTERED") {
          const list = filterUnits(state, self, "ALLY", step.filter || {});
          for (const u of list) apply(u);
          break;
        }
        if (step.target === "ALL_ENEMIES_FILTERED") {
          const list = filterUnits(state, self, "ENEMY", step.filter || {});
          for (const u of list) apply(u);
          break;
        }
        if (step.target === "ALLY_ADJACENT_MATCH") {
          let list = allUnits(state).filter((u) => u.owner === self.owner && u.uid !== self.uid && isAdjacent(u, self));
          if (step.faction) list = list.filter((u) => uCardFaction(state, u) === step.faction);
          if (step.rarityIn?.length) list = list.filter((u) => step.rarityIn.includes(uCardRarity(state, u)));
          for (const u of list) apply(u);
          break;
        }

        const target = resolveTargetRef(state, self, ctx, step.target);
        apply(target);
        break;
      }

      case "APPLY_STATUS": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (!target) break;

        // Disciplina immune a CORROTTO e PRIGIONIERO
        if (hasDiscipline(target) && (step.status === "CORROTTO" || step.status === "PRIGIONIERO" || step.status === "MARCHIATO")) {
          log(state, `→ ${target.uid} è immune a ${step.status} (DISCIPLINA)`);
          break;
        }

        addStatus(target, step.status);
        log(state, `→ STATUS ${step.status} su ${unitLabel(state, target.uid)}`);
        break;
      }

      case "REMOVE_STATUS": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (!target) break;

        if (step.status) {
          removeStatus(target, step.status);
          log(state, `→ Rimosso STATUS ${step.status} da ${unitLabel(state, target.uid)}`);
          break;
        }

        if (step.which === "ONE_NEGATIVE" || step.which === "ONE_NEGATIVE_APPLIED_LAST_TURN") {
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
        if (!target) break;
        ensureRuntimeFields(target);

        // default: fino a fine turno avversario successivo
        target.flags.preventActiveUntilTurnEnd = state.turn + 1;
        log(state, `→ ${target.uid} non può usare attive fino a fine turno ${state.turn + 1}`);
        break;
      }

      case "PREVENT_ATTACK": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (!target) break;
        ensureRuntimeFields(target);

        target.flags.preventAttackUntilTurnEnd =
          step.duration === "UNTIL_OPPONENT_NEXT_TURN_END" ? state.turn + 1 : state.turn;

        log(state, `→ ${target.uid} non può attaccare fino a fine turno ${target.flags.preventAttackUntilTurnEnd}`);
        break;
      }

      case "IMMUNITY_STATUS": {
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
        if (!target) break;
        ensureRuntimeFields(target);
        target.flags[step.key] = step.value;
        break;
      }

      case "ADD_ATTACK_MOD": {
        const src = resolveTargetRef(state, self, ctx, step.source === "TARGET" ? "TARGET" : "SELF") || self;
        ensureRuntimeFields(src);

        // extraAttacks special-case
        if (step.mod?.extraAttacks) {
          src.flags.extraAttacksThisTurn = (src.flags.extraAttacksThisTurn || 0) + step.mod.extraAttacks;
          break;
        }

        src.attackMods.push({
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
        for (let i = 0; i < n; i++) {
          const cardId = me.hand.pop();
          if (cardId) me.discard.push(cardId);
        }
        break;
      }

      case "SACRIFICE": {
        const target = resolveTargetRef(state, self, ctx, step.target);
        if (target) handleElimination(state, target, { source: self, sacrifice: true });
        break;
      }

      case "SACRIFICE_SELF": {
        handleElimination(state, self, { source: self, sacrifice: true });
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
        ensureRuntimeFields(self);
        self.flags.allowAttackFromBackline = true;
        self.flags.allowAttackTargets = step.allowedTargets || "ENEMY_FRONTLINE";
        break;

      case "UNTARGETABLE_BY_ENEMY_ABILITIES":
        ensureRuntimeFields(self);
        self.flags.untargetableByEnemyAbilities = true;
        break;

      case "REDIRECT_ATTACK_TO_SELF":
        // only during ON_ATTACK_DECLARE
        if (ctx?.target) {
          ctx.target = self;
          log(state, `→ Redirect: attacco deviato su ${self.uid}`);
        }
        break;

      case "PEEK_DECK_TOP": {
        const me = state.players[self.owner];
        const n = resolveValue(step.amount ?? 1, ctx);
        ctx._peek = me.deck.slice(0, Math.max(0, n));
        break;
      }

      case "CHOOSE_ONE": {
        const choices = step.choices || [];
        const peek = ctx._peek || [];

        const isScry1 =
          peek.length === 1 &&
          choices.includes("LEAVE_ON_TOP") &&
          choices.includes("PUT_ON_BOTTOM");

        if (!isScry1) {
          log(state, `→ [CHOOSE_ONE] non supportata (log-only)`);
          break;
        }

        // crea prompt UI (modal) e FERMA l'esecuzione dello script
        state.uiPrompt = {
          type: "SCRY1",
          player: self.owner,
          cardId: peek[0],
        };

        ctx._peek = [];
        ctx._halt = true; // <- importantissimo: stop finché non arriva RESOLVE_UI_PROMPT
        break;
      }

      // Ops ancora non implementate (rimangono log-only)
      case "REVEAL_CARD":
      case "MOVE_CARD_FROM_HAND_TO_DECK":
      case "PEEK_HAND_RANDOM":
      case "CHOOSE_TARGET":
      case "ALLOW_FREE_DEPLOY_OF_CARD": {
        log(state, `→ [${step.op}] richiede supporto UI avanzato (log-only)`);
        break;
      }

      default:
        break;
    }
  }
}

/* =========================
   Combattimento
   ========================= */

function computeDamage(state, att, def, attackMod = null) {
  const attStats = getEffectiveStats(state, att);
  const defStats = getEffectiveStats(state, def);

  let atkImp = attStats.imp;

  if (attackMod) {
    if (typeof attackMod.impMultiplier === "number") atkImp = atkImp * attackMod.impMultiplier;
    if (typeof attackMod.impBonus === "number") atkImp = atkImp + attackMod.impBonus;
  }

  const ignoreDef = !!(attackMod && attackMod.ignoreDef === true);
  const ignoreDefAmount = (attackMod && typeof attackMod.ignoreDefAmount === "number") ? attackMod.ignoreDefAmount : 0;

  const effDef = ignoreDef ? 0 : Math.max(0, defStats.def - ignoreDefAmount);

  let dmg = Math.max(1, atkImp - effDef);

  // Marchiato: +1 danno da qualsiasi fonte
  if (hasStatus(def, "MARCHIATO")) dmg += 1;

  return dmg;
}

function canAttackNow(state, unit) {
  ensureRuntimeFields(unit);

  // Prigioniero: non può attaccare (se non Disciplina)
  if (hasStatus(unit, "PRIGIONIERO") && !hasDiscipline(unit)) return false;

  if (isAttackPrevented(state, unit)) return false;

  const allowed = 1 + (unit.flags.extraAttacksThisTurn || 0);
  const used = unit.flags.attacksUsedThisTurn || 0;

  if (used >= allowed) return false;

  // Base: solo front; eccezione: allowAttackFromBackline
  if (unit.lane !== "front" && !unit.flags.allowAttackFromBackline) return false;

  return true;
}

export function getValidAttackTargets(state, attackerUid) {
  const att = getUnitByUid(state, attackerUid);
  if (!att) return [];

  const opponent = state.players[getOpponentIndex(att.owner)];
  const out = [];

  // Regola: puoi sempre bersagliare la FRONT presente.
  // Se in una colonna la FRONT è vuota, puoi bersagliare la BACK in quella colonna.
  for (let col = 0; col < 3; col++) {
    const f = opponent.board.front?.[col] || null;
    const b = opponent.board.back?.[col] || null;

    if (f) out.push(f.uid);
    else if (b) out.push(b.uid);
  }

  return out;
}

/* =========================
   Eliminazioni + Gloria
   ========================= */

function handleElimination(state, unit, meta = {}) {
  const owner = state.players[unit.owner];
  const eliminatedCard = getCard(state, unit.cardId);

  removeUnitFromBoard(state, unit);
  owner.discard.push(unit.cardId);

  log(state, `✖ ${unitLabel(state, unit.uid)} eliminata → discard`);

  // Gloria (se eliminazione nemica e non sacrificio)
  const src = meta.source || null;
  const isSacrifice = !!meta.sacrifice;

  if (src && !isSacrifice && src.owner !== unit.owner) {
    const g = gloriaForRarity(eliminatedCard?.rarity);
    state.players[src.owner].gloria += g;
    if (g > 0) log(state, `★ Gloria +${g} a P${src.owner} (tot=${state.players[src.owner].gloria})`);
  }

  emit(state, "ON_UNIT_ELIMINATED", {
    eliminatedUnit: unit,
    eliminationSource: meta.source || null,
    eliminatedCard,
    eliminatedOwner: unit.owner,
  });

  emit(state, "ON_ALLY_ELIMINATED", {
    eliminatedUnit: unit,
    eliminationSource: meta.source || null,
    eliminatedCard,
    eliminatedOwner: unit.owner,
  });

  emit(state, "ON_ENEMY_ELIMINATED", {
    eliminatedUnit: unit,
    eliminationSource: meta.source || null,
    eliminatedCard,
    eliminatedOwner: unit.owner,
  });

  // Victory check after any elimination
  checkVictory(state);
}

/* =========================
   Turn structure
   ========================= */

function startTurn(state) {
  const p = state.players[state.activePlayer];

  // Reset perTurn flags
  p.perTurn.usedAbilities = {};
  p.perTurn.unitsDeployed = 0;
  p.perTurn.ascendUsed = false;
  p.perTurn.actioUsed = false;
  p.perTurn.pactumUsed = false;

  // Command actions
  if (state.turn === 1) {
    p.perTurn.commandActionsLeft = 0; // T1: solo deploy fino a 2 Communis, gestito da unitsDeployed
  } else {
    p.perTurn.commandActionsLeft = 2;
  }

  // Reset per-unit turn counters
  for (const u of allUnits(state).filter((u) => u.owner === state.activePlayer)) {
    ensureRuntimeFields(u);
    u.flags.attacksUsedThisTurn = 0;
    u.flags.extraAttacksThisTurn = 0;
  }

  // DRAW 1
  const top = p.deck.shift();
  if (top) p.hand.push(top);
  log(state, `P${state.activePlayer} pesca 1`);

  // Turn start triggers for that player
  emit(state, "TURN_START_SELF", { player: state.activePlayer });

  // Reapply continuous effects (rule_mod + aura + passive)
  reapplyContinuous(state, { player: state.activePlayer });

  state.phase = "COMMAND";
  log(state, `→ Fase COMMAND (P${state.activePlayer})`);

  checkVictory(state);
}

function endTurn(state) {
  // Dominio Totale check/update: si valuta a fine turno del giocatore dominante
  updateDominance(state);

  // Expire end-of-turn buffs (UNTIL_END_OF_TURN)
  for (const u of allUnits(state)) {
    ensureRuntimeFields(u);
    if (!u.buffs || !u.buffs.length) continue;
    const keep = [];
    for (const b of u.buffs) {
      if (b.expires === "UNTIL_END_OF_TURN") {
        u[b.stat] -= b.amount;
        if (b.stat === "vit") {
          u.vitMax -= b.amount;
          u.vit = Math.min(u.vit, u.vitMax);
        }
      } else {
        keep.push(b);
      }
    }
    u.buffs = keep;
  }

  // Clear pending attacks (should already be resolved)
  state.pendingAttacks = [];

  // Switch player/turn
  state.activePlayer = 1 - state.activePlayer;
  state.turn += 1;
    state.phase = "COMMAND";
  log(state, `→ Fase COMMAND (P${state.activePlayer})`);
  state._firstAttackThisTurnUid = null;
  state._oncePerTurn = {};

  log(state, `--- Turno ${state.turn} (P${state.activePlayer}) ---`);

  startTurn(state);
}

function updateDominance(state) {
  for (let p = 0; p < 2; p++) {
    const me = state.players[p];
    const opp = state.players[1 - p];

    const oppUnits = countUnits(opp);
    const controls3Cols =
      [0, 1, 2].every((col) => {
        const anyMe = (me.board.front[col] || me.board.back[col]);
        return !!anyMe;
      });

    const dominantNow = controls3Cols && oppUnits === 0;

    if (dominantNow) {
      me.dominanceCounter = Math.min(2, (me.dominanceCounter || 0) + 1);
      log(state, `♛ Dominio: P${p} (${me.dominanceCounter}/2)`);
    } else {
      me.dominanceCounter = 0;
    }
  }

  if (state.players[0].dominanceCounter >= 2) {
    state.winner = 0;
    log(state, `🏆 Vittoria: Dominio Totale (P0)`);
  }
  if (state.players[1].dominanceCounter >= 2) {
    state.winner = 1;
    log(state, `🏆 Vittoria: Dominio Totale (P1)`);
  }
}

function checkVictory(state) {
  if (state.winner !== null) return;

  if (state.players[0].gloria >= 7) {
    state.winner = 0;
    log(state, `🏆 Vittoria: Gloria 7 (P0)`);
    return;
  }
  if (state.players[1].gloria >= 7) {
    state.winner = 1;
    log(state, `🏆 Vittoria: Gloria 7 (P1)`);
    return;
  }
}

/* =========================
   Regole schieramento / copie
   ========================= */

function violatesCopyRules(state, playerIndex, cardId) {
  const card = getCard(state, cardId);
  if (!card || card.type !== "unit") return true;

  const baseId = baseIdFromCardId(cardId);
  const r = String(card.rarity).toLowerCase();
  const meUnits = allUnits(state).filter((u) => u.owner === playerIndex);

  // no two copies of same Communis card
  if (r === "communis") {
    if (meUnits.some((u) => u.cardId === cardId)) return true;
  }

  // no two versions of same character (baseId)
  if (meUnits.some((u) => baseIdFromCardId(u.cardId) === baseId)) return true;

  return false;
}

function canDeployCard(state, playerIndex, cardId) {
  const p = state.players[playerIndex];
  const card = getCard(state, cardId);
  if (!card || card.type !== "unit") return false;

  // Se la carta ha una versione inferiore (stesso personaggio), non può essere deployata “diretta”.
  // Deve entrare in campo tramite ASCEND (partendo dalla communis).
  if (hasLowerRarityVersion(state, cardId)) return false;

  if (state.winner !== null) return false;
  if (state.activePlayer !== playerIndex) return false;
  if (state.phase !== "COMMAND") return false;

  if (countUnits(p) >= 6) return false;
  if (violatesCopyRules(state, playerIndex, cardId)) return false;

  const minT = minTurnForRarity(card.rarity);
  if (state.turn < minT) return false;

  // T1: solo 2 Communis deploy, no command actions needed
  if (state.turn === 1) {
    if (String(card.rarity).toLowerCase() !== "communis") return false;
    if (p.perTurn.unitsDeployed >= 2) return false;
    return true;
  }

  // dal T2: serve azione comando, e max 2 unità deploy/turno
  if (p.perTurn.commandActionsLeft <= 0) return false;
  if (p.perTurn.unitsDeployed >= 2) return false;

  return true;
}

function canAscend(state, playerIndex, fromUid, handIndex) {
  const p = state.players[playerIndex];
  const from = getUnitByUid(state, fromUid);
  if (!from) return false;
  if (from.owner !== playerIndex) return false;

  const toCardId = p.hand[handIndex];
  const toCard = getCard(state, toCardId);
  if (!toCard || toCard.type !== "unit") return false;

  if (state.winner !== null) return false;
  if (state.activePlayer !== playerIndex) return false;
  if (state.phase !== "COMMAND") return false;

  if (state.turn === 1) return false;
  if (p.perTurn.commandActionsLeft <= 0) return false;
  if (p.perTurn.ascendUsed) return false;

  // must be same baseId and higher rarity
  const baseFrom = baseIdFromCardId(from.cardId);
  const baseTo = baseIdFromCardId(toCardId);
  if (baseFrom !== baseTo) return false;

  const fromR = getCard(state, from.cardId)?.rarity;
  if (rarityIndex(toCard.rarity) !== (rarityIndex(fromR) + 1)) return false;

  // and toCard must be allowed by turn minimum
  if (state.turn < minTurnForRarity(toCard.rarity)) return false;

  return true;
}

/* =========================
   Legal actions (for UI)
   ========================= */

export function getLegalActions(state) {
  const pIndex = state.activePlayer;
  const me = state.players[pIndex];
  const actions = [];

  if (state.winner !== null) return actions;
// DRAW: puoi solo passare a COMMAND
if (state.phase === "DRAW") {
  actions.push({ type: "TO_COMMAND_PHASE", player: pIndex });
  return actions;
}
  // Deploy from hand
  if (state.phase === "COMMAND") {
    for (let hi = 0; hi < me.hand.length; hi++) {
      const cardId = me.hand[hi];
      const card = getCard(state, cardId);
      if (!card || card.type !== "unit") continue;
      if (!canDeployCard(state, pIndex, cardId)) continue;

      for (const lane of ["front", "back"]) {
        for (let slot = 0; slot < 3; slot++) {
          if (me.board[lane][slot] === null) {
            actions.push({ type: "PLAY_UNIT", player: pIndex, handIndex: hi, lane, slot });
          }
        }
      }
    }

    // Ascend: pick a board unit and a hand card
    if (state.turn >= 2 && me.perTurn.commandActionsLeft > 0 && !me.perTurn.ascendUsed) {
      const mine = allUnits(state).filter((u) => u.owner === pIndex);
      for (const u of mine) {
        for (let hi = 0; hi < me.hand.length; hi++) {
          if (canAscend(state, pIndex, u.uid, hi)) {
            actions.push({ type: "ASCEND", player: pIndex, fromUid: u.uid, handIndex: hi });
          }
        }
      }
    }

    actions.push({ type: "TO_ATTACK_PHASE", player: pIndex });
  }

  // Attack phase actions: queue attacks
  if (state.phase === "ATTACK") {
    const mine = allUnits(state).filter((u) => u.owner === pIndex);
    for (const u of mine) {
      if (!canAttackNow(state, u)) continue;
      const targets = getValidAttackTargets(state, u.uid);
      for (const tid of targets) {
        actions.push({ type: "QUEUE_ATTACK", player: pIndex, attackerUid: u.uid, targetUid: tid });
      }
    }
    actions.push({ type: "RESOLVE_ATTACKS", player: pIndex });
    actions.push({ type: "END_TURN", player: pIndex });
  }

  return actions;
}

/* =========================
   ApplyAction
   ========================= */

let UID_COUNTER = 1;
function newUid() {
  return `u_${UID_COUNTER++}`;
}

export function applyAction(state, action) {
  const next = structuredClone(state);
  if (next.winner !== null) return next;

  const pIndex = action.player;

  if (pIndex !== next.activePlayer && action.type !== "BOOTSTRAP" && action.type !== "RESOLVE_UI_PROMPT") return next;
  if (action.type === "RESOLVE_UI_PROMPT") {
  const prompt = next.uiPrompt;
  if (!prompt) return next;

  // solo il player del prompt può risolvere
  if (action.player !== prompt.player) return next;

  if (prompt.type === "SCRY1") {
    const me = next.players[prompt.player];
    const cardId = prompt.cardId;
    const choice = action.payload?.choice;

    if (choice === "BOTTOM") {
      const idx = me.deck.indexOf(cardId);
      if (idx !== -1) me.deck.splice(idx, 1);
      me.deck.push(cardId);
      log(next, `→ Occhi Attenti: carta messa sotto al mazzo`);
    } else {
      log(next, `→ Occhi Attenti: carta lasciata sopra al mazzo`);
    }
  }

  // chiudi prompt e sblocca eventuale halt
  next.uiPrompt = null;

  // (opzionale ma utile) pulisci eventuale flag di halt in ctx se lo usi altrove
  // non serve se hai ctx locale, ma non fa danni se non esiste.

  return next;
}
if (action.type === "TO_COMMAND_PHASE") {
  if (next.phase !== "DRAW") return next;
  next.phase = "COMMAND";
  log(next, `→ Fase COMMAND (P${pIndex})`);
  return next;
}
  const me = next.players[pIndex];

  // Phase transitions
  if (action.type === "TO_ATTACK_PHASE") {
    if (next.phase !== "COMMAND") return next;
    next.phase = "ATTACK";
    next.pendingAttacks = [];
    log(next, `→ Fase ATTACK (P${pIndex})`);
    return next;
  }

  if (action.type === "PLAY_UNIT") {
    if (!canDeployCard(next, pIndex, me.hand[action.handIndex])) return next;

    const cardId = me.hand[action.handIndex];
    const card = getCard(next, cardId);
    if (!card) return next;

    if (me.board[action.lane][action.slot] !== null) return next;

    // remove from hand
    me.hand.splice(action.handIndex, 1);

    const unit = {
      uid: newUid(),
      cardId,
      owner: pIndex,
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
      flags: {
        attacksUsedThisTurn: 0,
        extraAttacksThisTurn: 0,
      },
    };

    // init cd/uses
    for (const ab of unit.abilities) {
      if (ab?.slot == null) continue;
      if (typeof ab.cd === "number") unit.cooldowns[ab.slot] = 0;
      if (ab.uses?.perGame != null) unit.uses[ab.slot] = ab.uses.perGame;
    }

    placeUnitOnBoard(next, unit, action.lane, action.slot);
    log(next, `P${pIndex} schiera ${card.name} in ${action.lane}[${action.slot}]`);
    reapplyContinuous(next, { player: next.activePlayer });

    me.perTurn.unitsDeployed += 1;

    if (next.turn >= 2) me.perTurn.commandActionsLeft = Math.max(0, me.perTurn.commandActionsLeft - 1);

    emit(next, "ON_DEPLOY", { unit, player: pIndex });

    // reapply rule/aura
    reapplyContinuous(next, { player: pIndex });

    checkVictory(next);
    return next;
  }

  if (action.type === "ASCEND") {
    if (!canAscend(next, pIndex, action.fromUid, action.handIndex)) return next;

    const from = getUnitByUid(next, action.fromUid);
    const toCardId = me.hand[action.handIndex];
    const toCard = getCard(next, toCardId);
    if (!from || !toCard) return next;

    // remove from hand
    me.hand.splice(action.handIndex, 1);

    // move previous to discard
    me.discard.push(from.cardId);

    // replace unit in same slot/lane with new stats, same uid
    const carryDamage = Math.max(0, from.vitMax - from.vit);

    from.cardId = toCardId;
    rememberUid(next, from);
    from.vitMax = toCard.stats.vit;
    from.vit = Math.max(1, from.vitMax - carryDamage);
    from.imp = toCard.stats.imp;
    from.def = toCard.stats.def;
    from.vel = toCard.stats.vel;
    from.abilities = toCard.abilities || [];
    from.statuses = [];
    from.cooldowns = {};
    from.uses = {};
    from.attackMods = [];
    from.buffs = [];
    from.flags = {
      attacksUsedThisTurn: 0,
      extraAttacksThisTurn: 0,
    };
    from._baseStats = null;

    for (const ab of from.abilities) {
      if (ab?.slot == null) continue;
      if (typeof ab.cd === "number") from.cooldowns[ab.slot] = 0;
      if (ab.uses?.perGame != null) from.uses[ab.slot] = ab.uses.perGame;
    }

    me.perTurn.ascendUsed = true;
    me.perTurn.commandActionsLeft = Math.max(0, me.perTurn.commandActionsLeft - 1);

    log(next, `⇧ Ascesa: ${toCard.name} nello slot ${from.lane}[${from.slot}]`);

    emit(next, "ON_ASCEND", { unit: from, player: pIndex });

    reapplyContinuous(next, { player: pIndex });

    checkVictory(next);
    return next;
  }

  if (action.type === "ACTIVATE_ABILITY") {
    if (next.phase !== "COMMAND" && next.phase !== "ATTACK") return next;

    const unit = getUnitByUid(next, action.unitUid);
    if (!unit) return next;
    if (unit.owner !== pIndex) return next;

    ensureRuntimeFields(unit);

    const card = getCard(next, unit.cardId);
    const ability = (card?.abilities || []).find((a) => a.type === "active" && a.slot === action.slot);
    if (!ability) return next;

    if (isActivePrevented(next, unit)) return next;

    const slot = ability.slot;
    const cdLeft = unit.cooldowns[slot] ?? 0;
    if (cdLeft > 0) return next;

    const usesLeft = unit.uses[slot] ?? null;
    if (usesLeft !== null && usesLeft <= 0) return next;

    const usedKey = `${unit.uid}:${slot}`;
    if (me.perTurn.usedAbilities[usedKey]) return next;

    // payload targets
    const payload = action.payload || {};
    const ctx = {};
    if (payload.targetUid) ctx.target = getUnitByUid(next, payload.targetUid);
    if (payload.targets && typeof payload.targets === "object") {
      for (const [k, uid] of Object.entries(payload.targets)) ctx[k] = getUnitByUid(next, uid);
      if (!ctx.target && ctx.t1) ctx.target = ctx.t1;
    }

    // run ACTIVE_MANUAL blocks
    const blocks = getRulesBlocks(ability).filter((b) => b.trigger === "ACTIVE_MANUAL");
    for (const rb of blocks) {
      if (!checkCondition(next, unit, ctx, rb.condition)) continue;
      runScript(next, unit, ctx, rb.script || []);
    }

    me.perTurn.usedAbilities[usedKey] = true;

    const cd = typeof ability.cd === "number" ? ability.cd : null;
    if (cd != null) unit.cooldowns[slot] = cd;

    if (usesLeft !== null) unit.uses[slot] = usesLeft - 1;

    log(next, `P${pIndex} usa abilità: ${card?.name || unit.cardId} [A${slot}]`);

    // reapply rule/aura (alcune attive settano flag)
    reapplyContinuous(next, { player: pIndex });

    checkVictory(next);
    return next;
  }

if (action.type === "QUEUE_ATTACK") {
  // FIX: se la UI non ha fatto TO_ATTACK_PHASE, ci entriamo automaticamente
  if (next.phase === "COMMAND") {
    next.phase = "ATTACK";
    next.pendingAttacks = [];
    log(next, `→ Fase ATTACK (auto) (P${pIndex})`);
  }

  if (next.phase !== "ATTACK") return next;

  const att = getUnitByUid(next, action.attackerUid);
  const def = getUnitByUid(next, action.targetUid);
  if (!att || !def) return next;
  if (att.owner !== pIndex) return next;

  if (!canAttackNow(next, att)) return next;

  const validTargets = getValidAttackTargets(next, att.uid);
  if (!validTargets.includes(def.uid)) return next;

  const allowed = 1 + (att.flags.extraAttacksThisTurn || 0);
  const used = att.flags.attacksUsedThisTurn || 0;
  if (used >= allowed) return next;

  next.pendingAttacks.push({ attackerUid: att.uid, targetUid: def.uid });
  att.flags.attacksUsedThisTurn = used + 1;

  if (!next._firstAttackThisTurnUid) next._firstAttackThisTurnUid = att.uid;

  log(next, `→ Queue ATTACK: ${att.uid} → ${def.uid}`);
  return next;
}

  if (action.type === "RESOLVE_ATTACKS") {
    if (next.phase !== "ATTACK") return next;
    resolvePendingAttacks(next);
    reapplyContinuous(next, { player: next.activePlayer });
    checkVictory(next);
    return next;
  }

  if (action.type === "END_TURN") {
    if (next.phase !== "ATTACK") return next;

    // auto-resolve if still pending
    if (next.pendingAttacks.length) resolvePendingAttacks(next);

    // Tick cooldowns + remove UNTIL_END_OF_TURN buffs + consume attackMods
    for (const u of allUnits(next)) {
      ensureRuntimeFields(u);

      for (const k of Object.keys(u.cooldowns)) {
        u.cooldowns[k] = Math.max(0, (u.cooldowns[k] || 0) - 1);
      }

      if (u.buffs && u.buffs.length) {
        const keep = [];
        for (const b of u.buffs) {
          if (b.expires === "UNTIL_END_OF_TURN") {
            u[b.stat] -= b.amount;
            if (b.stat === "vit") {
              u.vitMax -= b.amount;
              u.vit = Math.min(u.vit, u.vitMax);
            }
          } else {
            keep.push(b);
          }
        }
        u.buffs = keep;
      }

      u.attackMods = (u.attackMods || []).filter((m) => !m._consumed);
    }

    // Reapply aura/rule after cleanup
    reapplyContinuous(next, { player: pIndex });

    checkVictory(next);
    if (next.winner !== null) return next;

    endTurn(next);
    return next;
  }

  return next;
}

function resolvePendingAttacks(state) {
  if (!state.pendingAttacks.length) return;

  // Build resolution list with current VEL ordering:
  // VEL desc, tie: rarity higher, tie: IMP higher
  const entries = state.pendingAttacks
    .map((x) => ({
      ...x,
      attacker: getUnitByUid(state, x.attackerUid),
      target: getUnitByUid(state, x.targetUid),
    }))
    .filter((e) => e.attacker && e.target);

  // It’s possible target died earlier in resolution; we re-check at execution time.

  entries.sort((a, b) => {
    const aU = a.attacker;
    const bU = b.attacker;

    const aVel = getEffectiveStats(state, aU).vel;
    const bVel = getEffectiveStats(state, bU).vel;
    if (bVel !== aVel) return bVel - aVel;

    const aR = rarityIndex(uCardRarity(state, aU));
    const bR = rarityIndex(uCardRarity(state, bU));
    if (bR !== aR) return bR - aR;

    const aImp = getEffectiveStats(state, aU).imp;
    const bImp = getEffectiveStats(state, bU).imp;
    return bImp - aImp;
  });

  log(state, `→ Risoluzione attacchi (${entries.length})`);

  for (const e of entries) {
    const att = getUnitByUid(state, e.attackerUid);
    const def0 = getUnitByUid(state, e.targetUid);
    if (!att || !def0) continue;
    ensureRuntimeFields(att);
    ensureRuntimeFields(def0);

    // Attacker could be dead or no longer able to attack: ignore
    if (att.vit <= 0) continue;
    if (hasStatus(att, "PRIGIONIERO") && !hasDiscipline(att)) continue;
    if (isAttackPrevented(state, att)) continue;

    // Validate target lane still legal at time of resolution
    const validNow = getValidAttackTargets(state, att.uid);
    if (!validNow.includes(def0.uid)) continue;

    // ON_ATTACK_DECLARE with redirect support
    const ctx = { attacker: att, target: def0 };
    emit(state, "ON_ATTACK_DECLARE", ctx);
    const def = ctx.target;
    if (!def || def.vit <= 0) continue;

    // Dodge: if defender is faster by 5+ (attacker slower by 5+)
    const attVel = getEffectiveStats(state, att).vel;
    const defVel = getEffectiveStats(state, def).vel;
    const dodgeCheck = (defVel - attVel) >= 5;

    if (dodgeCheck) {
      const coin = Math.random() < 0.5 ? "pari" : "dispari";
      const dodged = coin === "pari"; // semplificazione deterministica “pari=schiva”
      if (dodged) {
        log(state, `↯ Schivata: ${unitLabel(state, def.uid)} evita l'attacco di ${unitLabel(state, att.uid)}`);
        continue;
      }
    }

    // pick first unconsumed attack mod
    const mod = (att.attackMods || []).find((m) => !m._consumed) || null;

    const dmg = computeDamage(state, att, def, mod);
    if (mod) mod._consumed = true;

    def.vit -= dmg;
    log(state, `⚔ ${unitLabel(state, att.uid)} → ${unitLabel(state, def.uid)} per ${dmg} (vit=${def.vit}/${def.vitMax})`);

    emit(state, "ON_ATTACK_HIT", { attacker: att, target: def });

    if (def.vit <= 0) handleElimination(state, def, { source: att });

    emit(state, "ON_ATTACK_RESOLVED", { attacker: att, target: def });
  }

  state.pendingAttacks = [];
}
