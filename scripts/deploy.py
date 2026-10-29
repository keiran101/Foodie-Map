#!/usr/bin/env python
"""把本仓库部署到云服务器（/opt/foodmap 不是 git 仓库，用校验和对比增量上传）。

为什么不用 git pull：服务器上根本没有 .git，历史部署是整目录拷上去的。
所以这里做的是「按 md5 找出真正变了的文件 → 只传这些 → 服务端构建」。

用法：
    SRV_PW='<密码>' python scripts/deploy.py            # 有改动才构建
    SRV_PW='<密码>' python scripts/deploy.py --dry-run   # 只看差异，不动服务器
    SRV_PW='<密码>' python scripts/deploy.py --build     # 强制构建一次
    SRV_PW='<密码>' python scripts/deploy.py --force     # 越过可用内存检查

环境变量：
    SRV_HOST  默认 8.134.63.180
    SRV_USER  默认 root
    SRV_PW    必填
    SRV_PATH  默认 /opt/foodmap

构建为什么在服务器上做：本地是 Windows，Prisma 的查询引擎按平台生成，
交叉上传 .next 会把 windows 引擎带过去。1.6G 内存 + 4G swap 实测能构建，
`experimental.cpus: 1` 已经限制了并发。

内存这条线是硬约束（实测数据见 docs/DEPLOY.md §4）：
停 foodmap 只腾出 ~50MB，构建本身要吃掉 ~460MB。所以本脚本做三件事 ——
停服必须真的停掉、构建全程采样内存峰值并写进 build.log、启不来看得见就自动回滚。
"""
import atexit
import base64
import hashlib
import os
import posixpath
import sys
import tempfile
import time

try:
    import paramiko
except ImportError:
    sys.exit("需要 paramiko：pip install paramiko")

HOST = os.environ.get("SRV_HOST", "8.134.63.180")
USER = os.environ.get("SRV_USER", "root")
PW = os.environ.get("SRV_PW")
REMOTE = os.environ.get("SRV_PATH", "/opt/foodmap")
LOCAL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 参与部署的目录。node_modules / .next 不入比对（服务器自己构建）。
WATCH = ["src", "prisma", "public", "scripts"]
EXTRA_FILES = ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json"]

DRY = "--dry-run" in sys.argv
FORCE_BUILD = "--build" in sys.argv
FORCE = "--force" in sys.argv

# 构建额外需要的内存（实测 464MB，取 550MB 做门槛）。停 foodmap 只腾出 ~50MB，
# 所以用「当前 available + 50」估算停服后的可用量来比。
BUILD_NEED_MB = 550
STOP_FREES_MB = 50

# 放到服务器上执行的构建包装。单独成文件是为了不用在几层引号里拼 awk，
# 也方便出问题时直接 cat 出来看。
BUILD_SH = r"""#!/bin/bash
# 用法：bash /root/deploy-build.sh /opt/foodmap
# 峰值采样 → 构建 → 把 MEM_PEAK 和 EXIT 追加进 /root/build.log
cd "$1" || { echo "EXIT=9" >> /root/build.log; exit 9; }
rm -f /tmp/mempeak.log
( while :; do
    awk '/MemAvailable/{a=int($2/1024)} /SwapTotal/{t=$2} /SwapFree/{f=$2} END{print a" "int((t-f)/1024)}' /proc/meminfo >> /tmp/mempeak.log
    sleep 1
  done ) &
SAM=$!
# schema.prisma 变了必须先重新生成 client：否则 next build 的类型检查会直接失败
# （新的 model 在 @prisma/client 上不存在）。generate 很轻，不占多少内存。
npx prisma generate >> /root/build.log 2>&1 || echo "PRISMA_GENERATE_FAIL" >> /root/build.log
NODE_OPTIONS=--max-old-space-size=1024 npm run build >> /root/build.log 2>&1
C=$?
kill "$SAM" 2>/dev/null
awk '{if (m==0 || $1<m) m=$1; if ($2>s) s=$2} END{printf "MEM_PEAK MemAvailable_min=%dMB SwapUsed_max=%dMB\n", m, s}' /tmp/mempeak.log >> /root/build.log
echo "EXIT=$C" >> /root/build.log
"""


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def local_manifest():
    out = {}
    for d in WATCH:
        root_dir = os.path.join(LOCAL, d)
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [x for x in dirs if x not in ("node_modules", "__pycache__")]
            for f in files:
                if f.endswith((".pyc",)):
                    continue
                full = os.path.join(root, f)
                rel = os.path.relpath(full, LOCAL).replace(os.sep, "/")
                out[rel] = md5(full)
    for f in EXTRA_FILES:
        full = os.path.join(LOCAL, f)
        if os.path.exists(full):
            out[f] = md5(full)
    return out


