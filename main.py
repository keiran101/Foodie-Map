#!/usr/bin/env python3
"""foodmap 服务启动入口：python main.py"""
import os
import shutil
import socket
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def port_open(port):
    s = socket.socket()
    s.settimeout(1)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    if port_open(3000):
        print('[OK] foodmap 已在运行 (:3000)')
        return 0
    node = shutil.which('node')
    if not node:
        print('[X] 未找到 node，请先安装 Node.js')
        return 1
    next_cli = os.path.join(BASE_DIR, 'node_modules', 'next', 'dist', 'bin', 'next')
    logfile = open(os.path.join(BASE_DIR, 'server.log'), 'ab')
    kwargs = {'cwd': BASE_DIR, 'stdout': logfile, 'stderr': subprocess.STDOUT}
    if os.name == 'nt':
        kwargs['creationflags'] = 0x08000000  # 隐藏窗口
    subprocess.Popen([node, next_cli, 'start', '-H', '0.0.0.0', '-p', '3000'], **kwargs)
    print('[OK] foodmap 已启动: http://<本机IP>:3000（日志: server.log）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
