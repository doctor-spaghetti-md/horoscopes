/* Horoscope Landing (Planes Month)
   - Loads roster from JSON
   - Renders alphabetical cards
   - Draws "Sky Chart": a zodiac-ish wheel + starfield
   - Each person gets a unique aircraft (deterministic)
   - Each person has a route between TWO stars (no plane-to-plane connections)
*/

const $ = (sel) => document.querySelector(sel);

const state = {
  roster: [],
  periodLabel: "",
  auditorNote: "",

  // derived view
  sorted: [],      // alphabetical
  filtered: [],    // search filtered

  // chart
  canvas: null,
  ctx: null,
  dpr: 1,
  w: 0,
  h: 0,
  cx: 0,
  cy: 0,
  radius: 0,
  sectors: 12,

  // sky objects
  stars: [],       // {x,y,r,tw}
  routes: [],      // per person: {slug, name, plane, sectorIndex, p1, p2, node:{x,y,r}}
  hoveredSlug: null,
  pingSlug: null,
  pingT: 0
};

init();

async function init(){
  // buttons
  $("#shuffleBtn").addEventListener("click", () => {
    // re-roll the stars + re-roll the star routes (but aircraft stays stable)
    buildStars(true);
    buildRoutes(true);
    drawChart();
    randomPing();
  });

  // search
  $("#searchInput").addEventListener("input", (e) => applyFilters(e.target.value));

  // keep sectors toggle, but roster is always alphabetical
  const showSectorsToggle = $("#showSectorsToggle");
  if(showSectorsToggle){
    showSectorsToggle.addEventListener("change", () => drawChart());
  }

  setupCanvas();
  window.addEventListener("resize", () => {
    setupCanvas(true);
    buildStars(false);
    buildRoutes(false);
    drawChart();
  });

  await loadRoster();
  applyFilters("");

  buildStars(false);
  buildRoutes(false);
  drawChart();
  requestAnimationFrame(tick);
}