class Srv:
    def __init__(self):
        self.c = paramiko.SSHClient()
        self.c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.c.connect(HOST, 22, USER, PW, timeout=20, banner_timeout=30, auth_timeout=30)
        self.sftp = self.c.open_sftp()

    def run(self, cmd, timeout=180, check=True):
        _, so, se = self.c.exec_command(cmd, timeout=timeout)
        out = so.read().decode("utf-8", "replace")
        err = se.read().decode("utf-8", "replace")
        rc = so.channel.recv_exit_status()
        if check and rc != 0:
            raise RuntimeError(f"命令失败 rc={rc}: {cmd}\n{out}\n{err}")
        return out, err, rc

    def remote_manifest(self):
        paths = " ".join(WATCH + EXTRA_FILES)
        out, _, _ = self.run(f"cd {REMOTE} && for f in {paths}; do [ -f \"$f\" ] && md5sum \"$f\"; done; "
                             f"find {' '.join(WATCH)} -type f 2>/dev/null | sort | xargs md5sum 2>/dev/null",
                             check=False)
        m = {}
        for line in out.splitlines():
            if "  " in line:
                h, p = line.split("  ", 1)
                m[p.strip().lstrip("./")] = h.strip()
        return m


def main():
    if not PW:
        sys.exit("缺 SRV_PW 环境变量")
    lm = local_manifest()
    srv = Srv()
    rm = srv.remote_manifest()

    changed = [p for p in sorted(lm) if p not in rm or rm[p] != lm[p]]
    removed = [p for p in sorted(rm) if p not in lm]

    print(f"本地 {len(lm)} 个文件，服务器 {len(rm)} 个；差异 {len(changed)} 改动 / {len(removed)} 删除")
    for p in changed:
        print("  M" if p in rm else "  A", p)
    for p in removed:
        print("  D", p)

    if not changed and not removed:
        print("无改动，不构建。")
        if not FORCE_BUILD:
            srv.c.close()
            return 0

    if DRY:
        print("（--dry-run：不执行上传与构建）")
        srv.c.close()
        return 0

    # ---- 上传 ----
    for rel in changed:
        src = os.path.join(LOCAL, rel.replace("/", os.sep))
        dst = posixpath.join(REMOTE, rel)
        # 逐级建目录
        cur = ""
        for part in posixpath.dirname(dst).strip("/").split("/"):
            cur += "/" + part
            try:
                srv.sftp.stat(cur)
            except IOError:
                srv.sftp.mkdir(cur)
        srv.sftp.put(src, dst)
        srv.sftp.chmod(dst, 0o644)
    print(f"已上传 {len(changed)} 个文件")

    for rel in removed:
        srv.run(f"rm -f {posixpath.join(REMOTE, rel)}", check=False)
    if removed:
        print(f"已删除 {len(removed)} 个文件")

    # ---- schema 变更 → 推库 ----
    # 生产库是 db push 建的（见 docs/DEPLOY.md 坑 8），这里沿用同一套，别混进 migrate。
    # 只在真的上传了新的 schema.prisma 时才做；刻意**不加 --accept-data-loss**：
    # 万一遇到会删列/删表的变更，宁可在这一步失败、把线上留在旧版本上，
    # 也不要让一个部署脚本替人决定丢掉生产数据。
    if "prisma/schema.prisma" in changed:
        print("schema.prisma 有变更 → prisma db push")
        out, err, rc = srv.run(
            f"cd {REMOTE} && npx prisma db push --skip-generate", timeout=300, check=False
        )
        for line in (out or err).strip().splitlines()[-6:]:
            print("  " + line)
        if rc != 0:
            srv.c.close()
            sys.exit("db push 失败，已中止部署（服务仍在旧版本上，未被改动）。")

    # ---- 内存预检 ----
    # 这台机器 1608MB，构建要多占 ~460MB。停服务只腾出 ~50MB —— 别指望用「停服」换内存。
    avail = int((srv.run("free -m | awk 'NR==2{print $7}'", check=False)[0] or "0").strip() or 0)
    after_stop = avail + STOP_FREES_MB
    print(f"内存：available {avail}MB，停服后约 {after_stop}MB，构建需要 ~{BUILD_NEED_MB}MB")
    if after_stop < BUILD_NEED_MB and not FORCE:
        sys.exit(
            f"可用内存不足（{after_stop}MB < {BUILD_NEED_MB}MB），构建大概率被 OOM kill。\n"
            "先腾内存再部署：确认没有别的重活在跑（docker stats / ps aux --sort=-rss），\n"
            "必要时 docker stop filed_rop-filedrop-1（另一个项目，先问过再动）。\n"
            "确实要在这种状态下构建，加 --force。"
        )

    # ---- 停服 ----
    # 收尾钩子必须注册在「停」之前：一旦 stop 发出去了，任何异常（含 sys.exit、
    # Ctrl-C、SSH 断）都不能把线上留在停着的状态。对已在跑的服务 start 是 no-op。
    # （这条是踩出来的：钩子注册在检查之后，检查失败那条路径就漏了，站点真的停了两分钟。）
    rescue = {"on": True}

    def _rescue():
        if not rescue["on"]:
            return
        try:
            print("异常退出 → 尝试把 foodmap 拉起来")
            srv.run("systemctl start foodmap", check=False)
        except Exception as exc:  # 连接已断就只能提示，别吞掉原始异常
            print(f"  （拉不起来，手动执行 systemctl start foodmap：{exc}）")

    atexit.register(_rescue)

    # 判据不是「状态叫 inactive」：Next 收到 SIGTERM 以 143 退出，systemd 会把这次
    # stop 记成 failed。真正要验的是「3000 不再监听」——停不掉还硬构建，内存就是
    # 服务 + 构建两份，OOM 时会去杀别人（python / dockerd），比构建失败更难查。
    print("停服务 foodmap …")
    out, _, _ = srv.run(
        "systemctl stop foodmap; sleep 2; "
        "echo STATE=$(systemctl is-active foodmap || true); "
        "echo PORT=$(ss -lntH 'sport = :3000' | wc -l)", check=False)
    info = dict(l.split("=", 1) for l in out.strip().splitlines() if "=" in l)
    state, port = info.get("STATE", "?"), info.get("PORT", "?")
    print(f"  状态 {state}，3000 监听数 {port}")
    if state in ("active", "activating", "reloading"):
        sys.exit(f"停服务失败（状态仍是 {state}），不继续构建。查 systemctl status foodmap")
    if port != "0":
        sys.exit("3000 还在监听 —— 进程没退干净，构建会和服务抢内存，中止。查 ss -lntp | grep 3000")

    # ---- 备份 + 构建 ----
    print("备份 .next → 构建（峰值内存会记进 /root/build.log）")
    srv.run(f"cd {REMOTE} && rm -rf .next.bak && cp -a .next .next.bak", timeout=300)
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, newline="\n", encoding="utf-8") as fh:
        fh.write(BUILD_SH)
        local_sh = fh.name
    srv.sftp.put(local_sh, "/root/deploy-build.sh")
    srv.sftp.chmod("/root/deploy-build.sh", 0o755)
    os.unlink(local_sh)
    srv.run(f"rm -f /root/build.log; setsid nohup bash /root/deploy-build.sh {REMOTE} >/dev/null 2>&1 & echo started")

    for _ in range(90):  # 最多等 15 分钟
        time.sleep(10)
        out, _, _ = srv.run("tail -1 /root/build.log 2>/dev/null", check=False)
        if out.strip().startswith("EXIT="):
            break
    out, _, _ = srv.run("grep -E '^EXIT=' /root/build.log | tail -1", check=False)
    code = out.strip().split("=")[-1] if out.strip() else "?"
    peak, _, _ = srv.run("grep -E '^MEM_PEAK' /root/build.log | tail -1", check=False)
    print(peak.strip() or "（没采到内存峰值，可能构建被 OOM kill）")

    def health(max_wait=30):
        """等 Next 真的能响应，而不是只看 systemd 说 active。"""
        deadline = time.time() + max_wait
        while time.time() < deadline:
            time.sleep(2)
            o, _, _ = srv.run("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/discover",
                              check=False)
            if o.strip() == "200":
                return True
        return False

    if code == "0":
        srv.run("systemctl start foodmap", check=False)
        if health():
            print("构建成功，服务已重启，/discover 200")
            head, _, _ = srv.run("grep -E 'api/agent' /root/build.log || true", check=False)
            if head.strip():
                print(head.strip())
            rc = 0
        else:
            print("构建成功但服务起不来（/discover 30 秒内没返回 200），回滚旧版本")
            print(srv.run("tail -30 /root/build.log; journalctl -u foodmap -n 20 --no-pager",
                          check=False)[0])
            srv.run("cd %s && systemctl stop foodmap; rm -rf .next && mv .next.bak .next && "
                    "systemctl start foodmap" % REMOTE, check=False)
            rc = 1
    else:
        print(f"构建失败（EXIT={code}），回滚 .next 并重启旧版本")
        print(srv.run("tail -30 /root/build.log", check=False)[0])
        srv.run("cd %s && rm -rf .next && mv .next.bak .next && systemctl start foodmap" % REMOTE,
                check=False)
        rc = 1

    rescue["on"] = False  # 走到这里服务一定已经起来了，别再让钩子发命令
    srv.sftp.close()
    srv.c.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
