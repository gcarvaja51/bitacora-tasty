import json, ssl, urllib.request, pandas as pd
from zoneinfo import ZoneInfo
ET=ZoneInfo('America/New_York'); ctx=ssl._create_unverified_context()
def get(sym,iv,rg):
    u=f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={iv}&range={rg}&includePrePost=false'
    r=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),context=ctx,timeout=60))
    q=r['chart']['result'][0]; c=q['indicators']['quote'][0]
    df=pd.DataFrame({k:c[k] for k in ('open','high','low','close')},index=pd.to_datetime(q['timestamp'],unit='s',utc=True).tz_convert(ET)).dropna()
    return df,q['meta']
pd.set_option('display.width',200)
s15,m=get('%5EGSPC','15m','5d'); d,md=get('%5EGSPC','1d','1y'); s30,_=get('%5EGSPC','30m','60d')
v15,mv=get('%5EVIX','15m','2d'); es,me=get('ES%3DF','15m','5d')
hoy=s15[s15.index.date==pd.Timestamp('2026-09-28').date()]
print(hoy.round(2).to_string())
print('meta close', md['regularMarketPrice'], md.get('chartPreviousClose'), m['regularMarketPrice'])
print(d.tail(4).round(2))
vh=v15[v15.index.date==pd.Timestamp('2026-09-28').date()]
print('VIX', vh.open.iloc[0], vh.close.iloc[-1], vh.high.max(), mv['regularMarketPrice'])
# daily EMAs: replace today's with reconstruction
dd=d.close.copy(); dd.index=dd.index.date
dd[pd.Timestamp('2026-09-28').date()]=md['regularMarketPrice']
for n in (10,20,50,200): print('EMA d',n, round(dd.ewm(span=n,adjust=False).mean().iloc[-1],2))
c30=s30.close
for n in (10,20,50,200): print('EMA 30m',n, round(c30.ewm(span=n,adjust=False).mean().iloc[-1],2))
print(s30.tail(3).round(2))
s60,_=get('%5EGSPC','15m','60d'); c15=s60.close
e10=c15.ewm(span=10,adjust=False).mean(); e20=c15.ewm(span=20,adjust=False).mean()
x=pd.DataFrame({'c':c15,'e10':e10,'e20':e20,'dif':e10-e20}).round(2)
print(x.tail(30).to_string())
# ES base
esr=es.close; j=pd.concat([esr,hoy.close],axis=1,join='inner'); j.columns=['es','spx']
print('base', round((j.es-j.spx).median(),2), len(j), round((j.es-j.spx).min(),2), round((j.es-j.spx).max(),2))
print(es.tail(4).round(2)); print('ES meta', me['regularMarketPrice'])
print('----')
s60=s60[s60.index.time!=pd.Timestamp('16:00').time()]; c15=s60.close
e10=c15.ewm(span=10,adjust=False).mean(); e20=c15.ewm(span=20,adjust=False).mean(); dif=e10-e20
sg=(dif>0); ch=sg[sg!=sg.shift()]; print(ch.tail(5))
print('last', round(e10.iloc[-1],2), round(e20.iloc[-1],2), 'maxdif today', round(dif[dif.index.date==pd.Timestamp('2026-09-28').date()].max(),2))
s30=s30[s30.index.time!=pd.Timestamp('16:00').time()]; c30=s30.close
for n in (10,20,50,200): print('EMA 30m',n, round(c30.ewm(span=n,adjust=False).mean().iloc[-1],2))
e=c30.ewm(span=10,adjust=False).mean()-c30.ewm(span=20,adjust=False).mean(); sg=e>0; print(sg[sg!=sg.shift()].tail(3))
print(d.tail(8).round(0))

