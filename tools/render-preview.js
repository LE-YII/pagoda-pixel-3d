/* Node 软件光栅化预览器：把体素塔模型渲染成 PNG，用于离线自查外观。
 * 用法: node tools/render-preview.js
 * 与浏览器 WebGL 着色规则保持一致（量化平行光 + 面边描线 + 像素化）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildPagoda } = require('../pagoda-model.js');

/* ------------------------------------------------------------------ 数学 */
function mul(a, b) { const o = new Float64Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; }
function perspective(fovy, aspect, near, far) { const f = 1 / Math.tan(fovy / 2); const o = new Float64Array(16); o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far); return o; }
function lookAt(eye, ctr, up) {
  let z = [eye[0] - ctr[0], eye[1] - ctr[1], eye[2] - ctr[2]]; let l = Math.hypot(...z); z = z.map(v => v / l);
  let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]; l = Math.hypot(...x) || 1; x = x.map(v => v / l);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return new Float64Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]), -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1]);
}

/* -------------------------------------------------------------- 立方体面 */
const FACES = [
  { n: [0, 1, 0], v: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], ax: [0, 2] }, // +Y
  { n: [0, -1, 0], v: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], ax: [0, 2] },
  { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], ax: [0, 1] },
  { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], ax: [0, 1] },
  { n: [1, 0, 0], v: [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]], ax: [2, 1] },
  { n: [-1, 0, 0], v: [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]], ax: [2, 1] },
];
const LIGHT = (() => { const v = [-0.5, 0.82, 0.28]; const l = Math.hypot(...v); return v.map(x => x / l); })();
function shadeOf(n) {
  const ndl = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
  if (ndl > 0.8) return 1.14; if (ndl > 0.35) return 1.0; if (ndl > -0.1) return 0.80; if (ndl > -0.6) return 0.66; return 0.55;
}

const SHELL = { base: 1, wall: 1, roof: 1, rail: 1, finial: 1 };

