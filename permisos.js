// ============================================================
// permisos.js — roles y permisos de toda la app (Armador, Compras, Métricas).
// UN solo lugar: si se cambia lo que puede hacer un rol, se cambia acá.
//
// Cada persona (por DNI) está en la colección "usuarios" de Firestore con:
//   { documento, nombre, roles: [...], auditor: true/false, activo: true/false }
// Lo que puede hacer es la UNIÓN de lo que permite cada uno de sus roles.
// ============================================================

export const NOMBRE_ROL = {
  armador: 'Armador',
  compras: 'Compras',
  planificacion: 'Planificación',
  logistica: 'Logística'
};

// Qué permite cada rol. Los permisos son:
//   armar            armar pedidos y ver lo armado sin procesar
//   contar           contar stock e ingreso de proveedor
//   ver_stock        ver el stock
//   auditar          auditoría de "sin stock"
//   planificar       habilitar pendientes / sin stock, pedido fuera de planificación, borrar, editar armado
//   compras_ver      entrar al módulo de Compras y preparar el plan de compra
//   compras_aprobar  aprobar y emitir la orden de compra
//   metricas         tiempos, scoring y control de auditorías
//   usuarios         alta de personas, roles y quién puede auditar
export const PERMISOS_POR_ROL = {
  armador:       ['armar', 'contar', 'ver_stock'],
  compras:       ['ver_stock', 'compras_ver', 'compras_aprobar'],
  // Planificación: todo menos Métricas y Usuarios. Prepara la compra pero NO la aprueba ni emite la orden (eso es de Compras).
  planificacion: ['armar', 'contar', 'ver_stock', 'auditar', 'planificar', 'compras_ver'],
  logistica:     ['armar', 'contar', 'ver_stock', 'auditar', 'planificar', 'compras_ver', 'compras_aprobar', 'metricas', 'usuarios']
};

// Personas que ya usaban la app antes de existir la colección "usuarios". Se crean solas en Firestore la primera
// vez que se necesitan; desde ese momento manda lo que figure en Firestore (se edita desde Logística > Usuarios).
export const USUARIOS_INICIALES = {
  '43458682': { nombre: 'Taiel Isidro Madoery', roles: ['logistica'], auditor: false },
  '43985774': { nombre: 'Martin Carmelo Mazzeo', roles: ['logistica'], auditor: false },
  '35918123': { nombre: 'Franco Palomino', roles: ['armador'], auditor: true },
  '40865366': { nombre: 'Paulo David Mandon', roles: ['armador'], auditor: false },
  '45779563': { nombre: 'Brandon Jesus Carrizo', roles: ['armador'], auditor: false },
  '41556471': { nombre: 'Julian Hector Casabianca Perdriel', roles: ['armador'], auditor: false },
  '31944489': { nombre: 'Diego Terrein', roles: ['armador'], auditor: false },
  '39763131': { nombre: 'Enzo Ariel Ferrari', roles: ['armador'], auditor: false },
  '40143672': { nombre: 'Facundo Sebastián Nerli', roles: ['armador'], auditor: false }
};

export function calcularPermisos(roles, auditor) {
  const permisos = new Set();
  (roles || []).forEach(r => (PERMISOS_POR_ROL[r] || []).forEach(p => permisos.add(p)));
  if (auditor) permisos.add('auditar'); // la marca de auditor suma la auditoría a cualquier rol
  return permisos;
}

// Busca a la persona. api = { db, doc, getDoc, setDoc, serverTimestamp } (las funciones de Firestore de la página que llama).
// Devuelve { ok:true, usuario, fuente } o { ok:false, motivo: 'no_habilitado' | 'inactivo' | 'error' }.
//   1) Si está en Firestore, manda lo que dice Firestore.
//   2) Si no está pero es una persona "inicial", se crea en Firestore (migración).
//   3) Si Firestore no responde (reglas todavía sin publicar, sin conexión), se usa la lista inicial como respaldo.
export async function cargarUsuario(api, documento) {
  const { db, doc, getDoc, setDoc, serverTimestamp } = api;
  const inicial = USUARIOS_INICIALES[documento];
  try {
    const snap = await getDoc(doc(db, 'usuarios', documento));
    if (snap.exists()) {
      const u = snap.data();
      if (u.activo === false) return { ok: false, motivo: 'inactivo' };
      return { ok: true, usuario: u, fuente: 'firestore' };
    }
    if (inicial) {
      const nuevo = { documento, nombre: inicial.nombre, roles: inicial.roles, auditor: !!inicial.auditor, activo: true };
      try { await setDoc(doc(db, 'usuarios', documento), { ...nuevo, creadoEn: serverTimestamp(), creadoPor: 'migración inicial' }); } catch (e) { /* si no se puede escribir, igual entra */ }
      return { ok: true, usuario: nuevo, fuente: 'inicial' };
    }
    return { ok: false, motivo: 'no_habilitado' };
  } catch (err) {
    if (inicial) return { ok: true, usuario: { documento, nombre: inicial.nombre, roles: inicial.roles, auditor: !!inicial.auditor, activo: true }, fuente: 'respaldo', error: err };
    return { ok: false, motivo: 'error', error: err };
  }
}

// La sesión la guarda el Armador al ingresar (mismo navegador y dominio); Compras y Métricas la reutilizan.
export function leerSesionGuardada() {
  try {
    const s = JSON.parse(localStorage.getItem('armador_persona') || 'null');
    return (s && s.documento && s.expira && Date.now() < s.expira) ? s : null;
  } catch (e) { return null; }
}
