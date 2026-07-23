const P='/home/claude/trading/packages/shared/src';
const {run}=require(P+'/replay/harness');
const BASE=require(P+'/tmi/config');
const LIQ=require(P+'/live-engine/config').LIQUIDITY, COMM=require(P+'/live-engine/config').COMMISSION;
const days=[['/tmp/s2.json','15Jul'],['/tmp/s3.json','16Jul'],['/tmp/s4.json','19Jul'],['/tmp/s5.json','20Jul'],['/tmp/s6.json','21Jul']];
const sessions=days.map(([f,l])=>[require(f),l]);
const deep=o=>JSON.parse(JSON.stringify(o));
function variant(patch){const c=deep(BASE);for(const[k,v]of Object.entries(patch)){const[a,b]=k.split('.');c[a][b]=v;}return c;}
function ev(name,patch){
  const cfg=variant(patch);
  const res=sessions.map(([s,l])=>{const r=run(s,cfg,LIQ,COMM);return{l,net:r.summary.netKd,trips:r.summary.trips,wins:r.summary.wins};});
  const tot=res.reduce((a,r)=>a+r.net,0), tr=res.reduce((a,r)=>a+r.trips,0), w=res.reduce((a,r)=>a+r.wins,0);
  return {name,res,tot:Math.round(tot*10)/10,trips:tr,wins:w,green:res.filter(r=>r.net>0).length};
}
const tests=[
 ['CONFIRMATION (current)',{}],
 ['ZONE entry',{'ENTRY.model':'zone'}],
 ['ZONE + time exit 45m',{'ENTRY.model':'zone','EXIT.maxHoldMinutes':45}],
 ['ZONE + lockout 60m',{'ENTRY.model':'zone','SELECTION.openingWindowMinutes':60}],
 ['ZONE + time45 + lockout60',{'ENTRY.model':'zone','EXIT.maxHoldMinutes':45,'SELECTION.openingWindowMinutes':60}],
 ['ZONE + max1 stock',{'ENTRY.model':'zone','SELECTION.maxConcurrentStocks':1}],
 ['ZONE + max3 stocks',{'ENTRY.model':'zone','SELECTION.maxConcurrentStocks':3}],
];
console.log('A/B: entry model, walk-forward, 5 days, 5000 KD\n');
console.log('variant'.padEnd(28),'15Jul'.padStart(8),'16Jul'.padStart(8),'19Jul'.padStart(8),'20Jul'.padStart(8),'21Jul'.padStart(8),' |','TOTAL'.padStart(9),'green'.padStart(6),'trips'.padStart(6),'wins'.padStart(5));
console.log('-'.repeat(112));
for(const[n,p]of tests){const r=ev(n,p);
 console.log(n.padEnd(28),...r.res.map(x=>String(x.net).padStart(8)),' |',String(r.tot).padStart(9),String(r.green+'/5').padStart(6),String(r.trips).padStart(6),String(r.wins).padStart(5));}
