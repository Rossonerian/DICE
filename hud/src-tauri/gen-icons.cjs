const zlib=require("zlib"),fs=require("fs"),path=require("path");
const crc=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}return b=>{let c=~0;for(const x of b)c=t[(c^x)&255]^(c>>>8);return ~c>>>0}})();
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])}
function png(s){const raw=Buffer.alloc((s*4+1)*s);for(let y=0;y<s;y++){raw[y*(s*4+1)]=0;for(let x=0;x<s;x++){const o=y*(s*4+1)+1+x*4;const m=s*0.12,r=s*0.18;const inside=x>=m&&x<s-m&&y>=m&&y<s-m;const dx=Math.min(x-m,s-m-1-x),dy=Math.min(y-m,s-m-1-y);const corner=dx<r&&dy<r&&Math.hypot(r-dx,r-dy)>r;
const pip=[[.3,.3],[.7,.3],[.5,.5],[.3,.7],[.7,.7]].some(([px,py])=>Math.hypot(x-px*s,y-py*s)<s*0.07);
let c=[0,0,0,0];if(inside&&!corner)c=pip?[15,23,42,255]:[56,189,248,255];raw.set(c,o)}}
const ih=Buffer.alloc(13);ih.writeUInt32BE(s,0);ih.writeUInt32BE(s,4);ih[8]=8;ih[9]=6;
return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ih),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))])}
const out=path.join(__dirname,"icons");fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,"32x32.png"),png(32));
fs.writeFileSync(path.join(out,"128x128.png"),png(128));
fs.writeFileSync(path.join(out,"128x128@2x.png"),png(256));
const p=png(256),h=Buffer.alloc(22);h.writeUInt16LE(1,2);h.writeUInt16LE(1,4);h[6]=0;h[7]=0;h.writeUInt16LE(1,10);h.writeUInt16LE(32,12);h.writeUInt32LE(p.length,14);h.writeUInt32LE(22,18);
fs.writeFileSync(path.join(out,"icon.ico"),Buffer.concat([h,p]));