async function loadRoster(){
  try{
    const res = await fetch("data/roster.json", { cache: "no-store" });
    if(!res.ok) throw new Error(`Failed to load roster.json (${res.status})`);
    const data = await res.json();

    state.periodLabel = data.periodLabel || "Unknown period";
    state.auditorNote = data.auditorNote || "No note available.";
    state.roster = Array.isArray(data.names) ? data.names : [];

    $("#periodPill").textContent = `Period: ${state.periodLabel}`;
    $("#countPill").textContent = `Names: ${state.roster.length}`;

    $("#auditorNote").innerHTML = escapeHtml(state.auditorNote)
      .replace(/\n/g, "<br/>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  }catch(err){
    $("#auditorNote").textContent = `Error loading JSON: ${err.message}`;
    state.roster = [];
  }
}

function applyFilters(query){
  const q = (query || "").trim().toLowerCase();

  // ALWAYS alphabetical
  state.sorted = [...state.roster].sort((a,b) =>
    (a.display||"").localeCompare((b.display||""), undefined, { sensitivity:"base" })
  );

  state.filtered = state.sorted.filter(n => {
    const name = (n.display || "").toLowerCase();
    const slug = (n.slug || "").toLowerCase();
    return !q || name.includes(q) || slug.includes(q);
  });

  renderRoster();
  buildRoutes(false);
  drawChart();
}

function renderRoster(){
  const list = $("#rosterList");
  list.innerHTML = "";

  $("#rosterSub").textContent = `${state.filtered.length} shown`;

  for(let idx=0; idx<state.filtered.length; idx++){
    const item = state.filtered[idx];
    const display = item.display || "Unnamed";
    const slug = item.slug || slugify(display);

    const plane = uniquePlaneForSlug(slug);
    const sectorIndex = idx % state.sectors;
    const sectorLabel = sectorName(sectorIndex);

    const href = `people/${slug}/index.html`;

    const li = document.createElement("li");
    li.className = "card";

    li.innerHTML = `
      <div class="cardInner">
        <div>
          <div class="name">${escapeHtml(display)}</div>
          <div class="metaSmall">Call-sign: <span class="mono">${escapeHtml(slug)}</span></div>
          <div class="badge" title="Not star signs. Friend signs.">
            <span aria-hidden="true">✈️</span>
            <span><b>${escapeHtml(plane)}</b> • Sector <b>${sectorIndex+1}</b> (${escapeHtml(sectorLabel)})</span>
          </div>
        </div>

        <a class="link" href="${href}" data-slug="${escapeHtml(slug)}" data-name="${escapeHtml(display)}">Open</a>
      </div>
    `;

    // ping on click (but don't hijack link click)
    li.addEventListener("click", (e) => {
      const isLink = e.target && e.target.closest && e.target.closest("a");
      if(isLink) return;
      pingBySlug(slug);
    });

    li.addEventListener("mouseenter", () => {
      state.hoveredSlug = slug;
      setHoverCard(display, slug, plane, sectorIndex);
      drawChart();
    });
    li.addEventListener("mouseleave", () => {
      state.hoveredSlug = null;
      setHoverCard(null);
      drawChart();
    });

    list.appendChild(li);
  }
}

function setupCanvas(fromResize=false){
  state.canvas = $("#skyChart");
  state.ctx = state.canvas.getContext("2d");

  const rect = state.canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  state.dpr = dpr;

  const size = Math.floor(rect.width);
  state.canvas.width = Math.floor(size * dpr);
  state.canvas.height = Math.floor(size * dpr);

  state.w = state.canvas.width;
  state.h = state.canvas.height;
  state.cx = state.w / 2;
  state.cy = state.h / 2;
  state.radius = Math.min(state.w, state.h) * 0.42;

  if(!fromResize){
    state.canvas.addEventListener("mousemove", onMove);
    state.canvas.addEventListener("mouseleave", () => {
      state.hoveredSlug = null;
      setHoverCard(null);
      drawChart();
    });
    state.canvas.addEventListener("click", () => {
      // clicking canvas: ping random visible route
      randomPing();
    });
  }
}

/* -------------------- STARS + ROUTES -------------------- */

function buildStars(forceNew){
  const N = 24; // number of stars
  const seed = forceNew ? (Date.now() % 1000000000) : 13371337;
  const prng = mulberry32(seed);

  const inner = state.radius * 0.18;
  const outer = state.radius * 0.98;

  state.stars = [];
  for(let i=0; i<N; i++){
    // random polar placement inside a donut so they cluster nicely
    const a = prng() * Math.PI * 2;
    const r = inner + prng() * (outer - inner);
    const x = state.cx + Math.cos(a) * r;
    const y = state.cy + Math.sin(a) * r;

    state.stars.push({
      x, y,
      r: (2.0 + prng()*2.2) * state.dpr,
      tw: prng() * Math.PI * 2
    });
  }
}

function buildRoutes(forceNew){
  const items = state.filtered;

  // if no stars yet, build them
  if(state.stars.length === 0) buildStars(false);

  state.routes = [];

  for(let idx=0; idx<items.length; idx++){
    const it = items[idx];
    const name = it.display || "Unnamed";
    const slug = it.slug || slugify(name);
    const plane = uniquePlaneForSlug(slug);
    const sectorIndex = idx % state.sectors;

    // deterministic star pair selection per slug, but can be re-rolled if forceNew
    const baseSeed = hash32(slug) ^ (forceNew ? hash32(String(Date.now())) : 0);
    const prng = mulberry32(baseSeed);

    const a = Math.floor(prng() * state.stars.length);
    let b = Math.floor(prng() * state.stars.length);
    if(b === a) b = (b + 1) % state.stars.length;

    const p1 = state.stars[a];
    const p2 = state.stars[b];

    // place a "node" (plane blip) somewhere along that route, slightly offset
    const t = 0.35 + prng() * 0.30; // middle-ish
    const nx = lerp(p1.x, p2.x, t);
    const ny = lerp(p1.y, p2.y, t);

    // perpendicular offset for flair
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.max(1, Math.hypot(dx,dy));
    const ox = (-dy/len) * (8 * state.dpr) * (prng() - 0.5) * 2;
    const oy = ( dx/len) * (8 * state.dpr) * (prng() - 0.5) * 2;

    state.routes.push({
      slug, name, plane, sectorIndex,
      p1, p2,
      node: { x: nx + ox, y: ny + oy, r: Math.max(7, state.radius * 0.032) }
    });
  }
}

/* -------------------- DRAW -------------------- */

function drawChart(){
  const ctx = state.ctx;
  const { w,h,cx,cy,radius,dpr } = state;
  const lw = (n) => n * dpr;

  ctx.clearRect(0,0,w,h);

  // background glow
  radialGlow(ctx, cx, cy, radius*1.28, [
    { stop:0.0, color:"rgba(255,0,184,.16)" },
    { stop:0.55, color:"rgba(40,215,255,.10)" },
    { stop:1.0, color:"rgba(0,0,0,0)" }
  ]);

  // orbit rings
  [0.30, 0.52, 0.72, 0.92].forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(cx,cy, radius*p, 0, Math.PI*2);
    ctx.strokeStyle = i%2 ? "rgba(40,215,255,.18)" : "rgba(255,0,184,.18)";
    ctx.lineWidth = lw(1);
    ctx.stroke();
  });

  // sectors
  const showSectors = $("#showSectorsToggle") ? $("#showSectorsToggle").checked : true;
  if(showSectors){
    for(let s=0; s<state.sectors; s++){
      const ang = (s/state.sectors)*Math.PI*2 - Math.PI/2;
      const x2 = cx + Math.cos(ang) * radius;
      const y2 = cy + Math.sin(ang) * radius;

      ctx.beginPath();
      ctx.moveTo(cx,cy);
      ctx.lineTo(x2,y2);
      ctx.strokeStyle = (s%2===0) ? "rgba(255,0,184,.14)" : "rgba(139,91,255,.12)";
      ctx.lineWidth = lw(1);
      ctx.stroke();

      const tx = cx + Math.cos(ang) * (radius*1.05);
      const ty = cy + Math.sin(ang) * (radius*1.05);
      ctx.save();
      ctx.font = `${Math.round(11*dpr)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s+1), tx, ty);
      ctx.restore();
    }
  }

  // center core
  ctx.beginPath();
  ctx.arc(cx,cy, radius*0.10, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = lw(1);
  ctx.stroke();

  // stars
  drawStars(ctx);

  // routes (star -> star per person)
  drawRoutes(ctx);

  // sweep
  drawSweep(ctx, cx, cy, radius, performance.now()/1000);

  // footer label
  ctx.save();
  ctx.font = `${Math.round(12*dpr)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("FLIGHT PLANS: star routes only (no plane-to-plane links)", cx, h - (14*dpr));
  ctx.restore();
}

function drawStars(ctx){
  // twinkle
  const t = performance.now()/1000;

  for(const s of state.stars){
    const tw = 0.55 + 0.45 * Math.sin(t*1.4 + s.tw);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * tw, 0, Math.PI*2);
    ctx.fillStyle = `rgba(255,232,74,${0.55*tw})`;
    ctx.shadowColor = "rgba(255,0,184,.18)";
    ctx.shadowBlur = 10 * state.dpr;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawRoutes(ctx){
  for(const r of state.routes){
    const isHover = state.hoveredSlug === r.slug;
    const isPing = state.pingSlug === r.slug;

    // line style
    ctx.beginPath();
    ctx.moveTo(r.p1.x, r.p1.y);
    ctx.lineTo(r.p2.x, r.p2.y);

    ctx.strokeStyle = isHover
      ? "rgba(40,215,255,.55)"
      : "rgba(40,215,255,.20)";
    ctx.lineWidth = (isHover ? 2.4 : 1.6) * state.dpr;

    ctx.shadowColor = isHover ? "rgba(40,215,255,.28)" : "rgba(40,215,255,.10)";
    ctx.shadowBlur = (isHover ? 16 : 10) * state.dpr;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // node (plane blip)
    const p = r.node;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx.fillStyle = isHover ? "rgba(255,0,184,.92)" : "rgba(255,0,184,.72)";
    ctx.shadowColor = isHover ? "rgba(255,0,184,.45)" : "rgba(255,0,184,.24)";
    ctx.shadowBlur = (isHover ? 22 : 14) * state.dpr;
    ctx.fill();
    ctx.shadowBlur = 0;

    // tiny plane emoji label
    ctx.save();
    ctx.font = `${Math.round((isHover ? 18 : 16) * state.dpr)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.fillText("✈️", p.x, p.y - (10 * state.dpr));
    ctx.restore();

    // name label
    ctx.save();
    ctx.font = `${Math.round(12 * state.dpr)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = isHover ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.70)";
    ctx.fillText(r.name, p.x, p.y + (9 * state.dpr));
    ctx.restore();

    // ping ripple
    if(isPing){
      const tt = state.pingT;
      const rr = p.r + (state.radius*0.32) * tt;
      const a = 0.38 * (1 - tt);

      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(255,0,184,${a})`;
      ctx.lineWidth = 2.2 * state.dpr;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, rr*0.66, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(40,215,255,${a*0.85})`;
      ctx.lineWidth = 1.7 * state.dpr;
      ctx.stroke();
    }
  }
}

/* -------------------- INTERACTION -------------------- */

function onMove(e){
  const rect = state.canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * state.dpr;
  const my = (e.clientY - rect.top) * state.dpr;

  // hover hit test against nodes
  let hitSlug = null;
  for(const r of state.routes){
    const p = r.node;
    const dx = mx - p.x;
    const dy = my - p.y;
    if(Math.hypot(dx,dy) <= p.r * 2.2){
      hitSlug = r.slug;
      setHoverCard(r.name, r.slug, r.plane, r.sectorIndex);
      break;
    }
  }

  state.hoveredSlug = hitSlug;
  if(!hitSlug) setHoverCard(null);
  drawChart();
}

function setHoverCard(name, slug, plane, sectorIndex){
  const card = $("#hoverCard");
  if(!name){
    card.innerHTML = `
      <div class="legendTitle">Hover a call-sign</div>
      <div class="legendBody">to see its star route + link.</div>
    `;
    return;
  }

  const href = `people/${slug}/index.html`;
  const sectorLabel = sectorName(sectorIndex);

  card.innerHTML = `
    <div class="legendTitle">${escapeHtml(name)}</div>
    <div class="legendBody">
      Aircraft: <b>${escapeHtml(plane)}</b><br/>
      Sector <b>${sectorIndex+1}</b> (${escapeHtml(sectorLabel)})<br/>
      Link: <span style="font-family:var(--mono)">${escapeHtml(href)}</span>
    </div>
  `;
}

function pingBySlug(slug){
  state.pingSlug = slug;
  state.pingT = 0;
}

function randomPing(){
  if(state.routes.length === 0) return;
  const r = state.routes[Math.floor(Math.random() * state.routes.length)];
  pingBySlug(r.slug);
}

function tick(){
  if(state.pingSlug){
    state.pingT += 0.018;
    if(state.pingT >= 1){
      state.pingSlug = null;
      state.pingT = 0;
    }
  }
  drawChart();
  requestAnimationFrame(tick);
}

/* -------------------- VISUAL HELPERS -------------------- */

function radialGlow(ctx, x, y, r, stops){
  const g = ctx.createRadialGradient(x,y,0, x,y,r);
  stops.forEach(s => g.addColorStop(s.stop, s.color));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x,y,r,0,Math.PI*2);
  ctx.fill();
}

function drawSweep(ctx, cx, cy, radius, t){
  const ang = (t * 0.7) % (Math.PI*2);
  const sweep = Math.PI * 0.22;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx,cy);
  ctx.arc(cx,cy, radius, ang, ang+sweep);
  ctx.closePath();
  ctx.fillStyle = "rgba(40,215,255,.05)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx,cy, radius, ang, ang+sweep);
  ctx.strokeStyle = "rgba(40,215,255,.16)";
  ctx.lineWidth = 1.5 * state.dpr;
  ctx.stroke();
  ctx.restore();
}

/* -------------------- UNIQUE PLANE ASSIGNMENT -------------------- */
/* Deterministic: same slug => same plane, and we ensure uniqueness on the page.
   If you add more names than planes, it will wrap and then add a suffix.
*/

const PLANE_POOL = [
  "C-17 Globemaster III",
  "B-52 Stratofortress",
  "SR-71 Blackbird",
  "F-18 Super Hornet",
  "F-16 Fighting Falcon",
  "F-35 Lightning II",
  "A-10 Thunderbolt II",
  "P-8 Poseidon",
  "E-3 Sentry",
  "KC-135 Stratotanker",
  "C-130 Hercules",
  "UH-60 Black Hawk",
  "CH-47 Chinook",
  "V-22 Osprey",
  "A320",
  "B737",
  "B747",
  "B787 Dreamliner",
  "A350",
  "A380"
];

function uniquePlaneForSlug(slug){
  // build a stable, unique mapping for the current filtered list
  // (so no duplicates among visible cards)
  const used = new Set();
  const sortedSlugs = state.filtered
    .map(n => n.slug || slugify(n.display || ""))
    .sort((a,b) => a.localeCompare(b, undefined, { sensitivity:"base" }));

  const map = new Map();

  for(const s of sortedSlugs){
    const idx0 = hash32(s) % PLANE_POOL.length;
    let idx = idx0;
    let tries = 0;

    while(used.has(PLANE_POOL[idx]) && tries < PLANE_POOL.length){
      idx = (idx + 1) % PLANE_POOL.length;
      tries++;
    }

    let plane = PLANE_POOL[idx];
    if(used.has(plane)){
      // fallback if you exceed pool
      plane = `${plane} • Variant ${tries+1}`;
    }

    used.add(plane);
    map.set(s, plane);
  }

  return map.get(slug) || PLANE_POOL[hash32(slug) % PLANE_POOL.length];
}

/* -------------------- MATH + UTILS -------------------- */

function lerp(a,b,t){ return a + (b-a)*t; }

function slugify(s){
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sectorName(i){
  const names = [
    "Runway Ascendant",
    "Gate of Portents",
    "Turbulence House",
    "Altimeter Chapel",
    "Contrail Cathedral",
    "Cloud Bureau",
    "Radar Romance",
    "Hangar Hex",
    "Cabin Oracle",
    "Black Box Blessing",
    "Wingtip Omen",
    "Final Approach"
  ];
  return names[i % names.length];
}

function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// Deterministic PRNG
function mulberry32(a){
  return function(){
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple 32-bit hash for strings
function hash32(str){
  let h = 2166136261;
  const s = String(str);
  for(let i=0; i<s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}
