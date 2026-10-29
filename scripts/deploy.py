#!/usr/bin/env python
"""把本仓库部署到云服务器（/opt/foodmap 不是 git 仓库，用校验和对比增量上传）。

为什么不用 git pull：服务器上根本没有 .git，历史部署是整目录拷上去的。
所以这里做的是「按 md5 找出真正变了的文件 → 只传这些 → 服务端构建」。

用法：
    SRV_PW='<密码>' python scripts/deploy.py            # 有改动才构建
    SRV_PW='<密码>' python scripts/deploy.py --dry-run   # 只看差异，不动服务器
    SRV_PW='<密码>' python scripts/deploy.py --build     # 强制构建一次

环境变量：
    SRV_HOST  默认 8.134.63.180
    SRV_USER  默认 root
    SRV_PW    必填
    SRV_PATH  默认 /opt/foodmap

构建为什么在服务器上做：本地是 Windows，Prisma 的查询引擎按平台生成，
交叉上传 .next 会把 windows 引擎带过去。1.6G 内存 + 4G swap 实测能构建，
`experimental.cpus: 1` 已经限制了并发。
"""
import base64
import hashlib
import os
import posixpath
import sys

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

    # ---- 构建 ----
    # 停服务腾内存；.next 改名备份，构建失败就回滚，避免把线上打挂。
    print("停服务 → 备份 .next → 构建")
    plan = (
        f"set -e; cd {REMOTE}; "
        f"systemctl stop foodmap || true; "
        f"rm -rf .next.bak; cp -a .next .next.bak; "
        f"rm -f /root/build.log; "
        f"setsid nohup bash -c 'cd {REMOTE} && "
        f"NODE_OPTIONS=--max-old-space-size=1024 npm run build >> /root/build.log 2>&1; "
        f"echo EXIT=$? >> /root/build.log' >/dev/null 2>&1 & "
        f"echo started"
    )
    srv.run(plan)

    import time
    for _ in range(60):  # 最多等 10 分钟
        time.sleep(10)
        out, _, _ = srv.run("tail -1 /root/build.log 2>/dev/null", check=False)
        if out.strip().startswith("EXIT="):
            break
    out, _, _ = srv.run("grep -E '^EXIT=' /root/build.log | tail -1", check=False)
    code = out.strip().split("=")[-1] if out.strip() else "?"

    if code == "0":
        srv.run("systemctl start foodmap; sleep 4; systemctl is-active foodmap")
        print("构建成功，服务已重启")
        head, _, _ = srv.run("grep -E 'api/agent' /root/build.log || true", check=False)
        if head.strip():
            print(head.strip())
        rc = 0
    else:
        print(f"构建失败（EXIT={code}），回滚 .next 并重启旧版本")
        print(srv.run("tail -30 /root/build.log", check=False)[0])
        srv.run("cd %s && rm -rf .next && mv .next.bak .next && systemctl start foodmap" % REMOTE, check=False)
        rc = 1

    srv.sftp.close()
    srv.c.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
