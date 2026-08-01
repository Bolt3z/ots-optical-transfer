import {encodeQR, alnumCapacity} from '../src/qrencode.mjs';
import fs from 'fs';
const ALN="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
let seed=12345;
const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
const txt=n=>{let s='';for(let i=0;i<n;i++)s+=ALN[Math.floor(rnd()*45)];return s;};
const out=[];
for(let v=1;v<=40;v++){
  for(const frac of [0.3,1.0]){
    const n=Math.max(1,Math.floor(alnumCapacity(v)*frac));
    const t=txt(n);
    const {modules,size}=encodeQR(t,v);
    out.push({v,n,t,m:modules.map(r=>r.map(b=>b?1:0))});
  }
}
fs.writeFileSync('/tmp/sweep.json',JSON.stringify(out));
console.log('generati',out.length,'codici');
