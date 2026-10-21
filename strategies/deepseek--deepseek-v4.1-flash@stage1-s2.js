function cl(x,a,b){return x<a?a:x>b?b:x;}

export default function control(obs, mem) {
  const L=obs.lib, me=obs.self, R=obs.rules.ship.radius, W=obs.rules.weapon;
  const wrap=L.wrapAngle, P=me.pos, V=me.vel;

  // 1. escape imminent planet impact / arena exit
  const fp=L.predict(me,3,{step:0.05,radius:R+45});
  if(fp.hit||fp.leavesArena){
    let dx,dy;
    if(fp.hit){
      const p=obs.planets[fp.hit.planet];
      let nx=P.x-p.pos.x, ny=P.y-p.pos.y;
      const nl=Math.max(1,Math.hypot(nx,ny)); nx/=nl; ny/=nl;
      const tx=-ny, ty=nx;
      const sg=(V.x-p.vel.x)*tx+(V.y-p.vel.y)*ty>=0?1:-1;
      dx=tx*sg+nx; dy=ty*sg+ny;
    } else {
      const rl=Math.max(1,Math.hypot(P.x,P.y)); dx=-P.x/rl; dy=-P.y/rl;
    }
    const a=Math.atan2(dy,dx), e=wrap(a-me.angle);
    return {thrust:(Math.abs(e)<0.9&&me.fuel>0.5)?1:0, turn:cl(e*5-me.angVel*0.3,-1,1), fire:false};
  }

  // 2. incoming bullet threat
  let th=null;
  for(const b of obs.bullets){
    if(b.owner===me.id) continue;
    const dx=b.pos.x-P.x, dy=b.pos.y-P.y;
    const ux=b.vel.x-V.x, uy=b.vel.y-V.y;
    const uu=ux*ux+uy*uy;
    if(uu<1) continue;
    const tt=-(dx*ux+dy*uy)/uu;
    if(tt<=0||tt>0.8||tt>b.ttl) continue;
    const mx=dx+ux*tt, my=dy+uy*tt;
    if(mx*mx+my*my<R*R*6.76&&(!th||tt<th.t)) th={t:tt,mx,my,ux,uy};
  }

  // 3. pick nearest living target
  let tgt=null, td=1e9;
  for(const en of obs.enemies){
    if(!en.alive) continue;
    const d=Math.hypot(en.pos.x-P.x,en.pos.y-P.y);
    if(d<td){td=d;tgt=en;}
  }

  // 4. gravity-corrected aim
  let aimA=tgt?L.angleTo(P,tgt.pos):me.angle, miss=1e9, blocked=true;
  if(tgt){
    const lead=L.leadTarget(me,tgt,W.bulletSpeed);
    if(lead&&lead.time<2.9){
      aimA=lead.angle; blocked=false;
      const hz=Math.min(3,lead.time+0.3);
      const ep=L.predict(tgt,hz,{step:1/30}).points;
      const ev=(ang)=>{
        const c=Math.cos(ang), s=Math.sin(ang);
        const bp=L.predict({pos:{x:P.x+c*(R+2),y:P.y+s*(R+2)},
          vel:{x:V.x+c*W.bulletSpeed,y:V.y+s*W.bulletSpeed}},hz,{step:1/30,radius:0});
        const n=Math.min(bp.points.length,ep.length);
        let bs=1e18, at=-1;
        for(let i=0;i<n;i++){
          const dx=bp.points[i].pos.x-ep[i].pos.x, dy=bp.points[i].pos.y-ep[i].pos.y;
          const dd=dx*dx+dy*dy;
          if(dd<bs){bs=dd;at=i;}
        }
        if(at<0) return {ang,miss:1e9,corr:0,blk:true};
        const ex=ep[at].pos.x-bp.points[at].pos.x, ey=ep[at].pos.y-bp.points[at].pos.y;
        const rx=ep[at].pos.x-P.x, ry=ep[at].pos.y-P.y;
        const rg=Math.max(1,Math.hypot(rx,ry));
        return {ang,miss:Math.sqrt(bs),corr:(c*ey-s*ex)/rg,blk:!!(bp.hit&&bp.hit.t<=bp.points[at].t)};
      };
      let cur=ev(aimA);
      for(let k=0;k<2&&cur.miss>R*0.5;k++){
        const nx=ev(cur.ang+cl(cur.corr,-0.3,0.3));
        if(nx.miss>=cur.miss) break;
        cur=nx;
      }
      aimA=cur.ang; miss=cur.miss; blocked=cur.blk;
    }
  }

  // 5. heat management + fire decision
  if(me.heat>72) mem.hold=true; else if(me.heat<42) mem.hold=false;
  const aimErr=Math.abs(wrap(aimA-me.angle));
  const tol=Math.atan2(R*0.75,Math.max(td,1))+0.012;
  const fire=!!tgt&&!blocked&&miss<R*1.35&&aimErr<tol&&me.cooldown<=0&&!me.overheated&&!mem.hold&&me.ammo>0;

  // 6. movement desire: keep range, avoid planets and edge
  let wx=0,wy=0;
  if(tgt){
    const inv=1/Math.max(1,td);
    const want=cl((td-800)/400,-1,1)*130;
    wx+=(tgt.pos.x-P.x)*inv*want; wy+=(tgt.pos.y-P.y)*inv*want;
  }
  for(const p of obs.planets){
    const dx=P.x-p.pos.x, dy=P.y-p.pos.y;
    const dd=Math.max(1,Math.hypot(dx,dy));
    const safe=p.radius*3+150;
    if(dd<safe){const w=(1-dd/safe)*220; wx+=dx/dd*w; wy+=dy/dd*w;}
  }
  const rr=Math.max(1,Math.hypot(P.x,P.y));
  const band=obs.arena.radius*0.78;
  if(rr>band){const w=cl((rr-band)/(obs.arena.radius-band),0,1)*260; wx-=P.x/rr*w; wy-=P.y/rr*w;}
  const dvx=wx-V.x, dvy=wy-V.y, dvm=Math.hypot(dvx,dvy);
  const ang=dvm>1?Math.atan2(dvy,dvx):me.angle;

  let turn, thrust;
  if(th&&me.fuel>0.5){
    const sg=(-th.uy*th.mx+th.ux*th.my)>0?-1:1;
    const a=Math.atan2(th.ux*sg,-th.uy*sg);
    const e=wrap(a-me.angle);
    turn=cl(e*5-me.angVel*0.3,-1,1);
    thrust=Math.abs(e)<1.0?1:0;
  } else if(dvm>150){
    const e=wrap(ang-me.angle);
    turn=cl(e*4-me.angVel*0.3,-1,1);
    thrust=Math.abs(e)<0.9?cl(dvm/90,0,1):0;
  } else {
    turn=cl(wrap(aimA-me.angle)*4-me.angVel*0.3,-1,1);
    thrust=(dvm>20&&Math.abs(wrap(ang-aimA))<1.0)?cl(dvm/90,0,1):0;
  }
  if(me.fuel<=0) thrust=0;
  return {thrust,turn,fire};
}
