// Tiempo por pedido: cuánto tarda armar cada sucursal y cuánto tardarían 1, 2 o 3 personas.
// Se apoya en "eventosArmado" (una marca por artículo armado: hora, persona, sucursal y cantidades).
// Un PEDIDO es una sucursal en un día. Lo pueden armar una o varias personas.

const MIN = 60000;

export const CFG_INICIAL = {
  umbralDemora: 5,     // hasta estos minutos entre dos marcas = trabajo activo
  umbralPausa: 20,     // entre umbralDemora y este = demora (parte del trabajo); más = pausa
  tolerancia: 15,      // % que se suma al tiempo activo: necesidades personales, fatiga, demoras inevitables
  inicio: '07:00',     // hora a la que empieza el turno (para decir "terminan a las ...")
  descansos: [{ nombre: 'Desayuno', despues: 120, dura: 15 }, { nombre: 'Almuerzo', despues: 240, dura: 30 }],  // "después de N minutos de trabajo"
  par: { 2: { recargo: null, desbalance: null }, 3: { recargo: null, desbalance: null } }   // % escritos a mano; null = lo medido (o lo supuesto si todavía no hay datos)
};
// si todavía no hay pedidos armados entre varias personas para medirlo, se supone esto
export const PARALELO_SUPUESTO = { 1: { recargo: 1, desbalance: 1 }, 2: { recargo: 1.05, desbalance: 1.10 }, 3: { recargo: 1.10, desbalance: 1.20 } };

const suma = a => a.reduce((s, x) => s + x, 0);
export const mediana = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fechaLocal = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// ============================================================ 1) de las marcas a los pedidos
// eventos: [{ timestampMs, personaDocumento, personaNombre, sucursal, codigo, cantidadArmada, diferencia }]
export function agruparPedidos(eventos, cfg) {
  const uD = cfg.umbralDemora * MIN, uP = cfg.umbralPausa * MIN, grupos = new Map();
  for (const ev of eventos) {
    if (!ev.timestampMs) continue;
    const suc = ev.sucursal || '(sin sucursal)', dia = fechaLocal(ev.timestampMs), k = dia + '|' + suc;
    let g = grupos.get(k); if (!g) grupos.set(k, g = { dia, sucursal: suc, evs: [] });
    g.evs.push(ev);
  }
  return [...grupos.values()].map(g => {
    g.evs.sort((a, b) => a.timestampMs - b.timestampMs);
    const porPersona = new Map(), codigos = new Set(); let unidades = 0, sinStock = 0;
    g.evs.forEach((ev, i) => {
      const id = ev.personaDocumento || ev.personaNombre || '?';
      let p = porPersona.get(id); if (!p) porPersona.set(id, p = { id, nombre: ev.personaNombre || id, evs: [] });
      p.evs.push(ev);
      codigos.add(ev.codigo || ev.producto || ('?' + i));
      const u = Number(ev.cantidadArmada); if (u > 0) unidades += u;
      if (ev.diferencia === 'Falta de stock') sinStock++;
    });
    const personas = [...porPersona.values()].map(p => {
      let activo = 0, demora = 0, pausa = 0, nDemoras = 0, nPausas = 0, gapsActivos = 0;
      for (let i = 1; i < p.evs.length; i++) {
        const gap = p.evs[i].timestampMs - p.evs[i - 1].timestampMs;
        if (gap <= uD) { activo += gap; gapsActivos++; } else if (gap <= uP) { demora += gap; nDemoras++; } else { pausa += gap; nPausas++; }
      }
      // N marcas seguidas tienen N-1 intervalos: la primera no tiene una anterior. Se suma un artículo promedio por persona, para que el tiempo sea proporcional a los artículos.
      const trabajo = activo + (gapsActivos ? activo / gapsActivos : 0);
      return { id: p.id, nombre: p.nombre, picks: p.evs.length, activoMs: activo, trabajoMs: trabajo, demoraMs: demora, pausaMs: pausa, nDemoras, nPausas, desde: p.evs[0].timestampMs, hasta: p.evs[p.evs.length - 1].timestampMs };
    }).sort((a, b) => b.picks - a.picks);
    const participan = personas.filter(p => p.picks >= 5).length;       // una marca suelta de otra persona no cuenta como "equipo"
    const desde = g.evs[0].timestampMs, hasta = g.evs[g.evs.length - 1].timestampMs;
    return { dia: g.dia, sucursal: g.sucursal, picks: g.evs.length, lineas: codigos.size, unidades, sinStock, personas, k: Math.max(1, participan),
      activoMs: suma(personas.map(p => p.activoMs)), trabajoMs: suma(personas.map(p => p.trabajoMs)), demoraMs: suma(personas.map(p => p.demoraMs)), pausaMs: suma(personas.map(p => p.pausaMs)), desde, hasta, relojMs: hasta - desde };
  }).sort((a, b) => b.dia.localeCompare(a.dia) || a.sucursal.localeCompare(b.sucursal));
}

// ============================================================ 2) el modelo: tiempo activo = fijo + min/artículo × artículos + min/unidad × unidades
function resolver(filas, w, usar) {   // mínimos cuadrados ponderados; devuelve [a, b, c] (0 en los términos no usados) o null
  const cols = []; if (usar[0]) cols.push(() => 1); if (usar[1]) cols.push(f => f.lineas); if (usar[2]) cols.push(f => f.unidades);
  const n = cols.length, A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  filas.forEach((f, i) => { const x = cols.map(c => c(f)); for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += w[i] * x[r] * x[c]; A[r][n] += w[i] * x[r] * f.y; } });
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-9) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  const sol = A.map((fila, i) => fila[n] / fila[i]), out = [0, 0, 0]; let j = 0;
  [0, 1, 2].forEach(i => { if (usar[i]) out[i] = sol[j++]; });
  return out;
}
function robusto(filas, usar) {   // reponderación de Huber: los días raros no arrastran el ajuste
  let w = filas.map(() => 1), coef = resolver(filas, w, usar);
  for (let it = 0; it < 8 && coef; it++) {
    const r = filas.map(f => f.y - (coef[0] + coef[1] * f.lineas + coef[2] * f.unidades)), med = mediana(r), s = 1.4826 * mediana(r.map(x => Math.abs(x - med))) || 1e-6, k = 1.345 * s;
    w = r.map(x => Math.abs(x) <= k ? 1 : k / Math.abs(x));
    const nuevo = resolver(filas, w, usar); if (!nuevo) break; coef = nuevo;
  }
  return coef;
}
export const predecir = (m, lineas, unidades, factor = 1) => Math.max(0, m.a + m.b * lineas + m.c * unidades) * factor;

