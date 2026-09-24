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
   en empresas distintas nunca chocan entre sí.
 
   ---------------------------------------------------------------------
   CAMBIO: la aplicación se sirve desde aquí, con acceso cerrado (sept/2026)
   ---------------------------------------------------------------------
   Hasta ahora, CUALQUIERA que tuviera la dirección de este servidor podía
   leer TODOS los datos de TODAS las empresas de TODOS los contadores
   (/api/estado) y TODAS las contraseñas cifradas (/api/seg) sin haber
   iniciado sesión — el programa mismo se los pedía, sin preguntar, antes
   de mostrar siquiera la pantalla de ingreso. Y cualquiera podía además
   escribir sobre esos mismos datos, también sin iniciar sesión.
 
   Ahora:
   · El propio archivo de la aplicación (antes repartido suelto, un .html
     que cualquiera podía copiar y modificar) se sirve desde aquí mismo
     (GET /), leyendo un archivo aparte llamado app.html.
   · Para entrar hace falta una clave que el SERVIDOR verifica
     (POST /api/entrar) — no el navegador — y que entrega una llave de
     sesión (token) de un solo uso, válida 24 horas.
   · /api/estado y /api/seg exigen esa llave: sin ella, responden 401.
   · Un contador (no administrador, no consulta) solo ve y solo puede
     guardar sus propias empresas — o las que tenga asignadas puntualmente
     — nunca las de los demás; el servidor lo obliga aunque alguien
     modifique el programa que corre en su navegador.
   ---------------------------------------------------------------------ipsum*/
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
 
/* ---------- la aplicación misma: se sirve desde aquí (GET /) ----------
   Se lee UNA sola vez, al encender el servidor — no en cada visita — para
   no leer el disco en cada petición. Si el archivo cambia (una actualización
   del programa), hace falta un reinicio del servicio para que se note; eso
   ya pasa solo cada vez que se sube un cambio a GitHub/Render. */
let HTML_APP = null;
try{
  HTML_APP = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
}catch(e){
  console.error('⚠️  No se encontró app.html junto a servidor.js: por ahora GET / no puede servir la aplicación.', e.message);
}
 
/* ---------- sesiones: quién entró y hasta cuándo ----------
   Viven solo en memoria — igual que "conectados" más abajo — porque son
   información de "ahora mismo". Si el servicio se reinicia (algo normal en
   el plan gratuito, o al subir una actualización), las sesiones abiertas se
   pierden y cada quien tiene que volver a entrar; el programa lo avisa y no
   pierde lo que esa persona tuviera sin guardar. */
const SESIONES = new Map();                 // token -> {id, nombre, rol, vence}
const DURACION_SESION = 24*60*60*1000;       // 24 horas, y se renueva sola con cada uso
 
function nuevoToken(){ return crypto.randomBytes(32).toString('hex'); }
 
function crearSesion(id, nombre, rol){
  const token = nuevoToken();
  SESIONES.set(token, { id, nombre, rol, vence: Date.now()+DURACION_SESION });
  return token;
}
 
function sesionDe(token){
  if(!token) return null;
  const s = SESIONES.get(token);
  if(!s) return null;
  if(Date.now() > s.vence){ SESIONES.delete(token); return null; }
  s.vence = Date.now()+DURACION_SESION;      // sesión deslizante: cada uso la renueva otras 24 horas
  return s;
}
 
function tokenDe(req){
  const cab = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(cab.trim());
  return m ? m[1] : null;
}
 
let vigiaSesiones = null;
function arrancarVigiaSesiones(){
  vigiaSesiones = setInterval(()=>{
    const ahora = Date.now();
    for(const [token, s] of SESIONES){ if(ahora > s.vence) SESIONES.delete(token); }
  }, 30*60*1000);
  if(vigiaSesiones.unref) vigiaSesiones.unref();
}
 
/* ---------- recuperación de contraseña del administrador ----------
   El programa nunca guarda la contraseña como tal: guarda un derivado
   PBKDF2 (SHA-256, 150.000 vueltas, sal propia) — eso ya lo hace el
   navegador. Aquí se calcula EXACTAMENTE lo mismo, del lado del servidor,
   para poder generarle una clave temporal al administrador y guardarla sin
   que haga falta que nadie tenga una sesión abierta — que es justo lo que
   hace falta cuando el que queda afuera es el propio administrador. Y,
   ahora, también para verificar el ingreso de CUALQUIER usuario del lado
   del servidor (antes esa verificación la hacía, sola, la página en el
   navegador de cada quien). */
const ITER_CLAVE = 150000;
 
function salNueva(){ return crypto.randomBytes(16).toString('hex'); }
function derivarClave(clave, sal, iter){
  return crypto.pbkdf2Sync(clave, Buffer.from(sal, 'utf8'), iter || ITER_CLAVE, 32, 'sha256').toString('hex');
}
function claveTemporal(){
  const L='ABCDEFGHJKLMNPQRSTUVWXYZ', N='23456789', s='abcdefghijkmnpqrstuvwxyz';
  const r=n=>n[Math.floor(Math.random()*n.length)];
  return r(L)+r(s)+r(s)+r(s)+r(s)+'-'+r(N)+r(N)+r(N)+r(N);
}
/* El mismo sello de integridad que usa el programa en usuarios.seg — no es
   seguridad, es solo para notar si alguien tocó el archivo a mano. */
