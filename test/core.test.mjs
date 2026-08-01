import {LTEncoder, LTDecoder, b45encode, b45decode, buildFrame, parseFrame,
        packManifest, unpackManifest, crc32, symbolNeighbours, robustSolitonCdf} from '../src/core.mjs';

function rndBytes(n){const a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=Math.random()*256|0;return a;}
let fail=0;
const check=(c,m)=>{if(!c){console.log('  FALLITO:',m);fail++;}};

// --- Base45
for(let n=0;n<200;n++){
  const d=rndBytes(n);
  const r=b45decode(b45encode(d));
  check(r.length===n && d.every((v,i)=>v===r[i]), `base45 n=${n}`);
}
console.log('base45: roundtrip 0..199 ok');

// --- framing (con padding in coda, come fanno i decoder QR)
for(const n of [0,1,600,1200]){
  const p=rndBytes(n);
  const f=buildFrame(2,0xDEADBEEF,7,12345,p);
  const padded=new Uint8Array(f.length+24); padded.set(f);
  const r=parseFrame(padded);
  check(r && r.esi===12345 && r.blockIdx===7 && r.session===0xDEADBEEF
        && r.payload.length===n && p.every((v,i)=>v===r.payload[i]), `frame n=${n}`);
}
// CRC deve rifiutare la corruzione
{const f=buildFrame(2,1,0,0,rndBytes(100)); f[50]^=0xFF; check(parseFrame(f)===null,'CRC rileva corruzione');}
console.log('framing: ok (incluso padding in coda e rilevamento corruzione)');

// --- manifest
{
  const m={origLen:123456789, sha256:rndBytes(32), symbolSize:600,
           flags:1, sbRawSize:4194304, name:'test file.bin',
           compressedLens:[1000,2000,3000]};
  const u=unpackManifest(packManifest(m));
  check(u.origLen===m.origLen && u.symbolSize===600 && u.name===m.name
        && u.compressedLens.join()===m.compressedLens.join(), 'manifest roundtrip');
}
console.log('manifest: ok');

// --- fountain
function trial(bytes, symbolSize, loss){
  const data=rndBytes(bytes), seed=(Math.random()*2**31)|0;
  const enc=new LTEncoder(data,symbolSize,seed);
  const dec=new LTDecoder(enc.K,symbolSize,enc.dataLen,seed);
  let esi=0,n=0;
  while(!dec.complete){
    n++; if(n>200*enc.K+10000) throw new Error('nessuna convergenza');
    const s=enc.symbol(esi);
    if(Math.random()>=loss) dec.addSymbol(esi,s);
    esi++;
  }
  const out=dec.result();
  check(out.length===bytes && data.every((v,i)=>v===out[i]), `fountain ${bytes}B`);
  return {K:enc.K, ratio:dec.received/enc.K};
}
for(const [bytes,ss] of [[600,600],[1200,600],[64*1024,128],[512*1024,1024],[2*1024*1024,2048]]){
  const rs=[]; let K=0;
  for(let i=0;i<8;i++){const t=trial(bytes,ss,0); K=t.K; rs.push(t.ratio);}
  const avg=rs.reduce((a,b)=>a+b)/rs.length;
  console.log(`fountain: ${bytes}B ss=${ss} K=${K} overhead medio=${avg.toFixed(3)}x max=${Math.max(...rs).toFixed(3)}x`);
}
{const t=trial(512*1024,1024,0.4); console.log(`fountain: con 40% perdita, K=${t.K}, overhead=${t.ratio.toFixed(3)}x`);}

console.log(fail? `\n${fail} TEST FALLITI` : '\nTUTTI I TEST OK');
process.exit(fail?1:0);
