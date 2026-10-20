const clamp=(x,a,b)=>x<a?a:x>b?b:x;
const nrm=v=>{const l=Math.sqrt(v.x*v.x+v.y*v.y);return l>1e-6?{x:v.x/l,y:v.y/l}:{x:0,y:0};};
const steer=(L,me,a)=>{const e=L.wrapAngle(a-me.angle);return{e,turn:clamp(e*3-me.angVel*0.5,-1,1)};};
const alive=o=>o.enemies.filter(e=>e.alive);
const nearest=(L,o,pos,max)=>{let b=null,bd=max===undefined?Infinity:max;for(const p of o.planets){const d=L.len(L.sub(p.pos,pos));if(d<bd){bd=d;b=p;}}return b;};

function danger(o){
  const L=o.lib,me=o.self,R=o.rules.ship.radius,p=L.predict(me,5,{step:1/20,radius:R+20});
  if(p.hit){
    const pl=o.planets[p.hit.planet],rel=L.sub(me.pos,pl.pos),rad=nrm(rel),tg={x:-rad.y,y:rad.x};
    const sgn=L.dot(L.sub(me.vel,pl.vel),tg)>=0?1:-1;
    return{dir:L.add(L.scale(tg,sgn),L.scale(rad,0.9)),t:p.hit.t};
  }
  const r=L.len(me.pos),out=L.dot(me.vel,nrm(me.pos));
  if(p.leavesArena||(r>o.arena.radius*0.85&&out>-10))return{dir:nrm(L.scale(me.pos,-1)),t:2};
  return null;
}

function incoming(o){
  const L=o.lib,me=o.self,R=o.rules.ship.radius;let b=null;
  for(const bl of o.bullets){
    if(bl.owner===me.id)continue;
    const d=L.sub(bl.pos,me.pos),u=L.sub(bl.vel,me.vel),uu=L.dot(u,u);
    if(uu<1)continue;
    const t=-L.dot(d,u)/uu;
    if(t<=0||t>1.8||t>bl.ttl)continue;
    const m=L.add(d,L.scale(u,t));
    if(L.len(m)<R*3&&(!b||t<b.t))b={t,m,u};
  }
  if(!b)return null;
  const s=nrm({x:-b.u.y,y:b.u.x});
  return{dir:L.scale(s,L.dot(s,b.m)>0?-1:1),t:b.t};
}

function aim(o,e,maxT){
  const L=o.lib,me=o.self,R=o.rules.ship.radius,sp=o.rules.weapon.bulletSpeed;
  const lead=L.leadTarget(me,e,sp);
  if(!lead||lead.time>maxT)return null;
  const hor=Math.min(3,lead.time+0.35),ep=L.predict(e,hor,{step:1/30}).points;
  if(!ep.length)return null;
  const ev=ang=>{
    const dir={x:Math.cos(ang),y:Math.sin(ang)};
    const bp=L.predict({pos:L.add(me.pos,L.scale(dir,R+3)),vel:L.add(me.vel,L.scale(dir,sp))},hor,{step:1/30,radius:0});
    let best=Infinity,at=-1;
    for(let i=0;i<bp.points.length&&i<ep.length;i++){
      const dd=L.len(L.sub(bp.points[i].pos,ep[i].pos));
      if(dd<best){best=dd;at=i;}
    }
    if(at<0)return{angle:ang,miss:Infinity,blocked:true,corr:0,t:lead.time};
    const off=L.sub(ep[at].pos,bp.points[at].pos),range=Math.max(1,L.len(L.sub(ep[at].pos,me.pos)));
    return{angle:ang,miss:best,blocked:!!bp.hit&&bp.hit.t<=bp.points[at].t,corr:L.cross(dir,off)/range,t:bp.points[at].t};
  };
  let a=ev(lead.angle);
  for(let k=0;k<2&&a.miss>R*0.5;k++){
    const n=ev(a.angle+a.corr);
    if(n.miss>=a.miss)break;
    a=n;
  }
  return a;
}

