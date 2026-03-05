// battle-deck.js — UI + deck selezionato per battle.html
// Inserisci in battle.html (prima di battle.js):
//   <script type=\"module\" src=\"battle-deck.js\"></script>
// Questo file crea un selettore "Deck" e salva lo slot attivo.
// Espone anche window.ARI_ACTIVE_DECK per battle.js.

import { listDeckSlots, setActiveSlot, getActiveSlot, getActiveDeck, expandDeck } from "./deckstore.js";

const mountId = "battleDeckMount";

function ensureMount(){
  let m = document.getElementById(mountId);
  if (m) return m;

  const top = document.querySelector(".battlebar__right") || document.querySelector(".topbar__right") || document.querySelector(".battlebar") || document.querySelector(".topbar") || document.body;

  m = document.createElement("div");
  m.id = mountId;
  m.style.display = "flex";
  m.style.alignItems = "flex-end";
  m.style.gap = "10px";
  m.style.marginLeft = "10px";

  m.innerHTML = `
    <label class="field">
      <span>Deck</span>
      <select id="battleDeckSelect"></select>
    </label>
    <div class="pill" id="battleDeckPill">—</div>
  `;

  top.appendChild(m);
  return m;
}

function render(){
  ensureMount();
  const sel = document.getElementById("battleDeckSelect");
  const pill = document.getElementById("battleDeckPill");
  if (!sel) return;

  const slots = listDeckSlots();
  sel.innerHTML = "";
  for (const s of slots){
    const opt = document.createElement("option");
    opt.value = String(s.index);
    opt.textContent = `${s.name} (${s.count}/30)`;
    sel.appendChild(opt);
  }
  sel.value = String(getActiveSlot());

  const active = getActiveDeck();
  const count = Object.values(active.deck||{}).reduce((a,n)=>a+Number(n||0),0);
  if (pill) pill.textContent = `Attivo: ${active.name} · ${count}/30`;

  window.ARI_ACTIVE_DECK = {
    slot: getActiveSlot(),
    name: active.name,
    deck: active.deck,
    list: expandDeck(active.deck),
  };
}

function onChange(e){
  const idx = Number(e.target.value);
  setActiveSlot(idx);
  render();
}

render();
document.addEventListener("change", (e)=>{
  if (e.target && e.target.id === "battleDeckSelect") onChange(e);
});