export function ajustarModelo(pedidos) {
  const base = pedidos.filter(p => p.lineas >= 5 && p.trabajoMs > 0), solos = base.filter(p => p.k <= 1);
  const usados = solos.length >= 15 ? solos : base;                      // lo ideal es ajustar con pedidos armados por una sola persona
  const filas = usados.map(p => ({ lineas: p.lineas, unidades: p.unidades, y: p.trabajoMs / MIN }));
  if (filas.length < 3) return null;
  let usar = filas.length < 12 ? [false, true, false] : [true, true, true], coef = null;   // con pocos datos: solo minutos por artículo
  for (let i = 0; i < 4; i++) {
    coef = robusto(filas, usar);
    if (!coef) { usar = [false, true, false]; continue; }
    const neg = [0, 1, 2].find(j => usar[j] && coef[j] < 0);                // un tiempo negativo no tiene sentido: se saca ese término y se reajusta
    if (neg === undefined) break;
    usar[neg] = false; if (!usar[1] && !usar[2]) usar = [false, true, false];
  }
  if (!coef) return null;
  const corr = (xs, ys) => { const n = xs.length, mx = suma(xs) / n, my = suma(ys) / n, sxy = suma(xs.map((x, i) => (x - mx) * (ys[i] - my))), sxx = suma(xs.map(x => (x - mx) ** 2)), syy = suma(ys.map(y => (y - my) ** 2)); return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0; };
  const rho = corr(filas.map(f => f.lineas), filas.map(f => f.unidades));
  const pred = f => coef[0] + coef[1] * f.lineas + coef[2] * f.unidades, media = suma(filas.map(f => f.y)) / filas.length;
  const ssRes = suma(filas.map(f => (f.y - pred(f)) ** 2)), ssTot = suma(filas.map(f => (f.y - media) ** 2));
  const ratios = filas.map(f => f.y / pred(f)).filter(x => isFinite(x) && x > 0).sort((x, y) => x - y);
  const q = p => ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))] : 1;
  return { a: coef[0], b: coef[1], c: coef[2], n: filas.length, soloUnaPersona: usados === solos, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    mape: suma(filas.map(f => Math.abs(f.y - pred(f)) / f.y)) / filas.length, p20: q(0.2), p80: q(0.8), terminos: usar.filter(Boolean).length, rho, uPorArt: suma(filas.map(f => f.unidades)) / Math.max(1, suma(filas.map(f => f.lineas))) };
}

// qué tan bien estima el modelo CON el factor de cada sucursal (que es lo que se usa para estimar)
export function calidadModelo(pedidos, modelo, factores) {
  const base = pedidos.filter(p => p.lineas >= 5 && p.trabajoMs > 0), solos = base.filter(p => p.k <= 1), usados = modelo.soloUnaPersona ? solos : base;
  const f = p => (factores[p.sucursal] || { factor: 1 }).factor, filas = usados.map(p => ({ y: p.trabajoMs / MIN, e: predecir(modelo, p.lineas, p.unidades, f(p)) })).filter(x => x.e > 0);
  if (!filas.length) return { n: 0, r2: 0, mape: 0, p20: 1, p80: 1 };
  const media = suma(filas.map(x => x.y)) / filas.length, ssRes = suma(filas.map(x => (x.y - x.e) ** 2)), ssTot = suma(filas.map(x => (x.y - media) ** 2));
  const ratios = filas.map(x => x.y / x.e).sort((a, b) => a - b), q = p => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
  return { n: filas.length, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, mape: suma(filas.map(x => Math.abs(x.y - x.e) / x.y)) / filas.length, p20: q(0.2), p80: q(0.8) };
}

// cada sucursal es un poco distinta (distancias, embalaje): factor = qué tanto más o menos tarda que el modelo, con poco peso si hay pocos pedidos
export function factoresSucursal(pedidos, modelo) {
  const por = {};
  pedidos.filter(p => p.lineas >= 5 && p.trabajoMs > 0 && p.k <= 1).forEach(p => { const e = predecir(modelo, p.lineas, p.unidades); if (e > 0) (por[p.sucursal] = por[p.sucursal] || []).push(p.trabajoMs / MIN / e); });
  const out = {}; Object.keys(por).forEach(s => { const r = por[s], n = r.length, m = mediana(r); out[s] = { n, bruto: m, factor: 1 + (m - 1) * n / (n + 6) }; });
  return out;
}

// ============================================================ 3) cuando lo arman varias personas
// recargo: cuánto más trabajo total hay que hacer cuando se reparten el pedido (se pisan, caminan más); desbalance: cuánto más tarda el más lento que el promedio
export function medirParalelo(pedidos, modelo, factores) {
  const out = {};
  [2, 3].forEach(k => {
    const rec = [], des = [];
    pedidos.filter(p => p.k === k && p.lineas >= 8 && p.trabajoMs > 0).forEach(p => {
      const act = p.personas.filter(x => x.picks >= 5).map(x => x.trabajoMs); if (act.length < 2) return;
      const e = predecir(modelo, p.lineas, p.unidades, (factores[p.sucursal] || { factor: 1 }).factor);
      if (e > 0) rec.push(p.trabajoMs / MIN / e);
      des.push(Math.max(...act) / (suma(act) / act.length));
    });
    out[k] = { n: rec.length, recargoMedido: rec.length >= 3 ? Math.min(1.5, Math.max(0.9, mediana(rec))) : null, desbalanceMedido: des.length >= 3 ? Math.max(1, mediana(des)) : null };
  });
  return out;
}
export function parametrosParalelo(medido, manual) {
  const p = { 1: { recargo: 1, desbalance: 1, origenRecargo: '', origenDesbalance: '', n: 0 } };
  const elegir = (man, med, sup) => (man != null && man !== '' && isFinite(man) && 1 + man / 100 > 0.1) ? { v: 1 + man / 100, o: 'manual' } : med != null ? { v: med, o: 'medido' } : { v: sup, o: 'supuesto' };
  [2, 3].forEach(k => {
    const m = (medido && medido[k]) || {}, o = (manual && manual[k]) || {};
    const r = elegir(o.recargo, m.recargoMedido, PARALELO_SUPUESTO[k].recargo), d = elegir(o.desbalance, m.desbalanceMedido, PARALELO_SUPUESTO[k].desbalance);
    p[k] = { recargo: r.v, origenRecargo: r.o, desbalance: d.v, origenDesbalance: d.o, n: m.n || 0, medidoRecargo: m.recargoMedido ?? null, medidoDesbalance: m.desbalanceMedido ?? null };
  });
  return p;
}

// ============================================================ 4) escenarios: 1, 2 o 3 personas
export const conDescansos = (trabajoMin, descansos) => trabajoMin + suma(descansos.filter(d => trabajoMin > d.despues).map(d => d.dura));
// reparten el trabajo entre k personas, paso por paso: recargo por ser varios, se divide, el más lento tarda más, tolerancias, descansos
export function detalleDividido(total, k, par, cfg) {
  const p = par[k] || { recargo: 1, desbalance: 1 }, recargo = k === 1 ? 1 : p.recargo, desbalance = k === 1 ? 1 : p.desbalance;
  const conRecargo = total * recargo, porPersona = conRecargo / k, masLento = porPersona * desbalance, trabajo = masLento * (1 + cfg.tolerancia / 100);
  const descansos = cfg.descansos.filter(d => trabajo > d.despues), descansosMin = suma(descansos.map(d => d.dura));
  return { k, total, recargo, conRecargo, porPersona, desbalance, masLento, tolerancia: cfg.tolerancia, trabajo, descansos, descansosMin, reloj: trabajo + descansosMin };
}
export function escenarioDividido(esfuerzos, k, par, cfg) { const d = detalleDividido(suma(esfuerzos), k, par, cfg); return { k, activoMin: d.masLento, trabajoMin: d.trabajo, relojMin: d.reloj }; }
// la cuenta de UN pedido: del modelo al reloj, para 1, 2 y 3 personas
export function cuentaPedido(modelo, factorInfo, lineas, unidades, cfg, par, calidad) {
  const tA = modelo.a, tB = modelo.b * lineas, tC = modelo.c * unidades, tModelo = Math.max(0, tA + tB + tC), factor = factorInfo ? factorInfo.factor : 1, tBase = tModelo * factor;
  return { modelo: { a: modelo.a, b: modelo.b, c: modelo.c, lineas, unidades, tA, tB, tC, tModelo }, factor, factorInfo: factorInfo || null, tBase,
    rango: calidad ? { lo: tBase * calidad.p20, hi: tBase * calidad.p80 } : null, cols: [1, 2, 3].map(k => { const d = detalleDividido(tBase, k, par, cfg); return { ...d, fin: horaFin(cfg.inicio, d.reloj) }; }) };
}
// cada pedido lo arma UNA persona: se reparten los pedidos enteros (el más grande primero, a quien menos tenga)
export function escenarioEnteros(items, k, cfg) {
  const cargas = Array.from({ length: k }, () => ({ min: 0, items: [] }));
  [...items].sort((a, b) => b.min - a.min).forEach(it => { const c = cargas.reduce((m, x) => x.min < m.min ? x : m); c.min += it.min; c.items.push(it); });
  cargas.forEach(c => { c.trabajoMin = c.min * (1 + cfg.tolerancia / 100); c.relojMin = conDescansos(c.trabajoMin, cfg.descansos); });
  return { k, cargas, relojMin: Math.max(...cargas.map(c => c.relojMin)) };
}