/* ------------------------------------------------------------- 渲染一帧 */
function render(model, opt) {
  const W = opt.w, H = opt.h;
  const col = new Uint8Array(W * H * 3), zb = new Float64Array(W * H).fill(-Infinity);
  const kindBuf = new Array(W * H).fill(null), lumBuf = new Float64Array(W * H), lvlBuf = new Array(W * H).fill(null);
  // 背景：竖直渐变 + 抖动
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const r = Math.round(28 + 66 * (1 - t) + 46 * t), g = Math.round(38 + 78 * (1 - t) + 40 * t), b = Math.round(58 + 92 * (1 - t) + 34 * t);
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; const d = ((x + y) & 1) * 3; col[i] = r + d; col[i + 1] = g + d; col[i + 2] = b + d; }
  }
  const yaw = opt.yaw * Math.PI / 180, pitch = opt.pitch * Math.PI / 180;
  const tgt = opt.target, dist = opt.dist;
  const eye = [tgt[0] + dist * Math.cos(pitch) * Math.sin(yaw), tgt[1] + dist * Math.sin(pitch), tgt[2] + dist * Math.cos(pitch) * Math.cos(yaw)];
  const vp = mul(perspective(opt.fov * Math.PI / 180, W / H, 1, dist * 4), lookAt(eye, tgt, [0, 1, 0]));

  let boxes = model.boxes;
  if (opt.hide) boxes = boxes.filter(b => !opt.hide[b.k]);
  if (opt.maxLevel != null) boxes = boxes.filter(b => b.l <= opt.maxLevel);
  if (opt.clipX != null) {
    const out = [];
    for (const b of boxes) {
      if (!SHELL[b.k]) { out.push(b); continue; }
      if (b.x >= opt.clipX) continue;
      out.push(b.x + b.w > opt.clipX ? Object.assign({}, b, { w: opt.clipX - b.x }) : b);
    }
    boxes = out;
  }

  const P = new Float64Array(16), sx = new Float64Array(4), sy = new Float64Array(4), sw = new Float64Array(4);
  const uu = [0, 0, 1, 1], vv = [0, 1, 1, 0];
  for (const b of boxes) {
    for (const f of FACES) {
      // 背面剔除
      const cx = b.x + b.w / 2 + f.n[0] * b.w / 2, cy = b.y + b.h / 2 + f.n[1] * b.h / 2, cz = b.z + b.d / 2 + f.n[2] * b.d / 2;
      if ((cx - eye[0]) * f.n[0] + (cy - eye[1]) * f.n[1] + (cz - eye[2]) * f.n[2] > 0) continue;
      let ok = true;
      const size = [b.w, b.h, b.d];
      for (let i = 0; i < 4; i++) {
        const p = f.v[i];
        const X = b.x + p[0] * b.w, Y = b.y + p[1] * b.h, Z = b.z + p[2] * b.d;
        const clipX = vp[0] * X + vp[4] * Y + vp[8] * Z + vp[12];
        const clipY = vp[1] * X + vp[5] * Y + vp[9] * Z + vp[13];
        const clipW = vp[3] * X + vp[7] * Y + vp[11] * Z + vp[15];
        if (clipW < 0.2) { ok = false; break; }
        sw[i] = 1 / clipW; sx[i] = (clipX * sw[i] * 0.5 + 0.5) * W; sy[i] = (1 - (clipY * sw[i] * 0.5 + 0.5)) * H;
      }
      if (!ok) continue;
      const sh = shadeOf(f.n);
      const cr = ((b.c >> 16) & 255) * sh, cg = ((b.c >> 8) & 255) * sh, cb2 = (b.c & 255) * sh;
      const su = size[f.ax[0]], sv = size[f.ax[1]];
      tri(0, 1, 2); tri(0, 2, 3);
      function tri(a, b2, c) {
        const x0 = sx[a], y0 = sy[a], x1 = sx[b2], y1 = sy[b2], x2 = sx[c], y2 = sy[c];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (Math.abs(area) < 1e-9) return;
        const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
        const iw = 1 / area;
        for (let py = minY; py <= maxY; py++) {
          for (let px = minX; px <= maxX; px++) {
            const fx = px + 0.5, fy = py + 0.5;
            let w0 = ((x1 - fx) * (y2 - fy) - (x2 - fx) * (y1 - fy)) * iw;
            let w1 = ((x2 - fx) * (y0 - fy) - (x0 - fx) * (y2 - fy)) * iw;
            let w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const iz = w0 * sw[a] + w1 * sw[b2] + w2 * sw[c];
            const idx = py * W + px;
            if (iz <= zb[idx]) continue;
            zb[idx] = iz;
            // 透视正确 UV → 面边描线
            const u = (w0 * uu[a] * sw[a] + w1 * uu[b2] * sw[b2] + w2 * uu[c] * sw[c]) / iz;
            const v = (w0 * vv[a] * sw[a] + w1 * vv[b2] * sw[b2] + w2 * vv[c] * sw[c]) / iz;
            const de = Math.min(Math.min(u, 1 - u) * su, Math.min(v, 1 - v) * sv);
            const k = de < 0.10 ? 0.70 : (de < 0.22 ? 0.88 : 1);
            const o = idx * 3;
            col[o] = Math.min(255, cr * k); col[o + 1] = Math.min(255, cg * k); col[o + 2] = Math.min(255, cb2 * k);
            kindBuf[idx] = b.k; lumBuf[idx] = (cr + cg + cb2) / 3 * k / 255; lvlBuf[idx] = b.l;
          }
        }
      }
    }
  }
  return { col, W, H, boxes: boxes.length, kindBuf, lumBuf, lvlBuf };
}