function sumaControl(texto){
  let h=5381;
  for(const ch of texto) h=((h*33)^ch.charCodeAt(0))>>>0;
  return h.toString(16);
}
function segTextoDesde(usuarios, bitacora){
  const cuerpo = JSON.stringify({v:1, app:'Control de Vencimientos', creado:new Date().toISOString(), usuarios, bitacora});
  return 'CTRLVENCSEG1\n'+sumaControl(cuerpo)+'\n'+cuerpo;
}
function segDesdeTexto(txt){
  if(!txt || txt.slice(0,12)!=='CTRLVENCSEG1') return { usuarios: [], bitacora: [] };
  const l1 = txt.indexOf('\n'), l2 = txt.indexOf('\n', l1+1);
  try{ const o = JSON.parse(txt.slice(l2+1)); return { usuarios: o.usuarios||[], bitacora: o.bitacora||[] }; }
  catch(e){ return { usuarios: [], bitacora: [] }; }
}
/* La bitácora es un registro que solo CRECE (cada quien le agrega renglones,
   nadie edita uno que ya existe), así que combinarla es más simple que
   combinarLista: no hace falta decidir quién "gana" — solo juntar todo lo
   que cada lado tenga que el otro no tenga todavía, sin duplicar. Un
   renglón no trae id propio, así que se identifica por sus propios campos. */
function claveBitacora(e){ return [e.t, e.u, e.a, e.d, e.s].map(x=>x==null?'':String(x)).join('|'); }
function combinarBitacora(mio, actual){
  const vistos = new Set((actual||[]).map(claveBitacora));
  const salida = (actual||[]).slice();
  (mio||[]).forEach(e=>{ const k=claveBitacora(e); if(!vistos.has(k)){ salida.push(e); vistos.add(k); } });
  salida.sort((a,b)=> (a.t||'') < (b.t||'') ? -1 : (a.t||'') > (b.t||'') ? 1 : 0);
  return salida.length>3000 ? salida.slice(-3000) : salida;
}
 
/* Que no se pueda pedir la recuperación una y otra vez para el mismo
   correo en pocos minutos — ni falta le hace a un uso normal, y evita
   gastar de más el envío de correos si alguien insiste sin necesidad.
   Vive solo en memoria: se olvida si el servicio se reinicia, y no pasa
   nada por eso. */
const ultimaRecuperacion = new Map();   // correo (minúsculas) -> Date.now()
const ESPERA_RECUPERAR = 5*60*1000;
 
/* El correo se manda con Brevo (antes "Sendinblue"), un servicio gratuito
   de envío de correo que funciona por internet normal (HTTPS), no por el
   protocolo de correo tradicional (SMTP) — este servicio de hosting
   gratuito bloquea el SMTP hacia afuera, así que Gmail directo nunca iba a
   funcionar desde aquí. Hacen falta DOS variables de entorno del servicio
   de hosting (igual que FIREBASE_KEY, nunca en este archivo):
     BREVO_API_KEY    — la llave que genera Brevo para la cuenta
     BREVO_FROM_EMAIL — el correo remitente, ya verificado en Brevo
   Si esas dos variables no están puestas, esta función de recuperación
   queda apagada sola: no truena el servidor, simplemente no hay cómo
   avisarle a nadie por correo. */
function puedeEnviarCorreo(){ return !!(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL); }
async function enviarClaveTemporalPorCorreo(nombre, correoDestino, claveNueva){
  if(!puedeEnviarCorreo()) return;
  const cuerpo = {
    sender: { email: process.env.BREVO_FROM_EMAIL, name: 'Control de Vencimientos' },
    to: [ { email: correoDestino, name: nombre || '' } ],
    subject: 'Recuperación de acceso — Control de Vencimientos',
    textContent:
`${nombre}:
 
Alguien pidió recuperar el acceso de administrador en el programa de Control de Vencimientos, usando este correo.
 
Clave temporal (un solo uso): ${claveNueva}
 
Entre al programa con esta clave; de inmediato le va a pedir que escriba una nueva, la que usted quiera.
 
Si usted no pidió este cambio, entre de todas formas con esta clave y cámbiela usted mismo de una vez, para quedar protegido.`
  };
  try{
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify(cuerpo)
    });
    if(!resp.ok){
      const texto = await resp.text().catch(()=> '');
      console.error('⚠️  Brevo respondió con error al enviar el correo de recuperación:', resp.status, texto);
    }
  }catch(e){
    console.error('⚠️  No se pudo enviar el correo de recuperación (Brevo):', e.message);
  }
}
 
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
 
