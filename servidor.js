/* Servidor de Control de Vencimientos — versión "en la nube".
 
   Es el mismo programa de siempre, con un solo cambio de fondo: en vez de
   guardar el dato en el disco de un computador de la oficina (que se borra
   cada vez que este servicio gratuito se duerme y despierta), lo guarda en
   una base de datos gratuita de Google (Firestore). Por eso este programa
   puede vivir en un servicio de internet gratuito, sin que nadie tenga que
   dejar un computador prendido ni instalar nada en la oficina.
 
   La aplicación (el archivo .html) NO cambia en la forma de hablar con este
   servidor: las mismas direcciones de siempre (/api/estado, /api/seg,
   /api/latir, /api/gente) responden igual que antes. Lo único que cambia
   para el usuario final es que la dirección del servidor, en Configuración,
   ahora es una dirección fija de internet — se escribe una sola vez y no
   vuelve a cambiar nunca.
 
   Para encender este programa hace falta UNA sola cosa además del código:
   una variable llamada FIREBASE_KEY con las credenciales del proyecto de
   Firebase (el "Generar nueva clave privada" de la cuenta de servicio). Esa
   variable se configura en el panel del servicio de hosting, no se escribe
   en este archivo ni queda guardada en ningún lado del código.
 
   ---------------------------------------------------------------------
   CAMBIO: guardado por registro, no por documento completo (sept/2026)
   ---------------------------------------------------------------------
   Antes, cada «guardar» mandaba TODO el dato (todas las empresas de todos
   los contadores) y el servidor lo aceptaba entero o lo rechazaba entero
   («conflicto: 409») si alguien más había guardado primero — aunque esa
   otra persona hubiera tocado una empresa completamente distinta.
 
   Ahora el servidor combina, registro por registro (cada empresa, sede,
   obligación, vencimiento, contador o calendario tiene su propio «id»):
   si un registro no lo tocó nadie más, se guarda tal cual; si lo tocaron
   los dos lados a la vez, gana el que ya estaba guardado en el servidor
   SOLO para ese registro puntual — el resto de lo que cada quien guardó
   se conserva igual. Ya no hay «todo o nada»: dos contadores trabajando
   en empresas distintas nunca chocan entre sí. */
const http = require('http');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
 
/* La conexión con Firebase, por debajo, usa su propia conexión de red aparte
   de las peticiones normales del programa. Si esa conexión tiene un tropiezo
   pasajero (algo normal en cualquier red de internet), no debe tumbar todo
   el servidor — solo esa operación puntual falla, y el servidor sigue
   atendiendo lo demás con normalidad. */
