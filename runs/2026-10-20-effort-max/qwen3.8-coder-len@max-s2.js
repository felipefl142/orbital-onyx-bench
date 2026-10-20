const F=(x)=>Number.isFinite(x);
const C=(x,a,b)=>{x=+x;return F(x)?(x<a?a:x>b?b:x):a};
const W=(a)=>{a=+a;return F(a)?((a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI:0};
const S=(m,a)=>{const e=W(a-(m.angle||0));return[e,C(e*3-(m.angVel||0)*.3,-1,1)]};
const H=(x,y)=>{const l=Math.hypot(x,y);return F(l)?l:0};
const N=(x,y)=>{const l=H(x,y);return l<1e-9?[1,0]:[x/l,y/l]};

export default function control(o,m){try{
const L=o&&o.lib,me=(o&&o.self)||{pos:{x:0,y:0},vel:{x:0,y:0}},p=me.pos||{x:0,y:0},v=me.vel||{x:0,y:0};
let R=+((o&&o.rules&&o.rules.ship&&o.rules.ship.radius)||12),AR=+((o&&o.arena&&o.arena.radius)||2000),BS=+((o&&o.rules&&o.rules.weapon&&o.rules.weapon.bulletSpeed)||600);
if(!F(R)||R<=0)R=12;if(!F(AR)||AR<=0)AR=2000;if(!F(BS)||BS<=0)BS=600;
const fuel=Math.max(0,F(+me.fuel)?+me.fuel:0);
const B=(d)=>{const a=Math.atan2(d[1],d[0]),s=S(me,a);return{thrust:Math.abs(s[0])<.7?1:0,turn:s[1],fire:false}};

let dg=null;
if(fuel>0){let pr;try{pr=L.predict({pos:{x:p.x,y:p.y},vel:{x:v.x,y:v.y}},4,{step:.05,radius:R+20})}catch(e){}
if(pr){if(pr.hit&&F(pr.hit.t)&&pr.hit.t<3){const pl=(o&&o.planets||[])[pr.hit.planet]||{};const plp=pl.pos||{x:0,y:0},plv=pl.vel||{x:0,y:0};const n=N(p.x-plp.x,p.y-plp.y);const t=[-n[1],n[0]];const rv=[v.x-plv.x,v.y-plv.y];const sg=rv[0]*t[0]+rv[1]*t[1]>=0?1:-1;let d=N(n[0]+t[0]*sg*.8,n[1]+t[1]*sg*.8);const r=H(p.x,p.y);if(r>AR-300){const c=N(-p.x,-p.y);d=N(d[0]+c[0]*.7,d[1]+c[1]*.7)}dg=d}else{const r=H(p.x,p.y)||1;if(pr.leavesArena||(r>AR*.88&&(v.x*p.x+v.y*p.y)/r>-20))dg=N(-p.x,-p.y)}}}
if(dg)return B(dg);

let t=null,td=1e9;for(const e of (o&&o.enemies)||[])if(e&&e.alive&&e.pos){const d=H(e.pos.x-p.x,e.pos.y-p.y);if(d<td){td=d;t=e}}
if(!t){const rr=H(p.x,p.y)||1;if(fuel>0&&rr>AR*.8)return B(N(-p.x,-p.y));return{thrust:0,turn:0,fire:false}}
const endSafe=(o&&o.t>110)&&+(me.hp||0)>+(t.hp||0)+10;
const heatLimit=+(t.hp||0)<20?90:60;

if(fuel>0){let th=null;for(const b of (o&&o.bullets)||[])if(b&&b.pos&&b.vel&&b.owner!==me.id){const dx=b.pos.x-p.x,dy=b.pos.y-p.y,ux=b.vel.x-v.x,uy=b.vel.y-v.y,uu=ux*ux+uy*uy;if(uu<1)continue;const tt=-(dx*ux+dy*uy)/uu;if(!F(tt)||tt<=0||tt>1.2||tt>b.ttl)continue;const mx=dx+ux*tt,my=dy+uy*tt;if(H(mx,my)<R*3&&(!th||tt<th.tt))th={tt,mx,my,ux,uy}}
if(th){const n=N(-th.uy,th.ux),sg=n[0]*th.mx+n[1]*th.my>0?-1:1;let d=[n[0]*sg,n[1]*sg];const r=H(p.x,p.y);if(r>AR-300){const c=N(-p.x,-p.y);d=N(d[0]+c[0]*.7,d[1]+c[1]*.7)}return B(d)}}

let aim=Math.atan2(t.pos.y-p.y,t.pos.x-p.x),fire=false;
try{
if((me.ammo||0)>0&&!me.overheated&&(me.heat||0)<heatLimit&&td<1800){let ld=null;try{ld=L.leadTarget({pos:{x:p.x,y:p.y},vel:{x:v.x,y:v.y}},t,BS)}catch(e){}
let a=ld&&F(ld.angle)?ld.angle:aim;if(!F(a))a=0;let h=ld&&F(ld.time)?Math.min(3,ld.time+.4):Math.min(3,td/BS+.4);if(!F(h)||h<.2)h=.2;if(h>3)h=3;
const tv=t.vel||{x:0,y:0};
const ep=(L.predict({pos:{x:t.pos.x,y:t.pos.y},vel:{x:tv.x,y:tv.y}},h,{step:1/60}).points)||[];
if(ep.length){const ev=(ang)=>{const dx=Math.cos(ang),dy=Math.sin(ang);const bp=L.predict({pos:{x:p.x+dx*(R+3),y:p.y+dy*(R+3)},vel:{x:v.x+dx*BS,y:v.y+dy*BS}},h,{step:1/60,radius:0});const bps=bp.points||[];let best=1e9,at=-1;const n=Math.min(bps.length,ep.length);for(let i=0;i<n;i++){const ddx=bps[i].pos.x-ep[i].pos.x,ddy=bps[i].pos.y-ep[i].pos.y,dd=H(ddx,ddy);if(dd<best){best=dd;at=i}}if(at<0)return{a:ang,miss:1e9,blocked:true,corr:0,t:0};const offx=ep[at].pos.x-bps[at].pos.x,offy=ep[at].pos.y-bps[at].pos.y,range=Math.max(1,H(ep[at].pos.x-p.x,ep[at].pos.y-p.y));return{a:ang,miss:best,blocked:!!bp.hit&&bp.hit.t<=bps[at].t,corr:(dx*offy-dy*offx)/range,t:bps[at].t}};
let e=ev(a);for(let k=0;k<2&&e.miss>R*.5;k++){const c=F(e.corr)?C(e.corr,-.5,.5):0;const ne=ev(e.a+c);if(ne.miss>=e.miss)break;e=ne}
aim=e.a;fire=!e.blocked&&e.miss<R*1.2&&Math.abs(W(aim-(me.angle||0)))<Math.atan2(R*.8,td)+.02}}
}catch(e){}

if(td<250&&fuel>15){aim=Math.atan2(p.y-t.pos.y,p.x-t.pos.x);fire=false}
const rr=H(p.x,p.y)||1;
if(rr>AR*.85){aim=Math.atan2(-p.y,-p.x);fire=false}

const s=S(me,aim);let th=0;
if(fuel>5){
if(rr>AR*.8){const d=N(-p.x,-p.y);if(Math.abs(W(Math.atan2(d[1],d[0])-(me.angle||0)))<.8)th=.5}
else if(td>800&&fuel>25&&!endSafe){const d=N(t.pos.x-p.x,t.pos.y-p.y);if(Math.abs(W(Math.atan2(d[1],d[0])-(me.angle||0)))<.8)th=.35}
else if(td<250&&fuel>15){const d=N(p.x-t.pos.x,p.y-t.pos.y);if(Math.abs(W(Math.atan2(d[1],d[0])-(me.angle||0)))<.8)th=.3}
}
return{thrust:C(th,0,1),turn:s[1],fire}
}catch(e){return{thrust:0,turn:0,fire:false}}}
