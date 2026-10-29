#!/usr/bin/env python
"""Agent 接入冒烟：先探针，再真跑一条建合集任务。

对应 docs/DEPLOY.md §2 第 4 步。**顺序不能反** —— 排查时最先要区分的是
「穿透/凭据不通」还是「任务跑挂了」，混在一起会一上来就跑十分钟的任务。

用法：
    python scripts/smoke-agent.py                     # 复用 CLI 登录态
    python scripts/smoke-agent.py --skip-build        # 只探针
    FOODMAP_EMAIL=x@y.com FOODMAP_PASSWORD=pw python scripts/smoke-agent.py
    FOODMAP_TOKEN=<accessToken> python scripts/smoke-agent.py
    BASE=http://127.0.0.1:3000 python scripts/smoke-agent.py   # 打本机

退出码：0 全部通过 / 1 探针不通 / 2 任务未完成
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("BASE", "http://8.134.63.180:3000").rstrip("/")
CLI_CFG = os.path.expanduser("~/.foodmap-cli.json")
SOURCE = os.environ.get(
    "SOURCE", "把这两家店做成合集：深圳福田区八卦一路的豪先生、深圳南山区海岸城的海底捞"
)
CITY = os.environ.get("CITY", "深圳")
SKIP_BUILD = "--skip-build" in sys.argv


def http(url, method="GET", body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    return urllib.request.urlopen(req, timeout=timeout)


def get_token():
    """优先显式给的 token，其次 CLI 登录态（顺带续期），最后邮箱密码登录。"""
    tok = os.environ.get("FOODMAP_TOKEN")
    if tok:
        print("[token] 来自 FOODMAP_TOKEN")
        return tok

    if os.path.exists(CLI_CFG):
        cfg = json.load(open(CLI_CFG))
        try:
            with http(f"{BASE}/api/auth/refresh", "POST", {"refreshToken": cfg["refreshToken"]}) as r:
                d = json.load(r)
            cfg["accessToken"], cfg["refreshToken"] = d["accessToken"], d["refreshToken"]
            json.dump(cfg, open(CLI_CFG, "w"))
            print(f"[token] CLI 登录态续期成功（{cfg.get('email', '?')}）")
            return d["accessToken"]
        except urllib.error.HTTPError as e:
            print(f"[token] CLI 登录态失效（{e.code}），改用邮箱密码")

    email, pw = os.environ.get("FOODMAP_EMAIL"), os.environ.get("FOODMAP_PASSWORD")
    if not (email and pw):
        sys.exit("没有可用身份：给 FOODMAP_TOKEN，或 FOODMAP_EMAIL/FOODMAP_PASSWORD，"
                 "或先跑 `node scripts/foodmap.mjs login <email> <password>`")
    with http(f"{BASE}/api/auth/login", "POST", {"email": email, "password": pw}) as r:
        d = json.load(r)
    print(f"[token] 邮箱登录成功（{email}）")
    return d["accessToken"]


def probe(token):
    print(f"[1/2] GET {BASE}/api/agent/probe")
    try:
        with http(f"{BASE}/api/agent/probe", headers={"authorization": f"Bearer {token}"}) as r:
            status, body = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode()

    print(f"      http={status}")
    try:
        d = json.loads(body)
    except json.JSONDecodeError:
        print("      " + body[:300])
        return False

    print(json.dumps(d, ensure_ascii=False, indent=2))
    if d.get("connected"):
        card = d.get("card") or {}
        print(f"      card={card.get('name')} v{card.get('version')} streaming={card.get('streaming')}")
        return True

    hint = {
        503: "未配置 → 检查 .env 的 AGENT_A2A_BASE_URL / AGENT_A2A_TOKEN",
        502: "配了但不通 → 服务器上 `curl 127.0.0.1:3001` 看 frps 有没有这个监听；"
             "再看本机 7801 有没有起（ops\\resident.cmd）",
    }.get(status, "")
    print("      诊断：" + (hint or d.get("error", "未知")))
    return False


def build(token):
    print(f"[2/2] POST {BASE}/api/agent/build  city={CITY}")
    body = {"source": SOURCE, "city": CITY, "visibility": "UNLISTED"}
    try:
        resp = http(f"{BASE}/api/agent/build", "POST", body,
                    {"authorization": f"Bearer {token}", "accept": "text/event-stream"}, timeout=900)
    except urllib.error.HTTPError as e:
        print(f"      http={e.code} {e.read().decode()[:300]}")
        return None, None

    terminal, artifact, n = None, None, 0
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        t = ev.get("type")
        if t == "progress":
            n += 1
            print(f"      [{n:02d}] {ev.get('state', ''):<12} {str(ev.get('message', ''))[:100]}")
        elif t == "artifact":
            artifact = ev.get("data")
            print(f"      [artifact] {json.dumps(artifact, ensure_ascii=False)[:300]}")
        elif t == "done":
            terminal = ev.get("state")
            print(f"      [done] {terminal}")
        elif t == "error":
            print(f"      [error] {str(ev.get('message'))[:300]}")
            terminal = "error"
    return terminal, artifact


def main():
    token = get_token()
    if not probe(token):
        return 1
    if SKIP_BUILD:
        print("（--skip-build：不跑任务）")
        return 0

    terminal, artifact = build(token)
    if terminal != "completed":
        print(f"终态 {terminal}，未通过")
        return 2

    a = artifact or {}
    ok = True
    if a.get("citySource") not in ("platform", "inferred"):
        print(f"citySource 异常：{a.get('citySource')}"); ok = False
    if not (a.get("added") or 0) > 0:
        print(f"added={a.get('added')}，一家都没入库"); ok = False
    if not a.get("mapId"):
        print("没有 mapId"); ok = False

    # 合集必须落在调用方自己名下：用同一个 token 读得到才算数
    if a.get("mapId"):
        try:
            with http(f"{BASE}/api/maps/{a['mapId']}", headers={"authorization": f"Bearer {token}"}) as r:
                m = json.load(r)
            m = m.get("map") or m
            print(f"      归属校验：title={m.get('title')} ownerId={m.get('ownerId')} "
                  f"places={len(m.get('places') or [])}")
        except urllib.error.HTTPError as e:
            print(f"      归属校验失败：http={e.code}（合集不在调用方名下？）")
            ok = False

    print("通过" if ok else "有异常")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
