// Puerta de escritura (2026-11-16): toda acción que ESCRIBE en la Bitácora lleva la clave en la cabecera
// x-bitacora-token. La clave se pide UNA vez por dispositivo (solo cuando el servidor la exige) y se recuerda.
(function () {
  var LLAVE = 'bitacora_token';
  var leer = function () { try { return localStorage.getItem(LLAVE) || ''; } catch (e) { return ''; } };
  var poner = function (v) { try { if (v) localStorage.setItem(LLAVE, v); else localStorage.removeItem(LLAVE); } catch (e) { /* modo privado */ } };
  var original = window.fetch.bind(window);
  var escribe = function (m) { m = String(m || 'GET').toUpperCase(); return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS'; };
  var propia = function (u) { try { return new URL(u, location.href).origin === location.origin; } catch (e) { return false; } };
  var conClave = function (init, clave) {
    var h = new Headers((init && init.headers) || {});
    if (clave) h.set('x-bitacora-token', clave);
    return Object.assign({}, init || {}, { headers: h });
  };
  var pidiendo = null;
  window.fetch = function (entrada, init) {
    var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';
    var metodo = (init && init.method) || (entrada && entrada.method) || 'GET';
    if (typeof entrada !== 'string' || !escribe(metodo) || !propia(url)) return original(entrada, init);
    return original(entrada, conClave(init, leer())).then(function (r) {
      if (r.status !== 401) return r;
      return r.clone().json().catch(function () { return {}; }).then(function (j) {
        if (!j || !j.puerta) return r;
        if (!pidiendo) {
          pidiendo = Promise.resolve(window.prompt('Esta acción pide la clave de la Bitácora.\nSe guarda en este dispositivo y no se vuelve a pedir.'));
          pidiendo.then(function () { pidiendo = null; });
        }
        return pidiendo.then(function (clave) {
          clave = (clave || '').trim();
          if (!clave) return r;
          poner(clave);
          return original(entrada, conClave(init, clave)).then(function (r2) { if (r2.status === 401) poner(''); return r2; });
        });
      });
    });
  };
})();