// ============================================================ pedidos de hoy
// items: renglones de "pedidos" sin procesar. Cada renglón es un artículo a armar en una sucursal.
export function agruparHoy(items) {
  const por = new Map();
  items.forEach(it => {
    const suc = it.sucursal || '(sin sucursal)'; let g = por.get(suc);
    if (!g) por.set(suc, g = { sucursal: suc, lineas: 0, unidades: 0, armadas: 0, sinStock: 0, faltanLineas: 0, faltanUnidades: 0, sinHabilitar: 0, desde: null });
    if (it.habilitado === false) { g.sinHabilitar++; return; }                                   // todavía sin habilitar para armar: no cuenta
    const u = Number(it.cantidadHabilitada ?? it.cantidadPedida) || 0; if (u <= 0) return;      // sin cobertura: no hay nada que armar
    g.lineas++; g.unidades += u;
    if (it.armado !== null && it.armado !== undefined) { g.armadas++; if (it.diferencia === 'Falta de stock') g.sinStock++; } else { g.faltanLineas++; g.faltanUnidades += u; }
    if (it.fechaMs && (g.desde === null || it.fechaMs < g.desde)) g.desde = it.fechaMs;
  });
  return [...por.values()].filter(g => g.lineas > 0 || g.sinHabilitar > 0).sort((a, b) => a.sucursal.localeCompare(b.sucursal));
}

