// ORBITAL ONYX pilot: receding-horizon manoeuvre search under the real gravity field.
// Each decision forecasts about 23 manoeuvres for 2.5 s through moving planets, enemy ships and enemy bullets,
// scores them (planet / arena / bullet / ram hazards, engagement band, aim, fuel) and flies the cheapest first step.
// The gun fires only on a gravity-corrected intercept that the nose is already on.

const TAU = Math.PI * 2;
const NS = 50;        // horizon steps (50 x 0.05 s = 2.5 s)
const MAX_BUL = 8;    // enemy bullets forecast per decision
const MAX_EN = 3;     // enemy ships forecast per decision
const DEATH = 250;    // cost of a planet collision (HP-equivalent)
const DLO = 250;      // engagement band around the target: [DLO, DHI]
const DHI = 450;
const W_BAND = 0.02;  // per unit outside the band, per second
const W_AIM = 2.0;    // per second while the nose is off the firing solution
const W_FUEL = 0.3;   // per thrust-second (rises as the tank empties)

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

function wrap(a) {
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

// Turn command in [-1, 1] (target angular velocity = 3 * turn) that rotates the nose by err (rad).
function turnFor(err) {
  const a = Math.abs(err);
  const w = Math.min(3, Math.sqrt(16 * a), 6 * a);
  return clamp((err < 0 ? -w : w) / 3, -1, 1);
}

// Distance from the origin to segment a -> b.
function segDist(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const dd = dx * dx + dy * dy;
  const t = dd > 1e-12 ? clamp(-(ax * dx + ay * dy) / dd, 0, 1) : 0;
  const x = ax + dx * t, y = ay + dy * t;
  return Math.sqrt(x * x + y * y);
}

// Planet centres at every horizon step (planets ride circular tracks about the arena centre).
function buildWorld(obs) {
  const H = obs.dtDecision > 0 ? obs.dtDecision : 0.05;
  const planets = obs.planets || [];
  const np = planets.length;
  const PX = new Array((NS + 1) * np), PY = new Array((NS + 1) * np);
  const GM = new Array(np), EPS2 = new Array(np), PR = new Array(np);
  for (let j = 0; j < np; j++) {
    const p = planets[j];
    const r2 = p.pos.x * p.pos.x + p.pos.y * p.pos.y;
    const w = r2 > 1e-9 ? (p.pos.x * p.vel.y - p.pos.y * p.vel.x) / r2 : 0;
    const c = Math.cos(w * H), s = Math.sin(w * H);
    let x = p.pos.x, y = p.pos.y;
    PX[j] = x; PY[j] = y;
    for (let k = 1; k <= NS; k++) {
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
      PX[k * np + j] = x;
      PY[k * np + j] = y;
    }
    GM[j] = obs.G * p.mass;
    PR[j] = p.radius;
    EPS2[j] = 0.25 * p.radius * p.radius;
  }
  return { H, np, PX, PY, GM, EPS2, PR };
}

// Free-fall forecast under gravity (no thrust). Bullets (ttl given) expire and die on planet contact.
function forecast(W, x, y, vx, vy, ttl) {
  const { H, np, PX, PY, GM, EPS2, PR } = W;
  const isBullet = ttl !== undefined;
  const life = isBullet ? Math.min(NS, Math.floor(ttl / H + 1e-9)) : NS;
  const X = new Array(NS + 1), Y = new Array(NS + 1);
  X[0] = x; Y[0] = y;
  let dead = false;
  for (let k = 0; k < NS; k++) {
    if (!dead && k < life) {
      let ax = 0, ay = 0;
      const base = k * np;
      for (let j = 0; j < np; j++) {
        const dx = PX[base + j] - x, dy = PY[base + j] - y;
        const d2 = dx * dx + dy * dy;
        if (isBullet && d2 < PR[j] * PR[j]) { dead = true; break; }
        const s = d2 + EPS2[j] + 1e-9;
        const f = GM[j] / (s * Math.sqrt(s));
        ax += f * dx; ay += f * dy;
      }
      if (!dead) {
        vx += ax * H; vy += ay * H;
        x += vx * H; y += vy * H;
      }
    } else {
      dead = true;
    }
    X[k + 1] = dead ? 1e9 : x;
    Y[k + 1] = dead ? 1e9 : y;
  }
  return { X, Y };
}

// Gravity-corrected intercept of the target's free-fall path.
function solveAim(W, me, tgt, tp, sp, R) {
  const { H, np, PX, PY, GM, EPS2, PR } = W;
  const dx0 = tp.X[0] - me.pos.x, dy0 = tp.Y[0] - me.pos.y;
  const wx = tgt.vel.x - me.vel.x, wy = tgt.vel.y - me.vel.y;
  const dist0 = Math.sqrt(dx0 * dx0 + dy0 * dy0);
  // straight-line lead: |D + W t| = sp * t
  const qa = wx * wx + wy * wy - sp * sp;
  const qb = 2 * (dx0 * wx + dy0 * wy);
  const qc = dx0 * dx0 + dy0 * dy0;
  let t = -1;
  if (Math.abs(qa) > 1e-9) {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-qb - sq) / (2 * qa), t2 = (-qb + sq) / (2 * qa);
      const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
      t = lo > 0 ? lo : hi > 0 ? hi : -1;
    }
  } else if (qb < 0) {
    t = -qc / qb;
  }
  if (!(t > 0)) t = dist0 / sp;
  const ang0 = Math.atan2(dy0 + wy * t, dx0 + wx * t);

  const missFor = (ang) => {
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let bx = me.pos.x + ux * (R + 2), by = me.pos.y + uy * (R + 2);
    let bvx = me.vel.x + ux * sp, bvy = me.vel.y + uy * sp;
    let px = bx - tp.X[0], py = by - tp.Y[0];
    let best = 1e9, bestK = -1;
    for (let k = 0; k < NS; k++) {
      let ax = 0, ay = 0, blocked = false;
      const base = k * np;
      for (let j = 0; j < np; j++) {
        const dx = PX[base + j] - bx, dy = PY[base + j] - by;
        const d2 = dx * dx + dy * dy;
        if (d2 < PR[j] * PR[j]) { blocked = true; break; }
        const s = d2 + EPS2[j] + 1e-9;
        const f = GM[j] / (s * Math.sqrt(s));
        ax += f * dx; ay += f * dy;
      }
      if (blocked) break;
      bvx += ax * H; bvy += ay * H;
      bx += bvx * H; by += bvy * H;
      const rx = bx - tp.X[k + 1], ry = by - tp.Y[k + 1];
      const m = segDist(px, py, rx, ry);
      if (m < best) { best = m; bestK = k; }
      px = rx; py = ry;
    }
    return { ang, miss: best, k: bestK };
  };

  let sol = missFor(ang0);
  const coarse = [-0.08, -0.03, 0.03, 0.08];
  for (let i = 0; i < coarse.length; i++) {
    const r = missFor(ang0 + coarse[i]);
    if (r.miss < sol.miss) sol = r;
  }
  let st = 0.03;
  for (let it = 0; it < 4; it++) {
    st *= 0.5;
    const r1 = missFor(sol.ang - st), r2 = missFor(sol.ang + st);
    if (r1.miss < sol.miss) sol = r1;
    if (r2.miss < sol.miss) sol = r2;
  }
  return { ang: sol.ang, miss: sol.miss, t: (sol.k + 1) * H, ok: sol.k >= 0 };
}

