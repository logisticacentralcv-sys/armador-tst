// ============================================================
// metricas.js — el panel de tiempos y control, ahora dentro del Armador (Logística).
// Resumen en vivo, resumen por día, historial, scoring, evolución y control de auditorías.
// Se carga bajo demanda desde index.html (import('./metricas.js')).
// Todos los elementos de pantalla de este módulo llevan el prefijo "mt_".
// ============================================================
export function iniciarMetricas(ctx) {
  const { db, collection, query, where, orderBy, onSnapshot, getDocs, Timestamp } = ctx;

      let audPendientes = 0, rangoCargado = false, iniciado = false;
      // Indicadores de arriba del Resumen: lo que hay que saber de un vistazo, sin entrar a ningún panel.
      function renderizarKpis_() {
        const cont = document.getElementById('mt_kpiResumen'); if (!cont) return;
        const ahora = Date.now(), total = eventosDeHoyPlano.length;
        const sinStock = eventosDeHoyPlano.filter(e => e.diferencia === 'Falta de stock').length;
        const armando = Object.values(eventosDeHoyPorPersona).filter(p => p.eventos.length && ahora - p.eventos[p.eventos.length - 1].timestampMs <= UMBRAL_PAUSA_MS).length;
        const conectados = sesionesActivasCache.filter(s => (!s.expiraEnMs || s.expiraEnMs > ahora) && s.ultimaActividadMs && ahora - s.ultimaActividadMs < 150000).length;
        const tile = (n, txt, clase, panel) => `<button class="mt-kpi ${clase}" ${panel ? `data-panel="${panel}"` : ''}><span class="k-num">${n}</span><span class="k-txt">${txt}</span></button>`;
        cont.innerHTML = tile(total, 'armados hoy', '', '') + tile(armando, armando === 1 ? 'armando ahora' : 'armando ahora', armando ? 'verde' : '', '')
          + tile(conectados, conectados === 1 ? 'persona conectada' : 'personas conectadas', '', '')
          + tile(sinStock, 'marcados sin stock hoy', sinStock ? 'rojo' : '', '') + tile(audPendientes, 'sin auditar', audPendientes ? 'naranja' : '', 'auditoria');
      }

      const UMBRAL_PAUSA_MS = 5 * 60 * 1000; // 5 minutos sin marcar nada = se considera pausa, no tiempo activo

      // ---------------- UTILIDADES DE TIEMPO ----------------
      function formatearDuracion_(ms) {
        if (ms < 0) ms = 0;
        const totalMin = Math.round(ms / 60000);
        const horas = Math.floor(totalMin / 60);
        const min = totalMin % 60;
        if (horas > 0) return `${horas}h ${min}min`;
        return `${min} min`;
      }
      // Para promedios (por pick, sin stock) — antes de un minuto redondeaba
      // a minutos enteros, y cualquier cosa entre 60 y 89 segundos quedaba
      // como "1 min" sin distinguir. Ahora siempre muestra minutos+segundos
      // exactos (redondeados al segundo, no al minuto).
      function formatearDuracionCorta_(ms) {
        if (ms === null || ms === undefined) return '—';
        if (ms < 0) ms = 0;
        const totalSeg = Math.round(ms / 1000);
        const min = Math.floor(totalSeg / 60);
        const seg = totalSeg % 60;
        if (min > 0) return `${min} min ${String(seg).padStart(2, '0')}s`;
        return `${seg} seg`;
      }
      function formatearHora_(fecha) {
        return fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      }

      // Agrupa eventos (ya ordenados por tiempo) de una persona, separados
      // por sucursal, y calcula tiempo activo (gaps chicos) vs en pausa
      // (gaps grandes) para cada una.
      function calcularResumenPorSucursal_(eventos) {
        const porSucursal = {};
        eventos.forEach(ev => {
          const suc = ev.sucursal || '(sin sucursal)';
          if (!porSucursal[suc]) porSucursal[suc] = [];
          porSucursal[suc].push(ev);
        });

        return Object.keys(porSucursal).map(suc => {
          const evs = porSucursal[suc];
          let tiempoActivoMs = 0, tiempoPausaMs = 0, cantidadPausas = 0, gapsActivos = 0;
          let tiempoHastaSinStockMs = 0, gapsSinStock = 0; // aparte, no se mezcla con lo de arriba
          const pausasDetalle = [];
          for (let i = 1; i < evs.length; i++) {
            const gap = evs[i].timestampMs - evs[i - 1].timestampMs;
            if (gap <= UMBRAL_PAUSA_MS) {
              tiempoActivoMs += gap; gapsActivos++;
              if (evs[i].diferencia === 'Falta de stock') { tiempoHastaSinStockMs += gap; gapsSinStock++; }
            } else {
              tiempoPausaMs += gap; cantidadPausas++;
              pausasDetalle.push({ desdeMs: evs[i - 1].timestampMs, hastaMs: evs[i].timestampMs, duracionMs: gap });
            }
          }
          const picksSinStock = evs.filter(ev => ev.diferencia === 'Falta de stock').length;
          const tiempoTotalMs = evs[evs.length - 1].timestampMs - evs[0].timestampMs;
          return {
            sucursal: suc,
            picks: evs.length,
            picksSinStock,
            porcentajeSinStock: evs.length ? (picksSinStock / evs.length * 100) : 0,
            promedioMsPorPick: gapsActivos ? (tiempoActivoMs / gapsActivos) : null,
            promedioMsSinStock: gapsSinStock ? (tiempoHastaSinStockMs / gapsSinStock) : null,
            gapsActivos, gapsSinStock, tiempoHastaSinStockMs,
            porcentajePausas: tiempoTotalMs ? (tiempoPausaMs / tiempoTotalMs * 100) : 0,
            pausasDetalle,
            primerPick: evs[0].timestampMs,
            ultimoPick: evs[evs.length - 1].timestampMs,
            tiempoActivoMs, tiempoPausaMs, cantidadPausas,
            tiempoTotalMs: evs[evs.length - 1].timestampMs - evs[0].timestampMs
          };
        });
      }

      // Para "en tiempo real": a partir del último pick de la persona, camina
      // hacia atrás mientras los gaps sean chicos, para encontrar dónde
      // arrancó la racha activa actual (puede cruzar de una sucursal a otra
      // sin cortarse, si lo hizo rápido).
      // Calcula, para HOY completo, el tiempo activo acumulado (excluyendo
      // por completo cada pausa detectada, no solo "hasta el umbral") y
      // cuántas pausas hubo — como un cronómetro que se detiene solo
      // durante cada pausa y retoma cuando vuelve a marcar algo.
      function calcularEstadoHoy_(eventosPersonaOrdenados, ahoraMs) {
        if (!eventosPersonaOrdenados.length) return null;

        let tiempoActivoMs = 0;
        const pausas = [];
        for (let i = 1; i < eventosPersonaOrdenados.length; i++) {
          const gap = eventosPersonaOrdenados[i].timestampMs - eventosPersonaOrdenados[i - 1].timestampMs;
          if (gap <= UMBRAL_PAUSA_MS) {
            tiempoActivoMs += gap; // picks seguidos: el tiempo entre uno y otro es tiempo armando
          } else {
            pausas.push(gap); // más de 5 min sin marcar nada: NINGUNO de esos minutos cuenta como activo
          }
        }

        const ultimo = eventosPersonaOrdenados[eventosPersonaOrdenados.length - 1];
        const inactivoDesdeMs = ahoraMs - ultimo.timestampMs;
        const activo = inactivoDesdeMs <= UMBRAL_PAUSA_MS;
        if (activo) tiempoActivoMs += inactivoDesdeMs; // el tramo en curso, todavía no "cerrado" por el próximo pick

        return {
          activo,
          inactivoDesdeMs,
          tiempoActivoHoyMs: tiempoActivoMs,
          cantidadPausas: pausas.length,
          sucursal: ultimo.sucursal,
          producto: ultimo.producto,
          totalPicksHoy: eventosPersonaOrdenados.length
        };
      }

      // ---------------- TIEMPO REAL (hoy, onSnapshot) ----------------
      let eventosDeHoyPorPersona = {};
      let eventosDeHoyPlano = [];
      let sesionesActivasCache = [];
      let resumenFilasCache = []; // filas del resumen por día actualmente renderizadas, para el desglose de pausas

      window.__togglePausas = function(idx) {
        const fila = document.getElementById('detallePausas-' + idx);
        if (fila) fila.style.display = (fila.style.display === 'none') ? 'table-row' : 'none';
      };

      // Muestra quién está identificado ahora mismo en algún celular —
      // se arma solo (ver renderizarSesiones_), filtrando las que ya
      // vencieron (pasaron las 4hs de sesión), aunque el documento en
      // Firestore no se haya borrado todavía.
      function renderizarSesiones_() {
        renderizarKpis_();
        const cont = document.getElementById('mt_contenidoSesiones');
        const ahoraMs = Date.now();
        const vigentes = sesionesActivasCache
          .filter(s => !s.expiraEnMs || s.expiraEnMs > ahoraMs)
          .sort((a, b) => (b.ultimaActividadMs || b.iniciadoEnMs || 0) - (a.ultimaActividadMs || a.iniciadoEnMs || 0));

        if (!vigentes.length) {
          cont.innerHTML = '<div class="empty-state">Nadie está identificado en este momento</div>';
          return;
        }

        // El latido se manda cada 60s — si hace más de ~2.5 min que no llega
        // ninguno, lo más probable es que cerró la app, se quedó sin señal,
        // o el celular se bloqueó y dejó de correr el JS en segundo plano.
        cont.innerHTML = '<table><tr><th></th><th>Nombre</th><th>Documento</th><th>Desde</th><th>Actividad</th></tr>' +
          vigentes.map(s => {
            const inactivaMs = s.ultimaActividadMs ? (ahoraMs - s.ultimaActividadMs) : null;
            const presente = inactivaMs !== null && inactivaMs <= 150000;
            return `<tr>
            <td><span class="estado-dot ${presente ? 'verde' : 'naranja'}"></span></td>
            <td style="font-weight:700;">${escapeHtml(s.nombre)}</td>
            <td>${escapeHtml(s.documento)}</td>
            <td>${s.iniciadoEnMs ? formatearHora_(new Date(s.iniciadoEnMs)) : '—'}</td>
            <td style="color:${presente ? 'var(--green)' : 'var(--orange)'};">${inactivaMs === null ? '—' : (presente ? 'app abierta' : `sin señal hace ${formatearDuracion_(inactivaMs)}`)}</td>
          </tr>`;
          }).join('') + '</table>';
      }

      function iniciar_() {
        const inicioHoy = new Date(); inicioHoy.setHours(0, 0, 0, 0);
        const q = query(
          collection(db, 'eventosArmado'),
          where('timestamp', '>=', Timestamp.fromDate(inicioHoy)),
          orderBy('timestamp', 'asc')
        );
        onSnapshot(q, (snap) => {
          const porPersona = {};
          const plano = [];
          snap.forEach(d => {
            const data = d.data();
            if (!data.timestamp) return; // por si el serverTimestamp todavía no resolvió (optimistic local write)
            const ev = { ...data, timestampMs: data.timestamp.toMillis() };
            const key = ev.personaDocumento || ev.personaNombre || '?';
            if (!porPersona[key]) porPersona[key] = { nombre: ev.personaNombre, eventos: [] };
            porPersona[key].eventos.push(ev);
            plano.push(ev);
          });
          eventosDeHoyPorPersona = porPersona;
          eventosDeHoyPlano = plano; // ya viene ordenado ascendente por la query
          renderizarTiempoReal_();
          renderizarFeed_();
        }, (err) => {
          document.getElementById('mt_contenidoTiempoReal').innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
          document.getElementById('mt_contenidoFeed').innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
        });

        setInterval(renderizarTiempoReal_, 20000); // refresca aunque no entren eventos nuevos, para que "hace X min" avance

        onSnapshot(collection(db, 'sesionesActivas'), (snap) => {
          const sesiones = [];
          snap.forEach(d => {
            const data = d.data();
            sesiones.push({
              documento: data.documento || d.id,
              nombre: data.nombre,
              iniciadoEnMs: data.iniciadoEn ? data.iniciadoEn.toMillis() : null,
              expiraEnMs: data.expiraEn ? data.expiraEn.toMillis() : null,
              ultimaActividadMs: data.ultimaActividad ? data.ultimaActividad.toMillis() : null
            });
          });
          sesionesActivasCache = sesiones;
          renderizarSesiones_();
        }, (err) => {
          document.getElementById('mt_contenidoSesiones').innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
        });
        setInterval(renderizarSesiones_, 30000); // para que las que vencen (pasaron las 4hs) desaparezcan solas

        const inputFecha = document.getElementById('mt_inputFecha');
        inputFecha.value = new Date().toISOString().slice(0, 10);
        inputFecha.addEventListener('change', () => cargarResumenDia_(inputFecha.value));
        cargarResumenDia_(inputFecha.value);

        const hoy = new Date();
        const hace7 = new Date(); hace7.setDate(hoy.getDate() - 6);
        document.getElementById('mt_inputRangoHasta').value = hoy.toISOString().slice(0, 10);
        document.getElementById('mt_inputRangoDesde').value = hace7.toISOString().slice(0, 10);

        // Control de auditoría: últimos 30 días
        const hace30 = new Date(); hace30.setDate(hoy.getDate() - 30);
        document.getElementById('mt_audHasta').value = fechaInputAud_(hoy);
        document.getElementById('mt_audDesde').value = fechaInputAud_(hace30);
        cargarControlAuditoria_();
      }

      // Lista cronológica (más nuevo primero) de cada movimiento individual
      // de hoy — quién, qué, cuánto y a qué hora. Esto es lo que le faltaba
      // al resumen: ver el detalle real, no solo el agregado por persona.
      function renderizarFeed_() {
        const cont = document.getElementById('mt_contenidoFeed');
        document.getElementById('mt_contadorTotalHoy').textContent = `${eventosDeHoyPlano.length} movimiento(s) hoy`;

        let sinStock = 0, conDiferencia = 0, bien = 0;
        eventosDeHoyPlano.forEach(ev => {
          if (ev.diferencia === 'Falta de stock') sinStock++;
          else if (ev.diferencia) conDiferencia++;
          else bien++;
        });
        document.getElementById('mt_statsHoy').innerHTML = eventosDeHoyPlano.length ? `
          <div><span style="font-weight:700; color:var(--green);">${bien}</span> <span style="font-size:12px; color:var(--muted);">armados bien</span></div>
          <div><span style="font-weight:700; color:var(--orange);">${conDiferencia}</span> <span style="font-size:12px; color:var(--muted);">con diferencia</span></div>
          <div><span style="font-weight:700; color:var(--red);">${sinStock}</span> <span style="font-size:12px; color:var(--muted);">sin stock</span></div>
        ` : '';

        if (!eventosDeHoyPlano.length) {
          cont.innerHTML = '<div class="empty-state">Todavía no armó nada nadie hoy</div>';
          return;
        }

        const ultimos = eventosDeHoyPlano.slice().reverse().slice(0, 60); // más reciente arriba, tope de 60 para no saturar
        cont.innerHTML = ultimos.map(ev => {
          const sinStock = ev.diferencia === 'Falta de stock';
          const tag = ev.tipo === 'FALTANTE' ? '<span class="badge-tipo">FALTANTE</span>' : '';
          return `<div class="fila-feed ${sinStock ? 'sin-stock' : ''}">
            <div class="hora">${formatearHora_(new Date(ev.timestampMs))}</div>
            <div class="persona-feed">${escapeHtml(ev.personaNombre)}</div>
            <div class="detalle-feed">
              <div class="producto-feed">${escapeHtml(ev.producto || '')}${tag}</div>
              <div class="sucursal-feed">${escapeHtml(ev.sucursal || '')}${ev.diferencia ? ' · ' + escapeHtml(ev.diferencia) : ''}</div>
            </div>
            <div class="cantidad-feed">${sinStock ? '✕' : '×' + ev.cantidadArmada}</div>
          </div>`;
        }).join('');
      }

      function renderizarTiempoReal_() {
        renderizarKpis_();
        const cont = document.getElementById('mt_contenidoTiempoReal');
        const ahoraMs = Date.now();
        const personas = Object.values(eventosDeHoyPorPersona);

        if (!personas.length) {
          cont.innerHTML = '<div class="empty-state">Nadie armó nada todavía hoy</div>';
          return;
        }

        const filas = personas.map(p => {
          const estado = calcularEstadoHoy_(p.eventos, ahoraMs);
          return { nombre: p.nombre, estado };
        }).sort((a, b) => (b.estado.activo - a.estado.activo) || (a.estado.inactivoDesdeMs - b.estado.inactivoDesdeMs));

        cont.innerHTML = filas.map(f => {
          const e = f.estado;
          const pausasTexto = e.cantidadPausas > 0 ? ` · ${e.cantidadPausas} pausa${e.cantidadPausas === 1 ? '' : 's'} hoy` : '';
          if (e.activo) {
            return `<div class="persona-activa armando">
              <div>
                <div style="font-weight:700;"><span class="estado-dot verde"></span>${escapeHtml(f.nombre)}</div>
                <div style="font-size:12px; color:var(--muted); margin-top:2px;">${escapeHtml(e.sucursal || '')} · último: ${escapeHtml(e.producto || '')}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-weight:700; color:var(--green);">${formatearDuracion_(e.tiempoActivoHoyMs)}</div>
                <div style="font-size:12px; color:var(--muted);">${e.totalPicksHoy} pedido(s) hoy${pausasTexto}</div>
              </div>
            </div>`;
          }
          return `<div class="persona-activa pausado">
            <div>
              <div style="font-weight:700;"><span class="estado-dot naranja"></span>${escapeHtml(f.nombre)}</div>
              <div style="font-size:12px; color:var(--muted); margin-top:2px;">${escapeHtml(e.sucursal || '')} · último: ${escapeHtml(e.producto || '')}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-weight:700; color:var(--orange);">Pausado hace ${formatearDuracion_(e.inactivoDesdeMs)}</div>
              <div style="font-size:12px; color:var(--muted);">${formatearDuracion_(e.tiempoActivoHoyMs)} activo hoy · ${e.totalPicksHoy} pedido(s)${pausasTexto}</div>
            </div>
          </div>`;
        }).join('');
      }

      // ---------------- RESUMEN POR DÍA (elegido) ----------------
      async function cargarResumenDia_(fechaStr) {
        const cont = document.getElementById('mt_contenidoResumen');
        cont.innerHTML = '<div class="empty-state">Cargando...</div>';
        if (!fechaStr) return;

        const inicio = new Date(fechaStr + 'T00:00:00');
        const fin = new Date(fechaStr + 'T23:59:59.999');

        try {
          const q = query(
            collection(db, 'eventosArmado'),
            where('timestamp', '>=', Timestamp.fromDate(inicio)),
            where('timestamp', '<=', Timestamp.fromDate(fin)),
            orderBy('timestamp', 'asc')
          );
          const snap = await getDocs(q);
          const porPersona = {};
          snap.forEach(d => {
            const data = d.data();
            if (!data.timestamp) return;
            const ev = { ...data, timestampMs: data.timestamp.toMillis() };
            const key = ev.personaDocumento || ev.personaNombre || '?';
            if (!porPersona[key]) porPersona[key] = { nombre: ev.personaNombre, eventos: [] };
            porPersona[key].eventos.push(ev);
          });

          const personas = Object.values(porPersona);
          if (!personas.length) {
            cont.innerHTML = '<div class="empty-state">Nadie armó nada ese día</div>';
            return;
          }

          resumenFilasCache = [];
          let html = '<table><tr><th>Persona</th><th>Sucursal</th><th>Picks</th><th>Desde</th><th>Hasta</th><th>T. activo</th><th>Prom./pick</th><th>Sin stock</th><th>Prom. sin stock</th><th>Pausas</th><th>T. pausas</th><th>% pausas</th></tr>';
          personas.forEach(p => {
            const filas = calcularResumenPorSucursal_(p.eventos).sort((a, b) => a.primerPick - b.primerPick);
            filas.forEach((f, idx) => {
              const globalIdx = resumenFilasCache.length;
              resumenFilasCache.push(f);
              const pausasCelda = f.cantidadPausas > 0
                ? `<span onclick="window.__togglePausas(${globalIdx})" style="cursor:pointer; text-decoration:underline dotted; color:var(--orange);">${f.cantidadPausas} 🔽</span>`
                : '—';
              html += `<tr>
                <td>${idx === 0 ? escapeHtml(p.nombre) : ''}</td>
                <td>${escapeHtml(f.sucursal)}</td>
                <td>${f.picks}</td>
                <td>${formatearHora_(new Date(f.primerPick))}</td>
                <td>${formatearHora_(new Date(f.ultimoPick))}</td>
                <td style="font-weight:700; color:var(--green);">${formatearDuracion_(f.tiempoActivoMs)}</td>
                <td>${formatearDuracionCorta_(f.promedioMsPorPick)}</td>
                <td style="color:${f.picksSinStock > 0 ? 'var(--red)' : 'var(--muted)'};">${f.picksSinStock > 0 ? `${f.picksSinStock} (${f.porcentajeSinStock.toFixed(0)}%)` : '—'}</td>
                <td style="color:${f.promedioMsSinStock !== null ? 'var(--red)' : 'var(--muted)'};">${formatearDuracionCorta_(f.promedioMsSinStock)}</td>
                <td style="color:${f.cantidadPausas > 0 ? 'var(--orange)' : 'var(--muted)'};">${pausasCelda}</td>
                <td style="color:${f.tiempoPausaMs > 0 ? 'var(--orange)' : 'var(--muted)'};">${f.tiempoPausaMs > 0 ? formatearDuracion_(f.tiempoPausaMs) : '—'}</td>
                <td style="color:${f.porcentajePausas > 0 ? 'var(--orange)' : 'var(--muted)'};">${f.porcentajePausas > 0 ? f.porcentajePausas.toFixed(0) + '%' : '—'}</td>
              </tr>
              <tr id="detallePausas-${globalIdx}" style="display:none;">
                <td colspan="12" style="background:#fff7ed; font-size:12px; padding:8px 10px;">
                  ${f.pausasDetalle.map(pa => `📍 ${formatearHora_(new Date(pa.desdeMs))} → ${formatearHora_(new Date(pa.hastaMs))} (${formatearDuracion_(pa.duracionMs)})`).join('<br>')}
                </td>
              </tr>`;
            });
          });
          html += '</table>';
          cont.innerHTML = html;
        } catch (err) {
          cont.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
        }
      }

      // ---------------- HISTORIAL POR RANGO DE FECHAS + SCORING ----------------
      document.getElementById('mt_btnBuscarRango').addEventListener('click', () => {
        const desde = document.getElementById('mt_inputRangoDesde').value;
        const hasta = document.getElementById('mt_inputRangoHasta').value;
        if (!desde || !hasta) { alert('Elegí las dos fechas'); return; }
        cargarRango_(desde, hasta);
      });

      // Agrupa eventos por día calendario (clave "YYYY-MM-DD" en hora local)
      function agruparPorDia_(eventos) {
        const porDia = {};
        eventos.forEach(ev => {
          const d = new Date(ev.timestampMs);
          const clave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (!porDia[clave]) porDia[clave] = [];
          porDia[clave].push(ev);
        });
        return porDia;
      }

      // Suma los totales de una persona a lo largo de TODO el rango, día por
      // día — hay que cortar por día (y por sucursal, ya lo hace
      // calcularResumenPorSucursal_) para no confundir "se fue a las 18hs y
      // volvió a las 9hs del día siguiente" con una pausa gigante.
      function calcularTotalesPersona_(eventosPersona) {
        const porDia = agruparPorDia_(eventosPersona);
        const dias = Object.keys(porDia);
        let picks = 0, picksSinStock = 0, tiempoActivoMs = 0, tiempoPausaMs = 0, cantidadPausas = 0;
        let gapsActivos = 0, gapsSinStock = 0, tiempoHastaSinStockMs = 0;

        dias.forEach(dia => {
          calcularResumenPorSucursal_(porDia[dia]).forEach(f => {
            picks += f.picks;
            picksSinStock += f.picksSinStock;
            tiempoActivoMs += f.tiempoActivoMs;
            tiempoPausaMs += f.tiempoPausaMs;
            cantidadPausas += f.cantidadPausas;
            gapsActivos += f.gapsActivos;
            gapsSinStock += f.gapsSinStock;
            tiempoHastaSinStockMs += f.tiempoHastaSinStockMs;
          });
        });

        const tiempoTotalMs = tiempoActivoMs + tiempoPausaMs;
        return {
          diasTrabajados: dias.length,
          picks, picksSinStock,
          porcentajeSinStock: picks ? (picksSinStock / picks * 100) : 0,
          tiempoActivoMs, tiempoPausaMs, cantidadPausas,
          porcentajePausas: tiempoTotalMs ? (tiempoPausaMs / tiempoTotalMs * 100) : 0,
          promedioMsPorPick: gapsActivos ? (tiempoActivoMs / gapsActivos) : null,
          promedioMsSinStock: gapsSinStock ? (tiempoHastaSinStockMs / gapsSinStock) : null
        };
      }

      let totalesPorPersonaCache = [];

      async function cargarRango_(desde, hasta) {
        rangoCargado = true;
        const cont = document.getElementById('mt_contenidoRango');
        const contScoring = document.getElementById('mt_contenidoScoring');
        const contGrafico = document.getElementById('mt_contenidoGrafico');
        cont.innerHTML = '<div class="cargando">Cargando...</div>';
        contScoring.innerHTML = '<div class="cargando">Cargando...</div>';
        contGrafico.innerHTML = '<div class="cargando">Cargando...</div>';

        const inicio = new Date(desde + 'T00:00:00');
        const fin = new Date(hasta + 'T23:59:59.999');

        try {
          const q = query(
            collection(db, 'eventosArmado'),
            where('timestamp', '>=', Timestamp.fromDate(inicio)),
            where('timestamp', '<=', Timestamp.fromDate(fin)),
            orderBy('timestamp', 'asc')
          );
          const snap = await getDocs(q);
          const porPersona = {};
          const todosLosEventos = [];
          snap.forEach(d => {
            const data = d.data();
            if (!data.timestamp) return;
            const ev = { ...data, timestampMs: data.timestamp.toMillis() };
            const key = ev.personaDocumento || ev.personaNombre || '?';
            if (!porPersona[key]) porPersona[key] = { nombre: ev.personaNombre, eventos: [] };
            porPersona[key].eventos.push(ev);
            todosLosEventos.push(ev);
          });

          const personas = Object.values(porPersona);
          if (!personas.length) {
            cont.innerHTML = '<div class="empty-state">Nadie armó nada en ese rango</div>';
            contScoring.innerHTML = '<div class="empty-state">Nadie armó nada en ese rango</div>';
            contGrafico.innerHTML = '<div class="empty-state">Nadie armó nada en ese rango</div>';
            totalesPorPersonaCache = [];
            return;
          }

          totalesPorPersonaCache = personas.map(p => ({ nombre: p.nombre, ...calcularTotalesPersona_(p.eventos) }));
          renderizarRango_();
          renderizarScoring_();
          renderizarGraficoEvolucion_(todosLosEventos);
        } catch (err) {
          cont.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
          contScoring.innerHTML = '';
          contGrafico.innerHTML = '';
        }
      }

      function renderizarRango_() {
        const cont = document.getElementById('mt_contenidoRango');
        const filas = totalesPorPersonaCache.slice().sort((a, b) => b.picks - a.picks);
        let html = '<table><tr><th>Persona</th><th>Días</th><th>Picks</th><th>T. activo</th><th>Prom./pick</th><th>Sin stock</th><th>Pausas</th><th>% pausas</th></tr>';
        filas.forEach(f => {
          html += `<tr>
            <td style="font-weight:700;">${escapeHtml(f.nombre)}</td>
            <td>${f.diasTrabajados}</td>
            <td>${f.picks}</td>
            <td style="color:var(--green); font-weight:700;">${formatearDuracion_(f.tiempoActivoMs)}</td>
            <td>${formatearDuracionCorta_(f.promedioMsPorPick)}</td>
            <td style="color:${f.picksSinStock > 0 ? 'var(--red)' : 'var(--muted)'};">${f.picksSinStock > 0 ? `${f.picksSinStock} (${f.porcentajeSinStock.toFixed(0)}%)` : '—'}</td>
            <td style="color:${f.cantidadPausas > 0 ? 'var(--orange)' : 'var(--muted)'};">${f.cantidadPausas || '—'}</td>
            <td style="color:${f.porcentajePausas > 0 ? 'var(--orange)' : 'var(--muted)'};">${f.porcentajePausas > 0 ? f.porcentajePausas.toFixed(0) + '%' : '—'}</td>
          </tr>`;
        });
        html += '</table>';
        cont.innerHTML = html;
      }

      // Normaliza una métrica a 0-100 DENTRO del grupo que se está mirando
      // (el mejor del grupo saca 100, el peor saca 0) — es una comparación
      // relativa entre estos armadores en este período, no una vara fija.
      // "invertir:true" para métricas donde MENOS es mejor (tiempos, %).
      function normalizar_(valores, valor, invertir) {
        const validos = valores.filter(v => v !== null && v !== undefined);
        if (!validos.length || valor === null || valor === undefined) return 50; // sin datos suficientes: neutro
        const min = Math.min(...validos), max = Math.max(...validos);
        if (max === min) return 100; // todos iguales
        const norm = (valor - min) / (max - min);
        return (invertir ? (1 - norm) : norm) * 100;
      }

      function renderizarScoring_() {
        const cont = document.getElementById('mt_contenidoScoring');
        const filas = totalesPorPersonaCache;
        if (!filas.length) { cont.innerHTML = '<div class="empty-state">Sin datos</div>'; return; }

        // Pesos del score final — ajustables acá si hace falta cambiarlos.
        // "Sin stock" queda AFUERA del score a pedido (se sigue viendo la
        // columna/dato en las otras tablas, pero no entra en este número).
        const PESO_VELOCIDAD = 0.50;   // prom./pick más bajo = mejor
        const PESO_CONTINUIDAD = 0.25; // % pausas más bajo = mejor
        const PESO_VOLUMEN = 0.25;     // más picks totales = mejor

        const promedios = filas.map(f => f.promedioMsPorPick);
        const pausasPct = filas.map(f => f.porcentajePausas);
        const volumenes = filas.map(f => f.picks);

        const conScore = filas.map(f => {
          const sVelocidad = normalizar_(promedios, f.promedioMsPorPick, true);
          const sContinuidad = normalizar_(pausasPct, f.porcentajePausas, true);
          const sVolumen = normalizar_(volumenes, f.picks, false);
          const scoreFinal = sVelocidad * PESO_VELOCIDAD + sContinuidad * PESO_CONTINUIDAD + sVolumen * PESO_VOLUMEN;
          return { ...f, sVelocidad, sContinuidad, sVolumen, scoreFinal };
        }).sort((a, b) => b.scoreFinal - a.scoreFinal);

        let html = '<table><tr><th>#</th><th>Persona</th><th>Velocidad</th><th>Continuidad</th><th>Volumen</th><th>Score final</th></tr>';
        conScore.forEach((f, i) => {
          const colorScore = f.scoreFinal >= 70 ? 'var(--green)' : (f.scoreFinal >= 40 ? 'var(--orange)' : 'var(--red)');
          html += `<tr>
            <td>${i + 1}</td>
            <td style="font-weight:700;">${escapeHtml(f.nombre)}</td>
            <td>${f.sVelocidad.toFixed(0)}</td>
            <td>${f.sContinuidad.toFixed(0)}</td>
            <td>${f.sVolumen.toFixed(0)}</td>
            <td style="font-weight:700; color:${colorScore}; font-size:15px;">${f.scoreFinal.toFixed(0)}</td>
          </tr>`;
        });
        html += '</table>';
        html += `<div style="font-size:11px; color:var(--muted); margin-top:8px;">Pesos usados: Velocidad ${PESO_VELOCIDAD * 100}% · Continuidad ${PESO_CONTINUIDAD * 100}% · Volumen ${PESO_VOLUMEN * 100}%. "Sin stock" no entra en este score (se ve aparte en la tabla de arriba). Cada columna (menos "Score final") es un puntaje relativo de 0 a 100 dentro de este grupo, no un valor absoluto.</div>`;
        cont.innerHTML = html;
      }


      // ---------------- CONTROL DE AUDITORÍA DE "SIN STOCK" (solo lectura) ----------------
      // Acá se ve la cadena completa: qué sucursales lo pidieron, quién lo marcó
      // sin stock (y cuándo), qué pasó con cada pedido, y quién lo habilitó o
      // confirmó que no había. La auditoría en sí se hace desde el 🔎 del
      // Armador, que es ciega (no muestra quién marcó) a propósito.
      const VEREDICTOS_AUDITORIA = {
        sin_stock_confirmado: 'No había stock',
        habia_stock: 'Sí había stock (incidencia)',
        llego_despues: 'Llegó después (no es incidencia)'
      };
      let auditControlFilas = [];

      document.getElementById('mt_btnAudBuscar').addEventListener('click', cargarControlAuditoria_);
      document.getElementById('mt_btnAudCSV').addEventListener('click', descargarAuditoriaCSV_);
      document.getElementById('mt_audFiltroEstado').addEventListener('change', renderizarControlAuditoria_);
      document.getElementById('mt_audDetalleContenido').addEventListener('click', (e) => {
        const fila = e.target.closest('.fila-aud');
        if (!fila) return;
        const det = document.getElementById('audDet-' + fila.dataset.idx);
        if (det) det.style.display = det.style.display === 'none' ? 'table-row' : 'none';
      });

      function msAud_(ts) { return ts && ts.toMillis ? ts.toMillis() : 0; }

      function fechaHoraAud_(ts) {
        if (!ts || !ts.toDate) return '—';
        return ts.toDate().toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      }

      function fechaInputAud_(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      function estadoAud_(a) {
        if (a.estado === 'pendiente') return { txt: 'Sin auditar', color: 'var(--orange)' };
        if (a.veredicto === 'habia_stock') return { txt: 'Había stock · incidencia', color: 'var(--red)' };
        if (a.veredicto === 'llego_despues') return { txt: 'Llegó después', color: 'var(--primary)' };
        return { txt: 'No había stock', color: 'var(--green)' };
      }

      async function actualizarBadgeAuditoria_() {
        try {
          const snap = await getDocs(query(collection(db, 'auditoriaSinStock'), where('estado', '==', 'pendiente')));
          const badge = document.getElementById('mt_audBadge');
          badge.textContent = snap.size ? String(snap.size) : '';
          audPendientes = snap.size; renderizarKpis_();
          badge.style.display = snap.size ? 'inline-block' : 'none';
        } catch (err) { /* el badge es solo informativo */ }
      }

      async function cargarControlAuditoria_() {
        const desde = document.getElementById('mt_audDesde').value;
        const hasta = document.getElementById('mt_audHasta').value;
        if (!desde || !hasta) { alert('Elegí las dos fechas'); return; }
        document.getElementById('mt_audDetalleContenido').innerHTML = '<div class="empty-state">Cargando...</div>';
        actualizarBadgeAuditoria_();
        try {
          const inicio = new Date(desde + 'T00:00:00');
          const fin = new Date(hasta + 'T23:59:59.999');
          const snap = await getDocs(query(
            collection(db, 'auditoriaSinStock'),
            where('marcadoEn', '>=', inicio), where('marcadoEn', '<=', fin), orderBy('marcadoEn', 'asc')
          ));
          auditControlFilas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          renderizarControlAuditoria_();
        } catch (err) {
          document.getElementById('mt_audDetalleContenido').innerHTML = `<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`;
        }
      }

      function renderizarControlAuditoria_() {
        const filas = auditControlFilas;
        const contResumen = document.getElementById('mt_audResumenContenido');
        const contDetalle = document.getElementById('mt_audDetalleContenido');
        if (!filas.length) {
          contResumen.innerHTML = '';
          contDetalle.innerHTML = '<div class="empty-state">No hubo productos marcados sin stock en ese período.</div>';
          return;
        }

        // ----- Resumen por armador (quien marcó) -----
        const porArmador = {};
        filas.forEach(a => {
          const k = a.marcadoPorDocumento || a.marcadoPor || '?';
          if (!porArmador[k]) porArmador[k] = { nombre: a.marcadoPor || k, marcados: 0, auditados: 0, incidencias: 0, llegoDespues: 0, confirmados: 0, pendientes: 0 };
          const r = porArmador[k];
          r.marcados++;
          if (a.estado === 'pendiente') { r.pendientes++; return; }
          r.auditados++;
          if (a.veredicto === 'habia_stock') r.incidencias++;
          else if (a.veredicto === 'llego_despues') r.llegoDespues++;
          else r.confirmados++;
        });
        const pct = r => r.auditados ? (r.incidencias / r.auditados * 100) : -1;
        const lista = Object.values(porArmador).sort((a, b) => (b.incidencias - a.incidencias) || (pct(b) - pct(a)) || (b.marcados - a.marcados));
        const tot = lista.reduce((t, r) => { Object.keys(t).forEach(k => { t[k] += r[k]; }); return t; },
          { marcados: 0, auditados: 0, incidencias: 0, llegoDespues: 0, confirmados: 0, pendientes: 0 });
        const fmtPct = r => r.auditados ? Math.round(r.incidencias / r.auditados * 100) + '%' : '—';

        let html = '<table><tr><th>Armador</th><th>Marcó sin stock</th><th>Auditados</th><th>Incidencias</th><th>% incid.</th><th>Llegó después</th><th>Confirmado</th><th>Sin auditar</th></tr>';
        lista.forEach((r, i) => {
          html += `<tr style="${i === 0 && r.incidencias > 0 ? 'background:#fef2f2;' : ''}">
            <td style="font-weight:700;">${escapeHtml(r.nombre)}</td><td>${r.marcados}</td><td>${r.auditados}</td>
            <td style="font-weight:700; color:${r.incidencias ? 'var(--red)' : 'var(--muted)'};">${r.incidencias}</td>
            <td>${fmtPct(r)}</td><td>${r.llegoDespues}</td><td>${r.confirmados}</td>
            <td style="color:${r.pendientes ? 'var(--orange)' : 'var(--muted)'};">${r.pendientes}</td></tr>`;
        });
        html += `<tr style="background:#f9fafb; font-weight:700;"><td>Total</td><td>${tot.marcados}</td><td>${tot.auditados}</td><td>${tot.incidencias}</td><td>${fmtPct(tot)}</td><td>${tot.llegoDespues}</td><td>${tot.confirmados}</td><td>${tot.pendientes}</td></tr></table>`;
        html += '<p style="font-size:11px; color:var(--muted); margin:8px 0 16px;">El % de incidencia se calcula sobre lo ya auditado. Lo "sin auditar" no cuenta todavía ni a favor ni en contra.</p>';
        contResumen.innerHTML = html;

        // ----- Detalle, uno por marcado -----
        const filtro = document.getElementById('mt_audFiltroEstado').value;
        const visibles = filas.filter(a => {
          if (filtro === 'pendiente') return a.estado === 'pendiente';
          if (filtro === 'auditado') return a.estado !== 'pendiente';
          if (filtro === 'incidencia') return a.veredicto === 'habia_stock';
          return true;
        }).slice().reverse(); // más nuevo primero

        if (!visibles.length) { contDetalle.innerHTML = '<div class="empty-state">Nada para mostrar con ese filtro.</div>'; return; }

        let det = '<div style="font-size:12px; color:var(--muted); margin-bottom:6px;">Tocá una fila para ver todo el recorrido.</div>';
        det += '<table><tr><th>Marcado</th><th>Producto</th><th>Lo marcó</th><th>Lo pidieron</th><th>Estado</th><th>Auditó</th></tr>';
        visibles.forEach((a, idx) => {
          const e = estadoAud_(a);
          const pedidos = a.pedidos || [];
          const resumenSuc = pedidos.map(p => `${escapeHtml(p.sucursal || '?')} ${p.cantidadPedida}`).join(' · ');
          det += `<tr class="fila-aud" data-idx="${idx}" style="cursor:pointer;">
            <td>${fechaHoraAud_(a.marcadoEn)}</td>
            <td><b>${escapeHtml(a.producto || '')}</b><div style="font-size:11px; color:var(--muted);">${escapeHtml(a.codigo || '')}</div></td>
            <td>${escapeHtml(a.marcadoPor || '?')}</td>
            <td style="font-size:12px;">${resumenSuc}</td>
            <td style="font-weight:700; color:${e.color};">${e.txt}</td>
            <td>${a.estado === 'pendiente' ? '—' : escapeHtml(a.auditadoPor || '?')}</td></tr>
          <tr id="audDet-${idx}" style="display:none;"><td colspan="6" style="background:#f9fafb; font-size:13px; line-height:1.6;">${detalleAuditoriaHtml_(a)}</td></tr>`;
        });
        det += '</table>';
        contDetalle.innerHTML = det;
      }

      function detalleAuditoriaHtml_(a) {
        const rehab = {};
        (a.rehabilitados || []).forEach(r => { rehab[r.pedidoId] = r; });

        const lineas = (a.pedidos || []).map(p => {
          const r = rehab[p.id];
          let que;
          if (a.estado === 'pendiente') que = 'Cancelado (todavía sin auditar)';
          else if (!r) que = a.veredicto === 'sin_stock_confirmado' ? 'Quedó cancelado (se confirmó que no había stock)' : 'Sin dato';
          else if (r.accion === 'reabierto') que = `Habilitado de nuevo: <b>${r.cantidadHabilitada}</b> u.`;
          else if (r.accion === 'faltante_creado') que = `Habilitado como FALTANTE nuevo: <b>${r.cantidadHabilitada}</b> u.`;
          else if (r.accion === 'sin_cobertura') que = 'Quedó cancelado (no alcanzaron las unidades)';
          else que = 'Ya estaba habilitado';
          return `<div>• <b>${escapeHtml(p.sucursal || '?')}</b> pidió ${p.cantidadPedida} → ${que}</div>`;
        }).join('');

        let html = `<div><b>Cancelado por:</b> ${escapeHtml(a.marcadoPor || '?')} (DNI ${escapeHtml(a.marcadoPorDocumento || '—')}) · ${fechaHoraAud_(a.marcadoEn)}</div>`;
        html += `<div style="margin:4px 0;"><b>Pedido por las sucursales:</b></div>${lineas}`;

        if (a.estado === 'pendiente') {
          html += '<div style="margin-top:6px; color:var(--orange);"><b>Todavía no fue auditado.</b></div>';
        } else {
          const accion = a.veredicto === 'sin_stock_confirmado' ? 'Confirmó que no había stock' : 'Habilitó';
          html += `<div style="margin-top:6px;"><b>${accion}:</b> ${escapeHtml(a.auditadoPor || '?')} (DNI ${escapeHtml(a.auditadoPorDocumento || '—')}) · ${fechaHoraAud_(a.auditadoEn)}</div>`;
          html += `<div><b>Veredicto:</b> ${escapeHtml(VEREDICTOS_AUDITORIA[a.veredicto] || '—')}</div>`;
          if (a.origenResolucion === 'habilitar_sin_stock') html += '<div><b>Resuelto desde:</b> Habilitar sin stock (el proveedor llegó después, sin pasar por auditoría)</div>';
          if (a.veredicto !== 'sin_stock_confirmado' && a.unidadesHalladas != null) html += `<div><b>Unidades halladas:</b> ${a.unidadesHalladas}</div>`;
          if (a.stockAntes != null) {
            const posiciones = (a.ajusteStock || []).map(c => `${escapeHtml(c.posicion)}: ${c.antes}→${c.despues}`).join(', ');
            html += `<div><b>Stock en el sistema:</b> ${a.stockAntes} → ${a.stockDespues}${posiciones ? ' (' + posiciones + ')' : ''}</div>`;
          }
        }
        return html;
      }

      function descargarAuditoriaCSV_() {
        if (!auditControlFilas.length) { alert('Primero buscá un rango con datos'); return; }
        const filas = [['FechaMarcado', 'CanceladoPor', 'DNICanceladoPor', 'Codigo', 'CodigoInterno', 'Producto', 'Proveedor', 'PedidoPorSucursales', 'UnidadesPedidas', 'Estado', 'Veredicto', 'Incidencia', 'AuditadoPor', 'DNIAuditor', 'FechaAuditoria', 'UnidadesHalladas', 'StockAntes', 'StockDespues', 'Habilitaciones']];
        auditControlFilas.forEach(a => {
          filas.push([
            a.marcadoEn && a.marcadoEn.toDate ? a.marcadoEn.toDate().toLocaleString('es-AR') : '',
            a.marcadoPor, a.marcadoPorDocumento, a.codigo, a.codigoInterno, a.producto, a.proveedor,
            (a.pedidos || []).map(p => `${p.sucursal}:${p.cantidadPedida}`).join(' | '),
            a.totalUnidades,
            a.estado === 'pendiente' ? 'Sin auditar' : 'Auditado',
            VEREDICTOS_AUDITORIA[a.veredicto] || '',
            a.estado === 'pendiente' ? '' : (a.incidencia ? 'SI' : 'NO'),
            a.auditadoPor, a.auditadoPorDocumento,
            a.auditadoEn && a.auditadoEn.toDate ? a.auditadoEn.toDate().toLocaleString('es-AR') : '',
            a.unidadesHalladas, a.stockAntes, a.stockDespues,
            (a.rehabilitados || []).map(r => `${r.sucursal}:${r.cantidadHabilitada}:${r.accion}`).join(' | ')
          ]);
        });
        const csv = filas.map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `control_auditoria_sin_stock_${document.getElementById('mt_audDesde').value}_a_${document.getElementById('mt_audHasta').value}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }

      // ---------------- GRÁFICO DE EVOLUCIÓN DEL SCORE POR DÍA ----------------
      const COLORES_GRAFICO = ['#2563eb', '#dc2626', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04', '#db2777', '#4d7c0f', '#7c3aed'];

      // Mismo score que la tabla de arriba (Velocidad 50 / Continuidad 25 /
      // Volumen 25), pero calculado UN DÍA A LA VEZ — cada día se compara
      // solo contra quienes trabajaron ESE día (no contra todo el rango).
      function calcularEvolucionDiaria_(todosLosEventos) {
        const porDia = agruparPorDia_(todosLosEventos);
        const dias = Object.keys(porDia).sort();
        const seriePorPersona = {};

        dias.forEach(dia => {
          const porPersonaDelDia = {};
          porDia[dia].forEach(ev => {
            const key = ev.personaDocumento || ev.personaNombre || '?';
            if (!porPersonaDelDia[key]) porPersonaDelDia[key] = { nombre: ev.personaNombre, eventos: [] };
            porPersonaDelDia[key].eventos.push(ev);
          });

          const personasDelDia = Object.values(porPersonaDelDia).map(p => ({ nombre: p.nombre, ...calcularTotalesPersona_(p.eventos) }));
          if (!personasDelDia.length) return;

          const promedios = personasDelDia.map(f => f.promedioMsPorPick);
          const pausasPct = personasDelDia.map(f => f.porcentajePausas);
          const volumenes = personasDelDia.map(f => f.picks);

          personasDelDia.forEach(f => {
            const sVel = normalizar_(promedios, f.promedioMsPorPick, true);
            const sCon = normalizar_(pausasPct, f.porcentajePausas, true);
            const sVol = normalizar_(volumenes, f.picks, false);
            const score = sVel * 0.50 + sCon * 0.25 + sVol * 0.25;
            if (!seriePorPersona[f.nombre]) seriePorPersona[f.nombre] = [];
            seriePorPersona[f.nombre].push({ dia, score });
          });
        });

        return { dias, seriePorPersona };
      }

      function renderizarGraficoEvolucion_(todosLosEventos) {
        const cont = document.getElementById('mt_contenidoGrafico');
        const { dias, seriePorPersona } = calcularEvolucionDiaria_(todosLosEventos);
        const nombres = Object.keys(seriePorPersona);

        if (!dias.length || !nombres.length) {
          cont.innerHTML = '<div class="empty-state">Sin datos para graficar</div>';
          return;
        }

        const anchoTotal = 800, altoTotal = 320;
        const margenIzq = 40, margenDer = 20, margenSup = 20, margenInf = 50;
        const anchoUtil = anchoTotal - margenIzq - margenDer;
        const altoUtil = altoTotal - margenSup - margenInf;

        const xPorIndice = (i) => margenIzq + (dias.length > 1 ? (i / (dias.length - 1)) * anchoUtil : anchoUtil / 2);
        const yPorScore = (score) => margenSup + (1 - score / 100) * altoUtil;

        let svg = `<svg viewBox="0 0 ${anchoTotal} ${altoTotal}" style="width:100%; height:auto; font-family:inherit;">`;

        [0, 25, 50, 75, 100].forEach(v => {
          const y = yPorScore(v);
          svg += `<line x1="${margenIzq}" y1="${y}" x2="${anchoTotal - margenDer}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
          svg += `<text x="${margenIzq - 8}" y="${y + 4}" font-size="11" fill="#6b7280" text-anchor="end">${v}</text>`;
        });

        const salto = Math.ceil(dias.length / 10) || 1;
        dias.forEach((dia, i) => {
          if (i % salto !== 0 && i !== dias.length - 1) return;
          const x = xPorIndice(i);
          const partes = dia.split('-');
          const etiqueta = `${partes[2]}/${partes[1]}`;
          svg += `<text x="${x}" y="${altoTotal - margenInf + 18}" font-size="10" fill="#6b7280" text-anchor="middle">${etiqueta}</text>`;
        });

        nombres.forEach((nombre, idx) => {
          const color = COLORES_GRAFICO[idx % COLORES_GRAFICO.length];
          const puntosPorDia = {};
          seriePorPersona[nombre].forEach(p => { puntosPorDia[p.dia] = p.score; });

          const coords = [];
          dias.forEach((dia, i) => {
            if (puntosPorDia[dia] === undefined) return; // ese día no trabajó — se salta, no se inventa un punto
            coords.push(`${xPorIndice(i)},${yPorScore(puntosPorDia[dia])}`);
          });
          if (coords.length) {
            svg += `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
          }
          dias.forEach((dia, i) => {
            if (puntosPorDia[dia] === undefined) return;
            svg += `<circle cx="${xPorIndice(i)}" cy="${yPorScore(puntosPorDia[dia])}" r="3.5" fill="${color}"><title>${escapeHtml(nombre)} — ${dia}: ${puntosPorDia[dia].toFixed(0)}</title></circle>`;
          });
        });

        svg += '</svg>';

        const leyenda = nombres.map((nombre, idx) => {
          const color = COLORES_GRAFICO[idx % COLORES_GRAFICO.length];
          return `<span style="display:inline-flex; align-items:center; gap:5px; margin-right:14px; font-size:12px;"><span style="width:10px; height:10px; border-radius:50%; background:${color}; display:inline-block;"></span>${escapeHtml(nombre)}</span>`;
        }).join('');

        cont.innerHTML = svg + `<div style="margin-top:10px;">${leyenda}</div>`;
      }

      function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
      }
  

  return {
    // arranca las suscripciones en vivo (una sola vez; después quedan escuchando mientras la app esté abierta)
    abrir: () => { if (iniciado) return; iniciado = true; iniciar_(); },
    // los paneles de historial, scoring y evolución comparten el rango de fechas: la primera vez se carga solo
    asegurarRango: () => {
      if (rangoCargado) return;
      const d = document.getElementById('mt_inputRangoDesde').value, h = document.getElementById('mt_inputRangoHasta').value;
      if (d && h) cargarRango_(d, h);
    }
  };
}