// ============================================================ presentación
export const fmtMin = m => { if (m == null || !isFinite(m)) return '—'; m = Math.round(m); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + String(r).padStart(2, '0') + ' min' : ''); };
export const horaFin = (inicio, minutos) => { const [h, m] = String(inicio || '07:00').split(':').map(Number), t = (h * 60 + (m || 0) + Math.round(minutos)) % 1440; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = x => (x == null || !isFinite(x)) ? '—' : (Math.round(x * 10) / 10).toLocaleString('es-AR');
const n0 = x => (x == null || !isFinite(x)) ? '—' : Math.round(x).toLocaleString('es-AR');

export function iniciarTiemposPedido(ctx) {
  const { db, collection, query, where, orderBy, getDocs, Timestamp } = ctx;
  const $ = id => document.getElementById(id);
  const E = { cfg: null, semanas: 4, eventos: [], pedidos: [], modelo: null, factores: {}, calidad: null, medido: null, plan: null, planEditado: false, planOrigen: '', planElegido: '', cargado: false, filtroSuc: '', filasVis: [],
    hoy: { items: [], grupos: [], cargado: false, error: '', modo: 'todo' }, cuenta: null };
  let guardado = {}; try { guardado = JSON.parse(localStorage.getItem('tp_cfg') || '{}') || {}; } catch (e) { /* sin storage */ }
  E.cfg = { ...CFG_INICIAL, ...guardado };
  E.cfg.descansos = (Array.isArray(guardado.descansos) ? guardado.descansos : CFG_INICIAL.descansos).map(d => ({ ...d }));   // copia: no se toca la constante
  E.cfg.par = { 2: { recargo: null, desbalance: null, ...((guardado.par || {})[2] || {}) }, 3: { recargo: null, desbalance: null, ...((guardado.par || {})[3] || {}) } };
  const guardarCfg = () => { try { localStorage.setItem('tp_cfg', JSON.stringify(E.cfg)); } catch (e) { /* sin storage */ } };
  const n2 = x => (x == null || !isFinite(x)) ? '—' : (Math.round(x * 100) / 100).toLocaleString('es-AR');
  const n3 = x => (x == null || !isFinite(x)) ? '—' : (Math.round(x * 1000) / 1000).toLocaleString('es-AR');
  const fac = s => (E.factores[s] || { factor: 1 }).factor;
  const parUso = () => parametrosParalelo(E.medido, E.cfg.par);
  const trabajoPor = (min, k) => detalleDividido(min, k, parUso(), E.cfg).trabajo;
  const esperado = p => E.modelo ? predecir(E.modelo, p.lineas, p.unidades, fac(p.sucursal)) : null;
  const usoHoy = g => E.hoy.modo === 'falta' ? { l: g.faltanLineas, u: g.faltanUnidades } : { l: g.lineas, u: g.unidades };
  const origenPar = k => { const p = parUso()[k]; return (p.origenRecargo === 'manual' || p.origenDesbalance === 'manual') ? 'manual' : (p.origenRecargo === 'supuesto' || p.origenDesbalance === 'supuesto') ? 'supuesto' : 'medido'; };
  const TXT_ORIGEN = { manual: 'lo que escribiste', supuesto: 'lo supuesto', medido: 'lo medido' };

  // ---------------- casilleros que se pueden editar (todos escriben en E.cfg y se guardan en este navegador)
  const num = (path, v, ancho = 56, paso = 1) => `<input type="number" data-cfg="${path}" value="${v ?? ''}" step="${paso}" style="width:${ancho}px">`;
  function campoPar(k, campo) {
    const p = parUso()[k], o = campo === 'recargo' ? p.origenRecargo : p.origenDesbalance, v = Math.round(((campo === 'recargo' ? p.recargo : p.desbalance) - 1) * 1000) / 10;
    const tag = o === 'medido' ? `medido en ${p.n} pedidos` : o === 'supuesto' ? 'supuesto' : 'escrito por vos';
    return `${num('par.' + k + '.' + campo, v, 62, 0.5)} % <span class="tp-tag ${o}">${tag}</span>${o === 'manual' ? ` <a href="#" data-reset="par.${k}.${campo}" title="Volver a lo medido o supuesto">↺</a>` : ''}`;
  }
  function aplicarCfg(el) {
    const path = el.dataset.cfg, partes = path.split('.'); let o = E.cfg;
    for (let i = 0; i < partes.length - 1; i++) { if (o[partes[i]] === undefined || o[partes[i]] === null) o[partes[i]] = {}; o = o[partes[i]]; }
    const ult = partes[partes.length - 1];
    if (el.type === 'time') o[ult] = el.value || '07:00';
    else { const v = el.value === '' ? null : +el.value; o[ult] = path.startsWith('par.') ? (v != null && isFinite(v) ? v : null) : (v != null && isFinite(v) ? Math.max(0, v) : 0); }
    guardarCfg();
  }

  async function calcular() {
    const st = $('tp_estado'), btn = $('tp_btnCalcular'); btn.disabled = true; st.textContent = 'Leyendo las marcas de armado...';
    try {
      const hasta = new Date(), desde = new Date(); desde.setDate(desde.getDate() - E.semanas * 7); desde.setHours(0, 0, 0, 0);
      const snap = await getDocs(query(collection(db, 'eventosArmado'), where('timestamp', '>=', Timestamp.fromDate(desde)), where('timestamp', '<=', Timestamp.fromDate(hasta)), orderBy('timestamp', 'asc')));
      const evs = []; snap.forEach(d => { const x = d.data(); if (x.timestamp && x.timestamp.toMillis) evs.push({ ...x, timestampMs: x.timestamp.toMillis() }); });
      E.eventos = evs; if (!E.planEditado) E.plan = null; recalcular();
      st.textContent = `Se leyeron ${evs.length.toLocaleString('es-AR')} marcas de armado de las últimas ${E.semanas} semanas (${E.pedidos.length.toLocaleString('es-AR')} pedidos).`;
    } catch (err) { st.textContent = 'No se pudieron leer las marcas: ' + err.message; }
    btn.disabled = false;
  }
  function recalcular() {   // con los mismos datos, otros umbrales
    E.pedidos = agruparPedidos(E.eventos, E.cfg);
    E.modelo = ajustarModelo(E.pedidos);
    E.factores = E.modelo ? factoresSucursal(E.pedidos, E.modelo) : {};
    E.calidad = E.modelo ? calidadModelo(E.pedidos, E.modelo, E.factores) : null;
    E.medido = E.modelo ? medirParalelo(E.pedidos, E.modelo, E.factores) : null;
    E.cargado = true; refrescar();
  }
  function refrescar() { renderHoy(); renderEstimador(); renderModelo(); renderPedidos(); if (E.cuenta) renderCuenta(); }

  async function cargarHoy() {
    E.hoy.error = ''; E.hoy.cargado = false; renderHoy();
    try {
      const snap = await getDocs(query(collection(db, 'pedidos'), where('procesado', '==', false)));
      const items = []; snap.forEach(d => { const x = d.data(); items.push({ ...x, id: d.id, fechaMs: x.fecha && x.fecha.toMillis ? x.fecha.toMillis() : null }); });
      E.hoy.items = items; E.hoy.grupos = agruparHoy(items); E.hoy.cargado = true;
    } catch (err) { E.hoy.error = err.message; }
    if (!E.planEditado) E.plan = null;
    renderHoy(); renderEstimador();
  }

  // ---------------- pedidos de hoy
  function renderHoy() {
    const host = $('tp_hoy'); if (!host) return; const h = E.hoy;
    if (h.error) { host.innerHTML = `<div class="empty-state">No se pudieron leer los pedidos: ${esc(h.error)} <button class="btn-chico" id="tp_btnHoy">Reintentar</button></div>`; return; }
    if (!h.cargado) { host.innerHTML = '<div class="empty-state">Leyendo los pedidos de hoy...</div>'; return; }
    if (!h.grupos.length) { host.innerHTML = '<div class="mt-barra">No hay pedidos sin procesar en este momento. <button class="btn-chico" id="tp_btnHoy">Actualizar</button></div>'; return; }
    const m = E.modelo, cfg = E.cfg, par = parUso(), inicioHoy = new Date().setHours(0, 0, 0, 0), grupos = h.grupos;
    const est = g => { const u = usoHoy(g); return m ? (u.l > 0 ? predecir(m, u.l, u.u, fac(g.sucursal)) : 0) : null; };
    const viejos = grupos.filter(g => g.desde && g.desde < inicioHoy), tot = { lineas: suma(grupos.map(g => g.lineas)), unidades: suma(grupos.map(g => g.unidades)), armadas: suma(grupos.map(g => g.armadas)), sinHab: suma(grupos.map(g => g.sinHabilitar)), est: m ? suma(grupos.map(est)) : null };
    const aviso = !m ? (E.cargado ? 'Todavía no hay suficiente historial de armado para estimar el tiempo (hacen falta al menos 3 pedidos de 5 artículos o más).' : 'Calculando el historial para estimar el tiempo...') : '';
    host.innerHTML = `<div class="mt-barra" style="flex-wrap:wrap;gap:8px 16px"><b>Contar</b> <label><input type="radio" name="tp_modo" value="todo" ${h.modo === 'todo' ? 'checked' : ''}> todo el pedido</label> <label><input type="radio" name="tp_modo" value="falta" ${h.modo === 'falta' ? 'checked' : ''}> solo lo que falta armar</label>
        <button class="btn-chico" id="tp_btnHoy">Actualizar</button> <span class="contador">${n0(h.items.length)} renglones sin procesar${tot.sinHab ? ` · ${n0(tot.sinHab)} esperan habilitación y no se cuentan` : ''}${viejos.length ? ` · hay pedidos de días anteriores sin procesar (desde ${fechaLocal(Math.min(...viejos.map(g => g.desde)))})` : ''}</span></div>
      ${aviso ? `<div class="note" style="margin-bottom:10px">${aviso}</div>` : ''}
      <div style="overflow-x:auto"><table class="tp-t"><tr><th>Sucursal</th><th>Artículos</th><th>Armados</th><th>Una persona</th><th>Entre 2, cada una</th><th>Entre 3, cada una</th></tr>
      ${grupos.map((g, i) => { const e = est(g), u = usoHoy(g);
        return `<tr class="tp-click" data-cuenta="hoy:${i}" title="Tocá para ver la cuenta"><td><b>${esc(g.sucursal)}</b>${g.sinHabilitar ? `<div class="contador">${g.sinHabilitar} sin habilitar</div>` : ''}${g.desde && g.desde < inicioHoy ? `<div class="contador">desde ${fechaLocal(g.desde)}</div>` : ''}</td>
          <td>${n0(u.l)}<div class="contador">${n0(u.u)} unid.</div></td><td>${n0(g.armadas)} de ${n0(g.lineas)}<div class="contador">${g.lineas ? n0(g.armadas / g.lineas * 100) : 0}%${g.sinStock ? ` · ${g.sinStock} sin stock` : ''}</div></td>
          ${[1, 2, 3].map(k => `<td>${e == null ? '—' : '<b>' + fmtMin(trabajoPor(e, k)) + '</b>'}</td>`).join('')}</tr>`; }).join('')}
      <tr style="border-top:2px solid var(--border, #e2e8f0)"><td><b>Todo junto</b></td><td><b>${n0(tot.lineas)}</b><div class="contador">${n0(tot.unidades)} unid.</div></td><td>${n0(tot.armadas)} de ${n0(tot.lineas)}</td>
        ${[1, 2, 3].map(k => { if (tot.est == null) return '<td>—</td>'; const d = detalleDividido(tot.est, k, par, cfg); return `<td><b>${fmtMin(d.trabajo)}</b><div class="contador">reloj ${fmtMin(d.reloj)} · termina ${horaFin(cfg.inicio, d.reloj)}</div></td>`; }).join('')}</tr></table></div>
      <div class="mt-barra" style="flex-wrap:wrap;gap:8px 16px;margin-top:10px"><button class="btn-chico azul" id="tp_btnUsarHoy">Usar estos pedidos en la comparación de 1, 2 o 3 personas</button>
        <span class="contador">Tocá un pedido para ver cómo está hecha la cuenta. Los tiempos incluyen la tolerancia (${n0(cfg.tolerancia)}%); "reloj" suma además los descansos.</span></div>`;
  }

  // ---------------- pedidos armados (historial)
  function renderPedidos() {
    const host = $('tp_pedidos'); if (!E.pedidos.length) { host.innerHTML = '<div class="empty-state">No hay marcas de armado en este período.</div>'; return; }
    const sucs = [...new Set(E.pedidos.map(p => p.sucursal))].sort(), filas = E.pedidos.filter(p => !E.filtroSuc || p.sucursal === E.filtroSuc), tope = 150; E.filasVis = filas.slice(0, tope);
    host.innerHTML = `<div class="mt-barra"><b>Sucursal</b> <select id="tp_filtroSuc"><option value="">Todas</option>${sucs.map(s => `<option ${s === E.filtroSuc ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select> <button class="btn-chico" id="tp_btnCSV">⬇ CSV</button> <span class="contador">${filas.length.toLocaleString('es-AR')} pedidos · tocá uno para ver la cuenta</span></div>
      <div style="overflow-x:auto"><table class="tp-t"><tr><th>Día</th><th>Sucursal</th><th>Artículos</th><th>Sin stock</th><th>Personas</th><th>Tiempo de armado</th><th>Reloj</th><th>Min por artículo</th><th>Esperado</th></tr>
      ${E.filasVis.map((p, i) => { const e = esperado(p), real = p.trabajoMs / MIN, dv = e ? (real / e - 1) * 100 : null, quienes = p.personas.filter(x => x.picks >= 5).map(x => esc(x.nombre.split(' ')[0]) + ' ' + fmtMin(x.trabajoMs / MIN)).join(' · ');
        return `<tr class="tp-click" data-cuenta="ped:${i}"><td style="white-space:nowrap">${esc(p.dia)}</td><td><b>${esc(p.sucursal)}</b>${quienes ? `<div class="contador">${quienes}</div>` : ''}</td><td>${n0(p.lineas)}<div class="contador">${n0(p.unidades)} unid.</div></td><td>${p.picks ? n0(p.sinStock / p.picks * 100) + '%' : '—'}</td><td>${p.k}</td>
          <td><b>${fmtMin(real)}</b><div class="contador">demoras ${fmtMin(p.demoraMs / MIN)} · pausas ${fmtMin(p.pausaMs / MIN)}</div></td><td style="white-space:nowrap">${fmtMin(p.relojMs / MIN)}</td><td>${p.lineas ? n1(real / p.lineas) : '—'}</td>
          <td style="white-space:nowrap">${e == null ? '—' : fmtMin(e)}${dv == null ? '' : `<div style="font-size:12px;color:${dv > 25 ? 'var(--red)' : dv < -15 ? 'var(--green)' : 'var(--muted)'}">${Math.abs(dv) < 0.5 ? '0' : (dv > 0 ? '+' : '') + n0(dv)}%</div>`}</td></tr>`; }).join('')}</table></div>
      ${filas.length > tope ? `<div class="contador" style="margin-top:8px">Se muestran los ${tope} más recientes; el CSV trae todos.</div>` : ''}`;
    $('tp_filtroSuc').onchange = e => { E.filtroSuc = e.target.value; renderPedidos(); };
    $('tp_btnCSV').onclick = descargarCSV;
  }
  function descargarCSV() {
    const cel = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const enc = ['Día', 'Sucursal', 'Artículos', 'Unidades', 'Marcas', 'Sin stock', 'Personas', 'Tiempo de armado (min)', 'Demoras (min)', 'Pausas (min)', 'Reloj (min)', 'Min por artículo', 'Esperado 1 persona (min)', 'Desvío %', 'Detalle por persona'];
    const filas = E.pedidos.filter(p => !E.filtroSuc || p.sucursal === E.filtroSuc).map(p => { const e = esperado(p), real = p.trabajoMs / MIN; return [p.dia, p.sucursal, p.lineas, p.unidades, p.picks, p.sinStock, p.k, n1(real), n1(p.demoraMs / MIN), n1(p.pausaMs / MIN), n1(p.relojMs / MIN), p.lineas ? n1(real / p.lineas) : '', e == null ? '' : n1(e), e ? n0((real / e - 1) * 100) : '', p.personas.map(x => x.nombre + ': ' + n1(x.trabajoMs / MIN) + ' min de armado, ' + x.picks + ' marcas').join(' | ')]; });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + [enc, ...filas].map(f => f.map(cel).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'pedidos_tiempos_' + fechaLocal(Date.now()) + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------- el modelo
  function renderModelo() {
    const host = $('tp_modelo'), m = E.modelo, q = E.calidad; if (!m) { host.innerHTML = '<div class="empty-state">Hacen falta al menos 3 pedidos de 5 artículos o más para ajustar el modelo.</div>'; return; }
    const demoraPct = suma(E.pedidos.map(p => p.demoraMs)) / Math.max(1, suma(E.pedidos.map(p => p.trabajoMs))) * 100, par = parUso();
    const med = E.medido || {}, linea = k => { const x = med[k] || {}, p = par[k], quien = k === 2 ? 'dos personas' : 'tres personas';
      const base = x.n >= 3 ? `Cuando ${quien} armaron el mismo pedido (${x.n} pedidos): ${x.recargoMedido != null ? 'el trabajo total fue ' + n0((x.recargoMedido - 1) * 100) + '% ' + (x.recargoMedido >= 1 ? 'mayor' : 'menor') + ' que si lo armaba una sola' : 'sin dato suficiente de trabajo total'}, y ${x.desbalanceMedido != null ? 'el más lento tardó ' + n0((x.desbalanceMedido - 1) * 100) + '% más que el promedio' : 'sin dato de desbalance'}.` : `${k === 2 ? 'Dos' : 'Tres'} personas en el mismo pedido: todavía hay ${x.n || 0} pedidos armados así (hacen falta 3 o más).`;
      return `${base} <b>Se usa para ${k} personas:</b> +${n1((p.recargo - 1) * 100)}% de trabajo (${p.origenRecargo === 'manual' ? 'lo escribiste vos' : p.origenRecargo}) y ${n1((p.desbalance - 1) * 100)}% de desbalance (${p.origenDesbalance === 'manual' ? 'lo escribiste vos' : p.origenDesbalance}).`; };
    const sucs = Object.keys(E.factores).sort((a, b) => E.factores[b].factor - E.factores[a].factor);
    const juntos = m.rho > 0.95 && m.terminos > 1, porArt = m.b + m.c * m.uPorArt;   // si artículos y unidades crecen a la par, no se pueden separar: se da el tiempo por artículo en conjunto
    const titular = juntos ? `Tiempo de armado de un pedido ≈ ${n1(porArt)} min por artículo (con ${n1(m.uPorArt)} unidades por artículo en promedio)`
      : `Tiempo de armado de un pedido ≈ ${m.a > 0.05 ? n1(m.a) + ' min fijos + ' : ''}${n1(m.b)} min por artículo${m.c > 0.0005 ? ' + ' + n3(m.c) + ' min por unidad' : ''}`;
    host.innerHTML = `<div class="note" style="margin-bottom:12px"><b>${titular}</b>.
        Se ajustó con ${m.n.toLocaleString('es-AR')} pedidos${m.soloUnaPersona ? ' armados por una sola persona' : ''}. Error medio: ${n0(q.mape * 100)}% por pedido (R² ${q.r2.toFixed(2).replace('.', ',')}), usando además el factor de cada sucursal. Un pedido real suele quedar entre ${n0((q.p20 - 1) * 100)}% y +${n0((q.p80 - 1) * 100)}% de lo estimado.${m.terminos === 1 ? ' Con pocos pedidos solo se ajusta el tiempo por artículo.' : ''}${juntos ? ' En tus pedidos los artículos y las unidades crecen casi a la par, así que no se puede separar cuánto tarda cada uno; sí se puede estimar el pedido completo.' : ''}</div>
      <div class="contador" style="margin-bottom:8px">No incluye el arranque (ir al primer pasillo, preparar el pallet) ni el cierre (envolver, etiquetar): hoy no se marcan. Las demoras de ${E.cfg.umbralDemora} a ${E.cfg.umbralPausa} min son ${n0(demoraPct)}% del tiempo de armado medido. El tiempo de armado suma los tiempos entre marcas seguidas (hasta ${E.cfg.umbralDemora} min) más un artículo promedio por persona, porque la primera marca no tiene una anterior.</div>
      <div style="font-size:14px;line-height:1.6;margin-bottom:12px">${linea(2)}<br>${linea(3)}</div>
      ${sucs.length ? `<table class="tp-t"><tr><th>Sucursal</th><th>Pedidos (1 persona)</th><th>Tarda vs. el modelo</th><th>Factor que se usa</th></tr>${sucs.map(s => { const f = E.factores[s]; return `<tr><td style="font-weight:700">${esc(s)}</td><td>${f.n}</td><td>${f.bruto >= 1 ? '+' : ''}${n0((f.bruto - 1) * 100)}%</td><td>${f.factor.toFixed(2).replace('.', ',')}</td></tr>`; }).join('')}</table>` : ''}`;
  }

  // ---------------- 1, 2 o 3 personas
  function armarPlan() {
    const h = E.hoy;
    if (h.cargado && h.grupos.some(g => g.lineas > 0) && E.planElegido !== 'tipico') { E.planOrigen = 'hoy'; return h.grupos.filter(g => g.lineas > 0).map(g => { const u = usoHoy(g); return { sucursal: g.sucursal, incluir: u.l > 0, lineas: u.l, unidades: u.u }; }); }
    E.planOrigen = 'tipico';
    return [...new Set(E.pedidos.map(p => p.sucursal))].sort().map(s => { const ult = E.pedidos.filter(p => p.sucursal === s).slice(0, 10); return { sucursal: s, incluir: true, lineas: Math.round(mediana(ult.map(p => p.lineas))), unidades: Math.round(mediana(ult.map(p => p.unidades))) }; });
  }
  const htmlEquipo = () => `<div class="mt-barra" style="flex-wrap:wrap;gap:10px 22px"><b>Trabajo en equipo</b>
        <span>Entre 2: <span class="contador">+ trabajo</span> ${campoPar(2, 'recargo')} <span class="contador">desbalance</span> ${campoPar(2, 'desbalance')}</span>
        <span>Entre 3: <span class="contador">+ trabajo</span> ${campoPar(3, 'recargo')} <span class="contador">desbalance</span> ${campoPar(3, 'desbalance')}</span></div>`;
  const renderEquipo = () => { const h = $('tp_equipo'); if (h) h.innerHTML = htmlEquipo(); };
  function renderEstimador() {
    const host = $('tp_estim'); if (!host) return; if (!E.modelo) { host.innerHTML = `<div class="empty-state">${E.cargado ? 'No hay historial suficiente para estimar.' : 'Calculando el historial...'}</div>`; return; }
    if (!E.plan) E.plan = armarPlan();
    const c = E.cfg, hayHoy = E.hoy.cargado && E.hoy.grupos.some(g => g.lineas > 0);
    host.innerHTML = `<details class="tp-como"><summary>¿Cómo se calcula? (en palabras)</summary><ol>
        <li>Con tu historial se calcula cuánto tarda una persona por artículo, con un ajuste para cada sucursal (unas son más lentas que otras). Eso da el <b>tiempo de armado</b> del pedido, sin pausas ni demoras.</li>
        <li>Se le suma la <b>tolerancia</b>: tiempo extra por necesidades personales, fatiga y demoras inevitables.</li>
        <li>Si lo arman varias personas: el trabajo total aumenta un poco (<b>más trabajo por ser varios</b>: se pisan, caminan más), se divide entre las personas, y el que más tarda termina después que el promedio (<b>desbalance</b>).</li>
        <li>Si el trabajo pasa de cierto tiempo, se suman los <b>descansos</b> (por ejemplo, el desayuno cuando lleva más de 2 horas trabajando).</li>
        <li>El resultado es el <b>reloj</b>; sumado a la hora de inicio da a qué hora terminan.</li></ol>Tocá un pedido de cualquier tabla para ver esa cuenta con números, y cambiar los valores ahí mismo.</details>
      <div class="mt-barra" style="flex-wrap:wrap;gap:10px 18px">
        <span><b>Tolerancias</b> ${num('tolerancia', c.tolerancia, 58)} %</span>
        <span><b>Empiezan a las</b> <input type="time" data-cfg="inicio" value="${esc(c.inicio)}"></span>
        <span><b>Demora desde</b> ${num('umbralDemora', c.umbralDemora, 46)} min <b>y pausa desde</b> ${num('umbralPausa', c.umbralPausa, 46)} min</span></div>
      <div class="mt-barra" style="flex-wrap:wrap;gap:10px 18px">${c.descansos.map((d, i) => `<span><b>${esc(d.nombre)}</b> después de ${num('descansos.' + i + '.despues', d.despues, 54)} min de trabajo, dura ${num('descansos.' + i + '.dura', d.dura, 46)} min</span>`).join('')}</div>
      <div id="tp_equipo">${htmlEquipo()}</div>
      <div class="mt-barra" style="flex-wrap:wrap;gap:8px 14px"><b>Tamaño de los pedidos</b>
        <button class="btn-chico ${E.planOrigen === 'hoy' ? 'azul' : ''}" data-origen="hoy" ${hayHoy ? '' : 'disabled'}>Los de hoy</button><button class="btn-chico ${E.planOrigen === 'tipico' ? 'azul' : ''}" data-origen="tipico">Típico de cada sucursal (mediana de los últimos 10)</button>
        <span class="contador">${E.planEditado ? 'Cambiaste números a mano. ' : ''}Elegí qué sucursales entran y cuántos artículos y unidades tiene cada pedido.</span></div>
      <div style="overflow-x:auto"><table id="tp_tablaPlan" class="tp-t"><tr><th></th><th>Sucursal</th><th>Artículos</th><th>Unidades</th><th>1 persona</th><th>Entre 2, cada una</th><th>Entre 3, cada una</th></tr>
        ${E.plan.map((x, i) => `<tr data-i="${i}"><td><input type="checkbox" data-c="incluir" ${x.incluir ? 'checked' : ''}></td><td class="tp-click" data-cuenta="plan:${i}" title="Tocá para ver la cuenta"><b>${esc(x.sucursal)}</b><div class="contador">ver la cuenta</div></td><td><input type="number" data-c="lineas" value="${x.lineas}" min="0" style="width:64px"></td><td><input type="number" data-c="unidades" value="${x.unidades}" min="0" style="width:70px"></td><td data-r="1"></td><td data-r="2"></td><td data-r="3"></td></tr>`).join('')}</table></div>
      <div id="tp_resultados" style="margin-top:16px"></div>`;
    renderResultados();
  }
  function renderResultados() {
    const host = $('tp_resultados'); if (!host || !E.modelo || !E.plan) return;
    const c = E.cfg, par = parUso();
    const items = E.plan.filter(x => x.incluir && x.lineas > 0).map(x => ({ nombre: x.sucursal, min: predecir(E.modelo, x.lineas, x.unidades, fac(x.sucursal)) }));
    E.plan.forEach((x, i) => { const fila = document.querySelector(`#tp_tablaPlan tr[data-i="${i}"]`); if (!fila) return; const e = predecir(E.modelo, x.lineas, x.unidades, fac(x.sucursal));
      [1, 2, 3].forEach(k => { fila.querySelector(`[data-r="${k}"]`).innerHTML = x.lineas > 0 ? `<b>${fmtMin(trabajoPor(e, k))}</b>` + (k === 1 ? `<div class="contador">entre ${fmtMin(trabajoPor(e * E.calidad.p20, 1))} y ${fmtMin(trabajoPor(e * E.calidad.p80, 1))}</div>` : '') : '—'; }); });
    if (!items.length) { host.innerHTML = '<div class="empty-state">Elegí al menos una sucursal.</div>'; return; }
    const efs = items.map(i => i.min), filas = [1, 2, 3].map(k => ({ d: escenarioDividido(efs, k, par, c), e: escenarioEnteros(items, k, c) }));
    const base = filas[0].d.relojMin, ahorro = m => base - m >= 0.5 ? `<span style="color:var(--green)">−${fmtMin(base - m)}</span>` : '';
    host.innerHTML = `<h4 style="margin:0 0 8px">Cuánto tardarían en armar los ${items.length} pedidos</h4>
      <table class="tp-t"><tr><th>Personas</th><th>Se reparten cada pedido entre todas</th><th>Cada pedido lo arma una sola persona</th></tr>
      ${filas.map(({ d, e }) => `<tr><td style="font-weight:700">${d.k}</td>
        <td><b>${fmtMin(d.relojMin)}</b> ${ahorro(d.relojMin)}<div class="contador">terminan a las ${horaFin(c.inicio, d.relojMin)} · cada una trabaja ${fmtMin(d.trabajoMin)}${d.k > 1 ? ' (con ' + TXT_ORIGEN[origenPar(d.k)] + ': +' + n0((par[d.k].recargo - 1) * 100) + '% de trabajo, ' + n0((par[d.k].desbalance - 1) * 100) + '% de desbalance)' : ''}</div></td>
        <td><b>${fmtMin(e.relojMin)}</b> ${ahorro(e.relojMin)}<div class="contador">terminan a las ${horaFin(c.inicio, e.relojMin)}</div></td></tr>`).join('')}</table>
      <div class="contador" style="margin-top:8px">${[2, 3].map(k => `Con ${k} personas y pedidos enteros: ` + filas[k - 1].e.cargas.map((x, j) => `persona ${j + 1}: ${x.items.map(i => esc(i.nombre)).join(', ') || '—'} (${fmtMin(x.relojMin)})`).join(' · ')).join('<br>')}</div>`;
  }

  // ---------------- la cuenta de un pedido (ventana)
  function abrirCuenta(info) { E.cuenta = info; $('tp_modal').hidden = false; renderCuenta(); }
  function cerrarCuenta() { E.cuenta = null; const mo = $('tp_modal'); if (mo) mo.hidden = true; }
  function renderCuenta() {
    const host = $('tp_cuenta'), c = E.cuenta; if (!host || !c) return;
    if (!E.modelo) { host.innerHTML = '<div class="empty-state">Todavía no hay modelo para hacer la cuenta.</div>'; return; }
    const cfg = E.cfg, par = parUso(), fi = E.factores[c.sucursal], cu = cuentaPedido(E.modelo, fi, c.lineas, c.unidades, cfg, par, E.calidad), m = cu.modelo, juntos = E.modelo.rho > 0.95 && E.modelo.terminos > 1;
    const infoFactor = fi ? `${esc(c.sucursal)} tardó ${n0(Math.abs(fi.bruto - 1) * 100)}% ${fi.bruto >= 1 ? 'más' : 'menos'} que el modelo en ${fi.n} pedidos${fi.n < 12 ? '; con pocos pedidos el ajuste se acerca prudentemente a 1' : ''}` : `${esc(c.sucursal)} no tiene historial de una sola persona: no se ajusta`;
    const real = c.real != null ? `<tr class="tp-real"><td colspan="2">Lo que tardó de verdad ese día (tiempo de armado)</td><td><b>${n1(c.real)} min</b> (${(c.real / cu.tBase - 1) * 100 >= 0 ? '+' : ''}${n0((c.real / cu.tBase - 1) * 100)}% contra lo esperado${c.realReloj != null ? '; de reloj, ' + fmtMin(c.realReloj) : ''})</td></tr>` : '';
    const cols = cu.cols, cel = fn => cols.map(d => `<td>${fn(d)}</td>`).join('');
    host.innerHTML = `<h3 style="margin:0 0 4px">La cuenta: ${esc(c.sucursal)}</h3>
      <div class="contador" style="margin-bottom:12px">${esc(c.titulo || '')} · ${n0(c.lineas)} artículos · ${n0(c.unidades)} unidades${c.nota ? ' · ' + esc(c.nota) : ''}. Los números con casillero los podés cambiar: se guarda y se recalcula todo el panel.</div>
      <h4 style="margin:0 0 6px">1. Cuánto tardaría una persona, sin pausas</h4>
      <table class="tp-t"><tr><th>Paso</th><th>Cuenta</th><th>Resultado</th></tr>
        <tr><td>Artículos</td><td>${n0(m.lineas)} artículos × ${n2(m.b)} min</td><td>${n1(m.tB)} min</td></tr>
        ${m.c > 0.0005 ? `<tr><td>Unidades</td><td>${n0(m.unidades)} unidades × ${n3(m.c)} min</td><td>${n1(m.tC)} min</td></tr>` : ''}
        ${Math.abs(m.a) > 0.05 ? `<tr><td>Tiempo fijo</td><td>arranque y cierre promedio</td><td>${n1(m.tA)} min</td></tr>` : ''}
        <tr><td><b>Según el historial</b></td><td>la suma de lo anterior${juntos ? ' (los artículos y las unidades crecen a la par: lo que vale es el total, no cada parte)' : ''}</td><td><b>${n1(m.tModelo)} min</b></td></tr>
        <tr><td>Ajuste de la sucursal</td><td>× ${n2(cu.factor)} (${infoFactor})</td><td>${n1(cu.tBase)} min</td></tr>
        <tr class="tp-total"><td><b>Tiempo de armado esperado</b></td><td>una persona, sin pausas ni demoras${cu.rango ? `; un pedido real suele quedar entre ${n1(cu.rango.lo)} y ${n1(cu.rango.hi)} min` : ''}</td><td><b>${n1(cu.tBase)} min</b></td></tr>${real}</table>
      <h4 style="margin:16px 0 6px">2. Entre 1, 2 o 3 personas</h4>
      <div style="overflow-x:auto"><table class="tp-t"><tr><th>Paso</th><th>1 persona</th><th>2 personas</th><th>3 personas</th></tr>
        <tr><td>Tiempo de armado esperado</td>${cel(d => n1(d.total) + ' min')}</tr>
        <tr><td>Más trabajo por ser varios<div class="contador">se pisan y caminan más</div></td><td>—</td>${[2, 3].map(k => `<td>× ${campoPar(k, 'recargo')}<div class="contador">→ ${n1(cols[k - 1].conRecargo)} min</div></td>`).join('')}</tr>
        <tr><td>Se reparte entre las personas</td><td>—</td>${[2, 3].map(k => `<td>÷ ${k}<div class="contador">→ ${n1(cols[k - 1].porPersona)} min cada una</div></td>`).join('')}</tr>
        <tr><td>El más lento tarda más que el promedio<div class="contador">no terminan parejos</div></td><td>—</td>${[2, 3].map(k => `<td>× ${campoPar(k, 'desbalance')}<div class="contador">→ ${n1(cols[k - 1].masLento)} min</div></td>`).join('')}</tr>
        <tr><td>Tolerancias ${num('tolerancia', cfg.tolerancia, 52)} %<div class="contador">necesidades personales, fatiga, demoras</div></td>${cel(d => '× ' + n2(1 + d.tolerancia / 100) + '<div class="contador">→ <b>' + n1(d.trabajo) + ' min</b> de trabajo</div>')}</tr>
        <tr><td>Descansos que caen en el turno${cfg.descansos.map((d, i) => `<div class="contador">${esc(d.nombre)}: si pasa de ${num('descansos.' + i + '.despues', d.despues, 50)} min, suma ${num('descansos.' + i + '.dura', d.dura, 42)} min</div>`).join('')}</td>${cel(d => d.descansosMin ? '+ ' + n0(d.descansosMin) + ' min<div class="contador">' + d.descansos.map(x => esc(x.nombre)).join(' y ') + '</div>' : 'ninguno')}</tr>
        <tr class="tp-total"><td><b>Reloj total</b></td>${cel(d => '<b>' + fmtMin(d.reloj) + '</b>')}</tr>
        <tr><td>Terminan a las<div class="contador">empiezan a las <input type="time" data-cfg="inicio" value="${esc(cfg.inicio)}"></div></td>${cel(d => d.fin)}</tr></table></div>`;
  }

  // ---------------- armado del panel y eventos
  function abrir() {
    const host = $('tp_contenido'); if (!host || host.dataset.listo) return; host.dataset.listo = '1';
    host.innerHTML = `<style>.tp-t th,.tp-t td{padding:9px 8px;vertical-align:top}.tp-t td{font-size:14px}.tp-t .contador{font-size:12px;margin-top:2px}.tp-t td:nth-child(2) b{white-space:nowrap}
        .tp-click{cursor:pointer}.tp-click:hover td{background:rgba(46,91,255,.06)}.tp-tag{font-size:12px}.tp-tag.supuesto{color:#b45309}.tp-tag.manual{color:#1d4ed8}.tp-tag.medido{color:#15803d}
        .tp-como{margin-bottom:12px;font-size:14px;line-height:1.55}.tp-como summary{cursor:pointer;font-weight:700}.tp-como ol{margin:8px 0 8px 18px;padding:0}
        .tp-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto}.tp-modal[hidden]{display:none}
        .tp-box{background:#fff;border-radius:16px;max-width:1000px;width:100%;padding:22px 24px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3)}.tp-x{position:absolute;top:12px;right:14px;border:0;background:#eef2f7;border-radius:999px;width:34px;height:34px;font-size:16px;cursor:pointer}
        .tp-box table{width:100%;border-collapse:collapse;font-size:15px}.tp-box th{text-align:left;padding:10px 8px;font-size:12.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border-bottom:2px solid var(--border);white-space:nowrap}
        .tp-box td{padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:top}.tp-box h3,.tp-box h4{color:var(--text,#0f172a)}.tp-box input[type=number],.tp-box input[type=time]{padding:3px 5px;border:1px solid var(--border);border-radius:6px;font:inherit;font-size:13px}
        .tp-total td{background:rgba(46,91,255,.06)}.tp-real td{background:rgba(245,158,11,.12)}</style>
      <div class="card"><div class="mt-barra"><b>Período</b> <select id="tp_semanas"><option value="4">Últimas 4 semanas</option><option value="8">Últimas 8 semanas</option><option value="12">Últimas 12 semanas</option></select>
        <button class="btn-chico azul" id="tp_btnCalcular">Calcular</button> <span class="contador" id="tp_estado">Leyendo las marcas de armado del período...</span></div></div>
      <div class="card"><h3 class="mt-h3">📅 Pedidos de hoy: cuánto deberían tardar</h3><div id="tp_hoy"><div class="empty-state">Leyendo los pedidos de hoy...</div></div></div>
      <div class="card"><h3 class="mt-h3">👥 ¿Cuánto tardan 1, 2 o 3 personas?</h3><div id="tp_estim"><div class="empty-state">Calculando el historial...</div></div></div>
      <div class="card"><h3 class="mt-h3">🧮 Modelo de tiempo</h3><div id="tp_modelo"><div class="empty-state">Calculando el historial...</div></div></div>
      <div class="card"><h3 class="mt-h3">📋 Pedidos armados</h3><div id="tp_pedidos"><div class="empty-state">Calculando el historial...</div></div></div>`;
    let modal = $('tp_modal');
    if (!modal) { modal = document.createElement('div'); modal.className = 'tp-modal'; modal.id = 'tp_modal'; modal.hidden = true; modal.innerHTML = '<div class="tp-box"><button class="tp-x" id="tp_cerrar" aria-label="Cerrar">✕</button><div id="tp_cuenta"></div></div>'; document.body.appendChild(modal); }
    $('tp_semanas').onchange = e => { E.semanas = +e.target.value; };
    $('tp_btnCalcular').onclick = calcular;
    const cuentaDe = ref => { const [t, i] = ref.split(':'), n = +i;
      if (t === 'hoy') { const g = E.hoy.grupos[n], u = usoHoy(g); return { sucursal: g.sucursal, lineas: u.l, unidades: u.u, titulo: 'Pedido de hoy' + (E.hoy.modo === 'falta' ? ' (solo lo que falta armar)' : ''), nota: `${g.armadas} de ${g.lineas} artículos ya armados` }; }
      if (t === 'plan') { const x = E.plan[n]; return { sucursal: x.sucursal, lineas: x.lineas, unidades: x.unidades, titulo: 'Pedido de la comparación' }; }
      const p = E.filasVis[n]; return { sucursal: p.sucursal, lineas: p.lineas, unidades: p.unidades, titulo: 'Pedido del ' + p.dia, real: p.trabajoMs / MIN, realReloj: p.relojMs / MIN }; };
    const onClick = ev => {
      const t = ev.target;
      if (t.closest('#tp_cerrar') || t.id === 'tp_modal') { cerrarCuenta(); return; }
      const rs = t.closest('[data-reset]'); if (rs) { ev.preventDefault(); const p = rs.dataset.reset.split('.'); E.cfg.par[p[1]][p[2]] = null; guardarCfg(); refrescar(); return; }
      if (t.closest('#tp_btnHoy')) { cargarHoy(); return; }
      if (t.closest('#tp_btnUsarHoy')) { E.planElegido = 'hoy'; E.planEditado = false; E.plan = null; renderEstimador(); $('tp_estim').closest('.card').scrollIntoView({ behavior: 'smooth' }); return; }
      const og = t.closest('[data-origen]'); if (og && !og.disabled) { E.planElegido = og.dataset.origen; E.planEditado = false; E.plan = null; renderEstimador(); return; }
      if (t.closest('input, select, button, a, label')) return;
      const fila = t.closest('[data-cuenta]'); if (fila) abrirCuenta(cuentaDe(fila.dataset.cuenta));
    };
    host.addEventListener('click', onClick); modal.addEventListener('click', onClick);
    const onInput = ev => {                         // mientras se escribe: se actualizan los números sin rearmar los casilleros ni las tablas que vas a tocar
      const el = ev.target;
      if (el.dataset.c !== undefined) { const i = +el.closest('tr').dataset.i, k = el.dataset.c; E.plan[i][k] = k === 'incluir' ? el.checked : Math.max(0, Math.round(+el.value || 0)); E.planEditado = true; renderResultados(); return; }
      if (el.dataset.cfg === undefined || el.closest('#tp_modal') || /^umbral/.test(el.dataset.cfg)) return;
      aplicarCfg(el); renderResultados(); renderHoy(); renderModelo();
    };
    host.addEventListener('input', onInput); modal.addEventListener('input', onInput);
    const onChange = ev => {                        // al salir del casillero
      const el = ev.target;
      if (el.name === 'tp_modo') { E.hoy.modo = el.value; if (!E.planEditado) E.plan = null; refrescar(); return; }
      if (el.dataset.c !== undefined) { if (el.dataset.c === 'incluir') { E.plan[+el.closest('tr').dataset.i].incluir = el.checked; E.planEditado = true; renderResultados(); } return; }
      if (el.dataset.cfg === undefined) return;
      aplicarCfg(el);
      if (el.closest('#tp_modal')) { refrescar(); return; }                     // dentro de la cuenta: se rearma todo (lo que ves se actualiza)
      if (/^umbral/.test(el.dataset.cfg)) { E.cfg.umbralDemora = Math.max(1, E.cfg.umbralDemora || 5); E.cfg.umbralPausa = Math.max(E.cfg.umbralDemora + 1, E.cfg.umbralPausa || 20); guardarCfg(); recalcular(); return; }
      if (el.dataset.cfg.startsWith('par.')) renderEquipo();                    // solo se actualiza el rótulo (medido / escrito por vos)
    };
    host.addEventListener('change', onChange); modal.addEventListener('change', onChange);
    if (!document.__tpEsc) { document.__tpEsc = true; document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarCuenta(); }); }
    calcular(); cargarHoy();
  }
  return { abrir };
}
