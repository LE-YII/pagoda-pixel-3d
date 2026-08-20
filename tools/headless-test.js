/* Headless 校验：用 mock DOM + mock WebGL2 实际执行 app.js。
 * 检查：① 运行期异常 ② uniform 名称 JS↔GLSL 一致 ③ 顶点属性位置/分量匹配
 *      ④ VS/FS varying 匹配 ⑤ DOM id 是否都存在于 index.html ⑥ 默认取景是否合理
 * 用法: node tools/headless-test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const errors = [], warns = [];
const E = m => errors.push(m);
const W = m => warns.push(m);

/* --------------------------------------------------- 解析 index.html */
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
function childButtons(id, attr) {
  const re = new RegExp('id="' + id + '"[\\s\\S]*?</div>');
  const seg = (html.match(re) || [''])[0];
  return [...seg.matchAll(new RegExp('data-' + attr + '="([^"]+)"', 'g'))].map(m => m[1]);
}
const MODE_BTNS = childButtons('mode', 'm');
const LV_BTNS = childButtons('lvsel', 'l');
if (MODE_BTNS.length !== 4) E('index.html: #mode 按钮数 ' + MODE_BTNS.length + '（应为 4）');
if (LV_BTNS.length !== 6) E('index.html: #lvsel 按钮数 ' + LV_BTNS.length + '（应为 6）');

/* --------------------------------------------------- mock DOM */
function El(tag, id) {
  const el = {
    tagName: tag, id: id || '', children: [], style: {}, dataset: {}, checked: true, value: '0',
    textContent: '', innerHTML: '', className: '', _ls: {},
    addEventListener(t, f) { (el._ls[t] = el._ls[t] || []).push(f); },
    dispatch(t, ev) { for (const f of (el._ls[t] || [])) f(Object.assign({ target: el, preventDefault() { } }, ev || {})); },
    appendChild(c) { el.children.push(c); return c; },
    querySelector() { if (!el._inp) el._inp = El('input'); return el._inp; },
    setPointerCapture() { },
    classList: { toggle() { }, add() { }, remove() { }, contains: () => false },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
    toBlob(cb) { cb({}); },
    click() { el.dispatch('click'); },
  };
  return el;
}
const registry = new Map();
function getEl(id) {
  if (!registry.has(id)) {
    if (!ids.has(id)) { E('app.js 取用了 index.html 中不存在的 id: #' + id); }
    const el = El('div', id);
    if (id === 'mode') el.children = MODE_BTNS.map(m => { const b = El('button'); b.dataset.m = m; return b; });
    if (id === 'lvsel') el.children = LV_BTNS.map(l => { const b = El('button'); b.dataset.l = l; return b; });
    if (id === 'px') el.value = '3';
    if (id === 'cutA') el.value = '45';
    if (id === 'xray') el.value = '16';
    if (id === 'exp') el.value = '18';
    if (id === 'edge') el.value = '70';
    if (id === 'out') el.value = '62';
    if (id === 'night') el.value = '0';
    registry.set(id, el);
  }
  return registry.get(id);
}

/* --------------------------------------------------- mock WebGL2 */
const GLSL = { shaders: new Map(), programs: new Map() };
let cid = 1000;
const CONST = {};
const METHODS = {};
const glCalls = { uniformNull: 0, draws: 0, attribs: [] };

function parseUniforms(src) {
  return [...src.matchAll(/uniform\s+\w+\s+(\w+)\s*(\[\d+\])?\s*;/g)].map(m => m[1]);
}
function parseAttribs(src) {
  return [...src.matchAll(/layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(\w+)\s+(\w+)/g)]
    .map(m => ({ loc: +m[1], type: m[2], name: m[3] }));
}
function parseIO(src, dir) {
  return [...src.matchAll(new RegExp('(?:^|\\n|;)\\s*' + dir + '\\s+(\\w+)\\s+(\\w+)\\s*;', 'g'))]
    .map(m => ({ type: m[1], name: m[2] }));
}

