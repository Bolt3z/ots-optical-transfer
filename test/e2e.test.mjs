import fs from 'fs'; import vm from 'vm';
import {createRequire} from 'module';
const require=createRequire(import.meta.url);

// carica il bundle OTS estratto dal file HTML COSTRUITO (non dai sorgenti)
const html=fs.readFileSync(new URL('../dist/ots.html',import.meta.url),'utf8');
const s2=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1])[1];
const OTS=new Function('window','document', s2+'\nreturn window.OTS;')({addEventListener(){}},{getElementById:()=>null});
if(!OTS) throw new Error('OTS non esportato');
const jsQR=require('../vendor/jsQR.min.js');

const SB_RAW=1<<20;                 // 1 MiB per il test
const gzip=async u=>new Uint8Array(await new Response(new Blob([u]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const gunzip=async u=>new Uint8Array(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const sha=async u=>new Uint8Array(await crypto.subtle.digest('SHA-256',u));
const hex=u=>Array.from(u).map(b=>b.toString(16).padStart(2,'0')).join('');

function raster(modules,size,scale,border){
  const w=(size+2*border)*scale, d=new Uint8ClampedArray(w*w*4).fill(255);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){ if(!modules[y][x])continue;
    for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
      const i=((((border+y)*scale+dy)*w)+((border+x)*scale+dx))*4; d[i]=d[i+1]=d[i+2]=0;}}
  return {d,w};
}

async function run(fileBytes, name, symbolSize, loss){
  const file=new Uint8Array(fileBytes.length);
  for(let i=0;i<file.length;i++) file[i]=fileBytes[i];
  const nSB=Math.max(1,Math.ceil(file.length/SB_RAW));
  const hashes=[],payloads=[],lens=[];
  for(let i=0;i<nSB;i++){
    const raw=file.subarray(i*SB_RAW, Math.min((i+1)*SB_RAW,file.length));
    hashes.push(await sha(raw));
    const z=await gzip(raw); payloads.push(z); lens.push(z.length);
  }
  const cat=new Uint8Array(hashes.length*32); hashes.forEach((h,i)=>cat.set(h,i*32));
  const root=await sha(cat);
  const session=(Math.random()*2**32)>>>0;
  const manifest=OTS.packManifest({origLen:file.length, sha256:root, symbolSize,
    flags:1, sbRawSize:SB_RAW, name, compressedLens:lens});
  const encs=payloads.map(p=>new OTS.LTEncoder(p,symbolSize,session));
  const totalK=encs.reduce((a,e)=>a+e.K,0);

  // ---- ricevitore
  const st={manifest:null,dec:new Map(),seen:new Map(),done:new Map(),hh:new Map(),bad:0,ok:0};
  async function feed(raw){
    const f=OTS.parseFrame(raw); if(!f){st.bad++;return false;}
    st.ok++;
    if(f.type===OTS.T_MANIFEST){ if(!st.manifest) st.manifest=OTS.unpackManifest(f.payload); return false;}
    if(!st.manifest) return false;
    const m=st.manifest, bi=f.blockIdx;
    if(st.done.has(bi)) return false;
    let d=st.dec.get(bi);
    if(!d){ d=new OTS.LTDecoder(OTS.kForBlock(m.compressedLens[bi],m.symbolSize),m.symbolSize,m.compressedLens[bi],session);
      st.dec.set(bi,d); st.seen.set(bi,new Set()); }
    const seen=st.seen.get(bi); if(seen.has(f.esi)) return false; seen.add(f.esi);
    if(d.addSymbol(f.esi,f.payload)){
      const out=await gunzip(d.result());
      st.done.set(bi,out); st.hh.set(bi,await sha(out)); st.dec.delete(bi);
    }
    return st.done.size===m.compressedLens.length;
  }

  let frameNo=0, bi=0, esi=0, emitted=0, shown=0, dropped=0, ver=null;
  const t0=Date.now();
  while(true){
    let frame;
    if(frameNo%16===0) frame=OTS.buildFrame(OTS.T_MANIFEST,session,0,0,manifest);
    else{ const e=encs[bi];
      frame=OTS.buildFrame(OTS.T_DATA,session,bi,esi,e.symbol(esi)); esi++; emitted++;
      if(emitted>=Math.ceil(e.K*1.4)){emitted=0;bi=(bi+1)%encs.length;} }
    frameNo++;
    if(frameNo>totalK*8+2000) throw new Error('nessuna convergenza');
    if(Math.random()<loss){dropped++;continue;}
    const text=OTS.b45encode(frame);
    const v=OTS.minVersionFor(text.length); ver=v;
    const {modules,size}=OTS.encodeQR(text,v);
    const {d,w}=raster(modules,size,4,4);
    const r=jsQR(d,w,w,{inversionAttempts:'dontInvert'});
    if(!r){st.bad++;continue;}
    shown++;
    let raw; try{raw=OTS.b45decode(r.data);}catch{st.bad++;continue;}
    if(await feed(raw)) break;
  }
  // ricostruzione + verifica
  const parts=[]; for(let i=0;i<nSB;i++) parts.push(st.done.get(i));
  const total=parts.reduce((a,p)=>a+p.length,0);
  const out=new Uint8Array(total); let o=0; for(const p of parts){out.set(p,o);o+=p.length;}
  const cat2=new Uint8Array(nSB*32); for(let i=0;i<nSB;i++) cat2.set(st.hh.get(i),i*32);
  const okHash=hex(await sha(cat2))===hex(root);
  let identical = out.length===file.length; if(identical) for(let i=0;i<file.length;i++) if(out[i]!==file[i]){identical=false;break;}
  console.log(`  ${name}: ${file.length}B → ${nSB} source block, K totale=${totalK}, QRv${ver}`);
  console.log(`     frame emessi=${frameNo} persi=${dropped} letti=${st.ok} scartati=${st.bad} overhead=${(frameNo/totalK).toFixed(2)}x  [${((Date.now()-t0)/1000).toFixed(1)}s]`);
  console.log(`     digest verificato=${okHash}  byte identici=${identical}  ${okHash&&identical?'OK':'FALLITO'}`);
  if(!(okHash&&identical)) process.exitCode=1;
}

const randBytes=n=>{const a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=Math.random()*256|0;return a;};
const textBytes=n=>new TextEncoder().encode('Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(Math.ceil(n/57))).subarray(0,n);

console.log('E2E sul bundle costruito (dist/ots.html):');
await run(textBytes(120*1024),'testo comprimibile 120 kB',600,0);
await run(randBytes(200*1024),'binario incomprimibile 200 kB',600,0);
await run(randBytes(200*1024),'binario, 35% frame persi',600,0.35);
await run(randBytes(2.5*1024*1024),'binario 2.5 MB, 3 source block',1200,0.1);