function orbit(o,h,want,gain){
  const L=o.lib,me=o.self,rel=L.sub(me.pos,h.pos),r=Math.max(L.len(rel),1),rad=nrm(rel),tg={x:-rad.y,y:rad.x};
  const sgn=L.dot(L.sub(me.vel,h.vel),tg)>=0?1:-1,vc=Math.sqrt(o.G*h.mass/r);
  return L.sub(L.add(L.add(h.vel,L.scale(tg,vc*sgn)),L.scale(rad,(want-r)*gain)),me.vel);
}

function burn(L,me,dv,tol,scale){
  const m=L.len(dv);
  if(m<1)return{thrust:0,turn:0,fire:false};
  const s=steer(L,me,Math.atan2(dv.y,dv.x));
  return{thrust:me.fuel>0&&Math.abs(s.e)<tol?clamp(m/scale,0,1):0,turn:s.turn,fire:false};
}

function avoid(o,me,dv){
  const L=o.lib;
  for(const p of o.planets){
    const rel=L.sub(me.pos,p.pos),d=L.len(rel),safe=p.radius+90;
    if(d<safe&&d>1)dv=L.add(dv,L.scale(nrm(rel),(safe-d)*1.5));
  }
  const r=L.len(me.pos),edge=o.arena.radius-160;
  if(r>edge)dv=L.add(dv,L.scale(nrm(L.scale(me.pos,-1)),(r-edge)*0.8));
  return dv;
}

export default function control(o,mem){
  const L=o.lib,me=o.self,R=o.rules.ship.radius;
  const d=danger(o);
  if(d&&d.t<3.5&&me.fuel>0)return burn(L,me,L.scale(d.dir,130),0.8,40);
  const dg=incoming(o);
  if(dg&&dg.t<1.0&&me.fuel>0)return burn(L,me,L.scale(dg.dir,160),0.8,40);

  const foes=alive(o);
  if(!foes.length){
    const h=nearest(L,o,me.pos,1500);
    if(h){
      const dv=avoid(o,me,orbit(o,h,Math.max(h.radius*2.5,160),1.2));
      return burn(L,me,dv,0.9,45);
    }
    return{thrust:0,turn:0,fire:false};
  }

  let best=null;
  for(const e of foes){
    const dist=L.len(L.sub(e.pos,me.pos)),score=dist-e.hp*2;
    if(!best||score<best.score)best={e,dist};
  }

  const aimEv=aim(o,best.e,3.0);
  const ang=aimEv?aimEv.angle:L.angleTo(me.pos,best.e.pos);
  const s=steer(L,me,ang);

  let dv={x:0,y:0};
  const h=nearest(L,o,me.pos,1200);
  if(h)dv=L.add(dv,orbit(o,h,Math.max(h.radius*2.5,160),0.3));
  if(best.dist>700)dv=L.add(dv,L.scale(nrm(L.sub(best.e.pos,me.pos)),90));
  else if(best.dist<350)dv=L.add(dv,L.scale(nrm(L.sub(me.pos,best.e.pos)),50));
  if(dg)dv=L.add(dv,L.scale(dg.dir,80));
  dv=avoid(o,me,dv);
  if(me.fuel<20)dv=L.scale(dv,0.5);

  const aligned=Math.abs(s.e)<Math.atan2(R*0.8,best.dist)+0.02;
  const fire=!!aimEv&&!aimEv.blocked&&aimEv.miss<R*1.1&&aligned&&!me.overheated&&me.heat<80&&me.ammo>0&&me.cooldown<=0;

  if(best.dist<250||!aimEv||best.dist>900){
    const a=burn(L,me,dv,0.9,45);
    a.fire=fire&&best.dist>=250;
    return a;
  }

  const dvAng=Math.atan2(dv.y,dv.x);
  const canThrust=me.fuel>0&&Math.abs(L.wrapAngle(dvAng-ang))<0.7;
  return{thrust:canThrust?clamp(L.len(dv)/45,0,1):0,turn:s.turn,fire};
}