/* -------------------------------------------------- ASCII 结构自查输出 */
const KCH = { base: '#', frame: '|', wall: ':', roof: '^', rail: '=', floor: '_', stair: '/', core: 'I', furn: '*', finial: '$' };
const LUM = ' .,:;-=+*#%@';
function ascii(r, mode) {
  const lines = [];
  for (let y = 0; y < r.H; y++) {
    let s = '';
    for (let x = 0; x < r.W; x++) {
      const i = y * r.W + x, k = r.kindBuf[i];
      if (!k) { s += ' '; continue; }
      if (mode === 'kind') s += (KCH[k] || '?');
      else if (mode === 'level') { const v = r.lvlBuf[i]; s += v < 0 ? 'B' : (v >= 5 ? 'F' : String(v + 1)); }
      else if (mode === 'roof') { s += (k === 'roof' ? (r.lvlBuf[i] < 0 ? 'B' : String(r.lvlBuf[i] + 1)) : (k ? '.' : ' ')); }
      else s += LUM[Math.max(1, Math.min(LUM.length - 1, Math.round(r.lumBuf[i] * (LUM.length - 1) * 1.35)))];
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- PNG */
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) { CRC_T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(file, col, W, H, scale) {
  const OW = W * scale, OH = H * scale;
  const raw = Buffer.alloc((OW * 3 + 1) * OH);
  let p = 0;
  for (let y = 0; y < OH; y++) {
    raw[p++] = 0;
    const sy = (y / scale) | 0;
    for (let x = 0; x < OW; x++) { const i = (sy * W + ((x / scale) | 0)) * 3; raw[p++] = col[i]; raw[p++] = col[i + 1]; raw[p++] = col[i + 2]; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(OW, 0); ihdr.writeUInt32BE(OH, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

/* ---------------------------------------------------------------- main */
const model = buildPagoda();
const M = model.meta;
console.log('boxes =', M.boxCount, ' totalHeight =', M.totalHeight.toFixed(1), ' baseWidth =', (M.halfBase * 2).toFixed(1),
  ' ratio H/W =', (M.totalHeight / (M.halfBase * 2)).toFixed(2));
console.log('floorY =', M.floorY.map(v => v.toFixed(1)).join(', '));
let bad = 0, minY = Infinity, maxY = -Infinity, maxR = 0;
for (const b of model.boxes) {
  if (![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isFinite) || b.w <= 0 || b.h <= 0 || b.d <= 0) bad++;
  minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y + b.h);
  maxR = Math.max(maxR, Math.abs(b.x), Math.abs(b.x + b.w), Math.abs(b.z), Math.abs(b.z + b.d));
}
console.log('bad boxes =', bad, ' Y range =', minY.toFixed(1), '..', maxY.toFixed(1), ' maxRadius =', maxR.toFixed(1));
const counts = {};
for (const b of model.boxes) counts[b.k] = (counts[b.k] || 0) + 1;
console.log('by kind:', JSON.stringify(counts));

/* ---- 结构自检：楼梯与楼板洞口对位 / 楼梯净空 / 各层可达性 ---- */
function aabb(b) { return [b.x, b.x + b.w, b.y, b.y + b.h, b.z, b.z + b.d]; }
function hit(a, b) { return a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3] && a[4] < b[5] && b[4] < a[5]; }
const M2 = model.meta;
for (let i = 0; i < M2.levels - 1; i++) {
  const treads = model.boxes.filter(b => b.k === 'stair' && b.l === i && b.p === '踏板');
  const plat = model.boxes.filter(b => b.k === 'stair' && b.l === i && b.p === '楼梯口平台')[0];
  const ys = treads.map(b => b.y + b.h);
  const topY = Math.max(...ys, plat ? plat.y + plat.h : -1);
  const nextFloor = M2.floorY[i + 1];
  // 楼梯上口是否与上层楼板同高
  const dy = Math.abs(topY - nextFloor);
  // 楼梯上口平台是否落在上层楼板的洞口内（洞口 = 该处无 floor 方块）
  const probe = { x: plat.x + plat.w / 2 - 0.5, y: nextFloor - 0.9, z: plat.z + plat.d / 2 - 0.5, w: 1, h: 0.8, d: 1 };
  const blocked = model.boxes.filter(b => b.k === 'floor' && b.l === i + 1 && hit(aabb(probe), aabb(b)));
  // 净空：踏板上方 4.4（≈1.75m）内是否有构件；封闭段以上层楼板底为限，洞口段不封顶
  const clear = [];
  const floorAbove = (t) => model.boxes.some(b => b.k === 'floor' && b.l === i + 1 && b.p !== '楞木' &&
    hit([t.x, t.x + t.w, nextFloor - 1.05, nextFloor - 0.05, t.z, t.z + t.d], aabb(b)));
  for (const t of treads) {
    const headTop = floorAbove(t) ? Math.min(t.y + 0.6 + 4.4, nextFloor - 1.0) : t.y + 0.6 + 4.4;
    if (headTop <= t.y + 0.7) { clear.push('净空不足@踏板y=' + t.y.toFixed(1)); continue; }
    const head = { x: t.x, y: t.y + 0.6, z: t.z, w: t.w, h: headTop - (t.y + 0.6), d: t.d };
    for (const b of model.boxes) {
      if (b.k === 'stair' || b.k === 'roof' || b.k === 'wall') continue;
      if (b.k === 'floor' && b.l === i + 1) continue;
      const A = aabb(head), C = aabb(b);
      if (!hit(A, C)) continue;
      const ox = Math.min(A[1], C[1]) - Math.max(A[0], C[0]);
      const oz = Math.min(A[5], C[5]) - Math.max(A[4], C[4]);
      if (ox < 0.4 || oz < 0.4) continue;          // 擦边忽略
      clear.push(b.p + '@' + b.k + 'L' + (b.l + 1) + '(' + ox.toFixed(1) + 'x' + oz.toFixed(1) + ')');
    }
  }
  // 上口洞净空：最后 5 级踏板正上方必须是洞口（无上层楼板）
  let capped = 0;
  for (const t of treads.slice(-5)) if (floorAbove(t)) capped++;
  console.log(`L${i + 1}->L${i + 2} 楼梯: 上口高差=${dy.toFixed(2)} 落入洞口=${blocked.length === 0 ? 'YES' : 'NO(' + blocked.length + ')'}` +
    ` 末段被楼板封顶=${capped} 净空冲突=${clear.length ? [...new Set(clear)].join(',') : '无'}`);
}
// 悬空检查：立于楼板之上的构件（栏杆/陈设/楼梯下槛）其下必须有楼板
for (let l = 0; l < M2.levels; l++) {
  const fy = M2.floorY[l];
  const floors = model.boxes.filter(b => b.k === 'floor' && b.l === l && b.p !== '楞木');
  const standing = model.boxes.filter(b => (b.k === 'rail' || b.k === 'furn' || b.p === '楼梯下槛') &&
    b.l === l && Math.abs(b.y - fy) < 0.25 &&
    Math.abs(b.x + b.w / 2) < M2.halfWall[l] - 0.5 && Math.abs(b.z + b.d / 2) < M2.halfWall[l] - 0.5);
  const floaters = standing.filter(b => {
    const c = [b.x + b.w / 2 - 0.3, b.x + b.w / 2 + 0.3, fy - 0.9, fy - 0.1, b.z + b.d / 2 - 0.3, b.z + b.d / 2 + 0.3];
    return !floors.some(f => hit(c, aabb(f)));
  });
  console.log(`  L${l + 1} 立于楼板构件=${standing.length} 悬空=${floaters.length}` +
    (floaters.length ? ' → ' + floaters.map(b => `${b.p}(x=${(b.x + b.w / 2).toFixed(1)},z=${(b.z + b.d / 2).toFixed(1)})`).join(',') : ''));
}

const coreBoxes = model.boxes.filter(b => b.k === 'core');console.log('塔心柱段数=', coreBoxes.length, ' 顶端Y=', Math.max(...coreBoxes.map(b => b.y + b.h)).toFixed(1));
for (let i = 0; i < M2.levels; i++) {
  const f = model.boxes.filter(b => b.k === 'floor' && b.l === i);
  const pierce = f.filter(b => hit(aabb(b), [-1.5, 1.5, b.y, b.y + b.h, -1.5, 1.5]));
  console.log(`  L${i + 1} 楼板块=${f.length} 与塔心柱冲突=${pierce.length}`);
}

const outDir = path.join(__dirname, '..', 'preview');
fs.mkdirSync(outDir, { recursive: true });
const cy = maxY * 0.42;
const views = [
  { name: 'a-exterior', yaw: 34, pitch: 12, dist: maxY * 1.5, target: [0, cy, 0], fov: 34 },
  { name: 'b-cutaway', yaw: 32, pitch: 10, dist: maxY * 1.45, target: [0, cy, 0], fov: 34, clipX: 0 },
  { name: 'c-front', yaw: 0, pitch: 4, dist: maxY * 1.5, target: [0, cy, 0], fov: 34 },
  { name: 'd-interior', yaw: 40, pitch: -4, dist: 62, target: [0, M.floorY[0] + 12, 0], fov: 40, clipX: 2, hide: { roof: 1 } },
  { name: 'e-lower-cut', yaw: 30, pitch: 6, dist: 78, target: [0, M.floorY[1], 0], fov: 34, clipX: 0 },
];
for (const v of views) {
  const t0 = Date.now();
  const r = render(model, Object.assign({ w: 300, h: 420 }, v));
  writePNG(path.join(outDir, v.name + '.png'), r.col, r.W, r.H, 2);
  console.log('rendered', v.name, r.boxes, 'boxes', (Date.now() - t0) + 'ms');
}

/* ASCII 自查：按需渲染低分辨率字符图 */
const want = process.argv.slice(2);
if (want.length) {
  for (const spec of want) {
    const [name, mode] = spec.split(':');
    const v = views.find(v => v.name.indexOf(name) >= 0);
    if (!v) { console.log('no view', name); continue; }
    const r = render(model, Object.assign({ w: 108, h: 74 }, v));
    console.log('\n===== ' + v.name + ' [' + (mode || 'kind') + '] =====');
    console.log(ascii(r, mode || 'kind'));
  }
  console.log('\nlegend: ' + Object.entries(KCH).map(([k, c]) => c + '=' + k).join('  '));
}
