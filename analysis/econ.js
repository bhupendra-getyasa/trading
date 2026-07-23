const P='/home/claude/trading/packages/shared/src';
const { detectSwings } = require(P+'/live-engine/swings');
const { buildBook } = require(P+'/live-engine/liquidity');
const LIVE = require(P+'/live-engine/config');
const days=['/tmp/s2.json','/tmp/s3.json','/tmp/s4.json','/tmp/s5.json','/tmp/s6.json'];
const rec=[];
for (const f of days){
  const s=require(f);
  for (const [sym,d] of Object.entries(s.symbols)){
    if (!d.cls || !LIVE.HISTORY.qualifyLanes.includes(d.cls.lane)) continue;
    const rows=d.rows.filter(r=>r.price>0); if(rows.length<80) continue;
    const px=rows.map(r=>r.price);
    for (let i=20;i<px.length-30;i++){
      const w=rows.slice(i-19,i+1);
      const sw=detectSwings(w.map(r=>({price:r.price,ts:r.ts})), LIVE.SWING);
      if (!sw.fib||!sw.pullbackHeldFib) continue;
      if (!(px[i]>=sw.fib.zoneLow && px[i]<=sw.fib.zoneHigh)) continue;
      const book=buildBook(w.map(r=>r.raw), LIVE.LIQUIDITY, w[w.length-1].ts);
      rec.push({ price:px[i], swing1:sw.swing1Fils||0, depth:book.medBidQty, path:px.slice(i+1,i+31) });
    }
  }
}
const TICKET=2500;   // KD per position
function sim(label, {stop, target, hold, band}){
  let net=0, n=0, w=0, comm=0;
  for(const r of rec){
    if(band && (r.swing1<band[0]||r.swing1>band[1])) continue;
    const shares=Math.floor(Math.min(TICKET*1000/r.price, (r.depth||1e9)*0.5)/100)*100;
    if(shares<100) continue;
    let exit=null;
    for(let k=0;k<Math.min(hold,r.path.length);k++){
      const d=r.path[k]-r.price;
      if(stop!=null&&d<=-stop){exit=-stop;break;}
      if(target!=null&&d>=target){exit=target;break;}
    }
    if(exit==null) exit=(r.path[Math.min(hold,r.path.length)-1]??r.price)-r.price;
    const c=2*Math.max(0.5,0.0015*r.price*shares/1000);
    const pnl=(exit*shares)/1000-c;
    net+=pnl; comm+=c; n++; if(pnl>0)w++;
  }
  if(!n) return;
  console.log(label.padEnd(34), String(n).padStart(5), String(Math.round(net)).padStart(8)+' KD',
    String(Math.round(net/n*100)/100).padStart(8)+'/trade', String(Math.round(100*w/n)+'%').padStart(6),
    ' comm '+String(Math.round(comm)).padStart(6));
}
console.log(`zone signals: ${rec.length}   ticket ${TICKET} KD   (aggregate over ALL signals, not slot-limited)\n`);
console.log('strategy'.padEnd(34),'n'.padStart(5),'net'.padStart(11),'per trade'.padStart(9),'win%'.padStart(6),'commission'.padStart(12));
console.log('-'.repeat(92));
sim('hold 30m, NO stop, no target',      {stop:null,target:null,hold:30});
sim('hold 30m, stop 3f',                 {stop:3,target:null,hold:30});
sim('hold 30m, stop 5f',                 {stop:5,target:null,hold:30});
sim('hold 30m, stop 8f',                 {stop:8,target:null,hold:30});
sim('stop 3f / target 5f',               {stop:3,target:5,hold:30});
sim('stop 5f / target 8f',               {stop:5,target:8,hold:30});
sim('stop 8f / target 12f',              {stop:8,target:12,hold:30});
console.log('-- swing 5-12f band only --');
sim('hold 30m, NO stop [5-12f]',         {stop:null,target:null,hold:30,band:[5,12]});
sim('stop 5f / target 8f [5-12f]',       {stop:5,target:8,hold:30,band:[5,12]});
sim('stop 8f / target 12f [5-12f]',      {stop:8,target:12,hold:30,band:[5,12]});
