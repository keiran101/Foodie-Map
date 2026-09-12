import json, urllib.request, urllib.parse, urllib.error

BASE = 'http://localhost:3000'

def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    data = json.dumps(body).encode('utf-8') if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf-8'))

s, r = call('POST', '/api/auth/login', {'email': 'demo@foodie.test', 'password': '123456'})
print('1 login:', s, r.get('user'))
token = r.get('accessToken', '')

s, r = call('GET', '/api/auth/me', token=token)
print('2 me:', s, r.get('user', {}).get('nickname'))

s, r = call('GET', '/api/geo/search?keyword=' + urllib.parse.quote('火锅') + '&city=' + urllib.parse.quote('成都'))
print('3 geo search:', s, 'candidates=', len(r.get('pois', [])))

s, r = call('POST', '/api/maps', {'title': '周末成都火锅巡礼', 'city': '成都', 'description': '跟着达人探店'}, token)
mid = r.get('map', {}).get('id', '')
print('4 create map:', s, 'mapId=', mid)

s, r = call('GET', '/api/maps')
print('5 list maps:', s, 'count=', len(r.get('maps', [])))

s, r = call('POST', '/api/maps/' + mid + '/places', {'name': '蜀大侠火锅（春熙路店）', 'address': '成都市锦江区春熙路', 'lng': 104.075, 'lat': 30.657, 'category': '火锅', 'avgPrice': 120}, token)
pid = r.get('place', {}).get('id', '')
print('6 add place:', s, 'placeId=', pid)

s, r = call('GET', '/api/places/' + pid + '/nav-links')
links = r.get('links', {})
print('7 nav-links:', s, 'providers=', list(links.keys()))
if links:
    print('   amap sample:', links['amap']['url'][:90])
