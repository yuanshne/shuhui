# -*- coding: utf-8 -*-
# 内联 src/engine.js 与 src/game.js → 生成根目录 index.html
# 两个文件各自用 IIFE 包一层隔离作用域：引擎把 API 挂到 window.SH，界面再取用。
import io, os

base = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(base, 'src')

eng = io.open(os.path.join(src, 'engine.js'), encoding='utf-8').read()
game = io.open(os.path.join(src, 'game.js'), encoding='utf-8').read()
tpl = io.open(os.path.join(src, 'template.html'), encoding='utf-8').read()

assert '/*__ENGINE__*/' in tpl, 'template.html 缺少 /*__ENGINE__*/ 占位符'
assert '/*__GAME__*/' in tpl, 'template.html 缺少 /*__GAME__*/ 占位符'

NL = chr(10)
wrap = lambda code: '(function(){' + NL + code + NL + '})();'

out = tpl.replace('/*__ENGINE__*/', wrap(eng)).replace('/*__GAME__*/', wrap(game))
io.open(os.path.join(base, 'index.html'), 'w', encoding='utf-8').write(out)
print('built index.html,', len(out) // 1024, 'KB')