/* ---------- quién es dueño de qué: filtrado por rol ----------
   Un 'contador' (no administrador, no consulta) solo ve y solo puede
   guardar:
     · las empresas que son SUYAS (empresa.contadorId === su id), y
     · las que no son suyas pero tienen una obligación o un vencimiento
       puntual asignado a él (responsableId === su id) — la función ya
       documentada de "otro contador puede quedar a cargo de UNA
       obligación puntual dentro de una empresa que no es la suya".
   El administrador ('jefe') y 'consulta' ven y pueden guardar todo, igual
   que hasta ahora — eso no cambia.
 
   Deliberadamente NO se filtran, para cualquier rol autenticado:
   contadores, calendarios, municipios, impuestos — son catálogos e
   información compartida entre todos (la lista de contadores, el
   calendario tributario, la tabla de municipios, la de impuestos), y
   filtrarlos hoy arriesga romper partes del programa que hoy dependen de
   verlos completos sin que dé tiempo de probarlas todas. Queda anotado
   como una decisión de alcance, no un descuido. */
function empresasDeContador(datos, contadorId){
  const propias = new Set((datos.empresas||[]).filter(e=>e.contadorId===contadorId).map(e=>String(e.id)));
  const referenciadas = new Set();
  (datos.obligaciones||[]).forEach(o=>{ if(o.responsableId===contadorId && o.empresaId!=null) referenciadas.add(String(o.empresaId)); });
  (datos.vencimientos||[]).forEach(v=>{ if(v.responsableId===contadorId && v.empresaId!=null) referenciadas.add(String(v.empresaId)); });
  return { propias, todas: new Set([...propias, ...referenciadas]) };
}
 
function filtrarParaSesion(datos, sesion){
  datos = datos || {};
  if(!sesion || sesion.rol==='jefe' || sesion.rol==='consulta') return datos;
  const { propias, todas } = empresasDeContador(datos, sesion.id);
  const filtrado = Object.assign({}, datos);
  filtrado.empresas = (datos.empresas||[]).filter(e=>todas.has(String(e.id)));
  filtrado.sedes = (datos.sedes||[]).filter(s=>todas.has(String(s.empresaId)));
  filtrado.obligaciones = (datos.obligaciones||[]).filter(o=>propias.has(String(o.empresaId)) || o.responsableId===sesion.id);
  filtrado.vencimientos = (datos.vencimientos||[]).filter(v=>propias.has(String(v.empresaId)) || v.responsableId===sesion.id);
  return filtrado;
}
 
/* Con qué empresas puede "crear cosas nuevas" este contador EN ESTA
   petición puntual: las que ya eran suyas en el servidor, más las que él
   mismo esté creando ahora mismo (empresa nueva + su primera sede, en el
   mismo guardado). Así una empresa+sede nueva se puede crear de una sola
   vez sin que el servidor la rechace por no existir todavía. */
function idsEmpresasPropiasEnPeticion(actualDatos, mioEmpresas, contadorId){
  const propias = new Set((actualDatos.empresas||[]).filter(e=>e.contadorId===contadorId).map(e=>String(e.id)));
  (mioEmpresas||[]).forEach(e=>{ if(e && e.contadorId===contadorId && e.id!=null) propias.add(String(e.id)); });
  return propias;
}
 
/* Dentro de una lista, deja pasar solo los registros que son del contador
   — "esDeSuyo" se evalúa contra el registro que YA HAY en el servidor
   cuando ese registro ya existe (nunca contra lo que el cliente diga de
   un registro ajeno); solo para un registro TOTALMENTE NUEVO se evalúa
   contra lo que el propio cliente envía, porque de otra forma nunca se
   podría crear nada. La usan tanto "mio" (lo que se va a guardar) como
   "base" (lo que el cliente tenía antes) — ver la nota de completar(). */
function filtrarPropios(clave, lista, esDeSuyo, listaActual){
  listaActual = Array.isArray(listaActual) ? listaActual : [];
  const mapaActual = mapaPorClave(clave, listaActual);
  return (Array.isArray(lista)?lista:[]).filter(r=>{
    const id = idDeRegistro(clave, r);
    const actualR = id!=null ? mapaActual.get(id) : null;
    return actualR ? esDeSuyo(actualR) : esDeSuyo(r);
  });
}
 
/* Igual que filtrarPropios, pero además RESTITUYE cualquier registro que ya
   fuera suyo en el servidor pero que su envío no incluyera — así un
   programa modificado no puede simular un "borrado" simplemente omitiendo
   el registro al guardar. Esto es lo que se usa para "mio" (lo que se va a
   guardar); "base" nunca se restituye, solo se filtra (ver más abajo). */
function completar(clave, listaMio, esDeSuyo, listaActual){
  listaActual = Array.isArray(listaActual) ? listaActual : [];
  const propiosEnviados = filtrarPropios(clave, listaMio, esDeSuyo, listaActual);
  const idsEnviados = new Set(propiosEnviados.map(r=>idDeRegistro(clave, r)));
  const reinstalados = listaActual.filter(r=>esDeSuyo(r) && !idsEnviados.has(idDeRegistro(clave, r)));
  return [...propiosEnviados, ...reinstalados];
}
 