const gl = new Proxy({}, {
  get(_, k) {
    if (k in METHODS) return METHODS[k];
    if (!(k in CONST)) CONST[k] = ++cid;
    return CONST[k];
  },
});
Object.assign(METHODS, {
  createShader: () => ({ id: ++cid, src: '' }),
  shaderSource: (s, src) => { s.src = src; GLSL.shaders.set(s.id, src); },
  compileShader: s => {
    if (!/^#version 300 es\r?\n/.test(s.src)) E('着色器首行必须是 #version 300 es');
    const open = (s.src.match(/\{/g) || []).length, close = (s.src.match(/\}/g) || []).length;
    if (open !== close) E('着色器花括号不配对: ' + open + ' vs ' + close);
    if (!/void\s+main\s*\(/.test(s.src)) E('着色器缺少 main()');
  },
  getShaderParameter: () => true,
  getShaderInfoLog: () => '',
  createProgram: () => ({ id: ++cid, shaders: [] }),
  attachShader: (p, s) => p.shaders.push(s),
  linkProgram: p => {
    const vs = p.shaders[0].src, fs = p.shaders[1].src;
    p.uniforms = [...new Set(parseUniforms(vs).concat(parseUniforms(fs)))];
    p.attribs = parseAttribs(vs);
    const outs = parseIO(vs, 'out'), insF = parseIO(fs, 'in');
    for (const i of insF) {
      const o = outs.find(o => o.name === i.name);
      if (!o) E('varying 不匹配: 片元着色器 in ' + i.name + ' 在顶点着色器中无对应 out');
      else if (o.type !== i.type) E('varying 类型不一致: ' + i.name + ' ' + o.type + ' vs ' + i.type);
    }
    GLSL.programs.set(p.id, p);
  },
  getProgramParameter: (p, which) => (which === CONST.ACTIVE_UNIFORMS ? p.uniforms.length : true),
  getActiveUniform: (p, i) => ({ name: p.uniforms[i] }),
  getUniformLocation: (p, n) => (p.uniforms.includes(n) ? { p: p.id, n: n } : null),
  getProgramInfoLog: () => '',
  useProgram: p => { METHODS._cur = p; },
  createVertexArray: () => ({ id: ++cid, attribs: [] }),
  bindVertexArray: v => { METHODS._vao = v; },
  createBuffer: () => ({ id: ++cid }),
  bindBuffer: () => { },
  bufferData: (t, data) => {
    if (data && data.length !== undefined) {
      for (let i = 0; i < Math.min(data.length, 400); i++) {
        if (!Number.isFinite(data[i]) && data.BYTES_PER_ELEMENT === 4 && data instanceof Float32Array) {
          E('顶点数据含 NaN/Inf'); break;
        }
      }
    }
  },
  enableVertexAttribArray: i => { glCalls.attribs.push(i); },
  vertexAttribPointer: (i, size) => { glCalls.attribs.push([i, size]); },
  createTexture: () => ({ id: ++cid }), bindTexture: () => { }, texImage2D: () => { }, texParameteri: () => { },
  createFramebuffer: () => ({ id: ++cid }), bindFramebuffer: () => { }, framebufferTexture2D: () => { },
  deleteFramebuffer: () => { }, deleteTexture: () => { },
  viewport: () => { }, clearColor: () => { }, clear: () => { },
  enable: () => { }, disable: () => { }, depthFunc: () => { }, cullFace: () => { },
  blendFunc: () => { }, depthMask: () => { }, activeTexture: () => { },
  drawArrays: () => { glCalls.draws++; }, drawElements: () => { glCalls.draws++; },
});
for (const fn of ['uniform1f', 'uniform1i', 'uniform2f', 'uniform3f', 'uniform3fv', 'uniform4fv', 'uniformMatrix4fv']) {
  METHODS[fn] = (loc, ...rest) => {
    if (loc === null || loc === undefined) { glCalls.uniformNull++; E('gl.' + fn + ' 收到空 uniform 位置（JS 名称与着色器不一致或未使用）'); }
    for (const v of rest) {
      if (typeof v === 'number' && !Number.isFinite(v)) E('gl.' + fn + ' 传入非有限数值');
      if (v && v.length !== undefined) for (const x of v) if (!Number.isFinite(x)) { E('gl.' + fn + ' 数组含非有限数值'); break; }
    }
  };
}

/* --------------------------------------------------- mock 全局环境 */
const canvas = El('canvas', 'gl');
canvas.clientWidth = 1280; canvas.clientHeight = 800; canvas.width = 1280; canvas.height = 800;
canvas.getContext = () => gl;
registry.set('gl', canvas);

let rafQueue = [];
const sandbox = {
  console: console,
  document: {
    getElementById: getEl,
    createElement: t => El(t),
    body: El('body'),
    addEventListener() { },
  },
  window: null,
  devicePixelRatio: 2,
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  addEventListener() { },
  performance: { now: () => Date.now() },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() { } },
  setTimeout: () => 0,
  Math: Math, Float32Array, Uint32Array, Uint8Array, Map, Set, Object, Array, Number, JSON, String, Date, isFinite,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* 载入模型脚本（浏览器形态：挂到 window） */
vm.runInContext(fs.readFileSync(path.join(ROOT, 'pagoda-model.js'), 'utf8'), sandbox, { filename: 'pagoda-model.js' });
if (!sandbox.PagodaModel) E('pagoda-model.js 未挂载 window.PagodaModel');

/* 执行 app.js */
try {
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
} catch (e) {
  E('app.js 初始化抛异常: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
}

/* 驱动渲染帧，并逐一模拟 UI 交互 */
function runFrame(tag, t) {
  if (!rafQueue.length) { E('渲染循环中断于: ' + tag); return false; }
  const cb = rafQueue.shift();
  try { cb(t); frameCount++; return true; }
  catch (e) {
    E('渲染帧抛异常 [' + tag + ']: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
    return false;
  }
}
let frameCount = 0;
runFrame('初始', 16);

const actions = [];
for (const m of MODE_BTNS) actions.push(['透视=' + m, () => btn('mode', 'm', m)]);
for (const l of LV_BTNS) actions.push(['楼层=' + l, () => btn('lvsel', 'l', l)]);
actions.push(['剖及内构', () => { const e = getEl('cutIn'); e.checked = true; e.dispatch('change'); }]);
actions.push(['构件标注', () => { const e = getEl('anno'); e.checked = true; e.dispatch('change'); }]);
actions.push(['关闭标注', () => { const e = getEl('anno'); e.checked = false; e.dispatch('change'); }]);
for (const r of ['cutA', 'cutD', 'xray', 'exp', 'px', 'edge', 'out', 'night']) {
  actions.push(['滑块=' + r, () => { const e = getEl(r); e.value = '55'; e.dispatch('input'); }]);
}
for (const b of ['spin', 'reset', 'inside', 'outside', 'toggle', 'shot']) {
  actions.push(['按钮=' + b, () => getEl(b).click()]);
}
actions.push(['关闭屋顶显隐', () => {
  const box = getEl('kinds');
  for (const row of box.children) { const i = row.querySelector('input'); i.checked = false; i.dispatch('change'); }
}]);
actions.push(['进入塔内(聚焦二层)', () => { btn('lvsel', 'l', '1'); getEl('inside').click(); }]);

let ti = 32;
for (const [tag, act] of actions) {
  try { act(); } catch (e) { E('交互 [' + tag + '] 抛异常: ' + e.message); continue; }
  if (!runFrame(tag, (ti += 16))) break;
}
function btn(container, attr, val) {
  const c = getEl(container);
  const b = c.children.find(x => x.dataset[attr] === val);
  if (!b) { E('未找到按钮 ' + container + '[' + attr + '=' + val + ']'); return; }
  b.dispatch('click');
}
if (frameCount === 0) E('未执行任何渲染帧');

/* --------------------------------------------------- 属性布局校验 */
const prog = [...GLSL.programs.values()].find(p => p.attribs.length === 5);
if (!prog) E('未找到主程序（5 个顶点属性）');
else {
  const want = { 0: 3, 1: 3, 2: 2, 3: 2, 4: 3 };
  for (const a of prog.attribs) {
    const comp = { float: 1, vec2: 2, vec3: 3, vec4: 4 }[a.type];
    if (want[a.loc] !== comp) E('属性 location=' + a.loc + ' (' + a.name + ' ' + a.type + ') 与 JS 分量数不符');
  }
  const ptr = glCalls.attribs.filter(Array.isArray);
  for (const [loc, size] of ptr) {
    if (want[loc] !== undefined && want[loc] !== size && size !== 2) {
      if (!(loc === 0 && size === 2)) E('vertexAttribPointer(loc=' + loc + ', size=' + size + ') 与着色器声明不符');
    }
  }
}

/* --------------------------------------------------- 取景校验 */
(function framing() {
  const M = sandbox.PagodaModel.buildPagoda().meta;
  const dist = M.totalHeight * 1.78, yaw = 0.60, pitch = 0.22, ty = M.totalHeight * 0.44;
  const eye = [dist * Math.cos(pitch) * Math.sin(yaw), ty + dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw)];
  const f = 1 / Math.tan(38 * Math.PI / 180 / 2), asp = 1280 / 800;
  // 相机朝向 target
  const fwd = [-eye[0], ty - eye[1], -eye[2]];
  const fl = Math.hypot(...fwd); const fn = fwd.map(v => v / fl);
  const upw = [0, 1, 0];
  let rt = [fn[1] * upw[2] - fn[2] * upw[1], fn[2] * upw[0] - fn[0] * upw[2], fn[0] * upw[1] - fn[1] * upw[0]];
  const rl = Math.hypot(...rt); rt = rt.map(v => v / rl);
  const up2 = [rt[1] * fn[2] - rt[2] * fn[1], rt[2] * fn[0] - rt[0] * fn[2], rt[0] * fn[1] - rt[1] * fn[0]];
  let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9;
  const R = M.eaveHalf[0] + 6;
  for (const p of [[0, 0, 0], [0, M.totalHeight, 0], [R, 0, R], [-R, 0, -R], [R, M.totalHeight * 0.8, -R],
  [M.halfBase, 0, M.halfBase], [-M.halfBase, 0, -M.halfBase]]) {
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = -(d[0] * fn[0] + d[1] * fn[1] + d[2] * fn[2]);
    if (z >= -0.01) continue;
    const xs = (d[0] * rt[0] + d[1] * rt[1] + d[2] * rt[2]) * f / asp / -z;
    const ys = (d[0] * up2[0] + d[1] * up2[1] + d[2] * up2[2]) * f / -z;
    minY = Math.min(minY, ys); maxY = Math.max(maxY, ys); minX = Math.min(minX, xs); maxX = Math.max(maxX, xs);
  }
  const covY = (maxY - minY) / 2, covX = (maxX - minX) / 2;
  console.log(`  默认取景: 竖向占屏 ${(covY * 100).toFixed(0)}%  横向占屏 ${(covX * 100).toFixed(0)}%`);
  if (covY < 0.55) W('默认视距偏远（塔体竖向仅占 ' + (covY * 100).toFixed(0) + '%）');
  if (covY > 1.02) W('默认视距偏近（塔体上下可能出屏）');
})();

/* --------------------------------------------------- 报告 */
console.log('\n=== headless 校验 ===');
console.log('  DOM id 引用:', ids.size, '个已声明');
console.log('  着色器程序:', GLSL.programs.size, ' 绘制调用:', glCalls.draws, ' 帧:', frameCount);
console.log('  uniform 空位置:', glCalls.uniformNull);
if (warns.length) { console.log('\n[警告]'); for (const w of warns) console.log('  ! ' + w); }
if (errors.length) { console.log('\n[错误]'); for (const e of [...new Set(errors)]) console.log('  × ' + e); }
console.log(errors.length ? '\nFAIL (' + errors.length + ')' : '\nPASS');
process.exitCode = errors.length ? 1 : 0;
