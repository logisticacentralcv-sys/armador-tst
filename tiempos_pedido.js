// Tiempo por pedido: cuánto tarda armar cada sucursal y cuánto tardarían 1, 2 o 3 personas.
// Se apoya en "eventosArmado" (una marca por artículo armado: hora, persona, sucursal y cantidades).
// Un PEDIDO es una sucursal en un día. Lo pueden armar una o varias personas.

const MIN = 60000;

export const CFG_INICIAL = {
  umbralDemora: 5,     // hasta estos minutos entre dos marcas = trabajo activo
  umbralPausa: 20,     // entre umbralDemora y este = demora (parte del trabajo); más = pausa
  tolerancia: 15,      // % que se suma al tiempo activo: necesidades personales, fatiga, demoras inevitables
  inicio: '07:00',     // hora a la que empieza el turno (para decir "terminan a las ...")
  descansos: [{ nombre: 'Desayuno', despues: 120, dura: 15 }, { nombre: 'Almuerzo', despues: 240, dura: 30 }]  // "después de N minutos de trabajo"
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
export function parametrosParalelo(medido) {
  const p = { 1: PARALELO_SUPUESTO[1] };
  [2, 3].forEach(k => { const m = (medido && medido[k]) || {}; p[k] = { recargo: m.recargoMedido ?? PARALELO_SUPUESTO[k].recargo, desbalance: m.desbalanceMedido ?? PARALELO_SUPUESTO[k].desbalance, n: m.n || 0, medidoRecargo: m.recargoMedido != null, medidoDesbalance: m.desbalanceMedido != null }; });
  return p;
}

// ============================================================ 4) escenarios: 1, 2 o 3 personas
export const conDescansos = (trabajoMin, descansos) => trabajoMin + suma(descansos.filter(d => trabajoMin > d.despues).map(d => d.dura));
// reparten cada pedido entre todos: el trabajo total se divide (con recargo y desbalance)
export function escenarioDividido(esfuerzos, k, par, cfg) {
  const total = suma(esfuerzos), p = par[k] || { recargo: 1, desbalance: 1 };
  const activo = k === 1 ? total : total * p.recargo / k * p.desbalance, trabajo = activo * (1 + cfg.tolerancia / 100);
  return { k, activoMin: activo, trabajoMin: trabajo, relojMin: conDescansos(trabajo, cfg.descansos) };
}
// cada pedido lo arma UNA persona: se reparten los pedidos enteros (el más grande primero, a quien menos tenga)
export function escenarioEnteros(items, k, cfg) {
  const cargas = Array.from({ length: k }, () => ({ min: 0, items: [] }));
  [...items].sort((a, b) => b.min - a.min).forEach(it => { const c = cargas.reduce((m, x) => x.min < m.min ? x : m); c.min += it.min; c.items.push(it); });
  cargas.forEach(c => { c.trabajoMin = c.min * (1 + cfg.tolerancia / 100); c.relojMin = conDescansos(c.trabajoMin, cfg.descansos); });
  return { k, cargas, relojMin: Math.max(...cargas.map(c => c.relojMin)) };
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
  const E = { cfg: null, semanas: 4, eventos: [], pedidos: [], modelo: null, factores: {}, calidad: null, medido: null, plan: null, cargado: false, filtroSuc: '' };
  try { E.cfg = { ...CFG_INICIAL, ...JSON.parse(localStorage.getItem('tp_cfg') || '{}') }; } catch (e) { E.cfg = { ...CFG_INICIAL }; }
  if (!Array.isArray(E.cfg.descansos)) E.cfg.descansos = CFG_INICIAL.descansos;
  const guardarCfg = () => { try { localStorage.setItem('tp_cfg', JSON.stringify(E.cfg)); } catch (e) { /* sin storage */ } };

  async function calcular() {
    const st = $('tp_estado'), btn = $('tp_btnCalcular');
    btn.disabled = true; st.textContent = 'Leyendo las marcas de armado...';
    try {
      const hasta = new Date(), desde = new Date(); desde.setDate(desde.getDate() - E.semanas * 7); desde.setHours(0, 0, 0, 0);
      const snap = await getDocs(query(collection(db, 'eventosArmado'), where('timestamp', '>=', Timestamp.fromDate(desde)), where('timestamp', '<=', Timestamp.fromDate(hasta)), orderBy('timestamp', 'asc')));
      const evs = []; snap.forEach(d => { const x = d.data(); if (x.timestamp && x.timestamp.toMillis) evs.push({ ...x, timestampMs: x.timestamp.toMillis() }); });
      E.eventos = evs; E.plan = null; recalcular();
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
    E.cargado = true; renderPedidos(); renderModelo(); renderEstimador();
  }
  const esperado = p => E.modelo ? predecir(E.modelo, p.lineas, p.unidades, (E.factores[p.sucursal] || { factor: 1 }).factor) : null;

  // ---------------- pedidos armados
  function renderPedidos() {
    const host = $('tp_pedidos'); if (!E.pedidos.length) { host.innerHTML = '<div class="empty-state">No hay marcas de armado en este período.</div>'; return; }
    const sucs = [...new Set(E.pedidos.map(p => p.sucursal))].sort(), filas = E.pedidos.filter(p => !E.filtroSuc || p.sucursal === E.filtroSuc), tope = 150;
    host.innerHTML = `<div class="mt-barra"><b>Sucursal</b> <select id="tp_filtroSuc"><option value="">Todas</option>${sucs.map(s => `<option ${s === E.filtroSuc ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select> <button class="btn-chico" id="tp_btnCSV">⬇ CSV</button> <span class="contador">${filas.length.toLocaleString('es-AR')} pedidos</span></div>
      <div style="overflow-x:auto"><table class="tp-t"><tr><th>Día</th><th>Sucursal</th><th>Artículos</th><th>Sin stock</th><th>Personas</th><th>Tiempo de armado</th><th>Reloj</th><th>Min por artículo</th><th>Esperado</th></tr>
      ${filas.slice(0, tope).map(p => { const e = esperado(p), real = p.trabajoMs / MIN, dv = e ? (real / e - 1) * 100 : null, quienes = p.personas.filter(x => x.picks >= 5).map(x => esc(x.nombre.split(' ')[0]) + ' ' + fmtMin(x.trabajoMs / MIN)).join(' · ');
        return `<tr><td style="white-space:nowrap">${esc(p.dia)}</td><td><b>${esc(p.sucursal)}</b>${quienes ? `<div class="contador">${quienes}</div>` : ''}</td><td>${n0(p.lineas)}<div class="contador">${n0(p.unidades)} unid.</div></td><td>${p.picks ? n0(p.sinStock / p.picks * 100) + '%' : '—'}</td><td>${p.k}</td>
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
    const demoraPct = suma(E.pedidos.map(p => p.demoraMs)) / Math.max(1, suma(E.pedidos.map(p => p.trabajoMs))) * 100;
    const med = E.medido || {}, linea = (k) => { const x = med[k] || {}; return x.n >= 3 ? `Cuando ${k === 2 ? 'dos personas' : 'tres personas'} armaron el mismo pedido (${x.n} pedidos): ${x.recargoMedido != null ? 'el trabajo total fue ' + n0((x.recargoMedido - 1) * 100) + '% ' + (x.recargoMedido >= 1 ? 'mayor' : 'menor') + ' que si lo armaba una sola' : 'sin dato suficiente de trabajo total'}, y ${x.desbalanceMedido != null ? 'el más lento tardó ' + n0((x.desbalanceMedido - 1) * 100) + '% más que el promedio' : 'sin dato de desbalance'}.` : `${k === 2 ? 'Dos' : 'Tres'} personas en el mismo pedido: todavía hay ${x.n || 0} pedidos armados así (hacen falta 3 o más); mientras tanto se supone ${n0((PARALELO_SUPUESTO[k].recargo - 1) * 100)}% más de trabajo y ${n0((PARALELO_SUPUESTO[k].desbalance - 1) * 100)}% de desbalance.`; };
    const sucs = Object.keys(E.factores).sort((a, b) => E.factores[b].factor - E.factores[a].factor);
    const juntos = m.rho > 0.95 && m.terminos > 1, porArt = m.b + m.c * m.uPorArt;   // si artículos y unidades crecen a la par, no se pueden separar: se da el tiempo por artículo en conjunto
    const titular = juntos ? `Tiempo de armado de un pedido ≈ ${n1(porArt)} min por artículo (con ${n1(m.uPorArt)} unidades por artículo en promedio)`
      : `Tiempo de armado de un pedido ≈ ${m.a > 0.05 ? n1(m.a) + ' min fijos + ' : ''}${n1(m.b)} min por artículo${m.c > 0.0005 ? ' + ' + (Math.round(m.c * 1000) / 1000).toLocaleString('es-AR') + ' min por unidad' : ''}`;
    host.innerHTML = `<div class="note" style="margin-bottom:12px"><b>${titular}</b>.
        Se ajustó con ${m.n.toLocaleString('es-AR')} pedidos${m.soloUnaPersona ? ' armados por una sola persona' : ''}. Error medio: ${n0(q.mape * 100)}% por pedido (R² ${q.r2.toFixed(2).replace('.', ',')}), usando además el factor de cada sucursal. Un pedido real suele quedar entre ${n0((q.p20 - 1) * 100)}% y +${n0((q.p80 - 1) * 100)}% de lo estimado.${m.terminos === 1 ? ' Con pocos pedidos solo se ajusta el tiempo por artículo.' : ''}${juntos ? ' En tus pedidos los artículos y las unidades crecen casi a la par, así que no se puede separar cuánto tarda cada uno; sí se puede estimar el pedido completo.' : ''}</div>
      <div class="contador" style="margin-bottom:8px">No incluye el arranque (ir al primer pasillo, preparar el pallet) ni el cierre (envolver, etiquetar): hoy no se marcan. Las demoras de ${E.cfg.umbralDemora} a ${E.cfg.umbralPausa} min son ${n0(demoraPct)}% del tiempo de armado medido. El tiempo de armado suma los tiempos entre marcas seguidas (hasta ${E.cfg.umbralDemora} min) más un artículo promedio por persona, porque la primera marca no tiene una anterior.</div>
      <div style="font-size:14px;line-height:1.6;margin-bottom:12px">${linea(2)}<br>${linea(3)}</div>
      ${sucs.length ? `<table><tr><th>Sucursal</th><th>Pedidos (1 persona)</th><th>Tarda vs. el modelo</th><th>Factor que se usa</th></tr>${sucs.map(s => { const f = E.factores[s]; return `<tr><td style="font-weight:700">${esc(s)}</td><td>${f.n}</td><td>${f.bruto >= 1 ? '+' : ''}${n0((f.bruto - 1) * 100)}%</td><td>${f.factor.toFixed(2).replace('.', ',')}</td></tr>`; }).join('')}</table>` : ''}`;
  }

  // ---------------- 1, 2 o 3 personas
  function renderEstimador() {
    const host = $('tp_estim'); if (!E.modelo) { host.innerHTML = '<div class="empty-state">Calculá primero el historial.</div>'; return; }
    const sucs = [...new Set(E.pedidos.map(p => p.sucursal))].sort();
    if (!E.plan) E.plan = sucs.map(s => { const ult = E.pedidos.filter(p => p.sucursal === s).slice(0, 10); return { sucursal: s, incluir: true, lineas: Math.round(mediana(ult.map(p => p.lineas))), unidades: Math.round(mediana(ult.map(p => p.unidades))) }; });
    const c = E.cfg, inp = (id, v, ancho = 58) => `<input type="number" id="${id}" value="${v}" min="0" style="width:${ancho}px">`;
    host.innerHTML = `<div class="mt-barra" style="flex-wrap:wrap;gap:10px 18px">
        <span><b>Tolerancias</b> ${inp('tp_tol', c.tolerancia)} %</span>
        <span><b>Empiezan a las</b> <input type="time" id="tp_inicio" value="${esc(c.inicio)}"></span>
        <span><b>Demora desde</b> ${inp('tp_uDem', c.umbralDemora, 46)} min <b>y pausa desde</b> ${inp('tp_uPau', c.umbralPausa, 46)} min</span></div>
      <div class="mt-barra" style="flex-wrap:wrap;gap:10px 18px">${c.descansos.map((d, i) => `<span><b>${esc(d.nombre)}</b> después de ${inp('tp_dd' + i, d.despues, 54)} min de trabajo, dura ${inp('tp_dm' + i, d.dura, 46)} min</span>`).join('')}</div>
      <div class="contador" style="margin:6px 0 10px">Elegí las sucursales que hay que armar y cuántos artículos y unidades tiene cada pedido (arranca con la mediana de los últimos 10 pedidos de cada una). Los tiempos de esta tabla ya incluyen la tolerancia; los descansos se suman en el cuadro de abajo.</div>
      <div style="overflow-x:auto"><table id="tp_tablaPlan"><tr><th></th><th>Sucursal</th><th>Artículos</th><th>Unidades</th><th>1 persona</th><th>Entre 2, cada una</th><th>Entre 3, cada una</th></tr>
        ${E.plan.map((x, i) => `<tr data-i="${i}"><td><input type="checkbox" data-c="incluir" ${x.incluir ? 'checked' : ''}></td><td style="font-weight:700">${esc(x.sucursal)}</td><td>${inp('', x.lineas, 64).replace('id=""', 'data-c="lineas"')}</td><td>${inp('', x.unidades, 70).replace('id=""', 'data-c="unidades"')}</td><td data-r="1"></td><td data-r="2"></td><td data-r="3"></td></tr>`).join('')}</table></div>
      <div id="tp_resultados" style="margin-top:16px"></div>`;
    const leer = () => { c.tolerancia = +$('tp_tol').value || 0; c.inicio = $('tp_inicio').value || '07:00'; c.descansos.forEach((d, i) => { d.despues = +$('tp_dd' + i).value || 0; d.dura = +$('tp_dm' + i).value || 0; }); guardarCfg(); renderResultados(); };
    ['tp_tol', 'tp_inicio', ...c.descansos.flatMap((d, i) => ['tp_dd' + i, 'tp_dm' + i])].forEach(id => $(id).oninput = leer);
    const umbrales = () => { c.umbralDemora = Math.max(1, +$('tp_uDem').value || 5); c.umbralPausa = Math.max(c.umbralDemora + 1, +$('tp_uPau').value || 20); guardarCfg(); recalcular(); };
    $('tp_uDem').onchange = umbrales; $('tp_uPau').onchange = umbrales;
    host.querySelectorAll('#tp_tablaPlan [data-c]').forEach(el => el.oninput = el.onchange = () => { const i = +el.closest('tr').dataset.i, k = el.dataset.c; E.plan[i][k] = k === 'incluir' ? el.checked : Math.max(0, Math.round(+el.value || 0)); renderResultados(); });
    renderResultados();
  }
  function renderResultados() {
    const host = $('tp_resultados'); if (!host || !E.modelo) return;
    const c = E.cfg, par = parametrosParalelo(E.medido), fac = s => (E.factores[s] || { factor: 1 }).factor;
    const items = E.plan.filter(x => x.incluir && x.lineas > 0).map(x => ({ nombre: x.sucursal, lineas: x.lineas, unidades: x.unidades, min: predecir(E.modelo, x.lineas, x.unidades, fac(x.sucursal)) }));
    const trabajoPor = (min, k) => (k === 1 ? min : min * par[k].recargo / k * par[k].desbalance) * (1 + c.tolerancia / 100);
    E.plan.forEach((x, i) => { const fila = document.querySelector(`#tp_tablaPlan tr[data-i="${i}"]`); if (!fila) return; const e = predecir(E.modelo, x.lineas, x.unidades, fac(x.sucursal));
      [1, 2, 3].forEach(k => { fila.querySelector(`[data-r="${k}"]`).innerHTML = x.lineas > 0 ? `<b>${fmtMin(trabajoPor(e, k))}</b>` + (k === 1 ? `<div class="contador">entre ${fmtMin(trabajoPor(e * E.calidad.p20, 1))} y ${fmtMin(trabajoPor(e * E.calidad.p80, 1))}</div>` : '') : '—'; }); });
    if (!items.length) { host.innerHTML = '<div class="empty-state">Elegí al menos una sucursal.</div>'; return; }
    const efs = items.map(i => i.min), filas = [1, 2, 3].map(k => ({ d: escenarioDividido(efs, k, par, c), e: escenarioEnteros(items, k, c) }));
    const base = filas[0].d.relojMin, ahorro = (m) => m < base ? `<span style="color:var(--green)">−${fmtMin(base - m)}</span>` : '';
    const nota = k => k === 1 ? '' : `<div class="contador">${par[k].medidoRecargo || par[k].medidoDesbalance ? 'con lo medido' : 'con lo supuesto'} (+${n0((par[k].recargo - 1) * 100)}% trabajo, ${n0((par[k].desbalance - 1) * 100)}% desbalance)</div>`;
    host.innerHTML = `<h4 style="margin:0 0 8px">Cuánto tardarían en armar los ${items.length} pedidos</h4>
      <table class="tp-t"><tr><th>Personas</th><th>Se reparten cada pedido entre todas</th><th>Cada pedido lo arma una sola persona</th></tr>
      ${filas.map(({ d, e }) => `<tr><td style="font-weight:700">${d.k}</td>
        <td><b>${fmtMin(d.relojMin)}</b> ${ahorro(d.relojMin)}<div class="contador">terminan a las ${horaFin(c.inicio, d.relojMin)} · cada una trabaja ${fmtMin(d.trabajoMin)}${d.k > 1 ? ' (' + (par[d.k].medidoRecargo || par[d.k].medidoDesbalance ? 'con lo medido' : 'con lo supuesto') + ': +' + n0((par[d.k].recargo - 1) * 100) + '% de trabajo, ' + n0((par[d.k].desbalance - 1) * 100) + '% de desbalance)' : ''}</div></td>
        <td><b>${fmtMin(e.relojMin)}</b> ${ahorro(e.relojMin)}<div class="contador">terminan a las ${horaFin(c.inicio, e.relojMin)}</div></td></tr>`).join('')}</table>
      <div class="contador" style="margin-top:8px">${[2, 3].map(k => `Con ${k} personas y pedidos enteros: ` + filas[k - 1].e.cargas.map((x, j) => `persona ${j + 1}: ${x.items.map(i => esc(i.nombre)).join(', ') || '—'} (${fmtMin(x.relojMin)})`).join(' · ')).join('<br>')}</div>`;
  }

  function abrir() {
    const host = $('tp_contenido'); if (!host || host.dataset.listo) return; host.dataset.listo = '1';
    host.innerHTML = `<style>.tp-t th,.tp-t td{padding:9px 8px;vertical-align:top}.tp-t td{font-size:14px}.tp-t .contador{font-size:12px;margin-top:2px}.tp-t td:nth-child(2) b{white-space:nowrap}</style><div class="card"><div class="mt-barra"><b>Período</b> <select id="tp_semanas"><option value="4">Últimas 4 semanas</option><option value="8">Últimas 8 semanas</option><option value="12">Últimas 12 semanas</option></select>
        <button class="btn-chico azul" id="tp_btnCalcular">Calcular</button> <span class="contador" id="tp_estado">Lee las marcas de armado del período y arma los pedidos (sucursal por día). Cada lectura consume lecturas de Firebase: conviene empezar con 4 semanas.</span></div></div>
      <div class="card"><h3 class="mt-h3">📋 Pedidos armados</h3><div id="tp_pedidos"><div class="empty-state">Tocá "Calcular".</div></div></div>
      <div class="card"><h3 class="mt-h3">🧮 Modelo de tiempo</h3><div id="tp_modelo"><div class="empty-state">Tocá "Calcular".</div></div></div>
      <div class="card"><h3 class="mt-h3">👥 ¿Cuánto tardan 1, 2 o 3 personas?</h3><div id="tp_estim"><div class="empty-state">Tocá "Calcular".</div></div></div>`;
    $('tp_semanas').onchange = e => { E.semanas = +e.target.value; };
    $('tp_btnCalcular').onclick = calcular;
  }
  return { abrir };
}
