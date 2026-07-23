const P='/home/claude/trading/packages/shared/src';
const {run}=require(P+'/replay/harness');
const BASE=require(P+'/tmi/config');
const LIQ=require(P+'/live-engine/config').LIQUIDITY, COMM=require(P+'/live-engine/config').COMMISSION;
const days=[['/tmp/s2.json','15Jul'],['/tmp/s3.json','16Jul'],['/tmp/s4.json','19Jul'],['/tmp/s5.json','20Jul'],['/tmp/s6.json','21Jul']];
const sessions=days.map(([f,l])=>[require(f),l]);
const deep=o=>JSON.parse(JSON.stringify(o));
function V(p){const c=deep(BASE);for(const[k,v]of Object.entries(p)){const[a,b]=k.split('.');c[a][b]=v;}return c;}
function ev(n,p){const cfg=V(p);
 const res=sessions.map(([s,l])=>{const r=run(s,cfg,LIQ,COMM);return{l,net:r.summary.netKd,trips:r.summary.trips,wins:r.summary.wins};});
 const tot=res.reduce((a,r)=>a+r.net,0);
 return {n,res,tot:Math.round(tot*10)/10,green:res.filter(r=>r.net>0).length,
   trips:res.reduce((a,r)=>a+r.trips,0),wins:res.reduce((a,r)=>a+r.wins,0)};}
const Z={'ENTRY.model':'zone'};
const tests=[
 ['confirmation (ships today)',{}],
 ['zone, no filters',Z],
 ['zone + swing 5-12f',{...Z,'ENTRY.minSwing1Fils':5,'ENTRY.maxSwing1Fils':12}],
 ['zone + no-trade first 30m',{...Z,'SELECTION.noTradeBeforeMinute':30}],
 ['zone + swing5-12 + skip30m',{...Z,'ENTRY.minSwing1Fils':5,'ENTRY.maxSwing1Fils':12,'SELECTION.noTradeBeforeMinute':30}],
 ['  ...+ time exit 45m',{...Z,'ENTRY.minSwing1Fils':5,'ENTRY.maxSwing1Fils':12,'SELECTION.noTradeBeforeMinute':30,'EXIT.maxHoldMinutes':45}],
 ['  ...+ max 3 stocks',{...Z,'ENTRY.minSwing1Fils':5,'ENTRY.maxSwing1Fils':12,'SELECTION.noTradeBeforeMinute':30,'EXIT.maxHoldMinutes':45,'SELECTION.maxConcurrentStocks':3}],
];
console.log('final check — 5 days, walk-forward, 5000 KD\n');
console.log('variant'.padEnd(30),'15Jul'.padStart(8),'16Jul'.padStart(8),'19Jul'.padStart(8),'20Jul'.padStart(8),'21Jul'.padStart(8),' |','TOTAL'.padStart(9),'green'.padStart(6),'trips'.padStart(6),'win%'.padStart(6));
console.log('-'.repeat(116));
for(const[n,p]of tests){const r=ev(n,p);
 console.log(n.padEnd(30),...r.res.map(x=>String(x.net).padStart(8)),' |',String(r.tot).padStart(9),
  String(r.green+'/5').padStart(6),String(r.trips).padStart(6),String(r.trips?Math.round(100*r.wins/r.trips)+'%':'-').padStart(6));}
