/* =============================================================================
 *  pagoda-model.js  —  中国古代楼阁式木塔 · 体素(像素)模型生成器
 *  纯 JS，无依赖；可在浏览器 (window.PagodaModel) 与 Node (require) 中运行。
 *
 *  产出：一组轴对齐方块 (box) 规格 —— 由渲染层合并为顶点缓冲。
 *    box = { x,y,z, w,h,d, c, k, l, p }
 *      x,y,z : 最小角坐标（Y 向上，+Z 为塔正面）
 *      w,h,d : 尺寸
 *      c     : 颜色 0xRRGGBB
 *      k     : 构件类别 kind  见 KINDS
 *      l     : 层号 level（-1 = 台基，levels = 塔刹）
 *      p     : 构件名（中文，用于标注与图例）
 *
 *  形制参考：辽·应县木塔（佛宫寺释迦塔）一类"楼阁式"多层木塔——
 *    须弥座台基 → 每层：柱础·檐柱·阑额·普拍枋·斗拱·腰檐(筒瓦垄+戗脊+起翘飞檐)
 *    → 平座(勾栏) → 上层；内部：内槽柱·梁架·楞木·楼板·折转木楼梯·塔心柱
 *    → 顶层攒尖顶 → 塔刹（覆钵·相轮·宝盖·宝珠·铁链）
 * ========================================================================== */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.PagodaModel = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 调色板 */
  const P = {
    stoneD: 0x54585f, stone: 0x74797f, stoneL: 0x91969d, stoneW: 0xb0b5bc,
    woodD: 0x452c19, wood: 0x644025, woodM: 0x855832, woodL: 0xa87b46,
    plank: 0xc0955a, plankL: 0xd6ae74,
    redD: 0x6b2318, red: 0x9b3325, redL: 0xc04f36, redH: 0xd97a56,
    tileD: 0x232d3a, tile: 0x394759, tileL: 0x53667e, tileH: 0x6f849e,
    wall: 0xe2d8bd, wallD: 0xc2b492,
    gold: 0xd8a63b, goldL: 0xf3d275,
    green: 0x2c6a4e, greenL: 0x458a67,
    lamp: 0xf1913c, lampL: 0xffd48f,
    ink: 0x24242c, black: 0x15151a, white: 0xf2eee3,
  };

  /* 构件类别：外壳类会被"透视/剖切"处理，内构类保持实体 */
  const KINDS = {
    base: { name: '台基·须弥座', shell: true, color: P.stone },
    frame: { name: '柱额·斗拱·梁架', shell: false, color: P.red },
    wall: { name: '墙体·板门·直棂窗', shell: true, color: P.wall },
    roof: { name: '腰檐·瓦垄·戗脊', shell: true, color: P.tile },
    rail: { name: '平座·勾栏', shell: true, color: P.redL },
    floor: { name: '楼板·楞木', shell: false, color: P.plank },
    stair: { name: '木楼梯', shell: false, color: P.woodL },
    core: { name: '塔心柱', shell: false, color: P.woodM },
    furn: { name: '佛像·陈设·灯笼', shell: false, color: P.gold },
    finial: { name: '塔刹·相轮·宝珠', shell: true, color: P.gold },
  };

  /* ------------------------------------------------------------ 小工具 */
  function rotRect(times, x, z, w, d) {
    // 绕 Y 轴每次逆时针 90°: (x,z) -> (-z, x)
    let X = x, Z = z, W = w, D = d;
    for (let i = 0; i < (times & 3); i++) {
      const nx = -(Z + D), nz = X, nw = D, nd = W;
      X = nx; Z = nz; W = nw; D = nd;
    }
    return [X, Z, W, D];
  }

  function Builder() {
    this.boxes = [];
    this.labels = [];
    this.rot = 0;
  }
  Builder.prototype.box = function (x, y, z, w, h, d, c, k, l, p) {
    if (w <= 0 || h <= 0 || d <= 0) return;
    const r = rotRect(this.rot, x, z, w, d);
    this.boxes.push({ x: r[0], y: y, z: r[1], w: r[2], h: h, d: r[3], c: c, k: k, l: l, p: p });
  };
  /* 中心定位方块 */
  Builder.prototype.cb = function (cx, y, cz, w, h, d, c, k, l, p) {
    this.box(cx - w / 2, y, cz - d / 2, w, h, d, c, k, l, p);
  };
  Builder.prototype.label = function (text, x, y, z, k, l) {
    const r = rotRect(this.rot, x, z, 0, 0);
    this.labels.push({ text: text, x: r[0], y: y, z: r[1], k: k, l: l });
  };

  /* ============================================================ 主生成器 */
  function buildPagoda(userCfg) {
    const cfg = Object.assign({
      levels: 5,
      halfWall: [18, 16.5, 15, 13.5, 12], // 各层檐柱中线半宽
      eaveOut: 8,                          // 出檐（水平出跳）
      wallH: 11,                           // 檐柱高
      storyPitch: 20,                      // 层高（楼板面到楼板面）
      baseH: 5,
      colS: 1.5,                           // 柱径
    }, userCfg || {});

    const B = new Builder();
    const L = cfg.levels;
    const halfWall = cfg.halfWall.slice(0, L);
    const eaveHalf = halfWall.map(h => h + cfg.eaveOut);
    const innerHalf = halfWall.map(h => h - cfg.colS);
    const halfBase = halfWall[0] + 12;

    const floorY = [];
    for (let i = 0; i < L; i++) floorY.push(cfg.baseH + i * cfg.storyPitch);
    const inOffs = halfWall.map(h => Math.round(h * 0.42 * 2) / 2);   // 内槽柱位置
    const levelInfo = [];

    /* 楼梯定位：置于"外槽"走道（内槽柱与檐柱之间）。
       每层转向自动避让下层楼梯井：候选转角依次试算，取第一个平面上不冲突者。 */
    function stairSpec(i) {
      const wide = 4.0;
      const zo = -(halfWall[i] - 3.0);
      const n = 15, tread = 1.25, rise = cfg.storyPitch / n;
      const run = n * tread;
      const x0 = -run / 2 + 1.0;
      return {
        i: i, x0: x0, zo: zo, wide: wide, n: n, tread: tread, rise: rise, run: run, rot: 0,
        hole: { x0: x0 + run - 9.0, x1: x0 + run + 1.2, z0: zo - 0.4, z1: zo + wide + 0.4 },
        foot: { x0: x0 - 1.9, x1: x0 + run + 1.3, z0: zo - 0.5, z1: zo + wide + 0.5 },
      };
    }
    function rectOf(rot, r, pad) {
      const q = rotRect(rot, r.x0 - (pad || 0), r.z0 - (pad || 0), r.x1 - r.x0 + 2 * (pad || 0), r.z1 - r.z0 + 2 * (pad || 0));
      return { x0: q[0], x1: q[0] + q[2], z0: q[1], z1: q[1] + q[3] };
    }
    function overlap(a, b) { return a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1; }

    const stairs = [];
    for (let i = 0; i < L - 1; i++) {
      const sp = stairSpec(i);
      if (i === 0) sp.rot = 0;
      else {
        const prev = stairs[i - 1];
        const prevHole = rectOf(prev.rot, prev.hole, 1.6);   // 下层楼梯井 + 井口勾栏占位
        let best = (prev.rot + 1) & 3;
        for (let k = 1; k <= 4; k++) {
          const r = (prev.rot + k) & 3;
          if (!overlap(rectOf(r, sp.foot, 0), prevHole)) { best = r; break; }
        }
        sp.rot = best;
      }
      stairs.push(sp);
    }

    /* 陈设朝向：既不占本层梯道，也不挡下层楼梯井上口；一层佛坛须正对敞开的正门 */
    function furnRot(i) {
      if (i === 0) return 0;
      const bad = new Set();
      if (i < L - 1) bad.add(stairs[i].rot);
      if (i > 0) bad.add(stairs[i - 1].rot);
      const first = (i < L - 1 ? stairs[i].rot + 2 : stairs[i - 1].rot + 2) & 3;
      for (const r of [first, 0, 1, 2, 3]) if (!bad.has(r & 3)) return r & 3;
      return first;
    }

    /* ---------------------------------------------------- 台基 · 须弥座 */
    addBase(B, halfBase, cfg.baseH);
    addFrontSteps(B, halfBase, cfg.baseH);
    addLion(B, -10.5, 0, halfBase + 7.5);
    addLion(B, 10.5, 0, halfBase + 7.5);
    B.label('须弥座台基', 0, 2.5, halfBase + 1, 'base', -1);

    /* ------------------------------------------------------ 塔心柱（通高）*/
    const coreTop = floorY[L - 1] + 14 + topRoofRise(eaveHalf[L - 1]) - 2;
    B.cb(0, 0, 0, 3, coreTop, 3, P.woodM, 'core', -1, '塔心柱');
    for (let y = 6; y < coreTop - 4; y += cfg.storyPitch / 2) {
      B.cb(0, y, 0, 3.6, 0.8, 3.6, P.woodD, 'core', -1, '塔心柱铁箍');
    }
    B.label('塔心柱（通高·承塔刹）', 2.4, floorY[2] + 6, 0, 'core', -1);

    /* ================================================== 逐层生成 */
    for (let i = 0; i < L; i++) {
      const hw = halfWall[i], eh = eaveHalf[i], ih = innerHalf[i];
      const fy = floorY[i];
      const plinthTop = fy + 1;
      const colTop = plinthTop + cfg.wallH;
      const archTop = colTop + 1.5;   // 阑额 + 普拍枋
      const dgTop = archTop + 2.5;    // 斗拱
      const roofBase = dgTop;
      const isTop = (i === L - 1);

      /* ---- 楼板（含塔心柱洞、下层楼梯井洞） ---- */
      const holes = [];
      holes.push({ x0: -2.2, x1: 2.2, z0: -2.2, z1: 2.2 });     // 塔心柱
      if (i > 0) {
        const s = stairs[i - 1];
        const r = rectOf(s.rot, s.hole, 0);                 // 下层楼梯井
        holes.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 });
      }
      addFloor(B, i, fy, hw - 0.2, holes, i === 0);

      /* ---- 柱网：檐柱 12 根（三开间）+ 内槽柱 4 根 ---- */
      const bay = hw;                       // 角柱在 ±hw
      const midOff = hw / 3;                // 补间柱（三开间 → 两根中柱）
      const colX = [-bay, -midOff, midOff, bay];
      const colZ = [-bay, -midOff, midOff, bay];
      for (const cx of colX) {
        for (const cz of colZ) {
          const edge = (Math.abs(cx) === bay) || (Math.abs(cz) === bay);
          if (!edge) continue;             // 只保留周圈柱
          B.cb(cx, fy, cz, cfg.colS + 1.2, 1, cfg.colS + 1.2, P.stoneL, 'frame', i, '柱础');
          B.cb(cx, plinthTop, cz, cfg.colS, cfg.wallH, cfg.colS, P.red, 'frame', i, '檐柱');
          B.cb(cx, colTop - 0.6, cz, cfg.colS + 0.5, 0.6, cfg.colS + 0.5, P.redD, 'frame', i, '柱头');
        }
      }
      const inOff = inOffs[i];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        B.cb(sx * inOff, fy, sz * inOff, 2.4, 0.8, 2.4, P.stoneL, 'frame', i, '内柱础');
        B.cb(sx * inOff, fy + 0.8, sz * inOff, 1.6, cfg.wallH + 1.2, 1.6, P.redD, 'frame', i, '内槽柱');
      }
      if (i === 0) B.label('檐柱·柱础', hw, plinthTop + 4, hw, 'frame', i);
      if (i === 1) B.label('内槽柱', inOff, fy + 6, inOff, 'frame', i);

      /* ---- 阑额 / 普拍枋 / 地栿（周圈联系） ---- */
      for (const s of [-1, 1]) {
        B.cb(0, colTop, s * hw, hw * 2 + cfg.colS, 1.1, 1.2, P.redD, 'frame', i, '阑额');
        B.cb(s * hw, colTop, 0, 1.2, 1.1, hw * 2 + cfg.colS, P.redD, 'frame', i, '阑额');
        B.cb(0, colTop + 1.1, s * hw, hw * 2 + 3.4, 0.5, 2.0, P.woodM, 'frame', i, '普拍枋');
        B.cb(s * hw, colTop + 1.1, 0, 2.0, 0.5, hw * 2 + 3.4, P.woodM, 'frame', i, '普拍枋');
        B.cb(0, fy + 0.9, s * hw, hw * 2, 0.8, 1.0, P.woodD, 'frame', i, '地栿');
        B.cb(s * hw, fy + 0.9, 0, 1.0, 0.8, hw * 2, P.woodD, 'frame', i, '地栿');
      }

      /* ---- 内部梁架：内额 + 四椽栿大梁 + 井字次梁（随本层楼梯方向布置，避让通道） ---- */
      for (const s of [-1, 1]) {
        B.cb(0, colTop - 1.2, s * inOff, inOff * 2 + 1.6, 1.0, 1.4, P.wood, 'frame', i, '内额');
        B.cb(s * inOff, colTop - 1.2, 0, 1.4, 1.0, inOff * 2 + 1.6, P.wood, 'frame', i, '内额');
      }
      B.rot = isTop ? 0 : stairs[i].rot;
      for (const s of [-1, 1]) {
        // 大梁沿 X 架于内槽柱之上，直抵檐柱（与本层楼梯走向垂直，不跨越梯道）
        B.cb(0, colTop + 1.6, s * inOff, hw * 2 + 1, 1.5, 1.8, P.wood, 'frame', i, '大梁（四椽栿）');
        // 井字次梁只在内槽范围内
        B.cb(s * inOff, colTop + 1.6, 0, 1.8, 1.5, inOff * 2 - 0.2, P.woodM, 'frame', i, '次梁（平梁）');
      }
      for (const s of [-1, 1]) {
        B.cb(0, colTop + 3.1, s * (inOff * 0.55), inOff * 2, 1.2, 1.4, P.woodM, 'frame', i, '襻间枋');
      }
      B.rot = 0;
      /* 叉手 / 托脚（斜撑）—— 用阶梯方块近似斜料 */
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        for (let t = 0; t < 3; t++) {
          B.cb(sx * (hw - 1.2 - t * 1.1), colTop - 1.4 - t * 0.9, sz * (hw - 1.2 - t * 1.1),
            1.5, 1.0, 1.5, P.woodM, 'frame', i, '角替·斜撑');
        }
      }

      /* ---- 墙身：三开间（当心间板门 + 次间直棂窗） ---- */
      addWalls(B, i, hw, plinthTop, cfg.wallH, midOff, cfg.colS, i === 0);

      /* ---- 斗拱：转角铺作 4 + 补间铺作 8 ---- */
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        addDougong(B, i, sx * hw, archTop, sz * hw, sx, sz, true);
      }
      for (const s of [-1, 1]) {
        for (const m of [-midOff, midOff]) {
          addDougong(B, i, m, archTop, s * hw, 0, s, false);
          addDougong(B, i, s * hw, archTop, m, s, 0, false);
        }
      }
      if (i === 0) B.label('斗拱（转角铺作）', hw + 2, archTop + 2, hw + 2, 'frame', i);

      /* ---- 腰檐 / 顶层攒尖顶 ---- */
      const innerStop = isTop ? 1.5 : halfWall[i + 1] + 1.0;
      const roofTop = addRoof(B, i, roofBase, eh, innerStop, isTop);

      /* ---- 檐下椽子（自内向外的辐射椽，仰视可见） ---- */
      addRafters(B, i, roofBase - 0.6, hw + 1, eh);

      /* ---- 楼梯（顶层不设向上楼梯） ---- */
      if (!isTop) {
        B.rot = stairs[i].rot;
        addStairs(B, i, fy, stairs[i]);
        addWellRail(B, i + 1, floorY[i + 1], stairs[i].hole);
        B.rot = 0;
      }

      /* ---- 平座勾栏（第 2 层及以上，坐落于下层腰檐之上） ---- */
      if (i + 1 < L) {
        const bh = halfWall[i + 1] + 4.5;
        addBalcony(B, i + 1, floorY[i + 1], bh, halfWall[i + 1]);
      }

      /* ---- 室内陈设（避开本层梯道与下层楼梯井上口） ---- */
      const safe = Math.min(inOff + 0.8,
        (i < L - 1 ? hw - 7.7 : Infinity),
        (i > 0 ? halfWall[i - 1] - 7.7 : Infinity));
      B.rot = furnRot(i);
      addFurniture(B, i, fy, ih, inOff, isTop, safe);
      B.rot = 0;

      /* ---- 檐角风铃 ---- */
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        addBell(B, i, sx * (eh + 3.6), roofBase + 2.2, sz * (eh + 3.6));
      }

      levelInfo.push({
        level: i, floorY: fy, colTop: colTop, roofBase: roofBase, roofTop: roofTop,
        halfWall: hw, eaveHalf: eh, innerHalf: ih,
        name: ['一层（佛坛·释迦像）', '二层（经藏）', '三层（禅室）', '四层（藏经柜）', '五层（藻井·宝顶下）'][i] || ('第' + (i + 1) + '层'),
      });
      if (i === 0) B.label('腰檐·筒瓦垄', 0, roofBase + 3, eh + 1, 'roof', i);
      if (i === 1) B.label('平座勾栏', 0, floorY[i] + 2.5, halfWall[i] + 5.5, 'rail', i);
    }

    /* ------------------------------------------------------------ 塔刹 */
    const topInfo = levelInfo[L - 1];
    addFinial(B, L, topInfo.roofTop - 1, eaveHalf[L - 1], topInfo.roofBase);

    /* ------------------------------------------------- 顶层梁架 / 藻井 */
    addCaisson(B, L - 1, topInfo.colTop + 2.4, innerHalf[L - 1]);

    const totalH = topInfo.roofTop + finialHeight();
    return {
      boxes: B.boxes,
      labels: B.labels,
      palette: P,
      kinds: KINDS,
      meta: {
        levels: L, floorY: floorY, levelInfo: levelInfo,
        halfBase: halfBase, halfWall: halfWall, eaveHalf: eaveHalf,
        totalHeight: totalH, storyPitch: cfg.storyPitch,
        boxCount: B.boxes.length,
      },
    };
  }

  /* =========================================================== 台基 */
  function addBase(B, hb, H) {
    // 圭角（下枋）
    B.cb(0, 0, 0, hb * 2, 1.6, hb * 2, P.stone, 'base', -1, '圭角');
    B.cb(0, 1.6, 0, hb * 2 - 1.2, 0.6, hb * 2 - 1.2, P.stoneL, 'base', -1, '下枋');
    // 束腰（内收）+ 壸门
    const wHalf = hb - 2.2;
    B.cb(0, 2.2, 0, wHalf * 2, 1.4, wHalf * 2, P.stoneD, 'base', -1, '束腰');
    for (const s of [-1, 1]) {
      for (let t = -hb + 5; t <= hb - 5; t += 6) {
        B.cb(t, 2.5, s * wHalf, 3.2, 0.9, 0.6, P.stone, 'base', -1, '壸门');
        B.cb(s * wHalf, 2.5, t, 0.6, 0.9, 3.2, P.stone, 'base', -1, '壸门');
      }
    }
    // 上枋 + 台面
    B.cb(0, 3.6, 0, hb * 2 - 0.6, 0.7, hb * 2 - 0.6, P.stoneL, 'base', -1, '上枋');
    B.cb(0, 4.3, 0, hb * 2, 0.7, hb * 2, P.stoneW, 'base', -1, '台面石');
    // 台面铺地（十字缝）
    for (let t = -hb + 2; t < hb; t += 5) {
      B.cb(t, H - 0.1, 0, 0.35, 0.2, hb * 2 - 1, P.stoneL, 'base', -1, '铺地砖缝');
      B.cb(0, H - 0.1, t, hb * 2 - 1, 0.2, 0.35, P.stoneL, 'base', -1, '铺地砖缝');
    }
    // 石栏杆（除正面台阶段）
    for (const s of [-1, 1]) {
      for (let t = -hb + 2; t <= hb - 2; t += 5.5) {
        if (s === 1 && Math.abs(t) < 9) continue; // 正面留出台阶
        B.cb(t, H, s * (hb - 1), 1.1, 3.4, 1.1, P.stoneW, 'base', -1, '望柱');
        B.cb(s * (hb - 1), H, t, 1.1, 3.4, 1.1, P.stoneW, 'base', -1, '望柱');
        B.cb(t, H + 3.4, s * (hb - 1), 1.5, 0.6, 1.5, P.stoneL, 'base', -1, '望柱头');
        B.cb(s * (hb - 1), H + 3.4, t, 1.5, 0.6, 1.5, P.stoneL, 'base', -1, '望柱头');
      }
      B.cb(0, H + 2.2, s * (hb - 1), hb * 2 - 2, 0.7, 0.5, P.stoneL, 'base', -1, '石栏板');
      B.cb(s * (hb - 1), H + 2.2, 0, 0.5, 0.7, hb * 2 - 2, P.stoneL, 'base', -1, '石栏板');
    }
  }

  function addFrontSteps(B, hb, H) {
    const steps = 6, w = 16;
    for (let s = 0; s < steps; s++) {
      const y = (H / steps) * s;
      const z = hb + (steps - s) * 1.5;
      B.cb(0, y, z, w, H / steps + 0.2, 1.6, P.stoneW, 'base', -1, '踏跺（台阶）');
    }
    // 垂带
    for (const sx of [-1, 1]) {
      for (let s = 0; s < steps; s++) {
        B.cb(sx * (w / 2 + 1), (H / steps) * s, hb + (steps - s) * 1.5, 2.2, H / steps + 1.4, 1.7, P.stone, 'base', -1, '垂带');
      }
    }
  }

  function addLion(B, x, y, z) {
    // 石狮：须弥小座 + 蹲狮（体素简笔）
    B.cb(x, y, z, 5, 1.2, 5, P.stone, 'base', -1, '石狮座');
    B.cb(x, y + 1.2, z, 4, 0.8, 4, P.stoneL, 'base', -1, '石狮座');
    B.cb(x, y + 2, z, 3.2, 2.6, 3.6, P.stoneW, 'base', -1, '石狮');       // 身
    B.cb(x, y + 4.6, z + 0.6, 2.6, 2.2, 2.4, P.stoneW, 'base', -1, '石狮');// 头
    B.cb(x, y + 6.4, z + 0.4, 1.8, 0.7, 1.8, P.stoneL, 'base', -1, '石狮鬃');
    for (const s of [-1, 1]) {
      B.cb(x + s * 0.9, y + 5.4, z + 1.7, 0.6, 0.6, 0.5, P.ink, 'base', -1, '石狮目');
      B.cb(x + s * 1.0, y + 2, z + 1.6, 1.0, 1.6, 1.0, P.stoneL, 'base', -1, '石狮爪');
    }
    B.cb(x, y + 2.6, z - 2.0, 1.2, 2.6, 1.0, P.stoneL, 'base', -1, '石狮尾');
  }

  /* ==================================================== 楼板 / 楞木 */
  function addFloor(B, level, fy, half, holes, isGround) {
    const top = isGround ? P.stoneW : P.plank;
    const alt = isGround ? P.stoneL : P.plankL;
    const th = 1.0;
    const y = fy - th;
    const step = 2;
    let band = 0;
    for (let z = -half; z < half - 1e-6; z += step, band++) {
      const zA = z, zB = Math.min(z + step, half);
      // 在本条板带内按洞口的 z 边界精确细分，避免整带切除
      const zs = [zA, zB];
      for (const h of holes) {
        if (h.z0 > zA && h.z0 < zB) zs.push(h.z0);
        if (h.z1 > zA && h.z1 < zB) zs.push(h.z1);
      }
      zs.sort((a, b) => a - b);
      for (let k = 0; k < zs.length - 1; k++) {
        const za = zs[k], zb = zs[k + 1], zm = (za + zb) / 2;
        if (zb - za < 0.05) continue;
        const cuts = holes.filter(h => zm > h.z0 && zm < h.z1).map(h => [h.x0, h.x1]);
        for (const s of subtract(-half, half, cuts)) {
          B.box(s[0], y, za, s[1] - s[0], th, zb - za,
            band % 2 === 0 ? top : alt, 'floor', level, isGround ? '地面石' : '楼板');
        }
      }
    }
    // 楞木（承楼板的次梁，自下层室内可见）；按洞口断开
    if (!isGround) {
      for (let x = -half + 3; x <= half - 3; x += 6) {
        const cuts = holes.filter(h => x < h.x1 && x + 1.4 > h.x0).map(h => [h.z0, h.z1]);
        for (const s of subtract(-half, half, cuts)) {
          B.box(x, y - 1.2, s[0], 1.4, 1.2, s[1] - s[0], P.woodD, 'floor', level, '楞木');
        }
      }
    }
  }

  /* 在 [a,b] 上挖去若干区间，返回剩余区间 */
  function subtract(a, b, cuts) {
    let segs = [[a, b]];
    for (const c of cuts) {
      const out = [];
      for (const s of segs) {
        if (c[1] <= s[0] || c[0] >= s[1]) { out.push(s); continue; }
        if (c[0] > s[0]) out.push([s[0], c[0]]);
        if (c[1] < s[1]) out.push([c[1], s[1]]);
      }
      segs = out;
    }
    return segs.filter(s => s[1] - s[0] > 0.05);
  }

  /* ==================================================== 墙身：门与窗 */
  function addWalls(B, level, hw, y0, H, midOff, colS, isGround) {
    const sides = [
      { s: 1, axis: 'z' }, { s: -1, axis: 'z' },
      { s: 1, axis: 'x' }, { s: -1, axis: 'x' },
    ];
    for (const side of sides) {
      const front = (side.axis === 'z' && side.s === 1);
      /* 三开间：当心间 [-midOff, midOff] 为门；两次间为直棂窗 */
      const bays = [
        { a: -hw, b: -midOff, kind: 'win' },
        { a: -midOff, b: midOff, kind: 'door' },
        { a: midOff, b: hw, kind: 'win' },
      ];
      for (const bay of bays) {
        const c0 = bay.a + colS / 2, c1 = bay.b - colS / 2;
        const w = c1 - c0;
        if (w <= 0.5) continue;
        const cx = (c0 + c1) / 2;
        if (bay.kind === 'door') {
          addDoor(B, level, side, cx, y0, H, w, hw, front && isGround);
        } else {
          addWindow(B, level, side, cx, y0, H, w, hw);
        }
      }
    }
  }

  function placeOn(B, side, u, y, w, h, t, hw, c, k, l, p) {
    // u = 沿墙方向坐标；t = 墙厚；hw = 墙中线半宽
    if (side.axis === 'z') B.cb(u, y, side.s * hw, w, h, t, c, k, l, p);
    else B.cb(side.s * hw, y, u, t, h, w, c, k, l, p);
  }

  function addDoor(B, level, side, cx, y0, H, w, hw, open) {
    const t = 1.2, dh = H - 2.2;                 // 门洞高
    const leafW = w / 2 - 1.1, leafOff = w / 4 - 0.45;
    // 门框：立颊 + 门额 + 门砧
    placeOn(B, side, cx - w / 2 + 0.5, y0, 1.0, dh + 1.4, t + 0.4, hw, P.woodD, 'wall', level, '门框立颊');
    placeOn(B, side, cx + w / 2 - 0.5, y0, 1.0, dh + 1.4, t + 0.4, hw, P.woodD, 'wall', level, '门框立颊');
    placeOn(B, side, cx, y0 + dh, w, 1.4, t + 0.4, hw, P.woodD, 'wall', level, '门额');
    placeOn(B, side, cx, y0, w, 0.8, t + 0.6, hw, P.woodD, 'wall', level, '门砧·门槛');
    // 门上横披窗（棂条，透光）
    for (let u = cx - w / 2 + 1.6; u < cx + w / 2 - 1; u += 1.8) {
      placeOn(B, side, u, y0 + dh - 1.9, 0.6, 1.9, t, hw, P.woodM, 'wall', level, '横披窗棂');
    }
    placeOn(B, side, cx, y0 + dh - 2.2, w - 1.6, 0.5, t + 0.2, hw, P.woodD, 'wall', level, '横披窗下框');
    if (open) {
      // 正面当心间开敞（可直视佛坛），门扇向内侧贴靠
      for (const s of [-1, 1]) {
        placeOn(B, side, cx + s * (w / 2 - 1.6), y0 + 0.8, 1.5, dh - 3.2, t, hw, P.red, 'wall', level, '板门（敞开）');
      }
      // 匾额（悬于阑额之下，外挑）
      placeOn(B, side, cx, y0 + dh + 1.6, w * 0.66, 2.4, 1.0, hw + 0.7, P.woodD, 'wall', level, '匾额');
      placeOn(B, side, cx, y0 + dh + 1.9, w * 0.54, 1.7, 0.7, hw + 1.2, P.gold, 'wall', level, '匾额题字');
      for (const s of [-1, 1]) {
        placeOn(B, side, cx + s * w * 0.34, y0 + dh + 1.5, 0.7, 2.6, 0.9, hw + 0.9, P.redD, 'wall', level, '匾额边框');
      }
      return;
    }
    // 双扇板门 + 门钉 + 铺首衔环
    for (const s of [-1, 1]) {
      placeOn(B, side, cx + s * leafOff, y0 + 0.8, leafW, dh - 3.2, t, hw, P.red, 'wall', level, '板门');
      for (let ry = 0; ry < 3; ry++) {
        for (let rx = 0; rx < 2; rx++) {
          placeOn(B, side, cx + s * leafOff + (rx - 0.5) * (leafW * 0.5), y0 + 2.6 + ry * 2.0,
            0.5, 0.5, t + 0.5, hw, P.gold, 'wall', level, '门钉');
        }
      }
      placeOn(B, side, cx + s * 1.1, y0 + 4.6, 1.0, 1.0, t + 0.6, hw, P.goldL, 'wall', level, '铺首衔环');
    }
  }

  function addWindow(B, level, side, cx, y0, H, w, hw) {
    const t = 1.0, sill = 3.2, wh = H - sill - 2.2;
    // 槛墙（下部实墙）
    placeOn(B, side, cx, y0, w, sill, t, hw, P.wall, 'wall', level, '槛墙');
    placeOn(B, side, cx, y0 + sill - 0.5, w + 0.4, 0.6, t + 0.5, hw, P.woodD, 'wall', level, '窗榻板');
    // 窗框
    placeOn(B, side, cx, y0 + sill + wh, w, 1.0, t + 0.2, hw, P.woodD, 'wall', level, '窗上槛');
    placeOn(B, side, cx - w / 2 + 0.4, y0 + sill, 0.8, wh, t + 0.2, hw, P.woodD, 'wall', level, '窗框');
    placeOn(B, side, cx + w / 2 - 0.4, y0 + sill, 0.8, wh, t + 0.2, hw, P.woodD, 'wall', level, '窗框');
    // 直棂（竖向棂条，透光透视）
    for (let u = cx - w / 2 + 1.6; u <= cx + w / 2 - 1.6; u += 1.7) {
      placeOn(B, side, u, y0 + sill, 0.7, wh, t * 0.7, hw, P.woodM, 'wall', level, '直棂窗棂条');
    }
    // 窗上小壁（抹灰墙）
    placeOn(B, side, cx, y0 + sill + wh + 1.0, w, H - sill - wh - 1.0, t, hw, P.wallD, 'wall', level, '抹灰墙');
  }

  /* ======================================================== 斗拱铺作 */
  function addDougong(B, level, x, y, z, sx, sz, corner) {
    const c1 = P.woodL, c2 = P.woodM, c3 = P.redD;
    // 坐斗
    B.cb(x, y, z, 3.0, 1.4, 3.0, c1, 'frame', level, '栌斗（坐斗）');
    // 第一跳华拱
    const o1 = 2.2;
    if (corner) {
      B.cb(x + sx * o1 * 0.5, y + 1.4, z, 7.0, 1.0, 1.4, c2, 'frame', level, '华拱');
      B.cb(x, y + 1.4, z + sz * o1 * 0.5, 1.4, 1.0, 7.0, c2, 'frame', level, '华拱');
      B.cb(x + sx * 1.6, y + 1.4, z + sz * 1.6, 2.0, 1.0, 2.0, c1, 'frame', level, '角昂');
    } else {
      if (sz !== 0) {
        B.cb(x, y + 1.4, z + sz * o1 * 0.5, 1.4, 1.0, 6.0, c2, 'frame', level, '华拱（出跳）');
        B.cb(x, y + 1.4, z, 6.4, 1.0, 1.3, c2, 'frame', level, '泥道拱');
      } else {
        B.cb(x + sx * o1 * 0.5, y + 1.4, z, 6.0, 1.0, 1.4, c2, 'frame', level, '华拱（出跳）');
        B.cb(x, y + 1.4, z, 1.3, 1.0, 6.4, c2, 'frame', level, '泥道拱');
      }
    }
    // 第二跳 + 令拱 + 散斗
    const o2 = 4.4;
    const dx = sx * o2, dz = sz * o2;
    B.cb(x + dx * 0.55, y + 2.4, z + dz * 0.55, corner ? 2.4 : (sz !== 0 ? 7.2 : 2.2), 1.0, corner ? 2.4 : (sz !== 0 ? 2.2 : 7.2),
      c2, 'frame', level, '令拱');
    B.cb(x + dx * 0.55, y + 2.4, z + dz * 0.55, 2.2, 1.0, 2.2, c1, 'frame', level, '昂（下昂）');
    for (const t of [-1, 1]) {
      if (sz !== 0 || corner) B.cb(x + t * 2.6, y + 2.4, z + dz * 0.55, 1.6, 1.3, 1.6, c1, 'frame', level, '散斗');
      if (sx !== 0 || corner) B.cb(x + dx * 0.55, y + 2.4, z + t * 2.6, 1.6, 1.3, 1.6, c1, 'frame', level, '散斗');
    }
    // 替木 / 撩檐枋座
    B.cb(x + dx * 0.85, y + 3.4, z + dz * 0.85, corner ? 3.0 : (sz !== 0 ? 5.0 : 2.0), 0.8, corner ? 3.0 : (sz !== 0 ? 2.0 : 5.0),
      c3, 'frame', level, '替木');
  }

  /* ==================================================== 腰檐 / 屋顶 */
  function topRoofRise(eh) { return Math.max(10, (eh - 1.5) * 0.85); }
  function finialHeight() { return 20; }

  function addRoof(B, level, y0, outerHalf, innerStop, isTop) {
    const step = 2.2;
    let y = y0;
    let half = outerHalf;
    let r = 0;
    /* 檐口：檐椽头 + 飞子 + 瓦当滴水 */
    for (let t = -outerHalf + 1; t <= outerHalf - 1; t += 2) {
      for (const s of [-1, 1]) {
        B.cb(t, y0 - 1.0, s * (outerHalf + 0.6), 1.2, 1.0, 2.4, P.woodL, 'roof', level, '飞子（檐椽头）');
        B.cb(s * (outerHalf + 0.6), y0 - 1.0, t, 2.4, 1.0, 1.2, P.woodL, 'roof', level, '飞子（檐椽头）');
        B.cb(t, y0 - 1.9, s * (outerHalf + 0.1), 1.6, 0.9, 1.6, (t / 2 | 0) % 2 ? P.tileL : P.tileD, 'roof', level, '瓦当·滴水');
        B.cb(s * (outerHalf + 0.1), y0 - 1.9, t, 1.6, 0.9, 1.6, (t / 2 | 0) % 2 ? P.tileL : P.tileD, 'roof', level, '瓦当·滴水');
      }
    }
    for (const s of [-1, 1]) {
      B.cb(0, y0 - 0.2, s * (outerHalf + 1.4), outerHalf * 2 + 3.2, 1.0, 1.2, P.redD, 'roof', level, '撩檐枋');
      B.cb(s * (outerHalf + 1.4), y0 - 0.2, 0, 1.2, 1.0, outerHalf * 2 + 3.2, P.redD, 'roof', level, '撩檐枋');
    }

    /* 瓦面：层层内收的方环，起翘为上凹曲线。环高 = 升起量+1，保证层间无缝隙（不透光） */
    while (half > innerStop) {
      const rise = isTop ? (0.95 + 0.30 * r) : (1.05 + 0.22 * r);
      const ringH = rise + 1.0;
      const t = Math.min(step + 0.4, half - innerStop + step);
      // 底瓦（板瓦）整条
      for (const s of [-1, 1]) {
        B.cb(0, y, s * (half - t / 2), half * 2, ringH, t, P.tile, 'roof', level, '板瓦');
        B.cb(s * (half - t / 2), y, 0, t, ringH, (half - t) * 2, P.tile, 'roof', level, '板瓦');
      }
      // 筒瓦垄（每 2.2 单位一垄，顺坡向）
      for (let u = -half + 1.1; u <= half - 1.1; u += 2.2) {
        for (const s of [-1, 1]) {
          B.cb(u, y + ringH, s * (half - t / 2), 1.1, 0.55, t, P.tileL, 'roof', level, '筒瓦垄');
          B.cb(s * (half - t / 2), y + ringH, u, t, 0.55, 1.1, P.tileL, 'roof', level, '筒瓦垄');
        }
      }
      // 戗脊（四角对角脊）
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        B.cb(sx * (half - t / 2), y + ringH - 0.9, sz * (half - t / 2), t + 1.2, 1.6, t + 1.2, P.tileD, 'roof', level, '戗脊');
        B.cb(sx * (half - t / 2), y + ringH + 0.6, sz * (half - t / 2), t * 0.6, 0.8, t * 0.6, P.tileH, 'roof', level, '脊瓦');
      }
      y += rise;
      half -= step;
      r++;
    }

    /* 起翘飞檐：四角向外上翻的翼角 */
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      for (let k = 1; k <= 4; k++) {
        const off = outerHalf + k * 1.1 - 0.6;
        const yy = y0 + Math.pow(k, 1.45) * 0.52;
        const sz2 = 3.6 - k * 0.4;
        B.cb(sx * off, yy, sz * off, sz2, 1.6, sz2, k >= 3 ? P.tileH : P.tileD, 'roof', level, '翼角起翘（飞檐）');
      }
      const tipY = y0 + Math.pow(5, 1.45) * 0.52;
      B.cb(sx * (outerHalf + 4.6), tipY, sz * (outerHalf + 4.6), 2.0, 2.0, 2.0, P.goldL, 'roof', level, '套兽·仙人');
      B.cb(sx * (outerHalf + 3.0), y0 - 0.6, sz * (outerHalf + 3.0), 2.6, 1.2, 2.6, P.woodD, 'roof', level, '角梁（老角梁）');
    }

    if (isTop) {
      // 攒尖顶收头
      B.cb(0, y, 0, 5.0, 1.6, 5.0, P.tileD, 'roof', level, '雷公柱座');
      B.cb(0, y + 1.6, 0, 3.4, 1.4, 3.4, P.tileH, 'roof', level, '顶尖');
      return y + 3.0;
    }
    return y;
  }

  function addRafters(B, level, y, inHalf, outHalf) {
    const len = outHalf - inHalf + 2.6;
    for (let u = -outHalf + 2; u <= outHalf - 2; u += 3) {
      for (const s of [-1, 1]) {
        B.cb(u, y, s * (inHalf + len / 2 - 1), 1.0, 0.9, len, P.woodM, 'roof', level, '檐椽');
        B.cb(s * (inHalf + len / 2 - 1), y, u, len, 0.9, 1.0, P.woodM, 'roof', level, '檐椽');
      }
    }
  }

  /* ==================================================== 平座 · 勾栏 */
  function addBalcony(B, level, deckY, bh, hw) {
    // 挑出的斗拱（平座铺作）与承重枋
    for (const s of [-1, 1]) {
      B.cb(0, deckY - 2.4, s * (hw + 2.2), hw * 2 + 4, 1.2, 2.0, P.woodD, 'rail', level, '平座承重枋');
      B.cb(s * (hw + 2.2), deckY - 2.4, 0, 2.0, 1.2, hw * 2 + 4, P.woodD, 'rail', level, '平座承重枋');
    }
    for (let u = -bh + 2; u <= bh - 2; u += 4) {
      for (const s of [-1, 1]) {
        B.cb(u, deckY - 1.6, s * (hw + 2.4), 1.2, 1.0, (bh - hw) + 1.2, P.woodM, 'rail', level, '平座挑梁');
        B.cb(s * (hw + 2.4), deckY - 1.6, u, (bh - hw) + 1.2, 1.0, 1.2, P.woodM, 'rail', level, '平座挑梁');
      }
    }
    // 平座地板（环形，宽 bh-hw）
    const wide = bh - hw + 1.0;
    for (const s of [-1, 1]) {
      B.cb(0, deckY - 0.8, s * (bh - wide / 2), bh * 2, 0.8, wide, P.plank, 'rail', level, '平座地板');
      B.cb(s * (bh - wide / 2), deckY - 0.8, 0, wide, 0.8, bh * 2, P.plank, 'rail', level, '平座地板');
    }
    for (let u = -bh + 1; u <= bh - 1; u += 2.5) {
      for (const s of [-1, 1]) {
        B.cb(u, deckY - 0.05, s * (bh - wide / 2), 0.3, 0.15, wide, P.woodM, 'rail', level, '板缝');
        B.cb(s * (bh - wide / 2), deckY - 0.05, u, wide, 0.15, 0.3, P.woodM, 'rail', level, '板缝');
      }
    }
    // 勾栏：地栿 + 华板 + 寻杖 + 望柱
    const rh = 3.6;
    for (const s of [-1, 1]) {
      B.cb(0, deckY, s * (bh - 0.6), bh * 2, 0.7, 1.0, P.redD, 'rail', level, '勾栏地栿');
      B.cb(s * (bh - 0.6), deckY, 0, 1.0, 0.7, bh * 2, P.redD, 'rail', level, '勾栏地栿');
      B.cb(0, deckY + 1.6, s * (bh - 0.6), bh * 2 - 1, 1.2, 0.6, P.redL, 'rail', level, '华板（斗子蜀柱）');
      B.cb(s * (bh - 0.6), deckY + 1.6, 0, 0.6, 1.2, bh * 2 - 1, P.redL, 'rail', level, '华板（斗子蜀柱）');
      B.cb(0, deckY + rh, s * (bh - 0.6), bh * 2 + 0.8, 0.8, 1.3, P.red, 'rail', level, '寻杖（扶手）');
      B.cb(s * (bh - 0.6), deckY + rh, 0, 1.3, 0.8, bh * 2 + 0.8, P.red, 'rail', level, '寻杖（扶手）');
    }
    for (let u = -bh + 0.6; u <= bh - 0.6; u += 4.6) {
      for (const s of [-1, 1]) {
        B.cb(u, deckY, s * (bh - 0.6), 1.1, rh, 1.1, P.red, 'rail', level, '望柱');
        B.cb(s * (bh - 0.6), deckY, u, 1.1, rh, 1.1, P.red, 'rail', level, '望柱');
        B.cb(u, deckY + rh + 0.8, s * (bh - 0.6), 1.5, 0.7, 1.5, P.gold, 'rail', level, '望柱头');
        B.cb(s * (bh - 0.6), deckY + rh + 0.8, u, 1.5, 0.7, 1.5, P.gold, 'rail', level, '望柱头');
      }
    }
  }

  /* ======================================================== 木楼梯 */
  function addStairs(B, level, fy, sp) {
    const wide = sp.wide, z0 = sp.zo;
    for (let s = 0; s < sp.n; s++) {
      const y = fy + s * sp.rise + 0.5;
      const x = sp.x0 + s * sp.tread;
      // 踏板
      B.box(x, y, z0, sp.tread + 0.15, 0.55, wide, s % 2 ? P.plankL : P.plank, 'stair', level, '踏板');
      // 两侧帮板（阶梯近似斜料）
      for (const t of [0, 1]) {
        B.box(x, fy + s * sp.rise * 0.5, z0 + t * (wide - 0.8), sp.tread, s * sp.rise * 0.5 + 1.4, 0.8,
          P.woodD, 'stair', level, '楼梯帮板');
      }
      // 扶手（沿内侧升起）：望柱 + 寻杖
      if (s % 3 === 0) B.box(x, y + 0.5, z0 + wide - 0.7, 0.8, 3.0, 0.8, P.red, 'stair', level, '楼梯望柱');
      B.box(x, y + 3.3, z0 + wide - 0.75, sp.tread + 0.2, 0.7, 0.9, P.redL, 'stair', level, '楼梯扶手');
    }
    // 楼梯下槛 + 上口平台（严格落在上层楼板洞口内，顶面与上层楼板齐平）
    B.box(sp.x0 - 1.8, fy, z0, 1.8, 1.1, wide, P.woodD, 'stair', level, '楼梯下槛');
    B.box(sp.x0 + sp.run - 0.8, fy + sp.n * sp.rise - 0.6, z0, 2.0, 0.6, wide, P.plankL, 'stair', level, '楼梯口平台');
  }

  function addWellRail(B, level, fy, hole) {
    // 上层楼板洞口三侧的防护勾栏（立于洞口之外的实铺楼板上，上口一侧 x1 敞开）
    const rh = 3.2, t = 1.0;
    const x0 = hole.x0, x1 = hole.x1, z0 = hole.z0, z1 = hole.z1;
    const edge = (ax, a0, a1, b) => {
      // ax='x': 沿 X 走向的栏杆，位于 z=b..b+t
      const len = a1 - a0;
      for (let u = a0; u <= a1 - 0.6; u += 3.2) {
        if (ax === 'x') B.box(u, fy, b, t, rh, t, P.red, 'rail', level, '楼梯井望柱');
        else B.box(b, fy, u, t, rh, t, P.red, 'rail', level, '楼梯井望柱');
      }
      if (ax === 'x') {
        B.box(a0, fy + rh, b - 0.1, len, 0.7, t + 0.2, P.redL, 'rail', level, '楼梯井扶手');
        B.box(a0, fy + 1.4, b + 0.1, len, 0.9, t - 0.2, P.redD, 'rail', level, '楼梯井华板');
      } else {
        B.box(b - 0.1, fy + rh, a0, t + 0.2, 0.7, len, P.redL, 'rail', level, '楼梯井扶手');
        B.box(b + 0.1, fy + 1.4, a0, t - 0.2, 0.9, len, P.redD, 'rail', level, '楼梯井华板');
      }
    };
    edge('x', x0 - t, x1, z1);          // 内侧
    edge('x', x0 - t, x1, z0 - t);      // 外侧（临墙）
    edge('z', z0, z1, x0 - t);          // 端侧
  }

  /* ==================================================== 室内陈设 */
  function addFurniture(B, level, fy, ih, inOff, isTop, safe) {
    if (level === 0) {
      addAltar(B, level, fy, 0, -4);
      addBuddha(B, level, fy + 3.2, 0, -4);
      // 供桌 + 香炉 + 烛台
      B.cb(0, fy, 6, 10, 3.2, 4, P.woodD, 'furn', level, '供桌');
      B.cb(0, fy + 3.2, 6, 11, 0.6, 5, P.woodL, 'furn', level, '供桌面');
      B.cb(0, fy + 3.8, 6, 2.4, 1.6, 2.4, P.gold, 'furn', level, '香炉');
      for (const s of [-1, 1]) {
        B.cb(s * 4, fy + 3.8, 6, 0.8, 2.6, 0.8, P.goldL, 'furn', level, '烛台');
        B.cb(s * 4, fy + 6.4, 6, 0.6, 1.0, 0.6, P.lampL, 'furn', level, '烛焰');
      }
      // 蒲团
      for (const s of [-1, 1]) B.cb(s * 5, fy, 11, 3.4, 0.8, 3.4, P.redL, 'furn', level, '蒲团');
    } else {
      /* 上层陈设一律布置在内槽范围（safe 半宽）内，绝不侵占外槽梯道与楼梯井 */
      const nw = Math.min(6.6, safe * 1.15);        // 佛龛宽
      const nz = -safe + 1.6;
      B.cb(0, fy, nz, nw + 1.6, 1.0, 3.4, P.woodD, 'furn', level, '佛龛座');
      B.cb(0, fy + 1.0, nz, nw, 5.0, 2.8, P.redD, 'furn', level, '佛龛');
      B.cb(0, fy + 1.6, nz - 0.5, 2.2, 3.4, 1.4, P.gold, 'furn', level, '小佛像');
      B.cb(0, fy + 5.0, nz - 0.5, 1.3, 1.1, 1.3, P.goldL, 'furn', level, '小佛像');
      B.cb(0, fy + 6.0, nz, nw + 0.8, 0.6, 3.2, P.woodM, 'furn', level, '佛龛帐额');
      // 藏经柜（贴内槽两侧）
      for (const s of [-1, 1]) {
        const gx = s * (safe - 1.5);
        B.cb(gx, fy, nz + 0.4, 2.8, 6.2, 2.6, P.woodD, 'furn', level, '藏经柜');
        for (let sh = 1; sh < 3; sh++) {
          B.cb(gx, fy + sh * 2.0, nz + 0.5, 2.4, 0.35, 2.4, P.woodL, 'furn', level, '柜格');
          B.cb(gx, fy + sh * 2.0 + 0.35, nz + 0.5, 1.9, 1.1, 1.9, level % 2 ? P.plankL : P.wall, 'furn', level, '经卷');
        }
      }
      // 经案 + 蒲团（内槽另一侧）
      const az = safe - 2.4;
      B.cb(0, fy, az, Math.min(7, safe * 1.2), 2.4, 2.6, P.wood, 'furn', level, '经案');
      B.cb(0, fy + 2.4, az, Math.min(8, safe * 1.35), 0.5, 3.2, P.woodL, 'furn', level, '经案面');
      B.cb(0, fy + 2.9, az, 2.6, 0.5, 1.8, P.wall, 'furn', level, '经卷');
      for (const s of [-1, 1]) B.cb(s * 2.6, fy, safe - 0.6, 2.4, 0.7, 2.4, P.redL, 'furn', level, '蒲团');
    }
    if (isTop) {
      B.cb(0, fy, -safe + 1.2, 4.4, 1.0, 4.4, P.redD, 'furn', level, '礼佛坛');
      B.cb(0, fy + 1.0, -safe + 1.2, 3.4, 0.5, 3.4, P.gold, 'furn', level, '铜镜');
    }
    // 悬吊宫灯（每层两只，悬于内槽对角）
    for (const s of [-1, 1]) {
      addLantern(B, level, s * (inOff - 1), fy + 8.4, s * (inOff - 1));
    }
  }

  function addAltar(B, level, fy, cx, cz) {
    B.cb(cx, fy, cz, 20, 1.4, 14, P.stoneL, 'furn', level, '佛坛');
    B.cb(cx, fy + 1.4, cz, 18.4, 1.0, 12.6, P.stoneD, 'furn', level, '佛坛束腰');
    B.cb(cx, fy + 2.4, cz, 20, 0.8, 14, P.stoneW, 'furn', level, '佛坛上枋');
    for (let t = -8; t <= 8; t += 4) {
      B.cb(cx + t, fy + 1.6, cz + 7, 2.2, 0.7, 0.5, P.gold, 'furn', level, '佛坛雕饰');
    }
  }

  function addBuddha(B, level, y, cx, cz) {
    const G = P.gold, GL = P.goldL, R = P.redD;
    // 莲座
    B.cb(cx, y, cz, 12, 1.6, 10, R, 'furn', level, '莲花座');
    B.cb(cx, y + 1.6, cz, 13, 1.2, 11, GL, 'furn', level, '莲瓣');
    B.cb(cx, y + 2.8, cz, 11, 0.8, 9, G, 'furn', level, '莲台');
    const b = y + 3.6;
    // 结跏趺坐：腿 → 身 → 肩 → 头 → 肉髻 → 背光
    B.cb(cx, b, cz, 10.5, 2.2, 7.5, G, 'furn', level, '释迦坐像（趺坐）');
    B.cb(cx, b + 2.2, cz - 0.4, 8.0, 4.4, 5.6, G, 'furn', level, '释迦坐像');
    B.cb(cx, b + 6.6, cz - 0.4, 9.4, 1.4, 5.2, GL, 'furn', level, '双肩');
    B.cb(cx, b + 8.0, cz - 0.4, 4.4, 4.0, 4.0, GL, 'furn', level, '佛首');
    B.cb(cx, b + 12.0, cz - 0.4, 3.0, 1.4, 3.0, G, 'furn', level, '肉髻');
    B.cb(cx, b + 13.4, cz - 0.4, 1.6, 0.8, 1.6, GL, 'furn', level, '顶严');
    for (const s of [-1, 1]) {
      B.cb(cx + s * 1.4, b + 10.4, cz + 1.7, 0.6, 0.5, 0.4, P.ink, 'furn', level, '佛目');
      B.cb(cx + s * 4.4, b + 3.0, cz + 0.6, 2.0, 3.4, 3.0, G, 'furn', level, '佛臂');
      B.cb(cx + s * 3.0, b + 1.8, cz + 2.6, 2.6, 1.2, 2.0, GL, 'furn', level, '佛手（禅定印）');
    }
    B.cb(cx, b + 9.2, cz + 2.1, 2.0, 0.6, 0.4, R, 'furn', level, '佛唇');
    // 背光（火焰纹圆光，体素阶梯近似）
    const bx = [6.5, 7.4, 7.8, 7.4, 6.5, 5.0, 3.0];
    for (let k = 0; k < bx.length; k++) {
      const yy = b + 3.2 + k * 1.8;
      B.cb(cx - bx[k], yy, cz - 3.4, 1.2, 1.8, 1.0, k % 2 ? P.red : P.redL, 'furn', level, '背光');
      B.cb(cx + bx[k] - 1.2, yy, cz - 3.4, 1.2, 1.8, 1.0, k % 2 ? P.red : P.redL, 'furn', level, '背光');
    }
    B.cb(cx, b + 15.2, cz - 3.4, 6.0, 1.4, 1.0, P.redL, 'furn', level, '背光');
    B.cb(cx, b + 9.0, cz - 3.6, 11.0, 0.8, 0.8, P.gold, 'furn', level, '背光');
  }

  function addLantern(B, level, x, y, z) {
    B.cb(x, y + 4.4, z, 0.4, 3.0, 0.4, P.woodD, 'furn', level, '灯绳');
    B.cb(x, y + 3.8, z, 3.4, 0.7, 3.4, P.woodD, 'furn', level, '灯盖');
    B.cb(x, y + 1.2, z, 3.0, 2.6, 3.0, P.lamp, 'furn', level, '宫灯');
    B.cb(x, y + 0.9, z, 3.4, 0.5, 3.4, P.redD, 'furn', level, '灯托');
    B.cb(x, y + 0.2, z, 0.8, 0.8, 0.8, P.gold, 'furn', level, '灯坠');
    B.cb(x, y + 1.6, z, 3.4, 1.0, 3.4, P.lampL, 'furn', level, '灯光');
  }

  function addBell(B, level, x, y, z) {
    B.cb(x, y, z, 0.4, 2.2, 0.4, P.woodD, 'roof', level, '铃索');
    B.cb(x, y - 1.6, z, 1.8, 1.8, 1.8, P.gold, 'roof', level, '风铃（惊鸟铃）');
    B.cb(x, y - 2.2, z, 0.6, 0.8, 0.6, P.goldL, 'roof', level, '铃舌');
  }

  /* ==================================================== 藻井 · 梁架 */
  function addCaisson(B, level, y, ih) {
    const layers = 4;
    for (let k = 0; k < layers; k++) {
      const h = ih - 2 - k * 2.4;
      if (h <= 1) break;
      for (const s of [-1, 1]) {
        B.cb(0, y + k * 1.2, s * h, h * 2, 1.0, 1.2, k % 2 ? P.redD : P.woodM, 'frame', level, '藻井');
        B.cb(s * h, y + k * 1.2, 0, 1.2, 1.0, h * 2, k % 2 ? P.redD : P.woodM, 'frame', level, '藻井');
      }
    }
    B.cb(0, y + layers * 1.2, 0, 4.4, 1.4, 4.4, P.gold, 'frame', level, '藻井明镜');
    B.cb(0, y + layers * 1.2 + 1.4, 0, 2.4, 1.2, 2.4, P.goldL, 'frame', level, '垂莲柱');
  }

  /* ========================================================= 塔刹 */
  function addFinial(B, level, y0, eh, roofBase) {
    let y = y0;
    // 覆钵
    const bowl = [5.4, 6.4, 6.8, 6.4, 5.2];
    for (let k = 0; k < bowl.length; k++) {
      B.cb(0, y + k * 1.1, 0, bowl[k] * 2, 1.2, bowl[k] * 2, k % 2 ? P.tileD : P.tileH, 'finial', level, '覆钵');
    }
    y += bowl.length * 1.1;
    // 仰莲 + 刹杆座
    B.cb(0, y, 0, 9.0, 1.2, 9.0, P.gold, 'finial', level, '仰莲盘');
    y += 1.2;
    B.cb(0, y, 0, 2.2, 16, 2.2, P.woodD, 'finial', level, '刹杆');
    // 相轮（七重）
    for (let k = 0; k < 7; k++) {
      const r = 4.6 - k * 0.42;
      B.cb(0, y + 0.6 + k * 1.5, 0, r * 2, 1.0, r * 2, k % 2 ? P.gold : P.goldL, 'finial', level, '相轮（七重）');
      B.cb(0, y + 1.6 + k * 1.5, 0, r * 1.3, 0.5, r * 1.3, P.woodD, 'finial', level, '相轮轴');
    }
    y += 0.6 + 7 * 1.5;
    // 宝盖 + 垂铃
    B.cb(0, y, 0, 8.4, 1.0, 8.4, P.gold, 'finial', level, '宝盖');
    B.cb(0, y + 1.0, 0, 6.4, 0.9, 6.4, P.goldL, 'finial', level, '宝盖');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      B.cb(sx * 3.6, y - 1.4, sz * 3.6, 1.4, 1.4, 1.4, P.goldL, 'finial', level, '宝盖垂铃');
    }
    y += 2.0;
    // 水烟 + 宝珠
    B.cb(0, y, 0, 3.0, 1.6, 3.0, P.woodD, 'finial', level, '水烟');
    B.cb(0, y + 1.6, 0, 4.2, 2.4, 4.2, P.goldL, 'finial', level, '宝珠');
    B.cb(0, y + 4.0, 0, 2.6, 1.6, 2.6, P.gold, 'finial', level, '宝珠');
    B.cb(0, y + 5.6, 0, 1.2, 2.2, 1.2, P.goldL, 'finial', level, '刹尖');
    // 四角铁链（阶梯近似悬链）
    const topY = y + 1.0, span = eh + 3.0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const steps = 10;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const px = sx * (3.2 + (span - 3.2) * t);
        const pz = sz * (3.2 + (span - 3.2) * t);
        const py = topY - (topY - (roofBase + 2.4)) * Math.pow(t, 1.55);
        B.cb(px, py, pz, 0.6, 0.6, 0.6, P.tileH, 'finial', level, '铁链（角链）');
      }
    }
  }

  return { buildPagoda: buildPagoda, PALETTE: P, KINDS: KINDS };
});
