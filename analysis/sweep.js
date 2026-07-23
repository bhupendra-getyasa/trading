const P='/home/claude/trading/packages/shared/src';
const { run } = require(P+'/replay/harness');
const BASE = require(P+'/tmi/config');
const LIQ = require(P+'/live-engine/config').LIQUIDITY;
const COMM = require(P+'/live-engine/config').COMMISSION;
const days = [['/tmp/s1.json','15Jul'],['/tmp/s2.json','16Jul'],['/tmp/s3.json','19Jul'],['/tmp/s4.json','20Jul'],['/tmp/s5.json','21Jul']];
const sessions = days.map(([f,l])=>[require(f),l]);

function deep(o){ return JSON.parse(JSON.stringify(o)); }
function variant(patch){ const c=deep(BASE); for(const [k,v] of Object.entries(patch)){ const [a,b]=k.split('.'); c[a][b]=v; } return c; }

function evaluate(name, patch){
  const cfg = variant(patch);
  const res = sessions.map(([s,l])=>{ const r = run(s,cfg,LIQ,COMM); return {l, net:r.summary.netKd, roi:r.summary.roiPct, trips:r.summary.trips, wins:r.summary.wins}; });
  const tot = res.reduce((a,r)=>a+r.net,0);
  const totRoi = res.reduce((a,r)=>a+r.roi,0);
  const green = res.filter(r=>r.net>0).length;
  return { name, res, tot:Math.round(tot*10)/10, avgRoi:Math.round(totRoi/res.length*100)/100, green, trips:res.reduce((a,r)=>a+r.trips,0) };
}

const tests = [
  ['BASELINE (as shipped)',                         {}],
  ['+ time exit 30m',                               {'EXIT.maxHoldMinutes':30}],
  ['+ time exit 45m',                               {'EXIT.maxHoldMinutes':45}],
  ['+ time exit 60m',                               {'EXIT.maxHoldMinutes':60}],
  ['+ opening lockout 30m (1 slot)',                {'SELECTION.openingWindowMinutes':30}],
  ['+ opening lockout 60m (1 slot)',                {'SELECTION.openingWindowMinutes':60}],
  ['+ opening lockout 90m (1 slot)',                {'SELECTION.openingWindowMinutes':90}],
  ['max 1 stock',                                   {'SELECTION.maxConcurrentStocks':1}],
  ['max 3 stocks',                                  {'SELECTION.maxConcurrentStocks':3}],
  ['time45 + lockout60',                            {'EXIT.maxHoldMinutes':45,'SELECTION.openingWindowMinutes':60}],
  ['time30 + lockout60',                            {'EXIT.maxHoldMinutes':30,'SELECTION.openingWindowMinutes':60}],
  ['time30 + lockout90',                            {'EXIT.maxHoldMinutes':30,'SELECTION.openingWindowMinutes':90}],
];

console.log('sweep across 5 stored days, walk-forward, 5000 KD\n');
console.log('variant'.padEnd(32), '15Jul'.padStart(8),'16Jul'.padStart(8),'19Jul'.padStart(8),'20Jul'.padStart(8),'21Jul'.padStart(8),' | ','TOTAL'.padStart(8),'avgROI'.padStart(8),'green'.padStart(6),'trips'.padStart(6));
console.log('-'.repeat(120));
const out=[];
for (const [name,patch] of tests){
  const r = evaluate(name,patch); out.push(r);
  console.log(name.padEnd(32), ...r.res.map(x=>String(x.net).padStart(8)), ' | ',
    String(r.tot).padStart(8), (r.avgRoi+'%').padStart(8), String(r.green+'/5').padStart(6), String(r.trips).padStart(6));
}
console.log('\nbest by total:', out.slice().sort((a,b)=>b.tot-a.tot)[0].name);