function plan(obs, mem) {
  const me = obs.self;
  const R = obs.rules.ship.radius;
  const sp = obs.rules.weapon.bulletSpeed;
  const W = buildWorld(obs);
  const { H, np, PX, PY, GM, EPS2, PR } = W;
  const LIM2 = new Array(np), SOFT2 = new Array(np);
  for (let j = 0; j < np; j++) {
    const a = PR[j] + R + 2, b = PR[j] + 45;
    LIM2[j] = a * a;
    SOFT2[j] = b * b;
  }

  // Target: nearest alive enemy, damaged ones preferred, sticky across ticks
  const enemies = (obs.enemies || []).filter((e) => e.alive).slice(0, MAX_EN);
  let tgt = null, tIdx = -1, bestSc = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dx = e.pos.x - me.pos.x, dy = e.pos.y - me.pos.y;
    const sc = Math.sqrt(dx * dx + dy * dy) + (100 - e.hp) * 1.5 - (mem.tgt === e.id ? 80 : 0);
    if (sc < bestSc) { bestSc = sc; tgt = e; tIdx = i; }
  }
  mem.tgt = tgt ? tgt.id : null;

  const ePaths = enemies.map((e) => forecast(W, e.pos.x, e.pos.y, e.vel.x, e.vel.y));

  // Enemy bullets only (ours never hit us)
  const bl = [];
  const bullets = obs.bullets || [];
  for (let i = 0; i < bullets.length && bl.length < MAX_BUL; i++) {
    const b = bullets[i];
    if (b.owner === me.id || !(b.ttl > 0)) continue;
    bl.push(forecast(W, b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.ttl));
  }

  let aim = null, bearing0 = me.angle;
  if (tgt) {
    bearing0 = Math.atan2(tgt.pos.y - me.pos.y, tgt.pos.x - me.pos.x);
    aim = solveAim(W, me, tgt, ePaths[tIdx], sp, R);
  }
  const aimAng = aim ? aim.ang : me.angle;
  const leadOff = aim ? wrap(aimAng - bearing0) : 0;
  const wAim = me.ammo > 0 ? W_AIM : 0;

  // Candidate manoeuvres: { T: thrust level, phi: nose heading }
  const cands = [];
  for (let i = 0; i < 12; i++) cands.push({ T: 1, phi: -Math.PI + (i * TAU) / 12 });
  cands.push({ T: 0, phi: aimAng });                                   // coast, nose on the firing solution
  if (tgt) {
    cands.push({ T: 1, phi: bearing0 }, { T: 0.4, phi: bearing0 });                     // close in
    cands.push({ T: 1, phi: bearing0 + Math.PI }, { T: 0.4, phi: bearing0 + Math.PI }); // back off
  }
  const vx0 = me.vel.x, vy0 = me.vel.y;
  if (vx0 * vx0 + vy0 * vy0 > 9) {
    cands.push({ T: 1, phi: Math.atan2(-vy0, -vx0) });                 // brake
    cands.push({ T: 1, phi: Math.atan2(vy0, vx0) });                   // speed up
  }
  cands.push({ T: 1, phi: Math.atan2(-me.pos.y, -me.pos.x) });         // arena centre
  let near = -1, nearGap = Infinity;
  for (let j = 0; j < np; j++) {
    const dx = me.pos.x - PX[j], dy = me.pos.y - PY[j];
    const gap = Math.sqrt(dx * dx + dy * dy) - PR[j];
    if (gap < nearGap) { nearGap = gap; near = j; }
  }
  if (near >= 0) {
    const ra = Math.atan2(me.pos.y - PY[near], me.pos.x - PX[near]);
    cands.push({ T: 1, phi: ra }, { T: 1, phi: ra + Math.PI / 2 }, { T: 1, phi: ra - Math.PI / 2 });
  }

  // Cost of flying one candidate over the horizon (HP-equivalents)
  const dOm = 12 * H;
  const wFuel = W_FUEL * (1 + 3 * clamp((40 - me.fuel) / 40, 0, 1));
  const score = (T, phi) => {
    let x = me.pos.x, y = me.pos.y, vx = me.vel.x, vy = me.vel.y;
    let th = me.angle, om = me.angVel, fuel = me.fuel;
    let px = x, py = y, cost = 0;
    const hitB = new Array(bl.length).fill(false);
    const rammed = new Array(ePaths.length).fill(false);
    for (let k = 0; k < NS; k++) {
      // nose: same turn controller the real ship runs
      om += clamp(turnFor(wrap(phi - th)) * 3 - om, -dOm, dOm);
      th += om * H;
      const Te = fuel > 0 ? T : 0;
      // gravity and planet hazards at step k
      let ax = 0, ay = 0;
      const base = k * np;
      for (let j = 0; j < np; j++) {
        const dx = PX[base + j] - x, dy = PY[base + j] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LIM2[j]) return cost + DEATH + (NS - k) * 0.5;
        if (d2 < SOFT2[j]) cost += (2 * (45 - Math.sqrt(d2) + PR[j]) / 45) * H;
        const s = d2 + EPS2[j] + 1e-9;
        const f = GM[j] / (s * Math.sqrt(s));
        ax += f * dx; ay += f * dy;
      }
      // thrust along the nose, then integrate
      const acc = (60 * Te) / (1 + (0.5 * fuel) / 85);
      vx += (ax + acc * Math.cos(th)) * H;
      vy += (ay + acc * Math.sin(th)) * H;
      x += vx * H; y += vy * H;
      fuel -= Te * H;
      cost += wFuel * Te * H;
      const kk = k + 1;
      // enemy bullets: segment test so fast bullets cannot tunnel through
      for (let b = 0; b < bl.length; b++) {
        if (hitB[b]) continue;
        const B = bl[b];
        if (B.X[k] > 1e8 || B.X[kk] > 1e8) continue;
        if (segDist(B.X[k] - px, B.Y[k] - py, B.X[kk] - x, B.Y[kk] - y) < R + 1) {
          hitB[b] = true;
          cost += 10;
        }
      }
      // enemy ships: rams
      for (let e = 0; e < ePaths.length; e++) {
        if (rammed[e]) continue;
        const P = ePaths[e];
        const dx = P.X[kk] - x, dy = P.Y[kk] - y;
        if (dx * dx + dy * dy < (2 * R + 4) * (2 * R + 4)) {
          rammed[e] = true;
          const rvx = vx - (P.X[kk] - P.X[k]) / H, rvy = vy - (P.Y[kk] - P.Y[k]) / H;
          cost += 2 + 0.15 * Math.sqrt(rvx * rvx + rvy * rvy);
        }
      }
      // engagement band and aim against the target
      if (tgt) {
        const P = ePaths[tIdx];
        const dx = P.X[kk] - x, dy = P.Y[kk] - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > DHI) cost += W_BAND * (dist - DHI) * H;
        else if (dist < DLO) cost += W_BAND * 1.5 * (DLO - dist) * H;
        if (wAim > 0 && dist < 1100) {
          const off = Math.abs(wrap(th - (Math.atan2(dy, dx) + leadOff)));
          const e2 = off - Math.atan2(R, Math.max(dist, 1));
          if (e2 > 0) cost += wAim * Math.min(1, e2 / 0.4) * H;
        }
      }
      // arena limits (out of bounds costs 10 HP/s)
      const r2 = x * x + y * y;
      if (r2 > 1650 * 1650) {
        const q = (Math.sqrt(r2) - 1650) / 100;
        cost += 2 * q * q * H;
        if (r2 > 1990 * 1990) cost += 10 * H;
      }
      px = x; py = y;
    }
    return cost;
  };

  // Choose the cheapest manoeuvre (small bonus for keeping the previous one to avoid chatter)
  const last = mem.last;
  let pick = cands[0], bestCost = Infinity;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    let v = score(c.T, c.phi);
    if (last && Math.abs(c.T - last.T) < 0.05 && Math.abs(wrap(c.phi - last.phi)) < 0.08) v -= 0.25;
    if (v < bestCost) { bestCost = v; pick = c; }
  }
  mem.last = { T: pick.T, phi: pick.phi };

  const thrust = me.fuel > 0 ? clamp(pick.T, 0, 1) : 0;
  const turn = turnFor(wrap(pick.phi - me.angle));

  // Fire only on a gravity-corrected solution the nose is already on, within gun gates
  let fire = false;
  if (aim && tgt && aim.ok) {
    const dx = tgt.pos.x - me.pos.x, dy = tgt.pos.y - me.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const tol = Math.atan2(R * 0.8, Math.max(dist, 1)) + 0.01;
    fire = aim.miss < R * 0.85 && dist < 1100 &&
      Math.abs(wrap(aim.ang - me.angle)) < tol &&
      !me.overheated && me.heat < 72 && (me.cooldown || 0) <= 0 && me.ammo > 0;
  }
  return { thrust, turn, fire };
}

// Safe fallback used if planning throws or returns garbage
function fallback(obs) {
  const me = obs.self;
  if (Math.sqrt(me.pos.x * me.pos.x + me.pos.y * me.pos.y) > 1700) {
    const want = Math.atan2(-me.pos.y, -me.pos.x);
    return { thrust: 1, turn: turnFor(wrap(want - me.angle)), fire: false };
  }
  return { thrust: 0, turn: 0, fire: false };
}

export default function control(obs, mem) {
  let out = null;
  try {
    out = plan(obs, mem || {});
  } catch (err) {
    out = null;
  }
  if (!out || !Number.isFinite(out.thrust) || !Number.isFinite(out.turn)) {
    try {
      out = fallback(obs);
    } catch (err) {
      out = { thrust: 0, turn: 0, fire: false };
    }
  }
  return out;
}
