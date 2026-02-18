window.addEventListener('DOMContentLoaded', () => {
  // ================== MAPA + CAPAS BASE ==================
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  });

  const esriSat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
  );

  const map = L.map('map', { zoomControl: true, layers: [esriSat] });

  L.control.layers(
    { 'Mapa': osm, 'Satélite': esriSat },
    {},
    { position: 'topright', collapsed: false }
  ).addTo(map);

  // ================== PERFIL DE ELEVACIÓN ==================
  const elev = L.control.elevation({
    position: "bottomleft",
    theme: "",

    // No dibujamos la polilínea del plugin (ya pintamos la ruta nosotros).
    // Esto evita conflictos visuales cuando pasas el ratón por el perfil.
    polyline: false,

    // Marcador simple (punto) en vez de “línea vertical” (evita que tape el mapa)
    marker: "position-marker",
    markerIcon: L.divIcon({
      className: "elevation-position-marker",
      html: '<div class="elev-dot"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),

    detached: false,
    summary: "inline",
    followMarker: false,     // NO recentrar el mapa al mover el ratón por el perfil
    autofitBounds: false,

    imperial: false,
    altitude: true,
    distance: true,
    time: false,

    width: 620,
    height: 180,

    // Para GeoJSON (coords: [lon, lat, ele]) NO hay que invertir.
    reverseCoords: false,
  }).addTo(map);

  document.body.classList.remove('show-elevation');

  // ================== ESTADO ==================
  let ROUTES = [];
  let FOLDERS = [];              // carpetas explícitas (incluye vacías)
  const layersById = new Map();
  const arrowLayersById = new Map(); // routeId -> L.LayerGroup
  let SHOW_ARROWS = false;
  let activeRouteId = null;
  const geojsonCache = new Map();
  const blobUrls = new Map();

  
  // ================== SUPABASE (guardado automático compartido) ==================
  // 1) En Supabase > Settings > API, copia Project URL y la anon public key.
  // 2) Pega aquí los valores.
  const SUPABASE_URL = "https://uuowjdqztprgmpucwtby.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_5GXiqAUkegd_vKtUxc8HVg_IaRtdWWc";
  // Clave "anon" legacy (JWT) por si alguna vez la necesitas:
  const SUPABASE_LEGACY_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1b3dqZHF6dHByZ21wdWN3dGJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyNzE1MDQsImV4cCI6MjA4Njg0NzUwNH0.PEG_KEV4adALyzIPb68dTDHK2GKGpSRDFIXpnmvBGH0";


  // Para editar, esta web inicia sesión en Supabase con ESTE email fijo.
  // Crea este usuario en Supabase Auth y ponle la contraseña "javier".
  const SUPABASE_EMAIL = "ramon@rutas-ramon.local";

  // Un único estado para toda la aplicación
  const STATE_ID = "main";

  const sb = (window.supabase &&
              SUPABASE_URL &&
              (SUPABASE_ANON_KEY || SUPABASE_LEGACY_ANON_KEY) &&
              !SUPABASE_URL.includes("PON_AQUI") &&
              !(SUPABASE_ANON_KEY || '').includes("PON_AQUI"))
    ? window.supabase.createClient(SUPABASE_URL, (SUPABASE_ANON_KEY || SUPABASE_LEGACY_ANON_KEY))
    : null;

  const supabaseReady = () => !!sb;

  async function syncEditModeWithSession(){
    if(!supabaseReady()){
      // Sin Supabase no permitimos edición (porque no se puede guardar en GitHub Pages)
      EDIT_UNLOCKED = false;
      updateEditUI?.();
      try { renderList?.(groupedAndSorted?.()); refreshAllArrows?.(); } catch(e) { console.warn('Render tras sync sesión', e); }
      return;
    }
    try{
      const { data } = await sb.auth.getSession();
      const hasSession = !!data?.session?.user;
      EDIT_UNLOCKED = hasSession;
      updateEditUI?.();
      try { renderList?.(groupedAndSorted?.()); refreshAllArrows?.(); } catch(e) { console.warn('Render tras sync sesión', e); }
    }catch(e){
      console.warn('Supabase: no se pudo leer sesión', e);
      EDIT_UNLOCKED = false;
      updateEditUI?.();
    }
  }


  let _saveTimer = null;
  function scheduleSave(immediate=false){
    if(!supabaseReady()) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveNow, immediate ? 10 : 900);
  }

  async function loadRemoteState(){
    if(!supabaseReady()) return null;
    const { data, error } = await sb
      .from('rutas_state')
      .select('state')
      .eq('id', STATE_ID)
      .maybeSingle();

    if(error){
      console.warn('Supabase: no se pudo leer el estado', error);
      return null;
    }
    return data?.state || null;
  }

  function buildRemoteState(){
    const overrides = {};
    for(const r of ROUTES){
      overrides[r.id] = {
        name: r.name ?? r.id,
        with_whom: r.with_whom ?? "",
        folder: r.folder ?? "",
        distance_km: r.distance_km ?? 0,
        ascent_m: r.ascent_m ?? 0,
        start_time: r.start_time ?? null
      };
    }

    const added_routes = [];
    const added_geojson = {};

    for(const r of ROUTES){
      if(r && r.__remote_added){
        const entry = { ...r };
        // file es un blob URL del dispositivo; no se puede reutilizar.
        delete entry.file;
        delete entry.__remote_added;
        added_routes.push(entry);

        if(geojsonCache.has(r.id)){
          added_geojson[r.id] = geojsonCache.get(r.id).geojson;
        }
      }
    }

    return {
      version: 1,
      saved_at: new Date().toISOString(),
      folders: FOLDERS.slice(),
      overrides,
      added_routes,
      added_geojson
    };
  }

  async function applyRemoteState(remote){
    if(!remote || typeof remote !== 'object') return;

    if(Array.isArray(remote.folders)){
      FOLDERS = remote.folders.map(s => (s || '').trim()).filter(Boolean);
    }

    const ov = remote.overrides;
    if(ov && typeof ov === 'object'){
      for(const r of ROUTES){
        const o = ov[r.id];
        if(!o) continue;
        if(o.name !== undefined) r.name = o.name;
        if(o.with_whom !== undefined) r.with_whom = o.with_whom;
        if(o.folder !== undefined) r.folder = o.folder;
        if(o.distance_km !== undefined) r.distance_km = o.distance_km;
        if(o.ascent_m !== undefined) r.ascent_m = o.ascent_m;
        if(o.start_time !== undefined) r.start_time = o.start_time;
      }
    }

    if(Array.isArray(remote.added_routes)){
      const existing = new Set(ROUTES.map(r => r.id));
      for(const rr of remote.added_routes){
        if(!rr || !rr.id || existing.has(rr.id)) continue;

        const r = { ...rr };
        r.__remote_added = true;
        if(r.with_whom === undefined) r.with_whom = "";
        if(r.folder === undefined) r.folder = "";
        if(!r.export_file) r.export_file = `data/${r.id}.geojson`;

        const gj = remote.added_geojson && remote.added_geojson[r.id] ? remote.added_geojson[r.id] : null;
        if(gj){
          geojsonCache.set(r.id, { geojson: gj, filename: `${r.id}.geojson` });
          const blob = new Blob([JSON.stringify(gj)], { type:'application/geo+json' });
          const url = URL.createObjectURL(blob);
          blobUrls.set(r.id, url);
          r.file = url;
        } else {
          r.file = r.file || `data/${r.id}.geojson`;
        }

        ROUTES.push(r);
        existing.add(r.id);
      }
    }
  }

  async function saveNow(){
    if(!supabaseReady()) return;

    const { data: sessData } = await sb.auth.getSession();
    const session = sessData?.session;
    if(!session?.user) return;

    const state = buildRemoteState();

    const { error } = await sb
      .from('rutas_state')
      .upsert({ id: STATE_ID, owner: session.user.id, state }, { onConflict: 'id' });

    if(error){
      console.warn('Supabase: error guardando estado', error);
      // Muestra aviso breve (no bloqueante)
      try{ showToast?.('No se ha podido guardar en Supabase (mira consola).'); } catch {}
    }
  }

// ================== CONTROL DE EDICIÓN (contraseña) ==================
  // Por defecto: solo lectura. Para editar, pulsa "Editar 🔒" y escribe la contraseña.
  // La persistencia real (guardado automático compartido) la controla Supabase.
  let EDIT_UNLOCKED = false; // Solo lectura por defecto; se habilita tras login válido en Supabase

  const setEditUnlocked = async (v) => {
    // Solo permitimos desbloquear si hay sesión Supabase
    if(v){
      await syncEditModeWithSession();
      if(!EDIT_UNLOCKED){
        openLoginModal();
        return;
      }
    } else {
      EDIT_UNLOCKED = false;
    }

    // Si sales de edición, cerramos sesión en Supabase (opcional).
    if(!EDIT_UNLOCKED && supabaseReady()){
      try { await sb.auth.signOut(); } catch {}
    }

    updateEditUI();
    try { renderList(groupedAndSorted()); } catch {}
  };

  const openLoginModal = () => {
    const b = document.getElementById('loginBackdrop');
    if(!b) return;
    const pass = document.getElementById('login_pass');
    if(pass) pass.value = '';
    b.style.display = 'flex';
    setTimeout(() => pass?.focus(), 50);
  };

  const closeLoginModal = () => {
    const b = document.getElementById('loginBackdrop');
    if(b) b.style.display = 'none';
  };

  const tryLogin = async () => {
    const p = document.getElementById('login_pass')?.value;

    if(!supabaseReady()){
      alert('Para activar el modo edición necesitas configurar Supabase (SUPABASE_URL y SUPABASE_ANON_KEY) en app.js.');
      return false;
    }

    const { error } = await sb.auth.signInWithPassword({
      email: SUPABASE_EMAIL,
      password: String(p||'').trim()
    });

    if(error){
      console.warn(error);
      alert('Contraseña incorrecta o usuario no creado en Supabase.');
      return false;
    }

    await syncEditModeWithSession();
    if(!EDIT_UNLOCKED){
      alert('No se pudo activar el modo edición (sesión no válida).');
      return false;
    }
    closeLoginModal();
    scheduleSave(true);
    try { renderList(groupedAndSorted()); refreshAllArrows(); } catch(e) { console.warn('Render tras login', e); }
    return true;
  };

  const requireEdit = () => {
    if(EDIT_UNLOCKED) return true;
    // Si no hay sesión, pedimos contraseña

    openLoginModal();
    return false;
  };

  const setDisabled = (id, disabled) => {
    const el = document.getElementById(id);
    if(!el) return;
    el.disabled = !!disabled;
    if(disabled) el.title = 'Modo solo lectura';
    else el.title = '';
  };

  const updateEditUI = () => {
    const pill = document.getElementById('editPill');
    const btn = document.getElementById('editBtn');

    if(pill){
      pill.textContent = 'Solo lectura';
      pill.classList.toggle('active', !EDIT_UNLOCKED);
    }
    if(btn){
      btn.textContent = EDIT_UNLOCKED ? 'Editar 🔓' : 'Editar 🔒';
      btn.classList.toggle('active', EDIT_UNLOCKED);
    }

    // Carpetas
    setDisabled('createFolder', !EDIT_UNLOCKED);
    setDisabled('deleteFolder', !EDIT_UNLOCKED);
    setDisabled('folderToDelete', !EDIT_UNLOCKED);

    // Gestión de rutas
    setDisabled('exportZip', !EDIT_UNLOCKED);
    const addInput = document.getElementById('addGpx');
    if(addInput){
      addInput.disabled = !EDIT_UNLOCKED;
      const label = addInput.closest('label');
      if(label){
        label.style.opacity = EDIT_UNLOCKED ? '1' : '0.55';
        label.style.pointerEvents = EDIT_UNLOCKED ? 'auto' : 'none';
      }
    }

    // Modal editar
    const saveBtn = document.getElementById('m_save');
    if(saveBtn){
      saveBtn.disabled = !EDIT_UNLOCKED;
      saveBtn.title = !EDIT_UNLOCKED ? 'Modo solo lectura' : '';
    }
  };

  // Botones de modo arriba
  const editPillEl = document.getElementById('editPill');
  if(editPillEl) editPillEl.addEventListener('click', () => setEditUnlocked(false));

  const editBtnEl = document.getElementById('editBtn');
  if(editBtnEl){
    editBtnEl.addEventListener('click', () => {
      if(EDIT_UNLOCKED){
        if(confirm('¿Salir del modo edición y volver a solo lectura?')) setEditUnlocked(false);
        return;
      }
      openLoginModal();
    });
  }

  // Handlers del modal login
  const loginCancel = document.getElementById('login_cancel');
  const loginOk = document.getElementById('login_ok');
  const loginBackdrop = document.getElementById('loginBackdrop');

  if(loginCancel) loginCancel.addEventListener('click', closeLoginModal);
  if(loginOk) loginOk.addEventListener('click', () => { tryLogin(); });

  if(loginBackdrop){
    loginBackdrop.addEventListener('click', (ev) => {
      if(ev.target && ev.target.id === 'loginBackdrop') closeLoginModal();
    });
  }

  document.addEventListener('keydown', (ev) => {
    if(ev.key === 'Escape') closeLoginModal();
    if(ev.key === 'Enter'){
      const b = document.getElementById('loginBackdrop');
      if(b && b.style.display === 'flex') tryLogin();
    }
  });

  updateEditUI();

  // ================== CONTADOR TOPBAR ==================
  const updateRouteCounter = () => {
    const el = document.getElementById('routeCount');
    if(el) el.textContent = String(ROUTES.length);
  };

  
  // Toast muy simple (para avisos sin molestar)
  function showToast(msg){
    let t = document.getElementById('toast');
    if(!t){
      t = document.createElement('div');
      t.id = 'toast';
      t.style.position = 'fixed';
      t.style.left = '12px';
      t.style.bottom = '12px';
      t.style.zIndex = '99999';
      t.style.background = '#111827';
      t.style.color = '#fff';
      t.style.padding = '10px 12px';
      t.style.borderRadius = '12px';
      t.style.boxShadow = '0 10px 30px rgba(0,0,0,.25)';
      t.style.fontSize = '13px';
      t.style.maxWidth = 'min(520px, calc(100vw - 24px))';
      t.style.opacity = '0';
      t.style.transition = 'opacity .2s ease';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
  }

// ================== UTILS ==================
  const fmtKm = (km) => `${(km ?? 0).toFixed(2)} km`;
  const fmtM = (m) => `${Math.round(m ?? 0)} m`;
  const dateOnly = (iso) => {
    if(!iso) return '—';
    if(/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    return String(iso).slice(0, 10);
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
  const fitBBox = (bbox) => map.fitBounds([[bbox[1], bbox[0]],[bbox[3], bbox[2]]], { padding: [20,20] });

  const sanitizeId = (name) => (name
    .replace(/\.[^.]+$/,'')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-zA-Z0-9_-]+/g,'_')
    .replace(/^_+|_+$/g,'')
    .slice(0, 120) || `ruta_${Math.random().toString(16).slice(2)}`);

  const uniqueId = (base) => {
    let id = base, n = 2;
    const ids = new Set(ROUTES.map(r=>r.id));
    while(ids.has(id)) id = `${base}_${n++}`;
    return id;
  };

  const haversine = (lat1, lon1, lat2, lon2) => {
    const R=6371000;
    const toRad = d => d*Math.PI/180;
    const p1=toRad(lat1), p2=toRad(lat2);
    const dphi=toRad(lat2-lat1), dl=toRad(lon2-lon1);
    const a = Math.sin(dphi/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  };

  // Douglas-Peucker simplification (eps in meters)
  const simplifyDP = (points, eps=5) => {
    if(points.length < 3) return points;
    const distPointSeg = (p,a,b) => {
      const [lon,lat] = p;
      const [lon1,lat1] = a;
      const [lon2,lat2] = b;
      const x = (lon - lon1) * 111320 * Math.cos(((lat+lat1)/2) * Math.PI/180);
      const y = (lat - lat1) * 110540;
      const x2 = (lon2 - lon1) * 111320 * Math.cos(((lat2+lat1)/2) * Math.PI/180);
      const y2 = (lat2 - lat1) * 110540;
      if(x2===0 && y2===0) return Math.hypot(x,y);
      const t = Math.max(0, Math.min(1, (x*x2 + y*y2)/(x2*x2 + y2*y2)));
      const projx = t*x2, projy=t*y2;
      return Math.hypot(x-projx, y-projy);
    };
    const rec = (pts) => {
      const a=pts[0], b=pts[pts.length-1];
      let maxd=-1, idx=-1;
      for(let i=1;i<pts.length-1;i++){
        const d=distPointSeg(pts[i],a,b);
        if(d>maxd){ maxd=d; idx=i; }
      }
      if(maxd>eps){
        const left = rec(pts.slice(0,idx+1));
        const right = rec(pts.slice(idx));
        return left.slice(0,-1).concat(right);
      }
      return [a,b];
    };
    return rec(points);
  };

  // ================== FLECHAS DE DIRECCIÓN EN LA RUTA ==================
  const bearingDeg = (lat1, lon1, lat2, lon2) => {
    const toRad = d => d*Math.PI/180;
    const toDeg = r => r*180/Math.PI;
    const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
    const brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  };

  const extractLineCoords = (geojson) => {
    if(!geojson) return [];
    if(geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)){
      for(const f of geojson.features){
        const g = f && f.geometry;
        if(g && g.type === 'LineString' && Array.isArray(g.coordinates)) return g.coordinates;
        if(g && g.type === 'MultiLineString' && Array.isArray(g.coordinates) && g.coordinates[0]) return g.coordinates[0];
      }
    }
    if(geojson.type === 'Feature' && geojson.geometry){
      const g = geojson.geometry;
      if(g.type === 'LineString') return g.coordinates || [];
      if(g.type === 'MultiLineString') return (g.coordinates && g.coordinates[0]) || [];
    }
    if(geojson.type === 'LineString') return geojson.coordinates || [];
    if(geojson.type === 'MultiLineString') return (geojson.coordinates && geojson.coordinates[0]) || [];
    return [];
  };

  const buildDirectionArrows = (geojson, count=10) => {
    // Devuelve un LayerGroup con ~count flechas '>' superpuestas a la ruta.
    try{
      const feat = (geojson && geojson.features && geojson.features[0]) ? geojson.features[0] : null;
      const coords = feat && feat.geometry && feat.geometry.coordinates ? feat.geometry.coordinates : null;
      if(!coords || coords.length < 2) return L.layerGroup();

      // Puntos como [lon,lat,(ele)]
      const pts = coords.map(c => ({ lon: c[0], lat: c[1] }));
      const n = pts.length;
      const group = L.layerGroup();

      // Índices repartidos evitando extremos
      const steps = Math.max(1, Math.floor((n-2) / (count+1)));
      const picked = [];
      for(let i=1; i<n-1 && picked.length < count; i += steps){
        picked.push(i);
      }

      for(const i of picked){
        const a = pts[Math.max(0, i-1)];
        const b = pts[Math.min(n-1, i+1)];
        const brng = bearingDeg(a.lat, a.lon, b.lat, b.lon);
        const ang = brng - 90; // '>' apunta al este

        const icon = L.divIcon({
          className: 'dir-arrow',
          html: `<div style="transform:rotate(${ang}deg);">&gt;</div>`,
          iconSize: [20,20],
          iconAnchor: [10,10]
        });

        const marker = L.marker([pts[i].lat, pts[i].lon], { icon, interactive: false });
        group.addLayer(marker);
      }

      return group;
    } catch {
      return L.layerGroup();
    }
  };


  // ================== COLORES POR CARPETA (paleta: azul, verde, rojo, marrón, …) ==================
  // Objetivo: carpeta 1 -> azul, carpeta 2 -> verde, carpeta 3 -> rojo, carpeta 4 -> marrón, etc.
  // La asignación depende del orden actual de carpetas (Sin carpeta primero, luego alfabético).
  const FOLDER_PALETTE_HUES = [
    210, // azul
    125, // verde
    5,   // rojo
    28,  // marrón
    275, // morado
    35,  // naranja
    175, // turquesa
    330, // rosa
    55,  // amarillo/mostaza
    200  // azul-cian
  ];

  const folderHueMap = new Map(); // folderKey -> hue

  const rebuildFolderHueMap = () => {
    folderHueMap.clear();

    // '' (Sin carpeta) siempre primero
    const ordered = [''].concat(FOLDERS.slice().sort((a,b)=>a.localeCompare(b,'es')));

    for(let i=0;i<ordered.length;i++){
      const folder = ordered[i];
      const baseHue = FOLDER_PALETTE_HUES[i % FOLDER_PALETTE_HUES.length];

      // si hay más carpetas que paleta, “variamos” un poco el tono por ciclos para evitar clones exactos
      const cycle = Math.floor(i / FOLDER_PALETTE_HUES.length);
      const hue = (baseHue + cycle * 12) % 360;

      folderHueMap.set(folder, hue);
    }
  };

  const getFolderHue = (folder) => {
    const key = normalizeFolder(folder);
    if(folderHueMap.has(key)) return folderHueMap.get(key);
    // fallback
    return 210;
  };

  const folderHeaderColor = (folder) => '#111827';
  const folderBorderColor = (folder) => '#111827';

  // Tonalidad por ruta: estable (depende del id), no cambia aunque ordenes.
  const hashInt = (s) => {
    const str = String(s || '');
    let hash = 0;
    for(let i=0;i<str.length;i++){
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
      hash |= 0;
    }
    return Math.abs(hash);
  };

  const routeLightness = (routeId) => {
    const minL = 34; // más oscuro
    const maxL = 88; // muy claro
    const x = (hashInt(routeId) % 1000) / 999; // 0..1
    return Math.round(maxL - (maxL - minL) * x);
  };

  const routeCardColor = (folder, routeId) => '#ffffff';
  const routeLineColor = (folder, routeId) => {
    return '#dc2626'; // rojo para todas las rutas
  };

    // ================== COLOR DEL PERFIL (CSS variables del plugin) ==================
  const colorToRgba = (cssColor, alpha) => {
    try{
      const probe = document.createElement('span');
      probe.style.color = cssColor;
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color; // "rgb(r, g, b)" o "rgba(r, g, b, a)"
      probe.remove();
      const mm = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(rgb);
      if(!mm) return `rgba(0,0,0,${alpha})`;
      return `rgba(${mm[1]}, ${mm[2]}, ${mm[3]}, ${alpha})`;
    } catch {
      return `rgba(0,0,0,${alpha})`;
    }
  };

  const setElevationThemeColor = (cssColor) => {
    // 1) Control (gráfico)
    const el = document.querySelector('.elevation-control');
    if(el){
      el.style.setProperty('--ele-area', cssColor);
      el.style.setProperty('--ele-stroke', cssColor);
      el.style.setProperty('--ele-poly', cssColor);
      el.style.setProperty('--ele-bg', colorToRgba(cssColor, 0.12));
      el.style.setProperty('--ele-brush', colorToRgba(cssColor, 0.25));
    }
    // 2) Contenedor del mapa (para el punto .elev-dot)
    const mapEl = document.getElementById('map');
    if(mapEl){
      mapEl.style.setProperty('--ele-area', cssColor);
    }
  };


  // Mantener el mapa “vivo” cuando el control de elevación cambia tamaño o dibuja el SVG
  const safeInvalidateMap = () => {
    try { map.invalidateSize(); } catch {}
  };


  // ================== CARPETAS ==================
  const normalizeFolder = (s) => (s || '').trim();
  const folderFromRoute = (r) => normalizeFolder(r.folder || '');

  const recomputeFoldersFromRoutes = () => {
    const set = new Set(FOLDERS.map(normalizeFolder).filter(Boolean));
    for(const r of ROUTES){
      const f = folderFromRoute(r);
      if(f) set.add(f);
    }
    FOLDERS = Array.from(set).sort((a,b)=>a.localeCompare(b,'es'));
  };

  const refreshFolderControls = () => {
    recomputeFoldersFromRoutes();

    rebuildFolderHueMap();

    const delSel = document.getElementById('folderToDelete');
    if(delSel){
      delSel.innerHTML = '';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = 'Selecciona carpeta…';
      delSel.appendChild(opt0);

      for(const f of FOLDERS){
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        delSel.appendChild(opt);
      }
    }
  };

  const fillFolderSelect = (selectEl, current='') => {
    if(!selectEl) return;
    recomputeFoldersFromRoutes();
    selectEl.innerHTML = '';

    const rootOpt = document.createElement('option');
    rootOpt.value = '';
    rootOpt.textContent = '— (Sin carpeta)';
    selectEl.appendChild(rootOpt);

    for(const f of FOLDERS){
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      selectEl.appendChild(opt);
    }

    selectEl.value = normalizeFolder(current);
  };

  document.getElementById('createFolder').addEventListener('click', () => {
    if(!requireEdit()) return;
    const name = normalizeFolder(prompt('Nombre de la carpeta:'));
    if(!name) return;
    if(FOLDERS.includes(name)) return alert('Esa carpeta ya existe.');
    FOLDERS.push(name);
    refreshFolderControls();
    renderList(groupedAndSorted());
          refreshAllArrows();
          scheduleSave(true);
  });

  document.getElementById('deleteFolder')
  .addEventListener('click', () => {
    if(!requireEdit()) return;
    const sel = document.getElementById('folderToDelete');
    const name = normalizeFolder(sel?.value);
    if(!name) return alert('Selecciona una carpeta.');

    if(!confirm(`¿Borrar la carpeta "${name}"?\n\nLas rutas se moverán a "Sin carpeta".`)) return;

    for(const r of ROUTES){
      if(folderFromRoute(r) === name) r.folder = '';
    }
    FOLDERS = FOLDERS.filter(f => f !== name);
    refreshFolderControls();
    renderList(groupedAndSorted());
    refreshAllArrows();
    scheduleSave(true);
  });

  // ================== ORDENACIÓN ==================
  const sortByEl = document.getElementById('sortBy');
  const sortDirEl = document.getElementById('sortDir');
  sortByEl.value = 'date';
  sortDirEl.value = 'desc';

  const getSortKey = (r) => {
    const by = sortByEl.value;
    if(by === 'distance') return Number(r.distance_km ?? 0);
    if(by === 'elevation') return Number(r.ascent_m ?? 0);
    return Date.parse(dateOnly(r.start_time)) || 0; // date
  };

  const applySort = (arr) => {
    const dir = sortDirEl.value === 'asc' ? 1 : -1;
    arr.sort((a,b) => {
      const ka = getSortKey(a);
      const kb = getSortKey(b);
      if(ka < kb) return -1 * dir;
      if(ka > kb) return  1 * dir;
      return String(a.name||a.id).localeCompare(String(b.name||b.id), 'es') * dir;
    });
    return arr;
  };

  sortByEl.addEventListener('change', () => renderList(groupedAndSorted()));
  sortDirEl.addEventListener('change', () => renderList(groupedAndSorted()));

  // ================== MODAL EDITAR ==================
  let modalRouteId = null;

  const openModal = (route) => {
    if(!requireEdit()) return;
    modalRouteId = route.id;
    document.getElementById('m_name').value = route.name ?? '';
    document.getElementById('m_with').value = route.with_whom ?? '';
    document.getElementById('m_distance').value = route.distance_km ?? '';
    document.getElementById('m_ascent').value = route.ascent_m ?? '';
    document.getElementById('m_date').value = (dateOnly(route.start_time) !== '—') ? dateOnly(route.start_time) : '';
    fillFolderSelect(document.getElementById('m_folder'), route.folder || '');
    document.getElementById('modalBackdrop').style.display = 'flex';
  };

  const closeModal = () => {
    modalRouteId = null;
    document.getElementById('modalBackdrop').style.display = 'none';
  };

  document.getElementById('m_cancel').addEventListener('click', closeModal);

  document.getElementById('m_save').addEventListener('click', () => {
    if(!requireEdit()) return;
    const r = ROUTES.find(x => x.id === modalRouteId);
    if(!r) return closeModal();

    r.name = document.getElementById('m_name').value.trim() || r.id;
    r.with_whom = document.getElementById('m_with').value.trim() || '';
    r.folder = normalizeFolder(document.getElementById('m_folder').value);

    const d = Number(document.getElementById('m_distance').value);
    const a = Number(document.getElementById('m_ascent').value);
    if(!Number.isNaN(d)) r.distance_km = d;
    if(!Number.isNaN(a)) r.ascent_m = a;

    const dd = document.getElementById('m_date').value;
    if(dd) r.start_time = `${dd}T00:00:00Z`;

    refreshFolderControls();
    renderList(groupedAndSorted());
    refreshAllArrows();
    scheduleSave(true);
    closeModal();
  });

  document.getElementById('modalBackdrop').addEventListener('click', (ev) => {
    if(ev.target.id === 'modalBackdrop') closeModal();
  });

  // ================== AGRUPAR + FILTRAR ==================
  const getSearchTerm = () => document.getElementById('q').value.trim().toLowerCase();

  const getFilteredRoutes = () => {
    const term = getSearchTerm();
    if(!term) return ROUTES.slice();
    return ROUTES.filter(r => (r.name || '').toLowerCase().includes(term));
  };

  const groupedAndSorted = () => {
    recomputeFoldersFromRoutes();
    const filtered = getFilteredRoutes();

    const groups = new Map();
    for(const r of filtered){
      const f = folderFromRoute(r);
      if(!groups.has(f)) groups.set(f, []);
      groups.get(f).push(r);
    }

    for(const [k, arr] of groups.entries()){
      applySort(arr);
    }

    const folderKeys = Array.from(groups.keys()).sort((a,b)=>a.localeCompare(b,'es'));
    folderKeys.sort((a,b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b,'es')));

    return { groups, folderKeys, totalFiltered: filtered.length };
  };

  // ================== LISTA (plegable) ==================
  const folderOpenState = new Map(); // folderKey -> boolean
  const ensureFolderState = (folderKey) => {
    if(!folderOpenState.has(folderKey)) folderOpenState.set(folderKey, true);
    return folderOpenState.get(folderKey);
  };

  const renderList = ({ groups, folderKeys, totalFiltered }) => {
    const list = document.getElementById('list');
    list.innerHTML = '';

    updateRouteCounter();
    refreshFolderControls();

    for(const folder of folderKeys){
      const routes = groups.get(folder) || [];
      const folderLabel = folder ? folder : 'Sin carpeta';

      const details = document.createElement('details');
      details.className = 'folder';
      details.open = ensureFolderState(folder);

      const summary = document.createElement('summary');
      summary.style.background = folderHeaderColor(folder);
      summary.style.borderBottom = `1px solid ${folderBorderColor(folder)}`;
      summary.innerHTML = `
        ${normalizeFolder(folder) ? `<span class="folder-name">${escapeHtml(folderLabel)}</span>` : `<span class="folder-name" style="color:#111827;">${escapeHtml(folderLabel)}</span>`}
        ${normalizeFolder(folder) ? `<span class="folder-count">${routes.length} rutas</span>` : `<span class="folder-count" style="color:#111827;opacity:.75;">${routes.length} rutas</span>`}
      `;
      details.appendChild(summary);

      details.addEventListener('toggle', () => {
        folderOpenState.set(folder, details.open);
      });

      const body = document.createElement('div');
      body.className = 'folder-body';
      details.appendChild(body);

      for(const r of routes){
        const div = document.createElement('div');
        div.className = 'route';

        const checked = layersById.has(r.id);
        const withTxt = (r.with_whom && r.with_whom.trim()) ? r.with_whom.trim() : '—';

        const cardBg = routeCardColor(folder, r.id);
        if(cardBg) div.style.background = cardBg; else div.style.background = '#ffffff';

        div.innerHTML = `
          <div class="row" style="justify-content:space-between">
            <h3 title="${r.id}">${escapeHtml(r.name || r.id)}</h3>
            <div class="row">
              <button class="btn" data-action="view" data-id="${r.id}">Ver</button>
              <label class="row" style="gap:6px; font-size:12px;">
                <input type="checkbox" data-action="toggle" data-id="${r.id}" ${checked ? 'checked':''} />
                Mostrar
              </label>
            </div>
          </div>

          <div class="meta">
            Con quién: <b>${escapeHtml(withTxt)}</b><br/>
            Longitud: <b>${fmtKm(r.distance_km)}</b> · Elevación+: <b>${fmtM(r.ascent_m)}</b><br/>
            Fecha: ${dateOnly(r.start_time)}
          </div>

          <div class="row" style="margin-top:10px; justify-content:space-between;">
            <div class="row" style="flex: 1;">
              <span style="font-size:12px; color:#374151;">Carpeta</span>
              <select class="select-small" data-action="move" data-id="${r.id}" aria-label="Mover a carpeta"></select>
            </div>
            <div class="row">
              <button class="btn" data-action="edit" data-id="${r.id}">✏️ Editar</button>
              <button class="btn danger" data-action="delete" data-id="${r.id}">🗑 Borrar</button>
            </div>
          </div>
        `;

        // selector mover carpeta
        const moveSel = div.querySelector('select[data-action="move"]');
        if(moveSel) moveSel.disabled = !EDIT_UNLOCKED;
        fillFolderSelect(moveSel, r.folder || '');
        const eb = div.querySelector('button[data-action="edit"]');
        if(eb) { eb.disabled = !EDIT_UNLOCKED; eb.title = !EDIT_UNLOCKED ? 'Modo solo lectura' : ''; }
        const db = div.querySelector('button[data-action="delete"]');
        if(db) { db.disabled = !EDIT_UNLOCKED; db.title = !EDIT_UNLOCKED ? 'Modo solo lectura' : ''; }
        moveSel.addEventListener('change', () => {
          if(!requireEdit()) { moveSel.value = normalizeFolder(r.folder || ''); return; }
          const oldFolder = folderFromRoute(r);
          r.folder = normalizeFolder(moveSel.value);
          // mantener abiertas ambas carpetas para que se vea el cambio
          folderOpenState.set(oldFolder, true);
          folderOpenState.set(folderFromRoute(r), true);
          refreshFolderControls();
          renderList(groupedAndSorted());
    refreshAllArrows();
        });

        // acciones
        div.addEventListener('click', (ev) => {
          const btn = ev.target.closest('[data-action]');
          if(!btn) return;

          const action = btn.dataset.action;
          const id = btn.dataset.id;

          if(action === 'view'){
            ev.preventDefault();
            viewRoute(id);
          } else if(action === 'edit'){
            ev.preventDefault();
            const rr = ROUTES.find(x=>x.id===id);
            if(rr) openModal(rr);
          } else if(action === 'delete'){
            ev.preventDefault();
            deleteRoute(id);
          }
        });

        div.querySelector('input[type="checkbox"]').addEventListener('change', async (ev) => {
          await toggleRoute(r.id, ev.target.checked);
          renderList(groupedAndSorted());    refreshAllArrows(); // refresca checks
        });

        body.appendChild(div);
      }

      list.appendChild(details);
    }
  };

  
  const clearArrows = (routeId) => {
    const g = arrowLayersById.get(routeId);
    if(g){
      try { map.removeLayer(g); } catch {}
      arrowLayersById.delete(routeId);
    }
  };

  const updateArrowsForRoute = async (routeId) => {
    const r = ROUTES.find(x=>x.id===routeId);
    if(!r) return;

    if(!SHOW_ARROWS || !layersById.has(routeId)){
      clearArrows(routeId);
      return;
    }
    if(arrowLayersById.has(routeId)) return;

    const gj = await fetchGeoJSONForRoute(r);
    const group = buildDirectionArrows(gj, 10);
    group.addTo(map);
    arrowLayersById.set(routeId, group);
  };

  const refreshAllArrows = async () => {
    if(!SHOW_ARROWS){
      for(const rid of Array.from(arrowLayersById.keys())) clearArrows(rid);
      return;
    }
    for(const rid of Array.from(layersById.keys())){
      await updateArrowsForRoute(rid);
    }
  };
// ================== GEOJSON / MAPA / PERFIL ==================
  const fetchGeoJSONForRoute = async (route) => {
    if(geojsonCache.has(route.id)) return geojsonCache.get(route.id).geojson;

    // Normaliza "file": debe ser string. Si no lo es, intenta extraer/derivar ruta.
    const url = (typeof route.file === 'string' && route.file)
      ? route.file
      : (route.file && typeof route.file === 'object' && (route.file.url || route.file.href || route.file.path))
        ? (route.file.url || route.file.href || route.file.path)
        : (route.export_file || `data/${route.id}.geojson`);

    const res = await fetch(url);
    if(!res.ok) throw new Error(`No se pudo cargar ${url} (${res.status})`);

    const gj = await res.json();
    geojsonCache.set(route.id, { geojson: gj, filename: `${route.id}.geojson` });

    const blob = new Blob([JSON.stringify(gj)], { type: 'application/geo+json' });
    const blobUrl = URL.createObjectURL(blob);
    blobUrls.set(route.id, blobUrl);

    return gj;
  };

  const showElevation = (id) => {
    const r = ROUTES.find(x=>x.id===id);
    if(!r) return;

    // Mostrar el control (por defecto está oculto)
    document.body.classList.add('show-elevation');

    const folder = folderFromRoute(r);
    const lineColor = routeLineColor(folder, r.id);

    activeRouteId = id;

    // Color del perfil + marcador (igual que la ruta seleccionada)
    setElevationThemeColor('#dc2626');

    // IMPORTANTE: algunos builds del plugin al hacer clear() pueden tocar capas del mapa.
    // Nosotros repintamos siempre nuestra ruta después, para garantizar que se vea.
    try { elev.clear(); } catch {}

    // Cargar datos (usamos blob si existe; si no, URL del geojson)
    const url = blobUrls.get(id) || (typeof r.file === 'string' ? r.file : (r.export_file || `data/${r.id}.geojson`));
    try { elev.load(url); } catch (err) { console.warn('Error elev.load', err); }

    // Asegura que la ruta sigue dibujada en el mapa (por si el plugin la hubiera tocado)
    const layer = layersById.get(id);
    if(layer && !map.hasLayer(layer)) {
      try { layer.addTo(map); } catch {}
    }
    if(layer) try { layer.bringToFront(); } catch {}

    safeInvalidateMap();
  };

  const viewRoute = async (id) => {
    const r = ROUTES.find(x=>x.id===id);
    if(!r) return;

    // Si no está visible aún, la mostramos
    if(!layersById.has(id)){
      try { await toggleRoute(id, true); } catch (err) { console.error(err); return; }
    }

    try { fitBBox(r.bbox); } catch {}
    const layer = layersById.get(id);
    if(layer) try { layer.bringToFront(); } catch {}

    // Cargar/mostrar perfil para esta ruta
    showElevation(id);

    safeInvalidateMap();
  };

  const toggleRoute = async (id, turnOn) => {
    const r = ROUTES.find(x=>x.id===id);
    if(!r) return;

    const folder = folderFromRoute(r);
    const lineColor = routeLineColor(folder, r.id);
    const arrowColor = lineColor || '#111827';

    if(turnOn){
      if(layersById.has(id)) return;
      let gj;
      try {
        gj = await fetchGeoJSONForRoute(r);
      } catch (err) {
        console.error('No se pudo cargar GeoJSON de la ruta', r, err);
        alert(`No se pudo cargar el fichero de la ruta:
${r.file || r.export_file || ('data/' + r.id + '.geojson')}

Revisa que exista en /data y que el servidor lo sirva.`);
        return;
      }
      const layer = L.geoJSON(gj, { style: { color: lineColor, weight: 4, opacity: 0.95 } }).addTo(map);
      layersById.set(id, layer);
      fitBBox(r.bbox);
      await updateArrowsForRoute(id);
    } else {
      const layer = layersById.get(id);
      if(layer){
        map.removeLayer(layer);
        layersById.delete(id);
      }

      if(activeRouteId === id){
        activeRouteId = null;
        try { elev.clear(); } catch {}
        const cont = (typeof elev.getContainer === 'function') ? elev.getContainer() : elev._container;
        document.body.classList.remove('show-elevation');
      }
      clearArrows(id);
    }

    safeInvalidateMap();
  };

  const deleteRoute = (id) => {
    if(!requireEdit()) return;
    const r = ROUTES.find(x=>x.id===id);
    if(!r) return;
    if(!confirm(`¿Borrar la ruta "${r.name}"?`)) return;

    const layer = layersById.get(id);
    if(layer){
      map.removeLayer(layer);
      layersById.delete(id);
    }

    if(activeRouteId === id){
      activeRouteId = null;
    try { elev.clear(); } catch {}
    const cont = (typeof elev.getContainer === 'function') ? elev.getContainer() : elev._container;
    document.body.classList.remove('show-elevation');
    }

    if(blobUrls.has(id)){
      URL.revokeObjectURL(blobUrls.get(id));
      blobUrls.delete(id);
    }

    geojsonCache.delete(id);
    ROUTES = ROUTES.filter(x=>x.id!==id);

    updateRouteCounter();
    refreshFolderControls();
    renderList(groupedAndSorted());
    refreshAllArrows();
    scheduleSave(true);
  };

  // ================== MOSTRAR / OCULTAR TODAS ==================
  document.getElementById('showAll').addEventListener('click', async () => {
    const term = getSearchTerm();
    const toShow = term ? getFilteredRoutes() : ROUTES.slice();

    for(const r of toShow){
      if(!layersById.has(r.id)){
        await toggleRoute(r.id, true);
      }
    }
    renderList(groupedAndSorted());
    refreshAllArrows();
  });

  document.getElementById('hideAll').addEventListener('click', () => {
    for(const [id, layer] of layersById.entries()){
      map.removeLayer(layer);
    }
    layersById.clear();
    for(const [rid, grp] of arrowLayersById.entries()){
      try { map.removeLayer(grp); } catch {}
    }
    arrowLayersById.clear();
    activeRouteId = null;
    elev.clear();
    renderList(groupedAndSorted());
    refreshAllArrows();
  });

  // ================== FLECHAS (toggle) ==================
  const arrowsCheckbox = document.getElementById('toggleArrows');
  if(arrowsCheckbox){
    arrowsCheckbox.checked = false; // por defecto NO se ven
    arrowsCheckbox.addEventListener('change', async () => {
      SHOW_ARROWS = !!arrowsCheckbox.checked;
      refreshAllArrows();
    });
  }

  // ================== BUSCADOR ==================
  document.getElementById('q').addEventListener('input', () => {
    renderList(groupedAndSorted());
    refreshAllArrows();
  });

  // ================== AÑADIR GPX ==================
  document.getElementById('addGpx').addEventListener('change', async (ev) => {
    if(!requireEdit()) { try { ev.target.value=''; } catch {} return; }
    const files = Array.from(ev.target.files || []);
    if(!files.length) return;

    for(const f of files){
      try{
        const route = await gpxFileToRoute(f);
        ROUTES.push(route);
      } catch(err){
        console.error('Error importando GPX:', f.name, err);
        alert(`No se pudo importar ${f.name}. Mira la consola para más detalles.`);
      }
    }

    updateRouteCounter();
    refreshFolderControls();
    renderList(groupedAndSorted());
    refreshAllArrows();
    scheduleSave(true);
    ev.target.value = '';
  });

  const gpxFileToRoute = async (file) => {
    const text = await file.text();
    const dom = new DOMParser().parseFromString(text, 'application/xml');

    const nameNode = dom.querySelector('trk > name');
    const name = (nameNode?.textContent || file.name.replace(/\.gpx$/i,'')).trim();

    const trkpts = Array.from(dom.querySelectorAll('trkpt'));
    if(!trkpts.length) throw new Error('GPX sin trkpt');

    const pts = trkpts.map(pt => {
      const lat = Number(pt.getAttribute('lat'));
      const lon = Number(pt.getAttribute('lon'));
      const ele = Number(pt.querySelector('ele')?.textContent || 0);
      const time = pt.querySelector('time')?.textContent || null;
      return { lat, lon, ele, time };
    });

    let dist = 0, asc = 0;
    const ELE_THRESHOLD = 1.0;
    for(let i=1;i<pts.length;i++){
      dist += haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
      const d = pts[i].ele - pts[i-1].ele;
      if(d >= ELE_THRESHOLD) asc += d;
    }

    const times = pts.map(p=>p.time).filter(Boolean);
    const start_time = times[0] || null;

    const pts2d = pts.map(p => [p.lon, p.lat]);
    const simplified2d = simplifyDP(pts2d, 5);
    const eleByKey = new Map(pts.map(p => [`${p.lon},${p.lat}`, p.ele]));
    const coords3d = simplified2d.map(([lon,lat]) => [lon, lat, eleByKey.get(`${lon},${lat}`) ?? 0]);

    const lons = coords3d.map(c=>c[0]);
    const lats = coords3d.map(c=>c[1]);
    const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];

    const baseId = sanitizeId(file.name);
    const id = uniqueId(baseId);

    const geojson = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { id, name },
        geometry: { type: "LineString", coordinates: coords3d }
      }],
      bbox
    };

    geojsonCache.set(id, { geojson, filename: `${id}.geojson` });
    const blob = new Blob([JSON.stringify(geojson)], { type:'application/geo+json' });
    const url = URL.createObjectURL(blob);
    blobUrls.set(id, url);

    return {
      __remote_added: true,
      id,
      name,
      with_whom: "",
      folder: "",
      file: url,
      export_file: `data/${id}.geojson`,
      distance_km: Math.round((dist/1000)*1000)/1000,
      ascent_m: Math.round(asc*10)/10,
      start_time,
      bbox
    };
  };

  // ================== EXPORTAR ZIP ==================
  document.getElementById('exportZip').addEventListener('click', async () => {
    if(!requireEdit()) return;
    try{
      const zip = new JSZip();

      // 1) folders.json (para conservar carpetas vacías)
      recomputeFoldersFromRoutes();
      zip.file("folders.json", JSON.stringify(FOLDERS, null, 2));

      // 2) routes.json
      const routesForExport = ROUTES.map(r => {
        const filePath = r.export_file || `data/${r.id}.geojson`;
        const out = { ...r, file: filePath };
        delete out.export_file;
        return out;
      });

      zip.file("routes.json", JSON.stringify(routesForExport, null, 2));

      // 3) data/*.geojson
      const dataFolder = zip.folder("data");

      for(const r of ROUTES){
        const filename = `${r.id}.geojson`;

        if(geojsonCache.has(r.id)){
          dataFolder.file(filename, JSON.stringify(geojsonCache.get(r.id).geojson));
          continue;
        }

        const src = `data/${r.id}.geojson`;
        const res = await fetch(src);
        if(!res.ok) throw new Error(`No se pudo leer ${src} (${res.status})`);
        dataFolder.file(filename, await res.text());
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = "rutas_export.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);

      alert("ZIP exportado (rutas_export.zip).");
    } catch(err){
      console.error(err);
      alert("Error exportando ZIP. Mira la consola para más detalles.");
    }
  });

  // ================== START ==================
  const loadFolders = async () => {
    try{
      const res = await fetch('folders.json');
      if(!res.ok) return [];
      const data = await res.json();
      if(Array.isArray(data)) return data.map(normalizeFolder).filter(Boolean);
      return [];
    } catch {
      return [];
    }
  };

  const loadRoutes = async () => {
    const res = await fetch('routes.json');
    const data = await res.json();
    if(!Array.isArray(data)) throw new Error('routes.json debe ser un array');
    ROUTES = data;

    // backfill: compatibilidad
    for(const r of ROUTES){
      if(r.with_whom === undefined) r.with_whom = "";
      if(r.folder === undefined) r.folder = "";
    }
  };

  const start = async () => {
    FOLDERS = await loadFolders();
    await loadRoutes();

    refreshFolderControls();

    // Sincroniza modo edición con la sesión actual (si estabas logueado)
    await syncEditModeWithSession();

    // Carga el estado remoto (carpetas + cambios) desde Supabase (si existe)
    try {
      const remote = await loadRemoteState();
      if(remote) await applyRemoteState(remote);
    } catch (e) {
      console.warn('Supabase: no se pudo aplicar estado remoto', e);
    }

    refreshFolderControls();

    const all = ROUTES.flatMap(r => ([
      [r.bbox[1], r.bbox[0]],
      [r.bbox[3], r.bbox[2]]
    ]));
    if(all.length) map.fitBounds(all);

    updateRouteCounter();
    renderList(groupedAndSorted());
    refreshAllArrows();
  };

  window.addEventListener('resize', () => { safeInvalidateMap(); });

  // Best effort: intentar guardar antes de cerrar/recargar (no siempre garantizado)
  window.addEventListener('beforeunload', (ev) => {
    try {
      if(EDIT_UNLOCKED) {
        // Dispara guardado inmediato; supabase-js usa fetch, intentamos keepalive con un upsert manual
        if(supabaseReady()){
          const state = buildRemoteState();
          const key = (SUPABASE_ANON_KEY || SUPABASE_LEGACY_ANON_KEY);
          const url = `${SUPABASE_URL}/rest/v1/rutas_state?on_conflict=id`;
          const body = JSON.stringify([{ id: STATE_ID, owner: null, state }]);
          // owner se rellenará por RLS? No, así que solo hacemos esto si no hay sesión no sirve.
          // Si hay sesión, añadimos Authorization del access_token.
          sb.auth.getSession().then(({data})=>{
            const token = data?.session?.access_token;
            if(!token) return;
            fetch(url, {
              method:'POST',
              headers:{
                'apikey': key,
                'Authorization': `Bearer ${token}`,
                'Content-Type':'application/json',
                'Prefer':'resolution=merge-duplicates'
              },
              body,
              keepalive:true
            }).catch(()=>{});
          }).catch(()=>{});
        }
      }
    } catch {}
  });


  start().catch(err => {
    console.error(err);
    alert("No se pudo cargar routes.json (o folders.json). Revisa consola/Network.");
  });
});