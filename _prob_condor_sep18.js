'use strict';
// Probabilidades del condor SPX 2026-09-18 CONSISTENTES CON EL SKEW.
//
// Por que no basta N(d2): la probabilidad risk-neutral de terminar pasado un strike
// es -dC/dK (calls) o +dP/dK (puts) TOMANDO LA SONRISA EN CUENTA. Con IV plana se
// obtiene N(d2), que aca se equivoca feo: para el put 7400 da 21,6% cuando el propio
// mercado, que vende el spread 7400/7385 a 1,70 sobre 15 de ancho, no puede estar
// pagando mas de ~16%. La validacion de que el modelo esta bien es que reproduzca
// los marks observados de los DOS spreads.
const S = 7667.36;
const T = 27.96/365;

// IV cotizada en cada strike (dos puntos por lado -> pendiente local del skew)
const IV = { 7915:0.104670848, 7900:0.105397098, 7400:0.158996545, 7385:0.161143124 };
const MARK = { 7915:18.35, 7900:21.20, 7400:35.45, 7385:33.75 };
const CREDITO = 358.36;

function N(x){const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;
  const s=x<0?-1:1;x=Math.abs(x)/Math.SQRT2;const t=1/(1+p*x);
  return .5*(1+s*(1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t)*Math.exp(-x*x)));}
function bs(K, vol, tipo){
  const d1=(Math.log(S/K)+.5*vol*vol*T)/(vol*Math.sqrt(T)), d2=d1-vol*Math.sqrt(T);
  return tipo==='C' ? S*N(d1)-K*N(d2) : K*N(-d2)-S*N(-d1);
}
// Sonrisa local lineal por lado
const skewC = (IV[7915]-IV[7900])/(7915-7900);
const skewP = (IV[7400]-IV[7385])/(7400-7385);
const volC = (K) => IV[7900] + skewC*(K-7900);
const volP = (K) => IV[7400] + skewP*(K-7400);

console.log('=== VALIDACION: el modelo debe reproducir los marks ===');
for (const [K,tipo,vol] of [[7915,'C',IV[7915]],[7900,'C',IV[7900]],[7400,'P',IV[7400]],[7385,'P',IV[7385]]]) {
  console.log(`  ${tipo}${K}: modelo ${bs(K,vol,tipo).toFixed(2)}  vs mark ${MARK[K].toFixed(2)}`);
}
const spC_mod = bs(7900,IV[7900],'C')-bs(7915,IV[7915],'C'), spC_mkt = MARK[7900]-MARK[7915];
const spP_mod = bs(7400,IV[7400],'P')-bs(7385,IV[7385],'P'), spP_mkt = MARK[7400]-MARK[7385];
console.log(`  spread calls: modelo ${spC_mod.toFixed(2)} vs mercado ${spC_mkt.toFixed(2)}`);
console.log(`  spread puts : modelo ${spP_mod.toFixed(2)} vs mercado ${spP_mkt.toFixed(2)}`);

// Digital CON skew: derivada numerica del precio siguiendo la sonrisa
const h = 2;
const pArriba = (K) => -(bs(K+h,volC(K+h),'C') - bs(K-h,volC(K-h),'C'))/(2*h);
const pAbajo  = (K) =>  (bs(K+h,volP(K+h),'P') - bs(K-h,volP(K-h),'P'))/(2*h);
// Sin skew, para contraste
const pArribaPlano = (K) => -(bs(K+h,volC(K),'C') - bs(K-h,volC(K),'C'))/(2*h);
const pAbajoPlano  = (K) =>  (bs(K+h,volP(K),'P') - bs(K-h,volP(K),'P'))/(2*h);

const c = CREDITO/100, beAlto = 7900+c, beBajo = 7400-c;

console.log('\n=== PROBABILIDADES RISK-NEUTRAL ===');
console.log('                          con skew   IV plana');
console.log(`P(S > 7900)             :  ${(pArriba(7900)*100).toFixed(1)}%      ${(pArribaPlano(7900)*100).toFixed(1)}%`);
console.log(`P(S < 7400)             :  ${(pAbajo(7400)*100).toFixed(1)}%      ${(pAbajoPlano(7400)*100).toFixed(1)}%`);
console.log(`P(S > BE ${beAlto.toFixed(0)})         :  ${(pArriba(beAlto)*100).toFixed(1)}%`);
console.log(`P(S < BE ${beBajo.toFixed(0)})         :  ${(pAbajo(beBajo)*100).toFixed(1)}%`);

const pMax = 1 - pArriba(7900) - pAbajo(7400);
const pProfit = 1 - pArriba(beAlto) - pAbajo(beBajo);
console.log(`\nP(ganancia MAXIMA)      :  ${(pMax*100).toFixed(1)}%`);
console.log(`P(TERMINA EN PROFIT)    :  ${(pProfit*100).toFixed(1)}%`);
console.log(`P(pierde)               :  ${((1-pProfit)*100).toFixed(1)}%`);

// Contraste model-free: precio del spread / ancho
console.log('\n=== CONTRASTE MODEL-FREE (precio del spread / ancho) ===');
console.log(`spread calls ${spC_mkt.toFixed(2)}/15 = ${(spC_mkt/15*100).toFixed(1)}%  -> riesgo del lado call`);
console.log(`spread puts  ${spP_mkt.toFixed(2)}/15 = ${(spP_mkt/15*100).toFixed(1)}%  -> riesgo del lado put`);
console.log(`=> P(ambos expiran sin valor) ~ ${((1-spC_mkt/15-spP_mkt/15)*100).toFixed(1)}%`);

console.log('\n=== VALOR ESPERADO (exacto por no-arbitraje) ===');
console.log(`E[perdida a vencimiento] = valor de mercado de los spreads = $${((spC_mkt+spP_mkt)*100).toFixed(2)}`);
console.log(`credito neto cobrado                                        = $${CREDITO.toFixed(2)}`);
console.log(`>> EV de mantener = $${(CREDITO-(spC_mkt+spP_mkt)*100).toFixed(2)}  (= el mark-to-market de hoy)`);