/* Punto de entrada: recorta lo que un contador puede guardar. jefe/consulta
   pasan sin tocar, igual que siempre.
 
   OJO — MUY IMPORTANTE — hay que sanear "mio" (lo que se quiere guardar) Y
   TAMBIÉN "base" (lo que el cliente dice que tenía antes de tocar nada).
   Si solo se saneara "mio", un "base" viejo o sin filtrar — por ejemplo el
   que quedó guardado en el navegador de un contador desde ANTES de este
   cambio de seguridad, cuando todavía veía los datos de todos sin filtrar
   — haría que combinarLista/combinarBloque pensaran "este cliente tenía
   este registro ajeno y ya no lo mandó: lo borró" y lo eliminaran de
   verdad del servidor, aunque nadie más lo hubiera tocado. Saneando los
   dos lados por igual (con las mismas reglas de "esDeSuyo"), un registro
   que no es del contador nunca aparece en ninguno de los dos — así el
   servidor lo trata siempre como "nadie lo tocó aquí" y lo conserva tal
   cual estuviera. Lo mismo aplica a los tipos compartidos (contadores,
   calendarios, municipios, impuestos, meta): ahí, en vez de filtrar
   registro por registro, se igualan los dos lados a "actualDatos", que
   logra exactamente lo mismo (nunca puede haber diferencia = nunca hay
   "yo lo cambié" = el servidor conserva lo que ya había). */
