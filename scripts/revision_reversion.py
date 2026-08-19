# -*- coding: utf-8 -*-
"""
Revision del efecto de los cambios en Reversion a la Media (2026-08-19).

POR QUE EXISTE. El 19-ago se tocaron dos puertas de smaReversion:
  extBandMinPct        0.13 -> 0.10
  requiereGammaPositivo true -> false   (el gamma vuelve a pesar 10/100, no veta)

Los cambios se aplicaron DESPUES de las 13:00 ET, o sea despues de que cerrara la
ventana de la estrategia (9:45am-1pm ET), asi que ese dia no llegaron a probarse:
las 192 evaluaciones del 19-ago corrieron con la configuracion vieja.

Este script compara el dia pedido contra esa linea base y dice si los cambios
sirvieron. Corre despues de la 1pm ET, cuando la ventana ya cerro y el conteo del
dia esta completo.

Uso:
  python revision_reversion.py            -> hoy
  python revision_reversion.py 2026-08-20 -> un dia concreto
  python revision_reversion.py --sin-ntfy -> no manda notificacion
"""
import io, json, sys, re, urllib.request, datetime, zoneinfo

BASE = 'https://web-production-23473.up.railway.app'
NTFY = 'https://ntfy.sh/bitacora_gcarvaja51'

# Linea base medida el 19-ago con la config VIEJA (banda 0.13, gamma como puerta).
BASE_DIA   = {'total': 192, 'SIN_ALEJAMIENTO': 165, 'GAMMA_NO_POSITIVO': 14,
              'SCORE_FAIL': 13, 'SIGNAL_BUILT': 0}
# Historico 7-19 ago, 12 dias de mercado: 1720 evaluaciones -> 2 señales.
BASE_HIST  = {'dias': 12, 'total': 1720, 'sin_alej_pct': 77.2, 'señales': 2}


LOG = __file__.replace('.py', '.log')


def emitir(txt):
    """Imprime y ademas deja registro en disco.

    Se escribe aca y no con un redirect del shell porque el wrapper .vbs con
    `cmd /c ... >> log 2>&1` se colgaba sin dejar NI UNA linea, por las comillas
    anidadas (medido el 2026-08-19: la tarea quedaba en estado Running para
    siempre). Ahora el .vbs solo llama a python y el log es responsabilidad del
    script, que es donde se puede garantizar.
    """
    print(txt)
    try:
        with io.open(LOG, 'a', encoding='utf-8') as f:
            f.write('\n' + '=' * 70 + '\n')
            f.write(datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S') + '\n')
            f.write(txt + '\n')
    except Exception as e:
        print(f'(no se pudo escribir el log: {e})')


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.load(r)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    manda_ntfy = '--sin-ntfy' not in sys.argv
    et = datetime.datetime.now(datetime.timezone.utc).astimezone(zoneinfo.ZoneInfo('America/New_York'))
    dia = args[0] if args else et.strftime('%Y-%m-%d')

    res = get(f'/api/spx/strategy-log?date={dia}&family=REVERSION&resumen=true')
    etapas = res.get('porEtapa') or {}
    total  = res.get('total') or 0

    # La config real de ese momento, para que el informe no mienta si alguien la movio.
    cfg = get('/api/spx/config')
    cfg = cfg.get('config', cfg)
    rev = cfg['trading']['smaReversion']

    L = []
    L.append(f'REVERSION — revision del {dia}')
    L.append('')
    L.append(f"config vigente: banda {rev.get('extBandMinPct')}-{rev.get('extBandMaxPct')}% | "
             f"gamma como puerta: {rev.get('requiereGammaPositivo')} | minScore {rev.get('minScore')}")
    L.append('')

    if total == 0:
        L.append('SIN EVALUACIONES ese dia. O el mercado estuvo cerrado, o la estrategia')
        L.append('no corrio — revisar el daemon y los interruptores antes de sacar conclusiones.')
        salida = '\n'.join(L)
        emitir(salida)
        if manda_ntfy: avisar('Reversion: SIN evaluaciones', salida, 'high')
        return

    señales = etapas.get('SIGNAL_BUILT', 0)
    sin_alej = etapas.get('SIN_ALEJAMIENTO', 0)
    pct_alej = 100.0 * sin_alej / total

    L.append(f'{total} evaluaciones (linea base 19-ago: {BASE_DIA["total"]})')
    L.append('')
    L.append(f"{'etapa':<24}{'hoy':>7}{'19-ago':>9}{'cambio':>9}")
    for k in sorted(set(list(etapas) + list(BASE_DIA)) - {'total'},
                    key=lambda x: -etapas.get(x, 0)):
        hoy = etapas.get(k, 0); ant = BASE_DIA.get(k, 0)
        L.append(f'{k:<24}{hoy:>7}{ant:>9}{hoy-ant:>+9}')

    L.append('')
    L.append(f'SIN_ALEJAMIENTO: {pct_alej:.1f}% del total (19-ago: 85.9%)')
    L.append(f'SEÑALES GENERADAS: {señales}   (19-ago: 0 | historico: {BASE_HIST["señales"]} en {BASE_HIST["dias"]} dias)')
    L.append('')

    # Veredicto. Los umbrales salen de lo medido: con banda 0.10 sobre la muestra
    # historica pasaban 83 de 1329 (6.2%), o sea ~7 evaluaciones al dia deberian
    # superar el alejamiento. Si el porcentaje no se movio, la banda sigue corta.
    if señales > 0:
        L.append(f'VEREDICTO: los cambios FUNCIONARON — {señales} señal(es) donde antes habia 0.')
        L.append('Siguiente pregunta: cuantas se convirtieron en trade y como cerraron.')
        prio = 'default'
    elif pct_alej < 78:
        L.append('VEREDICTO: la banda SI abrio (menos rechazos por alejamiento) pero no hubo señal.')
        L.append('El cuello de botella se movio: mirar SCORE_FAIL — minScore 75 con un factor')
        L.append('que vale 45 hace que fallar el alejamiento sea casi imposible de compensar.')
        prio = 'default'
    else:
        L.append('VEREDICTO: la banda de 0.10% TAMPOCO alcanza — el rechazo por alejamiento')
        L.append('no bajo. El arreglo de fondo es expresar la banda en ATR y no en % fijo:')
        L.append('con el VIX en 15 el SPX no se despega de su SMA8 lo que la puerta exige.')
        prio = 'high'

    salida = '\n'.join(L)
    emitir(salida)
    if manda_ntfy:
        avisar(f'Reversion {dia}: {señales} señal(es)', salida, prio)


def avisar(titulo, cuerpo, prioridad='default'):
    try:
        req = urllib.request.Request(NTFY, data=cuerpo.encode('utf-8'), method='POST',
                                     headers={'Title': titulo, 'Priority': prioridad,
                                              'Tags': 'chart_with_upwards_trend'})
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as e:
        print(f'(ntfy fallo: {e})')


if __name__ == '__main__':
    main()
