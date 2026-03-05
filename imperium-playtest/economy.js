const CREDIT_KEY = "ari_credits";

export function getCredits(){
  return Number(localStorage.getItem(CREDIT_KEY)) || 0;
}

export function addCredits(n){
  const v = getCredits() + Number(n);
  localStorage.setItem(CREDIT_KEY, String(v));
}

export function spendCredits(n){
  const v = getCredits();
  const cost = Number(n);

  if(v < cost) return false;

  localStorage.setItem(CREDIT_KEY, String(v - cost));
  return true;
}