/* =============================================================================
 *  app.js — 零依赖 WebGL2 体素像素渲染器（中国古代楼阁式木塔 3D 剖视）
 *    · 合并顶点缓冲（按 构件类别 × 楼层 分组，便于显隐 / 透明 / 剖切）
 *    · 量化平行光 + 体素面边勾线  → 像素画质感
 *    · 低分辨率离屏渲染 + NEAREST 放大 + 深度描边 → 精致像素风
 *    · 透视：X 光半透明 / 任意角度半剖 / 逐层水平剖切 / 层间爆炸展开
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------ 4×4 矩阵 */
  function mIdent() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function mMul(a, b, o) {
    o = o || new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
    return o;
  }
  function mPersp(fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
    o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
    return o;
  }
  function mLook(e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }
  function mInv(m) {
    const o = new Float32Array(16), a = m;
    const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4],
      b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6],
      b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12],
      b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
    let d = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!d) return mIdent(); d = 1 / d;
    o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * d; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * d;
    o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * d; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * d;
    o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * d; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * d;
    o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * d; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * d;
    o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * d; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * d;
    o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * d; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * d;
    o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * d; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * d;
    o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * d; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * d;
    return o;
  }

  /* ------------------------------------------------------------- GL 初始化 */
  const cv = document.getElementById('gl');
  const gl = cv.getContext('webgl2', { antialias: false, alpha: false, depth: true, preserveDrawingBuffer: true });
  if (!gl) { document.getElementById('fallback').style.display = 'grid'; return; }

  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name.replace('[0]', ''); u[nm] = gl.getUniformLocation(p, nm); }
    return { p: p, u: u };
  }

  /* ============================================================ 着色器 */
  const V_MAIN = `#version 300 es
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm;
  layout(location=2) in vec2 aUv;  layout(location=3) in vec2 aSiz; layout(location=4) in vec3 aCol;
  uniform mat4 uVP; uniform vec3 uOff;
  out vec3 vW;
  out vec3 vN;
  out vec2 vUv;
  out vec2 vSiz;
  out vec3 vCol;
  void main(){ vec3 p = aPos + uOff; vW=p; vN=aNrm; vUv=aUv; vSiz=aSiz; vCol=aCol; gl_Position = uVP*vec4(p,1.0); }`;

  const F_MAIN = `#version 300 es
  precision highp float;
  in vec3 vW;
  in vec3 vN;
  in vec2 vUv;
  in vec2 vSiz;
  in vec3 vCol;
  uniform vec3 uEye; uniform vec3 uSky; uniform float uNight;
  uniform float uEdge; uniform float uAlpha;
  uniform vec4 uClip;
  uniform float uYCut;
  uniform float uHi;
  out vec4 oCol;
  void main(){
    if (vW.y > uYCut) discard;
    if (uClip.w > 0.5 && (vW.x*uClip.x + vW.z*uClip.y) > uClip.z) discard;
    vec3 L = normalize(vec3(-0.46,0.80,0.38));
    float nl = dot(normalize(vN), L);
    float s = nl>0.80 ? 1.15 : (nl>0.34 ? 1.0 : (nl>-0.10 ? 0.80 : (nl>-0.62 ? 0.66 : 0.55)));
    vec3 c = vCol * s;
    c += vec3(0.045,0.062,0.095) * max(0.0, vN.y) * (1.0-uNight*0.75);
    c += vec3(0.055,0.030,0.012) * max(0.0,-vN.y) * (1.0-uNight);
    float d = min(min(vUv.x,1.0-vUv.x)*vSiz.x, min(vUv.y,1.0-vUv.y)*vSiz.y);
    float e = d<0.085 ? (1.0-0.36*uEdge) : (d<0.19 ? (1.0-0.13*uEdge) : 1.0);
    c *= e;
    c = mix(c, c*vec3(0.40,0.46,0.72)+vec3(0.02,0.02,0.05), uNight);
    c *= uHi;
    float fog = clamp((length(vW-uEye)-140.0)/520.0, 0.0, 0.55);
    c = mix(c, uSky, fog);
    oCol = vec4(c, uAlpha);
  }`;

  const V_QUAD = `#version 300 es
  layout(location=0) in vec2 aP;
  out vec2 vUv;
  void main(){ vUv = aP*0.5+0.5; gl_Position = vec4(aP,0.0,1.0); }`;

  const F_SKY = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 oCol;
  uniform mat4 uInvVP; uniform vec3 uEye; uniform float uNight; uniform float uT;
  float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+34.5); return fract(p.x*p.y); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
  }
  void main(){
    vec4 h = uInvVP*vec4(vUv*2.0-1.0, 1.0, 1.0);
    vec3 d = normalize(h.xyz/h.w - uEye);
    vec3 dayLo = vec3(0.86,0.78,0.62), dayHi = vec3(0.30,0.50,0.74);
    vec3 ntLo  = vec3(0.10,0.11,0.20), ntHi  = vec3(0.03,0.04,0.10);
    float t = clamp(d.y*1.5+0.12, 0.0, 1.0);
    vec3 c = mix(mix(dayLo,dayHi,pow(t,0.72)), mix(ntLo,ntHi,pow(t,0.72)), uNight);
    vec3 sun = normalize(vec3(-0.46,0.42,0.38));
    float sd = dot(d, sun);
    c += vec3(1.0,0.86,0.62)*smoothstep(0.9975,0.9990,sd)*(1.0-uNight)*1.4;
    c += vec3(0.92,0.94,1.0)*smoothstep(0.9980,0.9993,sd)*uNight*1.5;
    c += vec3(1.0,0.72,0.38)*pow(max(sd,0.0),42.0)*0.22*(1.0-uNight);
    if (d.y > 0.02){
      vec2 q = d.xz/(d.y+0.22)*0.045 + vec2(uT*0.004, uT*0.0012);
      float n = noise(q*2.0)*0.55 + noise(q*4.7)*0.30 + noise(q*9.1)*0.15;
      n = smoothstep(0.50,0.78,n);
      float lv = floor(n*3.0)/3.0;
      vec3 cc = mix(vec3(0.98,0.95,0.90), vec3(0.42,0.44,0.55), uNight);
      c = mix(c, cc*(0.72+0.28*lv), lv*0.92*smoothstep(0.02,0.16,d.y));
    }
    if (uNight > 0.25 && d.y > 0.0){
      vec2 sp = floor((d.xz/(d.y+0.35))*95.0);
      float st = step(0.9965, hash(sp));
      c += vec3(1.0,0.98,0.92)*st*uNight*0.95;
    }
    oCol = vec4(c, 1.0);
  }`;

  const F_POST = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 oCol;
  uniform sampler2D uTex; uniform sampler2D uDep;
  uniform vec2 uTexel; uniform vec2 uNF; uniform float uOutline;
  float ez(vec2 uv){ float z=texture(uDep,uv).r*2.0-1.0; return (2.0*uNF.x*uNF.y)/(uNF.y+uNF.x-z*(uNF.y-uNF.x)); }
  void main(){
    vec3 c = texture(uTex, vUv).rgb;
    if (uOutline > 0.01){
      float z0 = ez(vUv);
      float m = 0.0;
      m = max(m, abs(ez(vUv+vec2(uTexel.x,0.0))-z0));
      m = max(m, abs(ez(vUv-vec2(uTexel.x,0.0))-z0));
      m = max(m, abs(ez(vUv+vec2(0.0,uTexel.y))-z0));
      m = max(m, abs(ez(vUv-vec2(0.0,uTexel.y))-z0));
      float k = step(0.028*z0 + 0.35, m);
      c *= mix(1.0, 0.42, k*uOutline);
    }
    float v = smoothstep(1.42,0.34,length(vUv-0.5)*1.52);
    c *= mix(1.0, v, 0.30);
    oCol = vec4(c, 1.0);
  }`;

  const PROG = program(V_MAIN, F_MAIN);
  const SKY = program(V_QUAD, F_SKY);
  const POST = program(V_QUAD, F_POST);

  /* 全屏三角形 */
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  /* ====================================================== 模型 + 场景 */
  const MODEL = PagodaModel.buildPagoda();
  const META = MODEL.meta, P = MODEL.palette;

  /* 塔外场景（庭院铺地 / 松树 / 石灯），由渲染层生成，可单独显隐 */
  function sceneBoxes() {
    const B = [], R = META.halfBase + 46;
    const add = (x, y, z, w, h, d, c, p) => B.push({ x: x, y: y, z: z, w: w, h: h, d: d, c: c, k: 'ground', l: -1, p: p });
    add(-R, -3, -R, R * 2, 3, R * 2, 0x53604a, '庭院地面');
    for (let t = -R; t <= R; t += 9) {
      add(t, -0.06, -R, 0.5, 0.12, R * 2, 0x606d54, '铺地砖缝');
      add(-R, -0.06, t, R * 2, 0.12, 0.5, 0x606d54, '铺地砖缝');
    }
    const hb = META.halfBase + 4;
    add(-hb, -0.2, -hb, hb * 2, 0.4, hb * 2, 0x8b9097, '散水');
    for (let t = -hb; t < hb; t += 6) {
      add(t, 0.18, -hb, 0.4, 0.12, hb * 2, 0x9aa0a8, '散水砖缝');
      add(-hb, 0.18, t, hb * 2, 0.12, 0.4, 0x9aa0a8, '散水砖缝');
    }
    const pine = (x, z, s) => {
      add(x - 1.2 * s, 0, z - 1.2 * s, 2.4 * s, 7 * s, 2.4 * s, 0x5a3a20, '松干');
      const lay = [[7.4, 5.4], [10.4, 4.4], [13.0, 3.2], [15.2, 2.0]];
      for (let i = 0; i < lay.length; i++) {
        const y = lay[i][0] * s, r = lay[i][1] * s;
        add(x - r, y, z - r, r * 2, 2.6 * s, r * 2, i % 2 ? 0x2c5c3f : 0x35704c, '松枝');
      }
      add(x - 1.0 * s, 17.0 * s, z - 1.0 * s, 2 * s, 1.6 * s, 2 * s, 0x2c5c3f, '松梢');
    };
    pine(-46, 38, 1.15); pine(44, 40, 0.92); pine(-52, -30, 1.0);
    pine(50, -40, 1.22); pine(20, 56, 0.85); pine(-24, -58, 1.05);
    const lamp = (x, z) => {
      add(x - 1.8, 0, z - 1.8, 3.6, 1.2, 3.6, 0x74797f, '石灯座');
      add(x - 0.8, 1.2, z - 0.8, 1.6, 3.0, 1.6, 0x8b9097, '石灯柱');
      add(x - 2.2, 4.2, z - 2.2, 4.4, 1.0, 4.4, 0x9aa0a8, '石灯托');
      add(x - 1.8, 5.2, z - 1.8, 3.6, 3.0, 3.6, 0xd9b075, '石灯火袋');
      add(x - 2.4, 8.2, z - 2.4, 4.8, 1.4, 4.8, 0x74797f, '石灯笠');
      add(x - 1.0, 9.6, z - 1.0, 2.0, 1.4, 2.0, 0x9aa0a8, '石灯宝珠');
    };
    lamp(-META.halfBase - 10, 26); lamp(META.halfBase + 10, 26);
    return B;
  }

  const ALL = MODEL.boxes.concat(sceneBoxes());

  /* ------------------------------------------------ 合并顶点缓冲（分组） */
  const FACES = [
    { n: [0, 1, 0], v: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], au: 0, av: 2 },
    { n: [0, -1, 0], v: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], au: 0, av: 2 },
    { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], au: 0, av: 1 },
    { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], au: 0, av: 1 },
    { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], au: 2, av: 1 },
    { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], au: 2, av: 1 },
  ];

  const groups = [];
  (function buildGroups() {
    const bins = new Map();
    for (const b of ALL) {
      const key = b.k + '#' + b.l;
      let g = bins.get(key);
      if (!g) { g = { kind: b.k, level: b.l, boxes: [] }; bins.set(key, g); }
      g.boxes.push(b);
    }
    for (const g of bins.values()) {
      const nb = g.boxes.length;
      const vert = new Float32Array(nb * 24 * 13);
      const idx = new Uint32Array(nb * 36);
      let vp = 0, ip = 0, vi = 0;
      let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
      for (const b of g.boxes) {
        const size = [b.w, b.h, b.d];
        const r = ((b.c >> 16) & 255) / 255, gg = ((b.c >> 8) & 255) / 255, bb = (b.c & 255) / 255;
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); z0 = Math.min(z0, b.z);
        x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); z1 = Math.max(z1, b.z + b.d);
        for (const f of FACES) {
          const su = size[f.au], sv = size[f.av];
          for (let k = 0; k < 4; k++) {
            const p = f.v[k];
            vert[vp++] = b.x + p[0] * b.w; vert[vp++] = b.y + p[1] * b.h; vert[vp++] = b.z + p[2] * b.d;
            vert[vp++] = f.n[0]; vert[vp++] = f.n[1]; vert[vp++] = f.n[2];
            vert[vp++] = p[f.au]; vert[vp++] = p[f.av];
            vert[vp++] = su; vert[vp++] = sv;
            vert[vp++] = r; vert[vp++] = gg; vert[vp++] = bb;
          }
          idx[ip++] = vi; idx[ip++] = vi + 1; idx[ip++] = vi + 2;
          idx[ip++] = vi; idx[ip++] = vi + 2; idx[ip++] = vi + 3;
          vi += 4;
        }
      }
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, vert, gl.STATIC_DRAW);
      const st = 13 * 4;
      const attr = [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 2, 32], [4, 3, 40]];
      for (const a of attr) { gl.enableVertexAttribArray(a[0]); gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, st, a[2]); }
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      groups.push({
        kind: g.kind, level: g.level, vao: vao, count: ip, nb: nb,
        c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      });
      g.boxes = null;
    }
    groups.sort((a, b) => (a.level - b.level) || (a.kind < b.kind ? -1 : 1));
  })();

  /* ------------------------------------------------------------ 离屏 FBO */
  let fbo = null, texC = null, texD = null, fw = 0, fh = 0;
  function ensureFBO(w, h) {
    if (fbo && w === fw && h === fh) return;
    fw = w; fh = h;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(texC); gl.deleteTexture(texD); }
    const np = [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]];
    texC = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texC);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const p of np) gl.texParameteri(gl.TEXTURE_2D, p[0], p[1]);
    texD = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texD);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    for (const p of np) gl.texParameteri(gl.TEXTURE_2D, p[0], p[1]);
    fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texC, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texD, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ============================================================ 状态 */
  const SHELL = { base: 1, wall: 1, roof: 1, rail: 1, finial: 1 };
  const KIND_LABEL = {
    base: ['台基须弥座', P.stone], frame: ['柱额·斗拱·梁架', P.red], wall: ['墙体·板门·直棂窗', P.wall],
    roof: ['腰檐·瓦垄·翼角', P.tile], rail: ['平座·勾栏', P.redL], floor: ['楼板·楞木', P.plank],
    stair: ['木楼梯', P.woodL], core: ['塔心柱', P.woodM], furn: ['佛像·陈设·宫灯', P.gold],
    finial: ['塔刹·相轮·宝珠', P.goldL], ground: ['庭院·松树·石灯', 0x53604a],
  };
  const S = {
    mode: 'solid', focus: -1, xray: 0.16, cutA: 45, cutD: 0, cutIn: false, exp: 18,
    px: 3, edge: 0.70, outline: 0.62, night: 0, spin: true, anno: false,
    kindOn: {}, inside: false,
  };
  for (const k in KIND_LABEL) S.kindOn[k] = true;

  const cam = {
    tx: 0, ty: META.totalHeight * 0.44, tz: 0, yaw: 0.60, pitch: 0.22, dist: META.totalHeight * 1.78,
  };
  const camHome = Object.assign({}, cam);

  /* ============================================================ 交互 */
  let drag = null;
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, pan: (e.button === 2 || e.shiftKey) };
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const sx = Math.sin(cam.yaw), cz = Math.cos(cam.yaw), k = cam.dist * 0.0016;
      cam.tx -= (dx * cz - dy * sx * Math.sin(cam.pitch)) * k;
      cam.tz -= (-dx * sx - dy * cz * Math.sin(cam.pitch)) * k;
      cam.ty += dy * Math.cos(cam.pitch) * k;
      cam.ty = Math.max(-4, Math.min(META.totalHeight * 1.25, cam.ty));
    } else {
      cam.yaw -= dx * 0.0062; cam.pitch += dy * 0.0050;
      cam.pitch = Math.max(-1.30, Math.min(1.44, cam.pitch));
    }
  });
  const endDrag = () => { drag = null; };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    cam.dist = Math.max(11, Math.min(760, cam.dist * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });
  let pinch = 0;
  cv.addEventListener('touchstart', e => { if (e.touches.length === 2) pinch = touchDist(e); }, { passive: true });
  cv.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && pinch) {
      const d = touchDist(e);
      cam.dist = Math.max(11, Math.min(760, cam.dist * (pinch / d)));
      pinch = d; drag = null;
    }
  }, { passive: true });
  function touchDist(e) {
    return Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  }

  /* ============================================================ UI */
  const $ = id => document.getElementById(id);
  function bindRange(id, fmt, set) {
    const el = $(id), out = $('v-' + id);
    const upd = () => { const v = +el.value; set(v); if (out) out.textContent = fmt(v); };
    el.addEventListener('input', upd); upd();
  }
  bindRange('cutA', v => v + '°', v => S.cutA = v);
  bindRange('cutD', v => v, v => S.cutD = v);
  bindRange('xray', v => v + '%', v => S.xray = v / 100);
  bindRange('exp', v => v, v => S.exp = v);
  bindRange('px', v => v + '×', v => S.px = v);
  bindRange('edge', v => v + '%', v => S.edge = v / 100);
  bindRange('out', v => v + '%', v => S.outline = v / 100);
  bindRange('night', v => (v < 20 ? '昼' : v < 55 ? '暮' : '夜'), v => S.night = v / 100);
  $('cutIn').addEventListener('change', e => S.cutIn = e.target.checked);
  $('anno').addEventListener('change', e => { S.anno = e.target.checked; if (!S.anno) clearLabels(); });

  function setMode(m) {
    S.mode = m;
    for (const b of $('mode').children) b.classList.toggle('on', b.dataset.m === m);
    $('r-cutA').style.display = $('r-cutD').style.display = $('r-cutIn').style.display = (m === 'cut' ? '' : 'none');
    $('r-xray').style.display = (m === 'xray' ? '' : 'none');
    $('r-exp').style.display = (m === 'explode' ? '' : 'none');
  }
  for (const b of $('mode').children) b.addEventListener('click', () => setMode(b.dataset.m));
  setMode('solid');

  function setFocus(l) {
    S.focus = l;
    for (const b of $('lvsel').children) b.classList.toggle('on', +b.dataset.l === l);
    const li = META.levelInfo[l];
    $('lvname').textContent = l < 0 ? '全塔通览' : li.name;
    $('lvinfo').innerHTML = l < 0
      ? '通高 ' + META.totalHeight.toFixed(0) + ' 单位 ｜ 台基 ' + (META.halfBase * 2).toFixed(0)
      + '×' + (META.halfBase * 2).toFixed(0) + '<br>共 ' + META.boxCount.toLocaleString() + ' 个体素方块'
      : '楼板标高 ' + li.floorY + ' ｜ 檐口 ' + li.roofBase.toFixed(0)
      + '<br>面阔 ' + (li.halfWall * 2).toFixed(0) + ' ｜ 出檐至 ' + (li.eaveHalf * 2).toFixed(0)
      + '<br>' + (l < META.levels - 1 ? '设木楼梯通上层' : '顶层：藻井·梁架·塔刹');
    if (l >= 0) { cam.ty = li.floorY + 9; if (!S.inside) cam.dist = Math.min(cam.dist, 130); }
    else { cam.ty = META.totalHeight * 0.44; }
  }
  for (const b of $('lvsel').children) b.addEventListener('click', () => setFocus(+b.dataset.l));

  const kindsBox = $('kinds');
  for (const k in KIND_LABEL) {
    const nm = KIND_LABEL[k][0], col = KIND_LABEL[k][1];
    const lab = document.createElement('label');
    lab.innerHTML = '<input type="checkbox" checked><span class="sw" style="background:#'
      + col.toString(16).padStart(6, '0') + '"></span>' + nm;
    (function (key) {
      lab.querySelector('input').addEventListener('change', e => { S.kindOn[key] = e.target.checked; });
    })(k);
    kindsBox.appendChild(lab);
  }

  $('spin').addEventListener('click', e => { S.spin = !S.spin; e.target.classList.toggle('on', S.spin); });
  $('reset').addEventListener('click', () => { Object.assign(cam, camHome); S.inside = false; setFocus(-1); });
  $('inside').addEventListener('click', () => {
    S.inside = true;
    const l = S.focus < 0 ? 0 : S.focus;
    if (S.focus < 0) setFocus(l);
    const li = META.levelInfo[l];
    cam.tx = 0; cam.tz = 0; cam.ty = li.floorY + 7; cam.dist = 15; cam.pitch = 0.06;
  });
  $('outside').addEventListener('click', () => {
    S.inside = false;
    cam.dist = META.totalHeight * (S.focus < 0 ? 1.78 : 1.0);
    cam.pitch = 0.22;
  });
  $('toggle').addEventListener('click', () => $('ui').classList.toggle('hide'));
  $('shot').addEventListener('click', () => {
    cv.toBlob(function (b) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = '木塔像素剖视_' + Date.now() + '.png';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  });
  addEventListener('keydown', e => {
    const k = (e.key || '').toLowerCase();
    if (k === '1') setMode('solid'); else if (k === '2') setMode('xray');
    else if (k === '3') setMode('cut'); else if (k === '4') setMode('explode');
    else if (k === '0') $('reset').click();
    else if (k === 'q') { S.kindOn.roof = !S.kindOn.roof; syncKinds(); }
    else if (k === 'w') { S.kindOn.wall = !S.kindOn.wall; syncKinds(); }
    else if (k === ' ') { e.preventDefault(); $('spin').click(); }
    else if (k >= '5' && k <= '9') setFocus(Math.min(META.levels - 1, +k - 5));
  });
  function syncKinds() {
    let i = 0;
    for (const key in KIND_LABEL) {
      const row = kindsBox.children[i];
      const inp = row && row.querySelector('input');
      if (inp) inp.checked = S.kindOn[key];
      i++;
    }
  }

  /* ============================================================ 标注 */
  const labelBox = $('labels');
  let labelEls = [];
  function clearLabels() { labelBox.innerHTML = ''; labelEls = []; }
  function updateLabels(vp, w, h) {
    if (!S.anno) return;
    const src = MODEL.labels;
    if (labelEls.length !== src.length) {
      clearLabels();
      for (const l of src) {
        const d = document.createElement('div');
        d.textContent = l.text; labelBox.appendChild(d); labelEls.push(d);
      }
    }
    for (let i = 0; i < src.length; i++) {
      const l = src[i], el = labelEls[i];
      const y = l.y + levelOffset(l.l < 0 ? 0 : l.l);
      if (y > yCut() || !S.kindOn[l.k]) { el.style.display = 'none'; continue; }
      const cw = vp[3] * l.x + vp[7] * y + vp[11] * l.z + vp[15];
      if (cw < 0.5) { el.style.display = 'none'; continue; }
      const sx = (vp[0] * l.x + vp[4] * y + vp[8] * l.z + vp[12]) / cw;
      const sy = (vp[1] * l.x + vp[5] * y + vp[9] * l.z + vp[13]) / cw;
      if (sx < -1.05 || sx > 1.05 || sy < -1.05 || sy > 1.05) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.left = ((sx * 0.5 + 0.5) * w) + 'px';
      el.style.top = ((1 - (sy * 0.5 + 0.5)) * h) + 'px';
    }
  }

  /* ============================================================ 渲染 */
  function yCut() { return S.focus < 0 ? 1e9 : META.floorY[S.focus] + META.storyPitch * 0.99; }
  function levelOffset(l) { return (S.mode === 'explode' && l >= 0) ? l * S.exp : 0; }

  let fps = 0, fpsT = 0, frames = 0;
  function frame(t) {
    const w = cv.clientWidth | 0, h = cv.clientHeight | 0;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (cv.width !== (w * dpr | 0) || cv.height !== (h * dpr | 0)) { cv.width = w * dpr | 0; cv.height = h * dpr | 0; }
    /* 像素粒度按 CSS 像素计（放大倍率 = px × dpr，整数倍 → 像素边缘锐利） */
    const rw = Math.max(160, Math.round(w / S.px)), rh = Math.max(120, Math.round(h / S.px));
    ensureFBO(rw, rh);

    if (S.spin && !drag) cam.yaw += 0.0022;

    const near = 1.2, far = Math.max(600, cam.dist * 3.2 + META.totalHeight * 2);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const eye = [cam.tx + cam.dist * cp * Math.sin(cam.yaw), cam.ty + cam.dist * sp, cam.tz + cam.dist * cp * Math.cos(cam.yaw)];
    const proj = mPersp(38 * Math.PI / 180, rw / rh, near, far);
    const view = mLook(eye, [cam.tx, cam.ty, cam.tz], [0, 1, 0]);
    const vp = mMul(proj, view);
    const invVP = mInv(vp);

    const skyC = [
      0.30 * (1 - S.night) + 0.05 * S.night,
      0.40 * (1 - S.night) + 0.06 * S.night,
      0.56 * (1 - S.night) + 0.13 * S.night];

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, rw, rh);
    gl.clearColor(skyC[0], skyC[1], skyC[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* 天空 */
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.useProgram(SKY.p);
    gl.uniformMatrix4fv(SKY.u.uInvVP, false, invVP);
    gl.uniform3fv(SKY.u.uEye, eye);
    gl.uniform1f(SKY.u.uNight, S.night);
    gl.uniform1f(SKY.u.uT, t * 0.001);
    gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* 塔体 */
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.useProgram(PROG.p);
    gl.uniformMatrix4fv(PROG.u.uVP, false, vp);
    gl.uniform3fv(PROG.u.uEye, eye);
    gl.uniform3fv(PROG.u.uSky, skyC);
    gl.uniform1f(PROG.u.uNight, S.night);
    gl.uniform1f(PROG.u.uEdge, S.edge);
    gl.uniform1f(PROG.u.uYCut, yCut());

    const a = S.cutA * Math.PI / 180;
    const clip = [Math.cos(a), Math.sin(a), S.cutD, 0];
    const xray = S.mode === 'xray';

    const vis = groups.filter(g => S.kindOn[g.kind] &&
      !(S.focus >= 0 && g.level > S.focus && g.level >= 0));
    const opaque = [], trans = [];
    for (const g of vis) (xray && SHELL[g.kind] ? trans : opaque).push(g);
    trans.sort(function (p, q) {
      const dp = (p.c[0] - eye[0]) * (p.c[0] - eye[0]) + (p.c[1] - eye[1]) * (p.c[1] - eye[1]) + (p.c[2] - eye[2]) * (p.c[2] - eye[2]);
      const dq = (q.c[0] - eye[0]) * (q.c[0] - eye[0]) + (q.c[1] - eye[1]) * (q.c[1] - eye[1]) + (q.c[2] - eye[2]) * (q.c[2] - eye[2]);
      return dq - dp;
    });

    function drawGroup(g, alpha) {
      const useClip = (S.mode === 'cut') && (SHELL[g.kind] || (S.cutIn && g.kind !== 'ground'));
      clip[3] = useClip ? 1 : 0;
      gl.uniform4fv(PROG.u.uClip, clip);
      gl.uniform1f(PROG.u.uAlpha, alpha);
      gl.uniform1f(PROG.u.uHi, (S.focus >= 0 && g.level === S.focus) ? 1.10 : 1.0);
      gl.uniform3f(PROG.u.uOff, 0, levelOffset(g.level), 0);
      gl.bindVertexArray(g.vao);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.BLEND); gl.depthMask(true);
    for (const g of opaque) drawGroup(g, 1);
    if (trans.length) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      for (const g of trans) drawGroup(g, S.xray);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }

    /* 后处理：NEAREST 放大 + 深度描边 */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(POST.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texC); gl.uniform1i(POST.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texD); gl.uniform1i(POST.u.uDep, 1);
    gl.uniform2f(POST.u.uTexel, 1 / rw, 1 / rh);
    gl.uniform2f(POST.u.uNF, near, far);
    gl.uniform1f(POST.u.uOutline, S.outline);
    gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLES, 0, 3);

    updateLabels(vp, w, h);

    frames++;
    if (t - fpsT > 500) { fps = Math.round(frames * 1000 / (t - fpsT)); frames = 0; fpsT = t; }
    $('stat').textContent = META.boxCount.toLocaleString() + ' 方块 ｜ ' + vis.length + ' 批次 ｜ '
      + rw + '×' + rh + ' ｜ ' + fps + ' fps';

    requestAnimationFrame(frame);
  }

  setFocus(-1);
  requestAnimationFrame(frame);
})();