process.on('uncaughtException', (err) => {
  console.error('⚠️  Error no manejado (el servidor sigue funcionando):', err && err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️  Promesa rechazada sin manejar (el servidor sigue funcionando):', err && err.message);
});
 
function leerCredenciales(){
  const texto = process.env.FIREBASE_KEY;
  if(!texto){
    console.error('⚠️  Falta la variable de entorno FIREBASE_KEY con las credenciales de Firebase. El programa no puede arrancar sin ella.');
    process.exit(1);
  }
  try{ return JSON.parse(texto); }
  catch(e){
    console.error('⚠️  FIREBASE_KEY no tiene un formato válido (debe ser el JSON completo de la clave, sin cambios):', e.message);
    process.exit(1);
  }
}
 
const appFirebase = initializeApp({ credential: cert(leerCredenciales()) });
const db = getFirestore(appFirebase);
 
const PUERTO = process.env.PORT || 4780;
 
const DOC_ESTADO    = db.collection('vencimientos').doc('estado');
const DOC_SEG       = db.collection('vencimientos').doc('seg');
const COL_RESPALDOS = db.collection('respaldos');
 
function selloNuevo(){
  return new Date().toISOString()+'·'+Date.now()+'·'+Math.random().toString(36).slice(2,8);
}
 
function hoy(){ return new Date().toLocaleDateString('sv-SE'); }   // AAAA-MM-DD
 
/* ---------- combinar (merge) registro por registro ----------
   base   = lo que el cliente tenía la ÚLTIMA VEZ que sincronizó con el servidor
   mio    = lo que el cliente tiene AHORA en pantalla (con sus cambios)
   actual = lo que hay guardado en el servidor EN ESTE MOMENTO
 
   Con esos tres, para cada registro se puede saber con certeza qué pasó:
   · si "mio" es igual a "base"      → este cliente no tocó ese registro
   · si "actual" es igual a "base"   → nadie más tocó ese registro
   Combinando esas dos preguntas se decide, registro por registro, sin
   adivinar ni perder cambios de nadie salvo en el choque puntual real. */
const CLAVES_POR_ID = ['contadores','empresas','sedes','obligaciones','calendarios','vencimientos'];
 
function igual(a, b){
  // comparación profunda simple — alcanza de sobra para estos datos (JSON puro, sin fechas ni funciones)
  return JSON.stringify(a===undefined?null:a) === JSON.stringify(b===undefined?null:b);
}
 
/* La mayoría de las listas (empresas, sedes, obligaciones, vencimientos,
   contadores) tienen un campo "id" propio de cada registro. Los
   CALENDARIOS son la excepción: no tienen "id" — cada uno se identifica,
   dentro del programa, por la combinación jurisdicción+impuesto+año+periodo
   (así es como el propio programa evita duplicados al guardar). Por eso
   hace falta esta excepción: si se los tratara igual que a los demás
   (buscando un "id" que no tienen), TODOS los calendarios quedarían fuera
   de la combinación y se borrarían en cada guardado. */
function idDeRegistro(clave, r){
  if(!r) return null;
  if(clave === 'calendarios') return [r.jur, r.imp, r.anio, r.periodo].join('|');
  return (r.id!=null) ? String(r.id) : null;
}
 
function mapaPorClave(clave, arr){
  const m = new Map();
  (Array.isArray(arr)?arr:[]).forEach(r => { const id = idDeRegistro(clave, r); if(id!=null) m.set(id, r); });
  return m;
}
 
function combinarLista(clave, base, mio, actual){
  const mapB = mapaPorClave(clave, base), mapM = mapaPorClave(clave, mio), mapA = mapaPorClave(clave, actual);
  const idsTotal = new Set([...mapM.keys(), ...mapA.keys()]);
  const salida = [];
  const conflictos = [];
  idsTotal.forEach(id => {
    const rb = mapB.get(id), rm = mapM.get(id), ra = mapA.get(id);
    const yoLoToque   = !igual(rb, rm);
    const otroLoToco  = !igual(rb, ra);
    if(!yoLoToque){                       // no lo cambié yo: gana lo que haya quedado en el servidor
      if(ra !== undefined) salida.push(ra);
      return;
    }
    if(!otroLoToco){                      // solo lo cambié yo: gana lo mío
      if(rm !== undefined) salida.push(rm);
      return;
    }
    if(rm === undefined && ra === undefined) return;   // los dos lo borraron: no hay nada que discutir
    // los dos lo cambiaron desde la última sincronización: choque puntual de ESTE registro
    conflictos.push({ id });
    if(ra !== undefined) salida.push(ra); else if(rm !== undefined) salida.push(rm);
  });
  return { lista: salida, conflictos };
}
 
function combinarBloque(clave, base, mio, actual){
  const yoLoToque  = !igual(base, mio);
  const otroLoToco = !igual(base, actual);
  if(!yoLoToque)  return { valor: (actual!==undefined ? actual : base), conflicto: null };
  if(!otroLoToco) return { valor: mio, conflicto: null };
  return { valor: actual, conflicto: { clave } };
}
 
function combinarDatos(base, mio, actual){
  base = base || {}; mio = mio || {}; actual = actual || {};
  const resultado = {};
  const conflictosPorTipo = [];
  const todasLasClaves = new Set([...Object.keys(mio), ...Object.keys(actual), ...Object.keys(base)]);
  todasLasClaves.forEach(clave => {
    if(CLAVES_POR_ID.includes(clave)){
      const { lista, conflictos } = combinarLista(clave, base[clave], mio[clave], actual[clave]);
      resultado[clave] = lista;
      conflictos.forEach(c => conflictosPorTipo.push({ tipo: clave, id: c.id }));
    } else {
      const { valor, conflicto } = combinarBloque(clave, base[clave], mio[clave], actual[clave]);
      resultado[clave] = valor;
      if(conflicto) conflictosPorTipo.push({ tipo: clave, id: null });
    }
  });
  return { datos: resultado, conflictos: conflictosPorTipo };
}
 
async function leerEstado(){
  const snap = await DOC_ESTADO.get();
  if(!snap.exists) return { sello: null, datos: {}, equipo: '' };
  return snap.data();
}
 
/* Igual que en la versión de oficina: se reescribe cada día con el ÚLTIMO
   estado guardado, y se conservan los últimos 30 días. Antes vivía en una
   carpeta "respaldos/"; ahora vive en su propia colección de Firestore, pero
   la idea — y la protección que da — es exactamente la misma. No detiene la
   respuesta al usuario: se hace de fondo, después de contestar. */
async function respaldoDelDiaSiHaceFalta(datos, equipo){
  try{
    await COL_RESPALDOS.doc(hoy()).set({
      creado: new Date().toISOString(),
      equipo: equipo || 'servidor',
      datos
    });
    const viejos = await COL_RESPALDOS.orderBy('creado', 'desc').get();
    const sobrantes = viejos.docs.slice(30);
    for(const d of sobrantes){ await d.ref.delete().catch(()=>{}); }
  }catch(e){
    console.error('⚠️  No se pudo hacer el respaldo del día:', e.message);
  }
}
 
/* ---------- quién está conectado ahora: esto sí puede vivir solo en
   memoria, porque es información de "ahora mismo" (últimos 2 minutos), no
   un dato que haya que conservar entre reinicios. ---------- */
const conectados = new Map();   // id -> {id, nombre, rol, hora}
const DOS_MINUTOS = 120000;
 
function gentaActiva(){
  const ahora = Date.now();
  const activos = [];
  for(const [id, o] of conectados){
    if(ahora - o.hora < DOS_MINUTOS) activos.push(o);
    else conectados.delete(id);
  }
  return activos.sort((a,b) => a.nombre < b.nombre ? -1 : 1);
}
 
/* ---------- servidor HTTP ---------- */
function leerCuerpo(req){
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', c => {
      datos += c;
      if(datos.length > 50 * 1024 * 1024){ reject(new Error('cuerpo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => resolve(datos));
    req.on('error', reject);
  });
}
 
function responderJSON(res, codigo, obj){
  const txt = JSON.stringify(obj);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(txt);
}
 
const servidor = http.createServer(async (req, res) => {
  try{
    if(req.method === 'OPTIONS'){
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
 
    if(req.url === '/' && req.method === 'GET'){
      const estado = await leerEstado();
      const n = (estado.datos && estado.datos.empresas) ? estado.datos.empresas.length : 0;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end('Servidor de Control de Vencimientos (en la nube) — activo.\n'+n+' empresa(s) guardadas.\n\nEsto no es la aplicación: abra el archivo .html como siempre; ahí, en Configuración, indique esta dirección.');
    }
 
    if(req.url === '/api/estado' && req.method === 'GET'){
      const estado = await leerEstado();
      return responderJSON(res, 200, estado);
    }
 
    if(req.url === '/api/estado' && req.method === 'POST'){
      const cuerpo = await leerCuerpo(req);
      let entrada;
      try{ entrada = JSON.parse(cuerpo); }catch(e){ return responderJSON(res, 400, { error: 'JSON inválido' }); }
 
      let resultado;
      try{
        resultado = await db.runTransaction(async (tx) => {
          const snap = await tx.get(DOC_ESTADO);
          const actual = snap.exists ? snap.data() : null;
          const actualDatos = actual ? (actual.datos || {}) : {};
          const { datos: combinados, conflictos } = combinarDatos(entrada.base, entrada.datos, actualDatos);
          const nuevo = { sello: selloNuevo(), datos: combinados, equipo: entrada.equipo || '' };
          tx.set(DOC_ESTADO, nuevo);
          return { ok: true, sello: nuevo.sello, _datos: nuevo.datos, _equipo: nuevo.equipo, conflictos };
        });
      }catch(e){
        console.error('⚠️  Error guardando en Firestore:', e.message);
        return responderJSON(res, 500, { error: 'no se pudo guardar' });
      }
 
      respaldoDelDiaSiHaceFalta(resultado._datos, resultado._equipo);  // de fondo, no bloquea la respuesta
      return responderJSON(res, 200, { ok: true, sello: resultado.sello, datos: resultado._datos, conflictos: resultado.conflictos });
    }
 
    /* Las credenciales viajan aparte de los datos (usuarios.seg), igual que
       antes: así un dato nunca lleva las claves pegadas. */
    if(req.url === '/api/seg' && req.method === 'GET'){
      try{
        const snap = await DOC_SEG.get();
        if(!snap.exists){ res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(snap.data().contenido || '');
      }catch(e){
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
    }
    if(req.url === '/api/seg' && req.method === 'POST'){
      const cuerpo = await leerCuerpo(req);
      try{ await DOC_SEG.set({ contenido: cuerpo }); }
      catch(e){ console.error('⚠️  No se pudo guardar usuarios.seg:', e.message); }
      return responderJSON(res, 200, { ok: true });
    }
 
    if(req.url === '/api/latir' && req.method === 'POST'){
      const cuerpo = await leerCuerpo(req);
      let entrada;
      try{ entrada = JSON.parse(cuerpo); }catch(e){ return responderJSON(res, 400, { error: 'JSON inválido' }); }
      if(entrada.id){
        conectados.set(entrada.id, { id: entrada.id, nombre: entrada.nombre||'', rol: entrada.rol||'', hora: Date.now() });
      }
      return responderJSON(res, 200, { ok: true });
    }
 
    if(req.url === '/api/gente' && req.method === 'GET'){
      return responderJSON(res, 200, { gente: gentaActiva() });
    }
 
    responderJSON(res, 404, { error: 'no existe' });
  }catch(e){
    console.error('Error atendiendo una solicitud:', e);
    try{ responderJSON(res, 500, { error: 'error interno del servidor' }); }catch(e2){}
  }
});
 
servidor.listen(PUERTO, () => {
  console.log('========================================================');
  console.log(' Servidor de Control de Vencimientos (en la nube) — encendido');
  console.log(' Puerto: ' + PUERTO);
  console.log(' Los datos se guardan en Firebase (Firestore), no en el disco de este servicio.');
  console.log(' Guardado por registro: contadores en empresas distintas ya no chocan entre sí.');
  console.log('========================================================');
});
