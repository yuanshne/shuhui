# -*- coding: utf-8 -*-
# 内联 src/engine.js、src/puzzle-client.js 与 src/game.js → 生成根目录 index.html
#
# 三个文件各自用 IIFE 包一层隔离作用域：
#   引擎把 API 挂到 window.SH，联机库把构造器挂到 window.PuzzleClient，界面再取用。
# 联机库是 vendored 的副本（源在本仓库 server/web/puzzle-client.js），
# 一致性由 CI 的 server job 逐字节对照把关；内联而不是外链，是为了保住"离线单文件"。
import io, os

base = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(base, 'src')


def read(name):
    path = os.path.join(src, name)
    if not os.path.isfile(path):
        raise SystemExit('缺少 ' + path)
    return io.open(path, encoding='utf-8').read()


eng = read('engine.js')
client = read('puzzle-client.js')
game = read('game.js')
tpl = io.open(os.path.join(src, 'template.html'), encoding='utf-8').read()

for token in ('/*__ENGINE__*/', '/*__CLIENT__*/', '/*__GAME__*/'):
    assert token in tpl, 'template.html 缺少 %s 占位符' % token

NL = chr(10)
wrap = lambda code: '(function(){' + NL + code + NL + '})();'

out = (tpl
       .replace('/*__ENGINE__*/', wrap(eng))
       .replace('/*__CLIENT__*/', wrap(client))
       .replace('/*__GAME__*/', wrap(game)))
io.open(os.path.join(base, 'index.html'), 'w', encoding='utf-8').write(out)
print('built index.html,', len(out) // 1024, 'KB')