function restringirEscritura(mio, base, actualDatos, sesion){
  mio = mio || {}; base = base || {}; actualDatos = actualDatos || {};
  if(!sesion || sesion.rol==='jefe' || sesion.rol==='consulta') return { mio, base };
 
  const mioSalida = Object.assign({}, mio);
  const baseSalida = Object.assign({}, base);
  ['contadores','calendarios','municipios','impuestos','meta'].forEach(clave=>{
    mioSalida[clave] = actualDatos[clave];
    baseSalida[clave] = actualDatos[clave];
  });
 
  const idsProp = idsEmpresasPropiasEnPeticion(actualDatos, mio.empresas, sesion.id);
  const esDeSuyoEmpresa = r => !!r && r.contadorId===sesion.id;
  const esDeSuyoSede     = r => !!r && idsProp.has(String(r.empresaId));
  const esDeSuyoOblVenc  = r => !!r && (idsProp.has(String(r.empresaId)) || r.responsableId===sesion.id);
 
  mioSalida.empresas  = completar('empresas', mio.empresas, esDeSuyoEmpresa, actualDatos.empresas);
  baseSalida.empresas = filtrarPropios('empresas', base.empresas, esDeSuyoEmpresa, actualDatos.empresas);
 
  mioSalida.sedes  = completar('sedes', mio.sedes, esDeSuyoSede, actualDatos.sedes);
  baseSalida.sedes = filtrarPropios('sedes', base.sedes, esDeSuyoSede, actualDatos.sedes);
 
  mioSalida.obligaciones  = completar('obligaciones', mio.obligaciones, esDeSuyoOblVenc, actualDatos.obligaciones);
  baseSalida.obligaciones = filtrarPropios('obligaciones', base.obligaciones, esDeSuyoOblVenc, actualDatos.obligaciones);
 
  mioSalida.vencimientos  = completar('vencimientos', mio.vencimientos, esDeSuyoOblVenc, actualDatos.vencimientos);
  baseSalida.vencimientos = filtrarPropios('vencimientos', base.vencimientos, esDeSuyoOblVenc, actualDatos.vencimientos);
 
  return { mio: mioSalida, base: baseSalida };
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
 
/* ---------- el ingreso: verificación de la clave, del lado del servidor ----------
   Replica, EXACTAMENTE, la lógica que antes vivía solo en el navegador de
   cada quien (verificarClave() en el .html) — con la diferencia de que
   ahora es el servidor quien decide, así que un programa modificado ya no
   puede saltársela. Todo el intento (leer, decidir, y anotar el resultado)
   pasa en UNA sola transacción de Firestore, para que dos intentos de
   ingreso al mismo tiempo (o un intento de ingreso justo cuando el
   administrador desbloquea a alguien desde otra parte) nunca se pisen. */
async function intentarEntrar(id, clave){
  const estado = await leerEstado();
  const contadores = (estado.datos && estado.datos.contadores) || [];
  const c = contadores.find(x=>x.id===id);
  if(!c) return { ok:false, msg:'Usuario no encontrado.' };
  if(c.activo===false) return { ok:false, msg:'Ese usuario está inactivo.' };
  const esJefeSolo = c.rol==='jefe';
 
  return await db.runTransaction(async (tx)=>{
    const snap = await tx.get(DOC_SEG);
    const actual = segDesdeTexto(snap.exists ? (snap.data().contenido||'') : '');
    const mapa = new Map(actual.usuarios.map(x=>[x.id, x]));
    let u = mapa.get(id);
    const bitacoraNueva = [];
    let resultado;
 
    if(!u){
      // usuario sin credencial: primera vez — solo el administrador arranca solo, con clave temporal 1234
      if(esJefeSolo && !actual.usuarios.length && clave==='1234'){
        const sal = salNueva();
        u = { id, sal, iter: ITER_CLAVE, hash: derivarClave('1234', sal, ITER_CLAVE),
              debeCambiar:true, cambiada: hoy(), intentos:0, bloqueado:false, esperaHasta:0 };
        mapa.set(id, u);
        bitacoraNueva.push({ t:new Date().toISOString(), u:c.id, n:c.nombre, s:'', a:'CLAVE TEMPORAL', d:'clave inicial de administrador (1234)' });
        resultado = { ok:true, id:c.id, nombre:c.nombre, rol:c.rol, debeCambiar:true };
      } else {
        resultado = { ok:false, msg:'Ese usuario no tiene clave. Pídale al administrador que se la asigne.' };
      }
    } else {
      u = Object.assign({}, u);   // nunca mutar el objeto que vino del mapa sin decidir antes si aplica
      /* Al contador se le bloquea la cuenta y lo desbloquea el administrador.
         Al ADMINISTRADOR nunca se le bloquea: es quien abre las de los demás, y si
         queda por fuera no hay quién lo saque. En su lugar, una espera que se
         levanta sola. */
      if(esJefeSolo && u.bloqueado){
        u.bloqueado=false; u.intentos=0;
        bitacoraNueva.push({ t:new Date().toISOString(), u:c.id, n:c.nombre, s:'', a:'BLOQUEO RETIRADO', d:'el administrador no se bloquea' });
      }
      if(u.esperaHasta && Date.now()<u.esperaHasta){
        const m=Math.ceil((u.esperaHasta-Date.now())/60000);
        resultado = { ok:false, msg:'Demasiados intentos fallidos. Vuelva a intentar en '+m+(m===1?' minuto.':' minutos.') };
      } else if(u.bloqueado){
        resultado = { ok:false, msg:'Usuario bloqueado por intentos fallidos. Solo el administrador puede desbloquearlo.' };
      } else {
        const h = derivarClave(clave, u.sal, u.iter);
        if(h !== u.hash){
          u.intentos = (u.intentos||0)+1;
          if(u.intentos>=5){
            if(esJefeSolo){ u.esperaHasta=Date.now()+5*60000; u.intentos=0; bitacoraNueva.push({t:new Date().toISOString(),u:c.id,n:c.nombre,s:'',a:'ESPERA',d:'5 intentos fallidos del administrador'}); }
            else { u.bloqueado=true; bitacoraNueva.push({t:new Date().toISOString(),u:c.id,n:c.nombre,s:'',a:'BLOQUEO',d:'5 intentos fallidos'}); }
          }
          resultado = { ok:false, msg: u.bloqueado ? 'Usuario bloqueado tras 5 intentos fallidos. Avísele al administrador.'
            : (u.esperaHasta && Date.now()<u.esperaHasta) ? 'Cinco intentos fallidos. Espere 5 minutos antes de volver a intentar.'
            : 'La clave no coincide. Intento '+u.intentos+' de 5.' };
        } else {
          u.intentos=0; u.esperaHasta=0;
          bitacoraNueva.push({ t:new Date().toISOString(), u:c.id, n:c.nombre, s:'', a:'INGRESO', d:'' });
          resultado = { ok:true, id:c.id, nombre:c.nombre, rol:c.rol, debeCambiar: !!u.debeCambiar };
        }
      }
      mapa.set(id, u);
    }
 
    const bitacora = combinarBitacora(bitacoraNueva, actual.bitacora);
    tx.set(DOC_SEG, { contenido: segTextoDesde(Array.from(mapa.values()), bitacora) });
    return resultado;
  });
}
 
/* Guarda UN solo registro de usuarios.seg (upsert por id) más bitácora
   nueva, en una sola transacción — el mismo patrón seguro que ya usa
   intentarEntrar e /api/recuperar: lee fresco, toca solo ese registro,
   escribe. La usa el auto-servicio de /api/seg para un contador (solo
   puede tocar su propio registro; ver más abajo). */
async function guardarUnUsuario(usuarioTocado, bitacoraNueva){
  return await db.runTransaction(async (tx)=>{
    const snap = await tx.get(DOC_SEG);
    const actual = segDesdeTexto(snap.exists ? (snap.data().contenido||'') : '');
    const mapa = new Map(actual.usuarios.map(x=>[x.id, x]));
    mapa.set(usuarioTocado.id, usuarioTocado);
    const bitacora = combinarBitacora(bitacoraNueva||[], actual.bitacora);
    const texto = segTextoDesde(Array.from(mapa.values()), bitacora);
    tx.set(DOC_SEG, { contenido: texto });
    return texto;
  });
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(txt);
}
 
const servidor = http.createServer(async (req, res) => {
  try{
    if(req.method === 'OPTIONS'){
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      return res.end();
    }
 
    /* La aplicación misma, servida desde aquí — reemplaza el .html suelto. */
    if(req.url === '/' && req.method === 'GET'){
      if(HTML_APP){
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(HTML_APP);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end('Servidor de Control de Vencimientos — activo, pero falta el archivo app.html junto a servidor.js.\nRevise /salud para el estado del servidor.');
    }
 
    /* Estado del servidor (antes vivía en "/"). */
    if(req.url === '/salud' && req.method === 'GET'){
      const estado = await leerEstado();
      const n = (estado.datos && estado.datos.empresas) ? estado.datos.empresas.length : 0;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end('Servidor de Control de Vencimientos (en la nube) — activo.\n'+n+' empresa(s) guardadas.');
    }
 
    /* Lista de usuarios activos, sin ningún otro dato — es la ÚNICA
       información de negocio visible sin haber iniciado sesión, y solo
       hace falta para poder mostrar el desplegable de la pantalla de
       ingreso antes de entrar. */
    if(req.url === '/api/quienes' && req.method === 'GET'){
      const estado = await leerEstado();
      const contadores = ((estado.datos && estado.datos.contadores) || [])
        .filter(c => c.activo !== false)
        .map(c => ({ id: c.id, nombre: c.nombre }));
      return responderJSON(res, 200, { contadores });
    }
 
    /* Ingreso: aquí, y no en el navegador de cada quien, se decide si la
       clave es correcta. Responde siempre 200 (ok:true/false) — el "no
       encontrado"/"clave incorrecta" van en el cuerpo, no en el código de
       estado, para que el programa los muestre igual que siempre. */
    if(req.url === '/api/entrar' && req.method === 'POST'){
      const cuerpo = await leerCuerpo(req);
      let entrada;
      try{ entrada = JSON.parse(cuerpo); }catch(e){ return responderJSON(res, 400, { error: 'JSON inválido' }); }
      const id = entrada.id, clave = entrada.clave;
      if(!id || typeof clave !== 'string') return responderJSON(res, 400, { error: 'faltan datos' });
      let r;
      try{ r = await intentarEntrar(id, clave); }
      catch(e){ console.error('⚠️  Error en /api/entrar:', e.message); return responderJSON(res, 500, { error: 'no se pudo verificar' }); }
      if(!r.ok) return responderJSON(res, 200, { ok:false, msg:r.msg });
      const token = crearSesion(r.id, r.nombre, r.rol);
      return responderJSON(res, 200, { ok:true, token, id:r.id, nombre:r.nombre, rol:r.rol, debeCambiar: !!r.debeCambiar });
    }
 
    /* Cerrar sesión: el programa la llama al oprimir «Salir», para que el
       servidor olvide esa llave de una vez, en vez de esperar a que venza
       sola (hasta 24 horas). No hace falta que la llave sea válida para
       pedir esto — si ya venció o no existe, no hay nada que hacer, y
       responde igual de bien. */
    if(req.url === '/api/salir' && req.method === 'POST'){
      const token = tokenDe(req);
      if(token) SESIONES.delete(token);
      return responderJSON(res, 200, { ok: true });
    }
 
    if(req.url === '/api/estado' && req.method === 'GET'){
      const sesion = sesionDe(tokenDe(req));
      if(!sesion) return responderJSON(res, 401, { error: 'sesión inválida o vencida' });
      const estado = await leerEstado();
      const datos = filtrarParaSesion(estado.datos || {}, sesion);
      return responderJSON(res, 200, Object.assign({}, estado, { datos }));
    }
 
    if(req.url === '/api/estado' && req.method === 'POST'){
      const sesion = sesionDe(tokenDe(req));
      if(!sesion) return responderJSON(res, 401, { error: 'sesión inválida o vencida' });
      const cuerpo = await leerCuerpo(req);
      let entrada;
      try{ entrada = JSON.parse(cuerpo); }catch(e){ return responderJSON(res, 400, { error: 'JSON inválido' }); }
 
      let resultado;
      try{
        resultado = await db.runTransaction(async (tx) => {
          const snap = await tx.get(DOC_ESTADO);
          const actual = snap.exists ? snap.data() : null;
          const actualDatos = actual ? (actual.datos || {}) : {};
          const { mio: mioRestringido, base: baseRestringido } = restringirEscritura(entrada.datos, entrada.base, actualDatos, sesion);
          const { datos: combinados, conflictos } = combinarDatos(baseRestringido, mioRestringido, actualDatos);
          const nuevo = { sello: selloNuevo(), datos: combinados, equipo: entrada.equipo || '' };
          tx.set(DOC_ESTADO, nuevo);
          return { ok: true, sello: nuevo.sello, _datos: nuevo.datos, _equipo: nuevo.equipo, conflictos };
        });
      }catch(e){
        console.error('⚠️  Error guardando en Firestore:', e.message);
        return responderJSON(res, 500, { error: 'no se pudo guardar' });
      }
 
      respaldoDelDiaSiHaceFalta(resultado._datos, resultado._equipo);  // de fondo, no bloquea la respuesta
      const datosParaCliente = filtrarParaSesion(resultado._datos, sesion);
      return responderJSON(res, 200, { ok: true, sello: resultado.sello, datos: datosParaCliente, conflictos: resultado.conflictos });
    }
 
    /* Las credenciales viajan aparte de los datos (usuarios.seg), igual que
       antes: así un dato nunca lleva las claves pegadas. Ahora, además,
       hace falta sesión — y un contador (no administrador, no consulta)
       nunca puede leer el archivo completo: la pantalla de Contadores, que
       es la única que lo necesita, ya está oculta para ese rol en el
       programa; el servidor ahora lo obliga también. */
    if(req.url === '/api/seg' && req.method === 'GET'){
      const sesion = sesionDe(tokenDe(req));
      if(!sesion){ res.writeHead(401, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
      if(sesion.rol === 'contador'){ res.writeHead(403, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
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
    /* OJO — CAMBIO IMPORTANTE (sept/2026): antes esto era un "el que guarda
       de último, gana": cualquier equipo que mandara CUALQUIER cambio
       (literalmente cualquier «guardar», porque anotar() llama a
       guardarSeg() casi en cada acción del programa) reemplazaba TODO el
       archivo de credenciales con la copia que tuviera en memoria en ESE
       momento — y esa copia se carga solo al entrar, nunca se refresca
       mientras alguien sigue trabajando. Con varios contadores conectados
       a la vez, el equipo con la copia más vieja terminaba pisando, tarde o
       temprano, cualquier cambio que otro hubiera hecho mientras tanto:
       desbloquear a alguien, generarle una clave temporal, lo que fuera.
       Eso era exactamente el bug que reportó el usuario con la cuenta de
       María Estefani: el administrador la desbloqueaba, y minutos después
       cualquier otro contador con una sesión más vieja abierta hacía
       cualquier guardado normal y sin querer la volvía a bloquear.
       Ahora se combina registro por registro, igual que /api/estado: cada
       usuario se identifica por su «id», y la bitácora se junta sin perder
       renglones de ningún lado (ver combinarBitacora arriba).
 
       CAMBIO ADICIONAL (sept/2026): además de la sesión, un CONTADOR aquí
       solo puede tocar SU PROPIO registro (para cambiar su propia clave) y
       anotar en la bitácora renglones de SUS propias acciones — nunca los
       de otro usuario. jefe/consulta siguen con el guardado de siempre. */
    if(req.url === '/api/seg' && req.method === 'POST'){
      const sesion = sesionDe(tokenDe(req));
      if(!sesion) return responderJSON(res, 401, { error: 'sesión inválida o vencida' });
 
      const cuerpo = await leerCuerpo(req);
      let entrada;
      try{ entrada = JSON.parse(cuerpo); }
      catch(e){
        console.error('⚠️  /api/seg recibió texto plano (copia del programa sin actualizar): se rechazó por seguridad.');
        return responderJSON(res, 400, { error: 'formato no admitido' });
      }
 
      if(sesion.rol === 'contador'){
        const mio = entrada.mio || { usuarios: [], bitacora: [] };
        const propio = (mio.usuarios||[]).find(u=>u && u.id===sesion.id);
        const bitacoraPropia = (mio.bitacora||[]).filter(e=>e && e.u===sesion.id);
        try{
          let texto;
          if(propio){
            texto = await guardarUnUsuario(Object.assign({}, propio, { id: sesion.id }), bitacoraPropia);
          } else if(bitacoraPropia.length){
            texto = await db.runTransaction(async (tx)=>{
              const snap = await tx.get(DOC_SEG);
              const actual = segDesdeTexto(snap.exists ? (snap.data().contenido||'') : '');
              const bitacora = combinarBitacora(bitacoraPropia, actual.bitacora);
              const t = segTextoDesde(actual.usuarios, bitacora);
              tx.set(DOC_SEG, { contenido: t });
              return t;
            });
          } else {
            const snap = await DOC_SEG.get();
            texto = snap.exists ? (snap.data().contenido||'') : segTextoDesde([], []);
          }
          return responderJSON(res, 200, { ok: true, texto });
        }catch(e){
          console.error('⚠️  No se pudo guardar usuarios.seg (contador):', e.message);
          return responderJSON(res, 500, { error: 'no se pudo guardar' });
        }
      }
 
      try{
        const resultado = await db.runTransaction(async (tx) => {
          const snap = await tx.get(DOC_SEG);
          const actual = segDesdeTexto(snap.exists ? (snap.data().contenido||'') : '');
          const base = entrada.base || { usuarios: [], bitacora: [] };
          const mio  = entrada.mio  || { usuarios: [], bitacora: [] };
          const { lista: usuarios, conflictos } = combinarLista('usuariosSeg', base.usuarios, mio.usuarios, actual.usuarios);
          const bitacora = combinarBitacora(mio.bitacora, actual.bitacora);
          const texto = segTextoDesde(usuarios, bitacora);
          tx.set(DOC_SEG, { contenido: texto });
          return { texto, conflictos };
        });
        return responderJSON(res, 200, { ok: true, texto: resultado.texto, conflictos: resultado.conflictos });
      }catch(e){
        console.error('⚠️  No se pudo guardar usuarios.seg:', e.message);
        return responderJSON(res, 500, { error: 'no se pudo guardar' });
      }
    }
 
    /* Recuperar el acceso del administrador cuando olvidó su clave y no
       tiene otro administrador ni una sesión abierta en otra parte. Es la
       ÚNICA dirección de este servidor a la que se puede llegar sin haber
       iniciado sesión en el programa — por eso nunca dice si el correo
       coincidió o no, ni si hubo algún error puntual: siempre responde lo
       mismo, para no darle pistas a un curioso sobre quién está registrado. */
    if(req.url === '/api/recuperar' && req.method === 'POST'){
      const cuerpo = await leerCuerpo(req);
      let entrada;
      try{ entrada = JSON.parse(cuerpo); }catch(e){ return responderJSON(res, 400, { error: 'JSON inválido' }); }
      const RESPUESTA = { ok: true, mensaje: 'Si el correo coincide con un administrador registrado, en unos minutos le llega un mensaje con una clave temporal.' };
      const correo = (entrada.correo||'').trim().toLowerCase();
      if(!correo || !puedeEnviarCorreo()) return responderJSON(res, 200, RESPUESTA);
 
      const ahora = Date.now();
      const antes = ultimaRecuperacion.get(correo);
      if(antes && (ahora-antes) < ESPERA_RECUPERAR) return responderJSON(res, 200, RESPUESTA);
 
      try{
        const estado = await leerEstado();
        const contadores = (estado.datos && estado.datos.contadores) || [];
        const jefe = contadores.find(c => c.rol==='jefe' && c.activo!==false && (c.correo||'').trim().toLowerCase()===correo);
        if(!jefe) return responderJSON(res, 200, RESPUESTA);
 
        ultimaRecuperacion.set(correo, ahora);
 
        /* En una transacción, igual que /api/seg ahora: lee, modifica solo el
           renglón del administrador, y escribe — así no pisa, por una
           coincidencia de tiempos, un guardado normal que algún equipo
           conectado esté haciendo en el mismo instante. */
        const claveNueva = claveTemporal();
        const sal = salNueva();
        await db.runTransaction(async (tx) => {
          const snapSeg = await tx.get(DOC_SEG);
          const { usuarios, bitacora } = segDesdeTexto(snapSeg.exists ? (snapSeg.data().contenido||'') : '');
          let u = usuarios.find(x=>x.id===jefe.id);
          if(!u){ u = { id: jefe.id }; usuarios.push(u); }
          u.sal=sal; u.iter=ITER_CLAVE; u.hash=derivarClave(claveNueva, sal, ITER_CLAVE);
          u.debeCambiar=true; u.cambiada=hoy(); u.intentos=0; u.bloqueado=false; u.esperaHasta=0;
          bitacora.push({ t: new Date().toISOString(), u: jefe.id, n: jefe.nombre, s:'', a:'CLAVE TEMPORAL', d:'generada por recuperación de contraseña (correo)' });
          tx.set(DOC_SEG, { contenido: segTextoDesde(usuarios, bitacora) });
        });
        await enviarClaveTemporalPorCorreo(jefe.nombre, jefe.correo, claveNueva);
      }catch(e){
        console.error('⚠️  Error en /api/recuperar:', e.message);
      }
      return responderJSON(res, 200, RESPUESTA);
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
 
/* Cuando este archivo se ejecuta directamente (node servidor.js, o lo que
   haga Render) sí se enciende el servidor de verdad. Cuando en cambio se
   hace require('./servidor.js') desde un script de pruebas, NO se abre
   ningún puerto — así las pruebas pueden usar las funciones puras de este
   archivo (filtrarParaSesion, restringirEscritura, intentarEntrar, etc.)
   sin levantar un servidor real ni depender de una conexión de verdad a
   Firebase. */
if(require.main === module){
  arrancarVigiaSesiones();
  servidor.listen(PUERTO, () => {
    console.log('========================================================');
    console.log(' Servidor de Control de Vencimientos (en la nube) — encendido');
    console.log(' Puerto: ' + PUERTO);
    console.log(' Los datos se guardan en Firebase (Firestore), no en el disco de este servicio.');
    console.log(' Guardado por registro: contadores en empresas distintas ya no chocan entre sí.');
    console.log(' La aplicación se sirve desde aquí (GET /) y el ingreso lo verifica el servidor.');
    console.log('========================================================');
  });
}
 
module.exports = {
  servidor, db,
  SESIONES, DURACION_SESION, nuevoToken, crearSesion, sesionDe, tokenDe,
  ITER_CLAVE, salNueva, derivarClave, sumaControl, segTextoDesde, segDesdeTexto,
  claveBitacora, combinarBitacora,
  idDeRegistro, mapaPorClave, igual, combinarLista, combinarBloque, combinarDatos,
  empresasDeContador, filtrarParaSesion, idsEmpresasPropiasEnPeticion, filtrarPropios, completar, restringirEscritura,
  intentarEntrar, guardarUnUsuario,
  leerEstado, gentaActiva
};
 
