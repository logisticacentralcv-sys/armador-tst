// Tiempo por pedido: cuánto tarda armar cada sucursal, cuánto deberían tardar y cuánto están tardando.
// Se apoya en "eventosArmado" (una marca por artículo armado: hora, persona, sucursal y cantidades).
// Un PEDIDO es una sucursal en un día. Lo pueden armar una o varias personas.

const MIN = 60000;

export const CFG_INICIAL = {
  umbralDemora: 5,     // entre dos artículos seguidos: hasta estos minutos es trabajo...
  umbralPausa: 20,     // ...de ahí hasta este valor es una demora (no cuenta como armado); más es una pausa
  tolerancia: 15,      // margen (%) que se suma al tiempo de armado para dar un tiempo realista (demoras y necesidades personales)
  inicio: '07:00',     // hora a la que empieza el turno (para decir "termina a las ...")
  descansos: [{ nombre: 'Desayuno', despues: 120, dura: 15 }, { nombre: 'Almuerzo', despues: 240, dura: 30 }],  // "si el trabajo pasa de N minutos, se suma el descanso"
  equipo: { 2: 10, 3: 15 }   // % que se pierde al armar entre varios: se coordinan y se pisan, así que el tiempo no baja justo a la mitad
};

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

// ============================================================ 4) escenarios: 1, 2 o 3 personas
export const conDescansos = (trabajoMin, descansos) => trabajoMin + suma(descansos.filter(d => trabajoMin > d.despues).map(d => d.dura));
// el tiempo entre k personas, paso por paso: se reparte, se suma lo que se pierde por trabajar entre varios, el margen y los descansos
export function detalleDividido(total, k, cfg) {
  const perdida = k === 1 ? 0 : (Number((cfg.equipo || {})[k]) || 0), porPersona = total / k, cadaUna = porPersona * (1 + perdida / 100), trabajo = cadaUna * (1 + cfg.tolerancia / 100);
  const descansos = cfg.descansos.filter(d => trabajo > d.despues), descansosMin = suma(descansos.map(d => d.dura));
  return { k, total, porPersona, perdida, cadaUna, tolerancia: cfg.tolerancia, trabajo, descansos, descansosMin, reloj: trabajo + descansosMin };
}
// la cuenta de UN pedido: del historial al tiempo total, para 1, 2 y 3 personas
export function cuentaPedido(modelo, factorInfo, lineas, unidades, cfg, calidad) {
  const tA = modelo.a, tB = modelo.b * lineas, tC = modelo.c * unidades, tModelo = Math.max(0, tA + tB + tC), factor = factorInfo ? factorInfo.factor : 1, tBase = tModelo * factor;
  return { modelo: { a: modelo.a, b: modelo.b, c: modelo.c, lineas, unidades, tA, tB, tC, tModelo }, factor, factorInfo: factorInfo || null, tBase,
    rango: calidad ? { lo: tBase * calidad.p20, hi: tBase * calidad.p80 } : null, cols: [1, 2, 3].map(k => { const d = detalleDividido(tBase, k, cfg); return { ...d, fin: horaFin(cfg.inicio, d.reloj) }; }) };
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

// ============================================================ gráfico: la serie día por día
export const METRICAS = {
  armado: { nombre: 'Tiempo de armado', ayuda: 'Minutos que se pasó armando cada pedido, sin contar pausas ni demoras largas. Si lo armaron dos personas, se suman las dos.' },
  porArt: { nombre: 'Minutos por artículo', ayuda: 'El tiempo de armado dividido la cantidad de artículos: sirve para comparar días y pedidos de distinto tamaño.' },
  lineas: { nombre: 'Artículos', ayuda: 'Cuántos artículos tuvo cada pedido: el tamaño del trabajo.' },
  reloj: { nombre: 'Tiempo total', ayuda: 'Desde el primer artículo hasta el último, con pausas y demoras incluidas. La diferencia con el tiempo de armado son las pausas.' }
};
// modo: 'todo' (lo real contra lo esperado), 'sucursal' (una línea por sucursal) o 'armador' (una línea por persona)
export function serieDiaria(pedidos, op) {
  const { modo = 'todo', metrica = 'armado', sucursales = [], armadores = [], desde = '', hasta = '', esperado = null, calidad = null } = op || {};
  const ps = pedidos.filter(p => (!desde || p.dia >= desde) && (!hasta || p.dia <= hasta) && (!sucursales.length || sucursales.includes(p.sucursal)));
  const info = {}, lineas = []; let banda = null;
  ps.forEach(p => { const i = info[p.dia] || (info[p.dia] = { pedidos: 0, lineas: 0, unidades: 0 }); i.pedidos++; i.lineas += p.lineas; i.unidades += p.unidades; });
  const porDia = lista => { const m = {}; lista.forEach(p => (m[p.dia] = m[p.dia] || []).push(p)); return m; };
  const valorDia = g => {
    const n = g.length, L = suma(g.map(p => p.lineas)), W = suma(g.map(p => p.trabajoMs)) / MIN, R = suma(g.map(p => p.relojMs)) / MIN, Es = esperado ? suma(g.map(esperado)) : null;
    if (metrica === 'armado') return { real: W / n, esp: Es == null ? null : Es / n };
    if (metrica === 'porArt') return { real: L ? W / L : null, esp: Es != null && L ? Es / L : null };
    if (metrica === 'lineas') return { real: L / n, esp: null };
    return { real: R / n, esp: null, extra: W / n };
  };
  if (modo === 'todo') {
    const real = {}, esp = {}, extra = {}, b = {}, m = porDia(ps);
    Object.keys(m).forEach(d => { const v = valorDia(m[d]); if (v.real != null) real[d] = v.real; if (v.esp != null) { esp[d] = v.esp; if (calidad) b[d] = [v.esp * calidad.p20, v.esp * calidad.p80]; } if (v.extra != null) extra[d] = v.extra; });
    lineas.push({ id: 'real', nombre: metrica === 'reloj' ? 'Tiempo total (con pausas)' : 'Lo que tardaron', estilo: 'real', valores: real });
    if (metrica === 'reloj') lineas.push({ id: 'armado', nombre: 'Tiempo de armado (sin pausas)', estilo: 'real', valores: extra });
    if (Object.keys(esp).length) { lineas.push({ id: 'esperado', nombre: 'Lo que debería tardar', estilo: 'esperado', valores: esp }); if (calidad && Object.keys(b).length) banda = b; }
  } else if (modo === 'sucursal') {
    const sucs = sucursales.length ? sucursales : [...new Set(ps.map(p => p.sucursal))].sort();
    sucs.forEach(s => { const m = porDia(ps.filter(p => p.sucursal === s)), real = {}; Object.keys(m).forEach(d => { const v = valorDia(m[d]); if (v.real != null) real[d] = v.real; }); if (Object.keys(real).length) lineas.push({ id: 's:' + s, nombre: s, estilo: 'real', valores: real }); });
  } else {
    const acum = {}, equipo = {};
    ps.forEach(p => p.personas.filter(x => x.picks >= 5).forEach(x => {             // una marca suelta de otra persona no cuenta
      const e = equipo[p.dia] || (equipo[p.dia] = { w: 0, n: 0 }); e.w += x.trabajoMs / MIN; e.n += x.picks;
      if (armadores.length && !armadores.includes(x.id)) return;
      const a = acum[x.id] || (acum[x.id] = { nombre: x.nombre, dias: {} }), dd = a.dias[p.dia] || (a.dias[p.dia] = { w: 0, n: 0 }); dd.w += x.trabajoMs / MIN; dd.n += x.picks;
    }));
    Object.keys(acum).forEach(id => { const real = {}; Object.keys(acum[id].dias).forEach(d => { const { w, n } = acum[id].dias[d]; if (metrica === 'porArt') { if (n) real[d] = w / n; } else real[d] = metrica === 'lineas' ? n : w; }); if (Object.keys(real).length) lineas.push({ id: 'a:' + id, nombre: acum[id].nombre, estilo: 'real', valores: real }); });
    if (metrica === 'porArt') { const ref = {}; Object.keys(equipo).forEach(d => { if (equipo[d].n) ref[d] = equipo[d].w / equipo[d].n; }); if (Object.keys(ref).length) lineas.push({ id: 'equipo', nombre: 'Promedio del equipo', estilo: 'esperado', valores: ref }); }
  }
  const dias = [...new Set(lineas.flatMap(l => Object.keys(l.valores)))].sort();
  return { dias, lineas, banda, info, metrica, modo };
}
// las personas que armaron en el período (con al menos 5 marcas en un pedido), de más a menos marcas
export function listaArmadores(pedidos) {
  const m = {}; pedidos.forEach(p => p.personas.filter(x => x.picks >= 5).forEach(x => { const a = m[x.id] || (m[x.id] = { id: x.id, nombre: x.nombre, picks: 0 }); a.picks += x.picks; }));
  return Object.values(m).sort((a, b) => b.picks - a.picks);
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
  const E = { cfg: null, semanas: 4, eventos: [], pedidos: [], modelo: null, factores: {}, calidad: null, cargado: false, filtroSuc: '', filasVis: [], filasDia: [], ajustesAbierto: false,
    hoy: { items: [], grupos: [], cargado: false, error: '', modo: 'todo' }, cuenta: null, calc: { sucursal: '', lineas: 0, unidades: 0 },
    graf: { modo: 'todo', metrica: 'armado', desde: '', hasta: '', sucSel: null, armSel: null, ocultas: new Set(), diaSel: '' } };
  let guardado = {}; try { guardado = JSON.parse(localStorage.getItem('tp_cfg') || '{}') || {}; } catch (e) { /* sin storage */ }
  E.cfg = { ...CFG_INICIAL, ...guardado }; delete E.cfg.par;
  E.cfg.descansos = (Array.isArray(guardado.descansos) ? guardado.descansos : CFG_INICIAL.descansos).map(d => ({ ...d }));   // copia: no se toca la constante
  E.cfg.equipo = { ...CFG_INICIAL.equipo, ...(guardado.equipo || {}) };
  const guardarCfg = () => { try { localStorage.setItem('tp_cfg', JSON.stringify(E.cfg)); } catch (e) { /* sin storage */ } };
  const n2 = x => (x == null || !isFinite(x)) ? '—' : (Math.round(x * 100) / 100).toLocaleString('es-AR');
  const n3 = x => (x == null || !isFinite(x)) ? '—' : (Math.round(x * 1000) / 1000).toLocaleString('es-AR');
  const fac = s => (E.factores[s] || { factor: 1 }).factor;
  const esperado = p => E.modelo ? predecir(E.modelo, p.lineas, p.unidades, fac(p.sucursal)) : null;
  const usoHoy = g => E.hoy.modo === 'falta' ? { l: g.faltanLineas, u: g.faltanUnidades } : { l: g.lineas, u: g.unidades };
  const tipico = s => { const ult = E.pedidos.filter(p => p.sucursal === s).slice(0, 10); return ult.length ? { lineas: Math.round(mediana(ult.map(p => p.lineas))), unidades: Math.round(mediana(ult.map(p => p.unidades))) } : { lineas: 0, unidades: 0 }; };
  const num = (path, v, ancho = 56, paso = 1) => `<input type="number" data-cfg="${path}" value="${v ?? ''}" step="${paso}" min="0" style="width:${ancho}px">`;
  function aplicarCfg(el) {      // todos los casilleros escriben en E.cfg y se guardan en este navegador
    const path = el.dataset.cfg, partes = path.split('.'); let o = E.cfg;
    for (let i = 0; i < partes.length - 1; i++) { if (o[partes[i]] === undefined || o[partes[i]] === null) o[partes[i]] = {}; o = o[partes[i]]; }
    const ult = partes[partes.length - 1];
    if (el.type === 'time') o[ult] = el.value || '07:00'; else { const v = el.value === '' ? null : +el.value; o[ult] = v != null && isFinite(v) ? Math.max(0, v) : 0; }
    guardarCfg();
  }

  async function calcular() {
    const st = $('tp_estado'), btn = $('tp_btnCalcular'); btn.disabled = true; st.textContent = 'Leyendo las marcas de armado...';
    try {
      const hasta = new Date(), desde = new Date(); desde.setDate(desde.getDate() - E.semanas * 7); desde.setHours(0, 0, 0, 0);
      const snap = await getDocs(query(collection(db, 'eventosArmado'), where('timestamp', '>=', Timestamp.fromDate(desde)), where('timestamp', '<=', Timestamp.fromDate(hasta)), orderBy('timestamp', 'asc')));
      const evs = []; snap.forEach(d => { const x = d.data(); if (x.timestamp && x.timestamp.toMillis) evs.push({ ...x, timestampMs: x.timestamp.toMillis() }); });
      E.eventos = evs; E.graf.desde = E.graf.hasta = ''; E.graf.diaSel = ''; recalcular();
      st.textContent = `Se leyeron ${evs.length.toLocaleString('es-AR')} marcas de armado de las últimas ${E.semanas} semanas (${E.pedidos.length.toLocaleString('es-AR')} pedidos).`;
    } catch (err) { st.textContent = 'No se pudieron leer las marcas: ' + err.message; }
    btn.disabled = false;
  }
  function recalcular() {   // con los mismos datos, otros umbrales
    E.pedidos = agruparPedidos(E.eventos, E.cfg);
    E.modelo = ajustarModelo(E.pedidos);
    E.factores = E.modelo ? factoresSucursal(E.pedidos, E.modelo) : {};
    E.calidad = E.modelo ? calidadModelo(E.pedidos, E.modelo, E.factores) : null;
    E.cargado = true; refrescar();
  }
  function refrescar() { renderGrafico(); renderHoy(); renderCalc(); renderAjustes(); renderPedidos(); if (E.cuenta) renderCuenta(); }
  async function cargarHoy() {
    E.hoy.error = ''; E.hoy.cargado = false; renderHoy();
    try {
      const snap = await getDocs(query(collection(db, 'pedidos'), where('procesado', '==', false)));
      const items = []; snap.forEach(d => { const x = d.data(); items.push({ ...x, id: d.id, fechaMs: x.fecha && x.fecha.toMillis ? x.fecha.toMillis() : null }); });
      E.hoy.items = items; E.hoy.grupos = agruparHoy(items); E.hoy.cargado = true;
    } catch (err) { E.hoy.error = err.message; }
    renderHoy();
  }

  // ======================================================== el gráfico
  const COLORES = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#0891b2', '#dc2626', '#ca8a04', '#db2777', '#4b5563', '#65a30d'];
  const etiquetaDia = (d, larga) => { const [y, m, dd] = d.split('-').map(Number), corta = String(dd).padStart(2, '0') + '/' + String(m).padStart(2, '0'); return larga ? new Date(y, m - 1, dd).toLocaleDateString('es-AR', { weekday: 'short' }) + ' ' + corta : corta; };
  const fmtVal = (m, v) => v == null ? '—' : (m === 'armado' || m === 'reloj') ? fmtMin(v) : m === 'porArt' ? n2(v) + ' min' : n0(v);
  function escalaNice(max) { if (!(max > 0)) return { max: 1, paso: 0.2 }; const raw = max / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag, nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10, paso = nf * mag; return { max: Math.ceil(max / paso - 1e-9) * paso, paso }; }
  function sucActivas() {   // [] = todas
    const g = E.graf; if (g.sucSel && g.sucSel.size) return [...g.sucSel];
    if (g.modo === 'sucursal') { const t = {}; E.pedidos.forEach(p => { t[p.sucursal] = (t[p.sucursal] || 0) + p.lineas; }); return Object.keys(t).sort((a, b) => t[b] - t[a]).slice(0, 4).sort(); }
    return [];
  }
  function armActivos() { const g = E.graf; return g.armSel && g.armSel.size ? [...g.armSel] : listaArmadores(E.pedidos).slice(0, 4).map(a => a.id); }
  const opcionesGraf = () => ({ modo: E.graf.modo, metrica: E.graf.metrica, sucursales: sucActivas(), armadores: E.graf.modo === 'armador' ? armActivos() : [], desde: E.graf.desde, hasta: E.graf.hasta, esperado: E.modelo ? esperado : null, calidad: E.calidad });

  function tablaPedidos(lista, pref, conDia) {
    return `<div style="overflow-x:auto"><table class="tp-t"><tr>${conDia ? '<th>Día</th>' : ''}<th>Sucursal</th><th>Artículos</th><th>Sin stock</th><th>Personas</th><th>Tiempo de armado</th><th>Tiempo total</th><th>Min por artículo</th><th>Debería tardar</th></tr>
      ${lista.map((p, i) => { const e = esperado(p), real = p.trabajoMs / MIN, dv = e ? (real / e - 1) * 100 : null, quienes = p.personas.filter(x => x.picks >= 5).map(x => esc(x.nombre.split(' ')[0]) + ' ' + fmtMin(x.trabajoMs / MIN)).join(' · ');
        return `<tr class="tp-click" data-cuenta="${pref}:${i}">${conDia ? `<td style="white-space:nowrap">${esc(p.dia)}</td>` : ''}<td><b>${esc(p.sucursal)}</b>${quienes ? `<div class="contador">${quienes}</div>` : ''}</td><td>${n0(p.lineas)}<div class="contador">${n0(p.unidades)} unid.</div></td><td>${p.picks ? n0(p.sinStock / p.picks * 100) + '%' : '—'}</td><td>${p.k}</td>
          <td><b>${fmtMin(real)}</b><div class="contador">demoras ${fmtMin(p.demoraMs / MIN)} · pausas ${fmtMin(p.pausaMs / MIN)}</div></td><td style="white-space:nowrap">${fmtMin(p.relojMs / MIN)}</td><td>${p.lineas ? n1(real / p.lineas) : '—'}</td>
          <td style="white-space:nowrap">${e == null ? '—' : fmtMin(e)}${dv == null ? '' : `<div style="font-size:12px;color:${dv > 25 ? 'var(--red)' : dv < -15 ? 'var(--green)' : 'var(--muted)'}">${Math.abs(dv) < 0.5 ? '0' : (dv > 0 ? '+' : '') + n0(dv)}%</div>`}</td></tr>`; }).join('')}</table></div>`;
  }

  function renderGrafico() {
    const host = $('tp_graf'); if (!host) return;
    if (!E.pedidos.length) { host.innerHTML = `<div class="empty-state">${E.cargado ? 'No hay marcas de armado en este período.' : 'Leyendo las marcas de armado...'}</div>`; return; }
    const g = E.graf, todos = [...new Set(E.pedidos.map(p => p.dia))].sort(), primero = todos[0], ultimo = todos[todos.length - 1];
    if (g.modo === 'armador' && g.metrica === 'reloj') g.metrica = 'armado';
    const S = serieDiaria(E.pedidos, opcionesGraf()), visibles = S.lineas.filter(l => !g.ocultas.has(l.id)), n = S.dias.length;
    S.lineas.forEach((l, i) => { l.color = l.estilo === 'esperado' ? '#64748b' : (g.modo === 'todo' ? (l.id === 'real' ? '#2563eb' : '#0891b2') : COLORES[i % COLORES.length]); });
    const seg = (items, actual, tipo) => `<div class="tp-seg">${items.map(([v, t]) => `<button class="${v === actual ? 'on' : ''}" data-g="${tipo}:${v}">${t}</button>`).join('')}</div>`;
    const metricas = Object.keys(METRICAS).filter(k => !(g.modo === 'armador' && k === 'reloj')).map(k => [k, METRICAS[k].nombre]);
    const sucs = [...new Set(E.pedidos.map(p => p.sucursal))].sort(), activasS = sucActivas(), armadores = listaArmadores(E.pedidos), activosA = armActivos();
    const chip = (tipo, v, txt, on) => `<button class="tp-chip ${on ? 'on' : ''}" data-g="${tipo}:${esc(v)}">${esc(txt)}</button>`;
    const ayuda = METRICAS[g.metrica].ayuda + (g.modo === 'todo' ? (E.modelo ? ' La línea punteada es lo que debería tardar según tu propio historial, y la franja es el rango en el que suele caer.' : '') : g.modo === 'sucursal' ? ' Cada línea es una sucursal.' : ' Cada línea es una persona' + (g.metrica === 'porArt' ? '; si está por encima del promedio del equipo, esa persona tarda más por artículo.' : '.'));
    // ---- el dibujo
    const W = Math.max(320, Math.round(host.clientWidth || 900)), H = W < 560 ? 260 : 340, ML = 46, MR = 14, MT = 14, MB = 30, IW = W - ML - MR, IH = H - MT - MB;
    const valores = visibles.flatMap(l => Object.values(l.valores)), conBanda = S.banda && visibles.some(l => l.id === 'esperado');
    const todosV = [...valores, ...(conBanda ? Object.values(S.banda).flat() : [])], maxY = Math.max(...todosV, 0), minV = todosV.length ? Math.min(...todosV) : 0;
    let yMin = 0, esc_ = escalaNice(maxY);   // el eje arranca en 0; solo en 'minutos por artículo' se ajusta a lo que hay, para que se vean las diferencias
    if (g.metrica === 'porArt' && maxY > 0) { const base = minV * 0.8; esc_ = escalaNice(maxY - base); yMin = Math.max(0, Math.floor(base / esc_.paso) * esc_.paso); esc_.max = Math.max(yMin + esc_.paso, Math.ceil(maxY / esc_.paso - 1e-9) * esc_.paso); }
    const top = esc_.max, xi = i => ML + (n === 1 ? IW / 2 : i * IW / (n - 1)), yv = v => MT + IH - ((v - yMin) / (top - yMin || 1)) * IH, fmtY = v => esc_.paso < 1 ? n2(v) : n0(v);
    let svg = `<svg class="tp-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Gráfico de tiempos por día">`;
    for (let v = yMin; v <= top + 1e-9; v += esc_.paso) svg += `<line x1="${ML}" y1="${yv(v)}" x2="${W - MR}" y2="${yv(v)}" stroke="#e5e7eb"/><text x="${ML - 8}" y="${yv(v) + 4}" font-size="11" fill="#6b7280" text-anchor="end">${fmtY(v)}</text>`;
    const cada = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(IW / 58))));
    S.dias.forEach((d, i) => { if (i % cada === 0 || i === n - 1) svg += `<text x="${xi(i)}" y="${H - 10}" font-size="11" fill="#6b7280" text-anchor="middle">${etiquetaDia(d)}</text>`; });
    const dsel = g.diaSel && S.dias.includes(g.diaSel) ? g.diaSel : S.dias[n - 1]; g.diaSel = dsel || '';
    if (dsel) { const i = S.dias.indexOf(dsel); svg += `<rect x="${xi(i) - Math.max(6, IW / n / 2 - 1)}" y="${MT}" width="${Math.max(12, IW / n - 2)}" height="${IH}" fill="rgba(37,99,235,.08)"/>`; }
    if (conBanda) { const idx = S.dias.map((d, i) => S.banda[d] ? i : -1).filter(i => i >= 0); if (idx.length > 1) svg += `<polygon points="${idx.map(i => `${xi(i)},${yv(S.banda[S.dias[i]][1])}`).concat(idx.slice().reverse().map(i => `${xi(i)},${yv(S.banda[S.dias[i]][0])}`)).join(' ')}" fill="rgba(37,99,235,.13)"/>`; }
    visibles.forEach(l => {
      let seg_ = []; const cerrar = () => { if (seg_.length > 1) svg += `<polyline points="${seg_.join(' ')}" fill="none" stroke="${l.color}" stroke-width="${l.estilo === 'esperado' ? 2 : 2.6}" ${l.estilo === 'esperado' ? 'stroke-dasharray="7 5"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`; seg_ = []; };
      S.dias.forEach((d, i) => { const v = l.valores[d]; if (v == null) cerrar(); else seg_.push(`${xi(i)},${yv(v)}`); }); cerrar();
      if (l.estilo !== 'esperado') S.dias.forEach((d, i) => { const v = l.valores[d]; if (v != null) svg += `<circle cx="${xi(i)}" cy="${yv(v)}" r="${n > 40 ? 2.4 : 3.6}" fill="${l.color}" stroke="#fff" stroke-width="1.2"/>`; });
    });
    svg += `<line class="tp-cross" x1="0" y1="${MT}" x2="0" y2="${MT + IH}" stroke="#94a3b8" stroke-dasharray="3 3" style="display:none"/><rect class="tp-selrect" x="0" y="${MT}" width="0" height="${IH}" fill="rgba(37,99,235,.15)" style="display:none"/><rect class="tp-gover" x="${ML}" y="${MT}" width="${IW}" height="${IH}" fill="transparent" style="touch-action:pan-y;cursor:crosshair"/></svg>`;
    const leyenda = S.lineas.map(l => `<button class="tp-leg ${g.ocultas.has(l.id) ? 'off' : ''}" data-g="linea:${esc(l.id)}" title="Tocá para mostrar u ocultar"><span class="tp-sw" style="${l.estilo === 'esperado' ? `background:repeating-linear-gradient(90deg,${l.color} 0 5px,transparent 5px 8px)` : `background:${l.color}`}"></span>${esc(l.nombre)}</button>`).join('') + (conBanda ? '<span class="tp-leg tp-leg-b"><span class="tp-sw" style="background:rgba(37,99,235,.25)"></span>Rango en el que suele caer</span>' : '');
    // ---- el detalle del día elegido
    const delDia = dsel ? E.pedidos.filter(p => p.dia === dsel && (!activasS.length || activasS.includes(p.sucursal))) : []; E.filasDia = delDia;
    const resumenDia = dsel && S.info[dsel] ? `${S.info[dsel].pedidos} pedido${S.info[dsel].pedidos === 1 ? '' : 's'} · ${n0(S.info[dsel].lineas)} artículos · ${n0(S.info[dsel].unidades)} unidades` : '';
    host.innerHTML = `<div class="tp-ctl"><span class="tp-lbl">Ver</span>${seg([['todo', 'Todo junto'], ['sucursal', 'Por sucursal'], ['armador', 'Por armador']], g.modo, 'modo')}</div>
      <div class="tp-ctl"><span class="tp-lbl">Qué mirar</span>${seg(metricas, g.metrica, 'metrica')}</div>
      <div class="tp-ayuda">${ayuda}</div>
      <div class="tp-ctl"><span class="tp-lbl">Días</span><input type="date" data-g="desde" value="${g.desde || primero}" min="${primero}" max="${ultimo}"> a <input type="date" data-g="hasta" value="${g.hasta || ultimo}" min="${primero}" max="${ultimo}">
        <button class="tp-chip" data-g="rango:7">Últimos 7 días</button><button class="tp-chip" data-g="rango:14">14 días</button><button class="tp-chip ${!g.desde && !g.hasta ? 'on' : ''}" data-g="rango:todo">Todo el período</button></div>
      <div class="tp-ctl"><span class="tp-lbl">Sucursales</span>${chip('suc', '__todas__', 'Todas', !activasS.length || activasS.length === sucs.length)}${sucs.map(s => chip('suc', s, s, activasS.includes(s) && activasS.length !== sucs.length)).join('')}</div>
      ${g.modo === 'armador' ? `<div class="tp-ctl"><span class="tp-lbl">Armadores</span>${chip('arm', '__todos__', 'Todos', activosA.length === armadores.length)}${armadores.map(a => chip('arm', a.id, a.nombre, activosA.includes(a.id) && activosA.length !== armadores.length)).join('')}</div>` : ''}
      ${n ? `<div class="tp-gwrap">${svg}<div class="tp-tip" hidden></div></div><div class="tp-leyenda">${leyenda}</div>
      <div class="tp-ayuda">Pasá el mouse (o el dedo) por un día para ver los números. Tocá un día para ver sus pedidos. Arrastrá sobre el gráfico para acercar${g.desde || g.hasta ? ' · <a href="#" data-g="rango:todo">Quitar el zoom</a>' : ''}.</div>
      <h4 class="tp-h4">${dsel ? `Pedidos del ${esc(etiquetaDia(dsel, true))}` : ''} <span class="contador">${resumenDia}</span></h4>${delDia.length ? tablaPedidos(delDia, 'dia', false) : '<div class="empty-state">Tocá un día del gráfico para ver sus pedidos.</div>'}` : '<div class="empty-state">No hay datos con esos filtros.</div>'}`;
    if (!n) return;
    // ---- interacción: números al pasar, tocar un día, arrastrar para acercar
    const ov = host.querySelector('.tp-gover'), svgEl = host.querySelector('.tp-svg'), tip = host.querySelector('.tp-tip'), wrap = host.querySelector('.tp-gwrap'), cross = host.querySelector('.tp-cross'), sel = host.querySelector('.tp-selrect');
    const px = cx => { const r = svgEl.getBoundingClientRect(); return (cx - r.left) * (W / r.width); };
    const idxDe = cx => Math.max(0, Math.min(n - 1, n === 1 ? 0 : Math.round((px(cx) - ML) / IW * (n - 1))));
    const mostrar = i => {
      const d = S.dias[i], inf = S.info[d] || { pedidos: 0, lineas: 0 }, x = xi(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
      tip.innerHTML = `<b>${esc(etiquetaDia(d, true))}</b>` + visibles.map(l => l.valores[d] == null ? '' : `<div><span class="tp-sw" style="background:${l.color}"></span>${esc(l.nombre)}: <b>${fmtVal(g.metrica, l.valores[d])}</b></div>`).join('') + (S.banda && S.banda[d] && visibles.some(l => l.id === 'esperado') ? `<div class="tp-ti">suele caer entre ${fmtVal(g.metrica, S.banda[d][0])} y ${fmtVal(g.metrica, S.banda[d][1])}</div>` : '') + `<div class="tp-ti">${inf.pedidos} pedido${inf.pedidos === 1 ? '' : 's'} · ${n0(inf.lineas)} artículos</div>`;
      tip.hidden = false; const k = wrap.getBoundingClientRect().width / W; let left = x * k + 14; if (left + tip.offsetWidth > wrap.getBoundingClientRect().width - 4) left = x * k - tip.offsetWidth - 14; tip.style.left = Math.max(4, left) + 'px'; tip.style.top = '10px';
    };
    let arr = null;
    ov.addEventListener('pointerdown', ev => { arr = { x0: px(ev.clientX), i0: idxDe(ev.clientX), mov: false }; try { ov.setPointerCapture(ev.pointerId); } catch (e) { /* sin captura */ } });
    ov.addEventListener('pointermove', ev => {
      mostrar(idxDe(ev.clientX));
      if (arr) { const x1 = px(ev.clientX); if (Math.abs(x1 - arr.x0) > 10) { arr.mov = true; sel.style.display = ''; sel.setAttribute('x', Math.min(arr.x0, x1)); sel.setAttribute('width', Math.abs(x1 - arr.x0)); } }
    });
    ov.addEventListener('pointerup', ev => {
      if (!arr) return; const i1 = idxDe(ev.clientX), a = arr; arr = null; sel.style.display = 'none';
      if (a.mov && Math.abs(i1 - a.i0) >= 1) { g.desde = S.dias[Math.min(a.i0, i1)]; g.hasta = S.dias[Math.max(a.i0, i1)]; g.diaSel = ''; renderGrafico(); }
      else { g.diaSel = S.dias[i1]; renderGrafico(); }
    });
    ov.addEventListener('pointerleave', () => { if (arr) return; tip.hidden = true; cross.style.display = 'none'; });
    ov.addEventListener('pointercancel', () => { arr = null; sel.style.display = 'none'; tip.hidden = true; cross.style.display = 'none'; });
  }
  function accionGraf(a) {
    const g = E.graf, i = a.indexOf(':'), tipo = i < 0 ? a : a.slice(0, i), v = i < 0 ? '' : a.slice(i + 1), todos = [...new Set(E.pedidos.map(p => p.dia))].sort();
    if (tipo === 'modo') { g.modo = v; g.sucSel = null; g.armSel = null; g.ocultas.clear(); }
    else if (tipo === 'metrica') { g.metrica = v; g.ocultas.clear(); }
    else if (tipo === 'rango') { if (v === 'todo') { g.desde = g.hasta = ''; } else { const ult = todos[todos.length - 1], [y, m, d] = ult.split('-').map(Number), f = new Date(y, m - 1, d - (+v - 1)); g.hasta = ult; g.desde = fechaLocal(f.getTime()) < todos[0] ? '' : fechaLocal(f.getTime()); } g.diaSel = ''; }
    else if (tipo === 'suc') { if (v === '__todas__') g.sucSel = null; else { const s = new Set(sucActivas()); if (g.modo !== 'sucursal' && !(g.sucSel && g.sucSel.size)) s.clear(); s.has(v) ? s.delete(v) : s.add(v); g.sucSel = s.size ? s : null; } }
    else if (tipo === 'arm') { if (v === '__todos__') g.armSel = new Set(listaArmadores(E.pedidos).map(x => x.id)); else { const s = new Set(armActivos()); s.has(v) ? s.delete(v) : s.add(v); g.armSel = s.size ? s : null; } }
    else if (tipo === 'linea') { g.ocultas.has(v) ? g.ocultas.delete(v) : g.ocultas.add(v); }
    renderGrafico();
  }

  // ======================================================== pedidos de hoy
  function renderHoy() {
    const host = $('tp_hoy'); if (!host) return; const h = E.hoy;
    if (h.error) { host.innerHTML = `<div class="empty-state">No se pudieron leer los pedidos: ${esc(h.error)} <button class="btn-chico" id="tp_btnHoy">Reintentar</button></div>`; return; }
    if (!h.cargado) { host.innerHTML = '<div class="empty-state">Leyendo los pedidos de hoy...</div>'; return; }
    if (!h.grupos.length) { host.innerHTML = '<div class="mt-barra">No hay pedidos sin procesar en este momento. <button class="btn-chico" id="tp_btnHoy">Actualizar</button></div>'; return; }
    const m = E.modelo, cfg = E.cfg, inicioHoy = new Date().setHours(0, 0, 0, 0), grupos = h.grupos;
    const est = g => { const u = usoHoy(g); return m ? (u.l > 0 ? predecir(m, u.l, u.u, fac(g.sucursal)) : 0) : null; };
    const viejos = grupos.filter(g => g.desde && g.desde < inicioHoy), tot = { lineas: suma(grupos.map(g => g.lineas)), unidades: suma(grupos.map(g => g.unidades)), armadas: suma(grupos.map(g => g.armadas)), sinHab: suma(grupos.map(g => g.sinHabilitar)), est: m ? suma(grupos.map(est)) : null };
    const aviso = !m ? (E.cargado ? 'Todavía no hay suficiente historial de armado para estimar el tiempo (hacen falta al menos 3 pedidos de 5 artículos o más).' : 'Calculando el historial para estimar el tiempo...') : '';
    const items = m ? grupos.map(g => ({ nombre: g.sucursal, min: est(g) })).filter(x => x.min > 0) : [];
    host.innerHTML = `<div class="mt-barra" style="flex-wrap:wrap;gap:8px 16px"><b>Contar</b> <label><input type="radio" name="tp_modo" value="todo" ${h.modo === 'todo' ? 'checked' : ''}> todo el pedido</label> <label><input type="radio" name="tp_modo" value="falta" ${h.modo === 'falta' ? 'checked' : ''}> solo lo que falta armar</label>
        <button class="btn-chico" id="tp_btnHoy">Actualizar</button> <span class="contador">${n0(h.items.length)} renglones sin procesar${tot.sinHab ? ` · ${n0(tot.sinHab)} esperan habilitación y no se cuentan` : ''}${viejos.length ? ` · hay pedidos de días anteriores sin procesar (desde ${fechaLocal(Math.min(...viejos.map(g => g.desde)))})` : ''}</span></div>
      ${aviso ? `<div class="note" style="margin-bottom:10px">${aviso}</div>` : ''}
      <div style="overflow-x:auto"><table class="tp-t"><tr><th>Sucursal</th><th>Artículos</th><th>Armados</th><th>Debería tardar<div class="contador">una persona</div></th><th>Entre 2<div class="contador">cada una</div></th><th>Entre 3<div class="contador">cada una</div></th></tr>
      ${grupos.map((g, i) => { const e = est(g), u = usoHoy(g);
        return `<tr class="tp-click" data-cuenta="hoy:${i}" title="Tocá para ver la cuenta"><td><b>${esc(g.sucursal)}</b>${g.sinHabilitar ? `<div class="contador">${g.sinHabilitar} sin habilitar</div>` : ''}${g.desde && g.desde < inicioHoy ? `<div class="contador">desde ${fechaLocal(g.desde)}</div>` : ''}</td>
          <td>${n0(u.l)}<div class="contador">${n0(u.u)} unid.</div></td><td>${n0(g.armadas)} de ${n0(g.lineas)}<div class="contador">${g.lineas ? n0(g.armadas / g.lineas * 100) : 0}%${g.sinStock ? ` · ${g.sinStock} sin stock` : ''}</div></td>
          ${[1, 2, 3].map(k => `<td>${e == null ? '—' : '<b>' + fmtMin(detalleDividido(e, k, cfg).cadaUna) + '</b>'}</td>`).join('')}</tr>`; }).join('')}
      <tr style="border-top:2px solid var(--border, #e2e8f0)"><td><b>Todo junto</b></td><td><b>${n0(tot.lineas)}</b><div class="contador">${n0(tot.unidades)} unid.</div></td><td>${n0(tot.armadas)} de ${n0(tot.lineas)}</td>
        ${[1, 2, 3].map(k => { if (tot.est == null) return '<td>—</td>'; const d = detalleDividido(tot.est, k, cfg); return `<td><b>${fmtMin(d.cadaUna)}</b><div class="contador">con margen y descansos: ${fmtMin(d.reloj)} · termina a las ${horaFin(cfg.inicio, d.reloj)}</div></td>`; }).join('')}</tr></table></div>
      ${items.length ? `<div class="contador" style="margin-top:8px">Si en vez de repartirse cada pedido, cada pedido lo arma una sola persona: ${[2, 3].map(k => { const e = escenarioEnteros(items, k, cfg); return `con ${k} personas terminan a las ${horaFin(cfg.inicio, e.relojMin)} (${e.cargas.map((c, j) => `persona ${j + 1}: ${c.items.map(x => esc(x.nombre)).join(', ') || '—'}`).join(' · ')})`; }).join('; ')}.</div>` : ''}
      <div class="contador" style="margin-top:8px">"Debería tardar" es el tiempo de armado según tu historial, sin pausas. "Entre 2" y "Entre 3" dividen el trabajo y suman ${n0(cfg.equipo[2])}% y ${n0(cfg.equipo[3])}% por trabajar entre varios. Tocá un pedido para ver la cuenta. Todo se puede cambiar en Ajustes.</div>`;
  }

  // ======================================================== calculadora de un pedido
  function renderCalc() {
    const host = $('tp_calc'); if (!host) return;
    if (!E.modelo) { host.innerHTML = `<div class="empty-state">${E.cargado ? 'No hay historial suficiente para estimar.' : 'Calculando el historial...'}</div>`; return; }
    const sucs = [...new Set(E.pedidos.map(p => p.sucursal))].sort(), c = E.calc;
    if (!c.sucursal || !sucs.includes(c.sucursal)) { c.sucursal = sucs[0]; Object.assign(c, tipico(c.sucursal)); }
    host.innerHTML = `<div class="mt-barra" style="flex-wrap:wrap;gap:10px 16px"><span><b>Sucursal</b> <select id="tp_calcSuc">${sucs.map(s => `<option ${s === c.sucursal ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></span>
        <span><b>Artículos</b> <input type="number" data-calc="lineas" value="${c.lineas}" min="0" style="width:70px"></span> <span><b>Unidades</b> <input type="number" data-calc="unidades" value="${c.unidades}" min="0" style="width:80px"></span>
        <span class="contador">Arranca con el tamaño típico de esa sucursal (mediana de sus últimos 10 pedidos).</span></div><div id="tp_calcRes"></div>`;
    renderCalcRes();
  }
  function renderCalcRes() {
    const host = $('tp_calcRes'); if (!host || !E.modelo) return; const c = E.calc, cfg = E.cfg;
    if (!(c.lineas > 0)) { host.innerHTML = '<div class="empty-state">Poné cuántos artículos tiene el pedido.</div>'; return; }
    const cu = cuentaPedido(E.modelo, E.factores[c.sucursal], c.lineas, c.unidades, cfg, E.calidad);
    host.innerHTML = `<div class="tp-resumen">Un pedido de <b>${esc(c.sucursal)}</b> con <b>${n0(c.lineas)} artículos</b> y ${n0(c.unidades)} unidades <b>debería tardar ${fmtMin(cu.tBase)}</b> si lo arma una sola persona${cu.rango ? ` (en la práctica, entre ${fmtMin(cu.rango.lo)} y ${fmtMin(cu.rango.hi)})` : ''}, sin contar pausas.</div>
      <table class="tp-t"><tr><th></th><th>1 persona</th><th>2 personas</th><th>3 personas</th></tr>
        <tr><td>Cada una arma</td>${cu.cols.map(d => `<td><b>${fmtMin(d.cadaUna)}</b></td>`).join('')}</tr>
        <tr><td>Tiempo total estimado<div class="contador">con margen y descansos</div></td>${cu.cols.map(d => `<td>${fmtMin(d.reloj)}</td>`).join('')}</tr>
        <tr><td>Terminan a las</td>${cu.cols.map(d => `<td>${d.fin}</td>`).join('')}</tr></table>
      <div style="margin-top:8px"><button class="btn-chico" data-cuenta="calc:0">Ver la cuenta paso a paso</button></div>`;
  }

  // ======================================================== ajustes (con explicación)
  function renderAjustes() {
    const host = $('tp_ajustes'); if (!host) return; const c = E.cfg, m = E.modelo, q = E.calidad;
    let modeloTxt = '<p>Todavía no hay historial suficiente para estimar (hacen falta al menos 3 pedidos de 5 artículos o más).</p>';
    if (m) {
      const juntos = m.rho > 0.95 && m.terminos > 1, porArt = m.b + m.c * m.uPorArt, demoraPct = suma(E.pedidos.map(p => p.demoraMs)) / Math.max(1, suma(E.pedidos.map(p => p.trabajoMs))) * 100, sucs = Object.keys(E.factores).sort((a, b) => E.factores[b].factor - E.factores[a].factor);
      modeloTxt = `<p>Con tu historial (${m.n.toLocaleString('es-AR')} pedidos${m.soloUnaPersona ? ' armados por una sola persona' : ''}), armar un pedido lleva <b>${juntos ? `≈ ${n1(porArt)} min por artículo (con ${n1(m.uPorArt)} unidades por artículo en promedio)` : `${m.a > 0.05 ? n1(m.a) + ' min fijos + ' : ''}${n1(m.b)} min por artículo${m.c > 0.0005 ? ' + ' + n3(m.c) + ' min por unidad' : ''}`}</b>, con un ajuste para cada sucursal (unas son más lentas que otras).
        La estimación se equivoca en promedio ${n0(q.mape * 100)}% por pedido, y un pedido real suele quedar entre ${n0((q.p20 - 1) * 100)}% y +${n0((q.p80 - 1) * 100)}% de lo estimado. Las demoras de ${c.umbralDemora} a ${c.umbralPausa} min equivalen a ${n0(demoraPct)}% del tiempo de armado.</p>
        <p class="contador">No incluye el arranque (ir al primer pasillo, preparar el pallet) ni el cierre (envolver, etiquetar): hoy el Armador no los marca. El tiempo de armado suma los tiempos entre artículos seguidos y agrega un artículo promedio por persona, porque el primero no tiene uno anterior.</p>
        ${sucs.length ? `<table class="tp-t"><tr><th>Sucursal</th><th>Pedidos (1 persona)</th><th>Tarda respecto del promedio</th></tr>${sucs.map(s => { const f = E.factores[s]; return `<tr><td style="font-weight:700">${esc(s)}</td><td>${f.n}</td><td>${f.bruto >= 1 ? '+' : ''}${n0((f.bruto - 1) * 100)}%</td></tr>`; }).join('')}</table>` : ''}`;
    }
    host.innerHTML = `<details id="tp_detAj" ${E.ajustesAbierto ? 'open' : ''}><summary>⚙️ Ajustes y cómo se calcula</summary><div class="tp-aj">
      <div class="tp-ajf"><b>Margen</b> ${num('tolerancia', c.tolerancia, 58)} %<p>Tiempo extra que se suma al tiempo de armado para dar un tiempo realista, porque siempre hay demoras y necesidades personales. Ejemplo: si armar son 100 min y el margen es 15%, el tiempo total estimado es 115 min.</p></div>
      <div class="tp-ajf"><b>Pérdida por armar entre varios</b> Entre 2: ${num('equipo.2', c.equipo[2], 54)} % Entre 3: ${num('equipo.3', c.equipo[3], 54)} %<p>Si varias personas arman el mismo pedido, el tiempo no baja justo a la mitad (o a un tercio): se coordinan y se pisan. Ejemplo: 100 min entre 2 personas son 50 min cada una, más 10% = 55 min cada una.</p></div>
      <div class="tp-ajf"><b>Empiezan a las</b> <input type="time" data-cfg="inicio" value="${esc(c.inicio)}"><p>Sirve para calcular a qué hora terminan.</p></div>
      <div class="tp-ajf"><b>Descansos</b>${c.descansos.map((d, i) => `<div>${esc(d.nombre)}: si el trabajo de una persona pasa de ${num('descansos.' + i + '.despues', d.despues, 58)} min, se suma un descanso de ${num('descansos.' + i + '.dura', d.dura, 50)} min</div>`).join('')}<p>Se suman al tiempo total estimado. Ponelos en 0 si no querés contarlos.</p></div>
      <div class="tp-ajf"><b>Demoras y pausas</b> Entre dos artículos seguidos, hasta ${num('umbralDemora', c.umbralDemora, 46)} min cuenta como trabajo; de ahí hasta ${num('umbralPausa', c.umbralPausa, 46)} min es una demora (no cuenta como armado); más es una pausa.<p>Al cambiarlo se recalcula todo el historial.</p></div>
      <div class="tp-ajf"><b>Cómo se calcula lo que debería tardar</b>${modeloTxt}</div></div></details>`;
  }

  // ======================================================== todos los pedidos armados
  function renderPedidos() {
    const host = $('tp_pedidos'); if (!host) return; if (!E.pedidos.length) { host.innerHTML = '<div class="empty-state">No hay marcas de armado en este período.</div>'; return; }
    const sucs = [...new Set(E.pedidos.map(p => p.sucursal))].sort(), filas = E.pedidos.filter(p => !E.filtroSuc || p.sucursal === E.filtroSuc), tope = 150; E.filasVis = filas.slice(0, tope);
    host.innerHTML = `<div class="mt-barra"><b>Sucursal</b> <select id="tp_filtroSuc"><option value="">Todas</option>${sucs.map(s => `<option ${s === E.filtroSuc ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select> <button class="btn-chico" id="tp_btnCSV">⬇ CSV</button> <span class="contador">${filas.length.toLocaleString('es-AR')} pedidos · tocá uno para ver la cuenta</span></div>
      ${tablaPedidos(E.filasVis, 'ped', true)}${filas.length > tope ? `<div class="contador" style="margin-top:8px">Se muestran los ${tope} más recientes; el CSV trae todos.</div>` : ''}`;
    $('tp_filtroSuc').onchange = e => { E.filtroSuc = e.target.value; renderPedidos(); };
    $('tp_btnCSV').onclick = descargarCSV;
  }
  function descargarCSV() {
    const cel = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const enc = ['Día', 'Sucursal', 'Artículos', 'Unidades', 'Marcas', 'Sin stock', 'Personas', 'Tiempo de armado (min)', 'Demoras (min)', 'Pausas (min)', 'Tiempo total (min)', 'Min por artículo', 'Debería tardar 1 persona (min)', 'Desvío %', 'Detalle por persona'];
    const filas = E.pedidos.filter(p => !E.filtroSuc || p.sucursal === E.filtroSuc).map(p => { const e = esperado(p), real = p.trabajoMs / MIN; return [p.dia, p.sucursal, p.lineas, p.unidades, p.picks, p.sinStock, p.k, n1(real), n1(p.demoraMs / MIN), n1(p.pausaMs / MIN), n1(p.relojMs / MIN), p.lineas ? n1(real / p.lineas) : '', e == null ? '' : n1(e), e ? n0((real / e - 1) * 100) : '', p.personas.map(x => x.nombre + ': ' + n1(x.trabajoMs / MIN) + ' min de armado, ' + x.picks + ' marcas').join(' | ')]; });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + [enc, ...filas].map(f => f.map(cel).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'pedidos_tiempos_' + fechaLocal(Date.now()) + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ======================================================== la cuenta de un pedido (ventana)
  function abrirCuenta(info) { E.cuenta = info; $('tp_modal').hidden = false; renderCuenta(); }
  function cerrarCuenta() { E.cuenta = null; const mo = $('tp_modal'); if (mo) mo.hidden = true; }
  function renderCuenta() {
    const host = $('tp_cuenta'), c = E.cuenta; if (!host || !c) return;
    if (!E.modelo) { host.innerHTML = '<div class="empty-state">Todavía no hay modelo para hacer la cuenta.</div>'; return; }
    const cfg = E.cfg, fi = E.factores[c.sucursal], cu = cuentaPedido(E.modelo, fi, c.lineas, c.unidades, cfg, E.calidad), m = cu.modelo, juntos = E.modelo.rho > 0.95 && E.modelo.terminos > 1, cols = cu.cols;
    const infoFactor = fi ? `${esc(c.sucursal)} tardó ${n0(Math.abs(fi.bruto - 1) * 100)}% ${fi.bruto >= 1 ? 'más' : 'menos'} que el promedio en ${fi.n} pedidos${fi.n < 12 ? '; con pocos pedidos el ajuste se acerca prudentemente a 1' : ''}` : `${esc(c.sucursal)} no tiene historial de una sola persona: no se ajusta`;
    const real = c.real != null ? `<tr class="tp-real"><td colspan="2">Lo que tardó de verdad ese día (tiempo de armado)</td><td><b>${n1(c.real)} min</b> (${(c.real / cu.tBase - 1) * 100 >= 0 ? '+' : ''}${n0((c.real / cu.tBase - 1) * 100)}% contra lo esperado${c.realReloj != null ? '; tiempo total, ' + fmtMin(c.realReloj) : ''})</td></tr>` : '';
    const cel = fn => cols.map(d => `<td>${fn(d)}</td>`).join('');
    host.innerHTML = `<h3 style="margin:0 0 4px">La cuenta: ${esc(c.sucursal)}</h3>
      <div class="contador" style="margin-bottom:12px">${esc(c.titulo || '')} · ${n0(c.lineas)} artículos · ${n0(c.unidades)} unidades${c.nota ? ' · ' + esc(c.nota) : ''}. Los números con casillero los podés cambiar: se guarda y se recalcula todo.</div>
      <h4 style="margin:0 0 6px">1. Cuánto debería tardar una persona armando (sin pausas)</h4>
      <table class="tp-t"><tr><th>Paso</th><th>Cuenta</th><th>Resultado</th></tr>
        <tr><td>Artículos</td><td>${n0(m.lineas)} artículos × ${n2(m.b)} min</td><td>${n1(m.tB)} min</td></tr>
        ${m.c > 0.0005 ? `<tr><td>Unidades</td><td>${n0(m.unidades)} unidades × ${n3(m.c)} min</td><td>${n1(m.tC)} min</td></tr>` : ''}
        ${Math.abs(m.a) > 0.05 ? `<tr><td>Tiempo fijo</td><td>arranque y cierre promedio</td><td>${n1(m.tA)} min</td></tr>` : ''}
        <tr><td><b>Según el historial</b></td><td>la suma de lo anterior${juntos ? ' (los artículos y las unidades crecen a la par: lo que vale es el total, no cada parte)' : ''}</td><td><b>${n1(m.tModelo)} min</b></td></tr>
        <tr><td>Ajuste de la sucursal</td><td>× ${n2(cu.factor)} (${infoFactor})</td><td>${n1(cu.tBase)} min</td></tr>
        <tr class="tp-total"><td><b>Debería tardar</b></td><td>una persona, sin pausas ni demoras${cu.rango ? `; un pedido real suele quedar entre ${n1(cu.rango.lo)} y ${n1(cu.rango.hi)} min` : ''}</td><td><b>${n1(cu.tBase)} min</b></td></tr>${real}</table>
      <h4 style="margin:16px 0 6px">2. Entre 1, 2 o 3 personas</h4>
      <div style="overflow-x:auto"><table class="tp-t"><tr><th>Paso</th><th>1 persona</th><th>2 personas</th><th>3 personas</th></tr>
        <tr><td>Debería tardar</td>${cel(d => n1(d.total) + ' min')}</tr>
        <tr><td>Se reparte entre las personas</td><td>—</td>${[2, 3].map(k => `<td>÷ ${k}<div class="contador">→ ${n1(cols[k - 1].porPersona)} min cada una</div></td>`).join('')}</tr>
        <tr><td>Pérdida por armar entre varios<div class="contador">se coordinan y se pisan</div></td><td>—</td>${[2, 3].map(k => `<td>+ ${num('equipo.' + k, cfg.equipo[k], 50)} %<div class="contador">→ ${n1(cols[k - 1].cadaUna)} min cada una</div></td>`).join('')}</tr>
        <tr class="tp-total"><td><b>Cada persona arma</b></td>${cel(d => '<b>' + n1(d.cadaUna) + ' min</b>')}</tr>
        <tr><td>Margen ${num('tolerancia', cfg.tolerancia, 52)} %<div class="contador">demoras y necesidades personales</div></td>${cel(d => '+ ' + n0(d.tolerancia) + '%<div class="contador">→ ' + n1(d.trabajo) + ' min de trabajo</div>')}</tr>
        <tr><td>Descansos que caen en el turno${cfg.descansos.map((d, i) => `<div class="contador">${esc(d.nombre)}: si pasa de ${num('descansos.' + i + '.despues', d.despues, 50)} min, suma ${num('descansos.' + i + '.dura', d.dura, 42)} min</div>`).join('')}</td>${cel(d => d.descansosMin ? '+ ' + n0(d.descansosMin) + ' min<div class="contador">' + d.descansos.map(x => esc(x.nombre)).join(' y ') + '</div>' : 'ninguno')}</tr>
        <tr class="tp-total"><td><b>Tiempo total estimado</b></td>${cel(d => '<b>' + fmtMin(d.reloj) + '</b>')}</tr>
        <tr><td>Terminan a las<div class="contador">empiezan a las <input type="time" data-cfg="inicio" value="${esc(cfg.inicio)}"></div></td>${cel(d => d.fin)}</tr></table></div>`;
  }

  // ======================================================== armado del panel y eventos
  function abrir() {
    const host = $('tp_contenido'); if (!host || host.dataset.listo) return; host.dataset.listo = '1';
    host.innerHTML = `<style>.tp-t th,.tp-t td{padding:9px 8px;vertical-align:top}.tp-t td{font-size:14px}.tp-t .contador{font-size:12px;margin-top:2px}.tp-t td:nth-child(2) b{white-space:nowrap}
        .tp-click{cursor:pointer}.tp-click:hover td{background:rgba(46,91,255,.06)}
        .tp-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:0 0 10px}.tp-lbl{font-weight:800;min-width:78px}
        .tp-seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:#fff}.tp-seg button{border:0;background:#fff;padding:8px 14px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;color:var(--text)}.tp-seg button+button{border-left:1px solid var(--border)}.tp-seg button.on{background:var(--primary);color:#fff}
        .tp-chip{border:1px solid var(--border);background:#fff;border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;color:var(--text)}.tp-chip.on{background:var(--primary-soft);border-color:var(--primary);color:var(--primary-dark)}
        .tp-ctl input[type=date],.tp-ctl input[type=time]{border:1px solid var(--border);border-radius:8px;padding:5px 8px;font:inherit;font-size:14px}
        .tp-ayuda{font-size:13.5px;color:var(--muted);margin:2px 0 12px;line-height:1.5}.tp-ayuda a{color:var(--primary);font-weight:700}
        .tp-gwrap{position:relative;width:100%}.tp-svg{display:block;width:100%;height:auto;font-family:inherit;user-select:none}
        .tp-tip{position:absolute;pointer-events:none;background:#0f172a;color:#fff;border-radius:10px;padding:9px 11px;font-size:13px;line-height:1.5;z-index:5;box-shadow:0 6px 20px rgba(0,0,0,.25);white-space:nowrap}.tp-tip[hidden]{display:none}.tp-tip b{color:#fff}.tp-ti{color:#cbd5e1;font-size:12px}
        .tp-sw{display:inline-block;width:18px;height:4px;border-radius:2px;vertical-align:middle;margin-right:6px}
        .tp-leyenda{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 0 6px}.tp-leg{border:0;background:none;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;color:var(--text);padding:3px 0}.tp-leg.off{opacity:.4;text-decoration:line-through}.tp-leg-b{cursor:default;font-weight:600;color:var(--muted)}
        .tp-h4{margin:16px 0 8px;font-size:16px}.tp-resumen{background:var(--primary-soft);border-radius:12px;padding:12px 14px;margin-bottom:10px;line-height:1.55}
        #tp_ajustes summary{cursor:pointer;font-weight:800;font-size:16px}.tp-aj{margin-top:12px}.tp-ajf{margin:0 0 14px;line-height:1.7}.tp-ajf p{margin:2px 0 0;font-size:13.5px;color:var(--muted);line-height:1.5}
        .tp-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto}.tp-modal[hidden]{display:none}
        .tp-box{background:#fff;border-radius:16px;max-width:1000px;width:100%;padding:22px 24px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3)}.tp-x{position:absolute;top:12px;right:14px;border:0;background:#eef2f7;border-radius:999px;width:34px;height:34px;font-size:16px;cursor:pointer}
        .tp-box table{width:100%;border-collapse:collapse;font-size:15px}.tp-box th{text-align:left;padding:10px 8px;font-size:12.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border-bottom:2px solid var(--border);white-space:nowrap}
        .tp-box td{padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:top}.tp-box h3,.tp-box h4{color:var(--text,#0f172a)}.tp-box input[type=number],.tp-box input[type=time]{padding:3px 5px;border:1px solid var(--border);border-radius:6px;font:inherit;font-size:13px}
        .tp-total td{background:rgba(46,91,255,.06)}.tp-real td{background:rgba(245,158,11,.12)}</style>
      <div class="card"><div class="mt-barra"><b>Período</b> <select id="tp_semanas"><option value="4">Últimas 4 semanas</option><option value="8">Últimas 8 semanas</option><option value="12">Últimas 12 semanas</option></select>
        <button class="btn-chico azul" id="tp_btnCalcular">Actualizar</button> <span class="contador" id="tp_estado">Leyendo las marcas de armado del período...</span></div></div>
      <div class="card"><h3 class="mt-h3">📈 Cuánto están tardando</h3><div id="tp_graf"><div class="empty-state">Leyendo las marcas de armado...</div></div></div>
      <div class="card"><h3 class="mt-h3">📅 Pedidos de hoy: cuánto deberían tardar</h3><div id="tp_hoy"><div class="empty-state">Leyendo los pedidos de hoy...</div></div></div>
      <div class="card"><h3 class="mt-h3">🧮 ¿Cuánto debería tardar un pedido?</h3><div id="tp_calc"><div class="empty-state">Calculando el historial...</div></div></div>
      <div class="card" id="tp_ajustes"></div>
      <div class="card"><h3 class="mt-h3">📋 Todos los pedidos armados</h3><div id="tp_pedidos"><div class="empty-state">Calculando el historial...</div></div></div>`;
    let modal = $('tp_modal');
    if (!modal) { modal = document.createElement('div'); modal.className = 'tp-modal'; modal.id = 'tp_modal'; modal.hidden = true; modal.innerHTML = '<div class="tp-box"><button class="tp-x" id="tp_cerrar" aria-label="Cerrar">✕</button><div id="tp_cuenta"></div></div>'; document.body.appendChild(modal); }
    renderAjustes();
    $('tp_semanas').onchange = e => { E.semanas = +e.target.value; calcular(); };
    $('tp_btnCalcular').onclick = () => { calcular(); cargarHoy(); };
    const cuentaDe = ref => { const [t, i] = ref.split(':'), n = +i;
      if (t === 'hoy') { const g = E.hoy.grupos[n], u = usoHoy(g); return { sucursal: g.sucursal, lineas: u.l, unidades: u.u, titulo: 'Pedido de hoy' + (E.hoy.modo === 'falta' ? ' (solo lo que falta armar)' : ''), nota: `${g.armadas} de ${g.lineas} artículos ya armados` }; }
      if (t === 'calc') return { sucursal: E.calc.sucursal, lineas: E.calc.lineas, unidades: E.calc.unidades, titulo: 'Pedido de la calculadora' };
      const p = (t === 'dia' ? E.filasDia : E.filasVis)[n]; return { sucursal: p.sucursal, lineas: p.lineas, unidades: p.unidades, titulo: 'Pedido del ' + p.dia, real: p.trabajoMs / MIN, realReloj: p.relojMs / MIN }; };
    const onClick = ev => {
      const t = ev.target;
      if (t.closest('#tp_cerrar') || t.id === 'tp_modal') { cerrarCuenta(); return; }
      const gb = t.closest('[data-g]'); if (gb && gb.tagName !== 'INPUT') { ev.preventDefault(); accionGraf(gb.dataset.g); return; }
      if (t.closest('#tp_btnHoy')) { cargarHoy(); return; }
      const b = t.closest('button[data-cuenta]'); if (b) { abrirCuenta(cuentaDe(b.dataset.cuenta)); return; }
      if (t.closest('input, select, button, a, label')) return;
      const fila = t.closest('[data-cuenta]'); if (fila) abrirCuenta(cuentaDe(fila.dataset.cuenta));
    };
    const onInput = ev => {                         // mientras se escribe: se actualizan los números sin rearmar los casilleros
      const el = ev.target;
      if (el.dataset.calc !== undefined) { E.calc[el.dataset.calc] = Math.max(0, Math.round(+el.value || 0)); renderCalcRes(); return; }
      if (el.dataset.cfg === undefined || el.closest('#tp_modal') || /^umbral/.test(el.dataset.cfg)) return;
      aplicarCfg(el); renderHoy(); renderCalcRes();
    };
    const onChange = ev => {                        // al salir del casillero
      const el = ev.target;
      if (el.id === 'tp_calcSuc') { E.calc.sucursal = el.value; Object.assign(E.calc, tipico(el.value)); renderCalc(); return; }
      if (el.name === 'tp_modo') { E.hoy.modo = el.value; renderHoy(); return; }
      if (el.dataset.g === 'desde' || el.dataset.g === 'hasta') { E.graf[el.dataset.g] = el.value; if (E.graf.desde && E.graf.hasta && E.graf.desde > E.graf.hasta) [E.graf.desde, E.graf.hasta] = [E.graf.hasta, E.graf.desde]; E.graf.diaSel = ''; renderGrafico(); return; }
      if (el.dataset.cfg === undefined) return;
      aplicarCfg(el);
      if (el.closest('#tp_modal')) { refrescar(); return; }
      if (/^umbral/.test(el.dataset.cfg)) { E.cfg.umbralDemora = Math.max(1, E.cfg.umbralDemora || 5); E.cfg.umbralPausa = Math.max(E.cfg.umbralDemora + 1, E.cfg.umbralPausa || 20); guardarCfg(); recalcular(); return; }
      renderHoy(); renderCalcRes();
    };
    [host, modal].forEach(x => { x.addEventListener('click', onClick); x.addEventListener('input', onInput); x.addEventListener('change', onChange); });
    host.addEventListener('toggle', ev => { if (ev.target.id === 'tp_detAj') E.ajustesAbierto = ev.target.open; }, true);
    if (!document.__tpEsc) { document.__tpEsc = true; document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarCuenta(); }); }
    if (!window.__tpResize) { window.__tpResize = true; let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { const h = $('tp_graf'); if (h && h.clientWidth) renderGrafico(); }, 200); }); }
    calcular(); cargarHoy();
  }
  return { abrir };
}
