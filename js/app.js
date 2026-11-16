/* global KNOWLEDGE_DATA */
(() => {
  'use strict';

  const DATA = window.KNOWLEDGE_DATA;
  if (!DATA) {
    console.error('KNOWLEDGE_DATA 未加载');
    return;
  }

  const { layers, categories, username } = DATA;
  const LAYER_BY_ID = Object.fromEntries(layers.map((l) => [l.id, l]));
  const CAT_BY_ID = Object.fromEntries(categories.map((c) => [c.id, c]));
  const CAT_ORDER = categories.map((c) => c.id);
  const LAYER_ORDER = layers.map((l) => l.id);

  const WORLD = { w: 1800, h: 1420 };
  const BANDS = {
    foundation: { top: 70, bottom: 480, rows: 3 },
    engineering: { top: 540, bottom: 1000, rows: 4 },
    research: { top: 1060, bottom: 1400, rows: 3 },
  };
  const MIN_K = 0.28;
  const MAX_K = 2.8;
  const NS = 'http://www.w3.org/2000/svg';
  const LS_LIVE = 'knowledge-links:live-stars:v1';
  const LS_LIVE_TTL = 7 * 24 * 3600 * 1000;
  const AUTO_SYNC_AGE = 3 * 24 * 3600 * 1000;
  const LIVE_CACHE_FRESH = 6 * 3600 * 1000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    nodes: [],
    edges: [],
    nodeMap: new Map(),
    adjacency: new Map(),
    positions: new Map(),
    visibleIds: new Set(),
    matches: null,
    layers: new Set(LAYER_ORDER),
    categories: new Set(CAT_ORDER),
    query: '',
    selectedId: null,
    hoverId: null,
    view: { x: 0, y: 0, k: 1 },
    snapshotRepos: [],
    liveRepos: [],
    snapshotAt: null,
    liveAt: 0,
    dom: {},
    syncing: false,
    suppressClick: false,
    animId: 0,
    statsAnimated: false,
  };

  const pointerState = {
    pointers: new Map(),
    panStart: null,
    pinch: null,
    miniDragging: false,
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function truncate(str, max) {
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
  }

  function formatNum(n) {
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
    return n.toLocaleString('zh-CN');
  }

  function formatStars(n) {
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  }

  function relTime(isoOrMs) {
    if (!isoOrMs) return '';
    const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    if (diff < 0) return '刚刚';
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
    if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前`;
    return `${Math.floor(diff / (365 * day))} 年前`;
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function setText(target, text) {
    const el = typeof target === 'string' ? $(target) : target;
    if (el) el.textContent = text;
  }

  function svgEl(tag, attrs = {}, text) {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value !== undefined && value !== null) el.setAttribute(key, String(value));
    });
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function edgeKey(a, b) {
    return `${a}||${b}`;
  }

  function radius(node) {
    if (!node.stars) return 9;
    return 6.5 + Math.min(12, Math.log10(node.stars + 1) * 2.45);
  }

  /* ------------------------------------------------------------------ */
  /* Data merge & classification                                         */
  /* ------------------------------------------------------------------ */

  function classify(text) {
    const t = text.toLowerCase();
    let category = 'tools';
    if (/autonomous driving|self[- ]driving|adas|bev|lidar|trajectory|vehicle|traffic|自动驾驶|无人驾驶|车路|驾驶/.test(t)) {
      category = 'driving';
    } else if (/robot|robotic|\bros\b|ros2|slam|embodied|navigation|manipulat|gazebo|rviz|机器人|导航|定位|避障|运动学/.test(t)) {
      category = 'robotics';
    } else if (/\bllm\b|large language|language model|\bagent\b|rag\b|retrieval|prompt|\bgpt\b|transformer|fine[- ]tun|multimodal|大模型|智能体/.test(t)) {
      category = 'llm';
    } else if (/tutorial|course|beginner|machine learning|deep learning|pytorch|tensorflow|interview|awesome|课程|教程|入门|学习|教材/.test(t)) {
      category = 'fundamentals';
    }

    const research = /paper|arxiv|cvpr|iccv|eccv|neurips|iclr|aaai|corl|icra|iros|benchmark|survey|official implementation|research|论文|基准|综述|研究/.test(t);
    const foundation = /tutorial|course|beginner|learn|book|awesome|interview|example|from scratch|zero to hero|入门|教程|课程|学习|刷题|教材/.test(t);
    let layer = 'engineering';
    if (research && !foundation) layer = 'research';
    else if (foundation) layer = 'foundation';
    return { layer, category };
  }

  function baseNode(entry) {
    const layer = LAYER_BY_ID[entry.layer] ? entry.layer : 'engineering';
    const category = CAT_BY_ID[entry.category] ? entry.category : 'tools';
    return {
      fullName: entry.full_name,
      name: entry.name || entry.full_name.split('/')[1],
      layer,
      category,
      summary: entry.summary || entry.description || '来自 GitHub Star 的自动收录项目，尚未添加中文注释。',
      description: entry.description || '',
      tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
      topics: Array.isArray(entry.topics) ? entry.topics.slice() : [],
      stars: Number.isFinite(entry.stargazers_count)
        ? entry.stargazers_count
        : Number.isFinite(entry.stars)
          ? entry.stars
          : 0,
      language: entry.language || '',
      url: entry.html_url || `https://github.com/${entry.full_name}`,
      starred: entry.starred !== false,
      related: Boolean(entry.related),
      auto: Boolean(entry.auto),
      starredAt: entry.starred_at || null,
      recentRank: Number.isFinite(entry.recentRank) ? entry.recentRank : 999,
      pushedAt: entry.pushed_at || null,
      _hay: '',
    };
  }

  function autoNode(repo) {
    const text = [repo.full_name, repo.description, repo.language, ...(repo.topics || [])].join(' ');
    const classified = classify(text);
    const tags = (repo.topics || []).slice(0, 4);
    return baseNode({
      ...repo,
      layer: classified.layer,
      category: classified.category,
      summary: repo.description || '来自 GitHub Star 的自动收录项目，尚未添加中文注释。',
      tags,
      auto: true,
      starred: true,
      related: false,
    });
  }

  function mergeNodes(snapshotRepos, liveRepos) {
    const map = new Map();
    DATA.repos.forEach((entry) => {
      if (entry && entry.full_name) map.set(entry.full_name, baseNode(entry));
    });

    const apply = (repos, isLive) => {
      (repos || []).forEach((repo, index) => {
        if (!repo || !repo.full_name) return;
        let node = map.get(repo.full_name);
        if (!node) {
          node = autoNode(repo);
          map.set(repo.full_name, node);
        }
        if (Number.isFinite(repo.stargazers_count)) node.stars = repo.stargazers_count;
        if (repo.language) node.language = repo.language;
        if (repo.description) {
          node.description = repo.description;
          if (node.auto) node.summary = repo.description;
        }
        if (Array.isArray(repo.topics) && repo.topics.length) {
          node.topics = repo.topics.slice();
          if (!node.tags.length) node.tags = repo.topics.slice(0, 4);
        }
        if (repo.html_url) node.url = repo.html_url;
        if (repo.starred_at) node.starredAt = repo.starred_at;
        if (repo.pushed_at) node.pushedAt = repo.pushed_at;
        node.starred = true;
        node.related = false;
        node.recentRank = index + (isLive ? 0 : 1000);
      });
    };

    apply(snapshotRepos, false);
    apply(liveRepos, true);

    return [...map.values()];
  }

  function buildEdges(nodes) {
    const byName = new Map(nodes.map((n) => [n.fullName, n]));
    const edges = [];
    const seen = new Set();
    const adjacency = new Map(nodes.map((n) => [n.fullName, new Set()]));

    const addEdge = (a, b) => {
      if (!a || !b || a === b || !byName.has(a) || !byName.has(b)) return;
      const key = a < b ? `${a}||${b}` : `${b}||${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ source: a, target: b });
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    };

    DATA.edges.forEach(([a, b]) => addEdge(a, b));

    const byCategory = new Map(CAT_ORDER.map((id) => [id, []]));
    nodes.forEach((n) => {
      if (!byCategory.has(n.category)) byCategory.set(n.category, []);
      byCategory.get(n.category).push(n);
    });

    for (let pass = 0; pass < 3; pass += 1) {
      nodes.forEach((node) => {
        if (adjacency.get(node.fullName).size >= 2) return;
        let candidates = (byCategory.get(node.category) || []).filter(
          (m) => m !== node && !adjacency.get(node.fullName).has(m.fullName),
        );
        if (!candidates.length) {
          candidates = nodes.filter(
            (m) => m !== node && m.layer === node.layer && !adjacency.get(node.fullName).has(m.fullName),
          );
        }
        if (!candidates.length) {
          candidates = nodes.filter((m) => m !== node && !adjacency.get(node.fullName).has(m.fullName));
        }
        candidates.sort((a, b) => {
          const layerDelta = (a.layer === node.layer ? 1 : 0) - (b.layer === node.layer ? 1 : 0);
          if (layerDelta) return layerDelta;
          return (b.stars || 0) - (a.stars || 0);
        });
        candidates.slice(0, 2).forEach((candidate) => addEdge(node.fullName, candidate.fullName));
      });
    }

    return { edges, adjacency };
  }

  function refreshHaystacks() {
    state.nodes.forEach((n) => {
      n._hay = [
        n.name,
        n.fullName,
        n.summary,
        n.description,
        n.language,
        ...(n.tags || []),
        ...(n.topics || []),
        LAYER_BY_ID[n.layer]?.name,
        LAYER_BY_ID[n.layer]?.en,
        CAT_BY_ID[n.category]?.name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Layout                                                              */
  /* ------------------------------------------------------------------ */

  function computeLayout(nodes, edges, previousPositions) {
    const prev = previousPositions || new Map();
    const categoryIndex = Object.fromEntries(CAT_ORDER.map((id, i) => [id, i]));

    LAYER_ORDER.forEach((layerId) => {
      const band = BANDS[layerId];
      const items = nodes
        .filter((n) => n.layer === layerId)
        .sort(
          (a, b) =>
            (categoryIndex[a.category] ?? 99) - (categoryIndex[b.category] ?? 99) ||
            (b.stars || 0) - (a.stars || 0) ||
            a.name.localeCompare(b.name),
        );
      if (!items.length) return;

      const groups = CAT_ORDER.map((cat) => ({
        cat,
        items: items.filter((n) => n.category === cat),
      })).filter((group) => group.items.length);
      const extra = items.filter((n) => !CAT_ORDER.includes(n.category));
      if (extra.length) groups.push({ cat: 'tools', items: extra });

      const slots = groups.map((group) => Math.max(1, Math.ceil(group.items.length / band.rows)));
      const totalSlots = slots.reduce((a, b) => a + b, 0) || 1;
      const usableWidth = WORLD.w - 140;
      const innerTop = band.top + 104;
      const innerBottom = band.bottom - 22;
      const innerHeight = innerBottom - innerTop;
      let cursor = 70;

      groups.forEach((group, groupIndex) => {
        const segmentWidth = (usableWidth * slots[groupIndex]) / totalSlots;
        const cols = Math.max(1, Math.ceil(group.items.length / band.rows));
        const rows = Math.max(1, Math.ceil(group.items.length / cols));
        group.items.forEach((node, index) => {
          const col = index % cols;
          const row = Math.floor(index / cols);
          const h = hashString(node.fullName);
          let initX = cursor + ((col + 0.5) * segmentWidth) / cols + ((h % 19) - 9);
          let initY = innerTop + ((row + 0.5) * innerHeight) / rows + (((h >> 5) % 15) - 7);
          const old = prev.get(node.fullName);
          if (old) {
            initX = old.x;
            initY = old.y;
          }
          node.initX = clamp(initX, 64, WORLD.w - 64);
          node.initY = clamp(initY, band.top + 104, band.bottom - 20);
          node.x = node.initX;
          node.y = node.initY;
        });
        cursor += segmentWidth;
      });
    });

    const arr = nodes
      .filter((n) => Number.isFinite(n.x))
      .map((n) => ({
        node: n,
        x: n.x,
        y: n.y,
        initX: n.initX,
        initY: n.initY,
        fx: 0,
        fy: 0,
        band: BANDS[n.layer],
      }));
    const index = new Map(arr.map((item, i) => [item.node.fullName, i]));
    const links = edges
      .map((edge) => [index.get(edge.source), index.get(edge.target)])
      .filter(([a, b]) => a !== undefined && b !== undefined);

    const iterations = 260;
    for (let iter = 0; iter < iterations; iter += 1) {
      const cooling = 1 - (iter / iterations) * 0.82;
      arr.forEach((item) => {
        item.fx = 0;
        item.fy = 0;
      });

      for (let i = 0; i < arr.length; i += 1) {
        for (let j = i + 1; j < arr.length; j += 1) {
          const a = arr[i];
          const b = arr[j];
          if (a.node.layer !== b.node.layer) continue;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          const minDist = 82;
          if (dist < 0.01) {
            dx = (hashString(a.node.fullName + b.node.fullName) % 2 ? 1 : -1) * 0.5;
            dy = 0.5;
            dist = 0.7;
          }
          if (dist < 210) {
            const force = ((210 - dist) / dist) * 0.018;
            const fx = dx * force;
            const fy = dy * force;
            a.fx -= fx;
            a.fy -= fy;
            b.fx += fx;
            b.fy += fy;
          }
          if (dist < minDist) {
            const push = (minDist - dist) * 0.06;
            const nx = dx / dist;
            const ny = dy / dist;
            a.fx -= nx * push;
            a.fy -= ny * push;
            b.fx += nx * push;
            b.fy += ny * push;
          }
        }
      }

      links.forEach(([ai, bi]) => {
        const a = arr[ai];
        const b = arr[bi];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const desired = 155;
        const force = ((dist - desired) / dist) * 0.014;
        const fx = dx * force;
        const fy = dy * force;
        a.fx += fx;
        a.fy += fy;
        b.fx -= fx;
        b.fy -= fy;
      });

      const step = 2 + 4.5 * cooling;
      arr.forEach((item) => {
        item.fx += (item.initX - item.x) * 0.024;
        item.fy += (item.initY - item.y) * 0.06;
        item.x = clamp(item.x + clamp(item.fx, -step, step), 58, WORLD.w - 58);
        item.y = clamp(
          item.y + clamp(item.fy, -step, step),
          item.band.top + 104,
          item.band.bottom - 18,
        );
      });
    }

    const positions = new Map();
    arr.forEach((item) => {
      item.node.x = item.x;
      item.node.y = item.y;
      positions.set(item.node.fullName, { x: item.x, y: item.y });
    });

    // Place each label below its node by default, flipping it above only when
    // the lower slot is occupied. Rectangles are checked in world coordinates
    // so labels in adjacent rows don't collide either.
    const labelRectFor = (node, above) => {
      const width = Math.min(node.name.length, 17) * 6.5 + 8;
      const r = radius(node);
      const baseline = above ? node.y - r - 8 : node.y + r + 16;
      return {
        x1: node.x - width / 2,
        x2: node.x + width / 2,
        y1: baseline - 11,
        y2: baseline + 3,
      };
    };
    const overlapsRect = (a, b) =>
      a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

    const circles = nodes
      .filter((node) => Number.isFinite(node.x))
      .map((node) => {
        const r = radius(node) + 3.5;
        return {
          node,
          x1: node.x - r,
          x2: node.x + r,
          y1: node.y - r,
          y2: node.y + r,
        };
      });

    const placed = [];
    nodes
      .filter((node) => Number.isFinite(node.x))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .forEach((node) => {
        let best = null;
        [false, true].forEach((above) => {
          if (
            above &&
            BANDS[node.layer] &&
            node.y - radius(node) - 19 < BANDS[node.layer].top + 64
          ) {
            return;
          }
          const rect = labelRectFor(node, above);
          let collisions = 0;
          placed.forEach((other) => {
            if (overlapsRect(rect, other)) collisions += 1;
          });
          circles.forEach((other) => {
            if (other.node !== node && overlapsRect(rect, other)) collisions += 1;
          });
          if (!best || collisions < best.collisions) {
            best = { above, rect, collisions };
          }
        });
        if (!best) {
          best = { above: false, rect: labelRectFor(node, false), collisions: 0 };
        }
        node.labelAbove = best.above;
        placed.push(best.rect);
      });
    return positions;
  }

  function graphBounds(names) {
    const list = names ? names.map((name) => state.nodeMap.get(name)).filter(Boolean) : state.nodes;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    list.forEach((node) => {
      if (!Number.isFinite(node.x)) return;
      const r = radius(node);
      minX = Math.min(minX, node.x - r - 6);
      maxX = Math.max(maxX, node.x + r + 6);
      minY = Math.min(minY, node.y - r - 6);
      maxY = Math.max(maxY, node.y + r + 22);
    });
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: WORLD.w, maxY: WORLD.h };
    return { minX, minY, maxX, maxY };
  }

  function fitTarget(bounds, padding, maxK) {
    const bw = Math.max(120, bounds.maxX - bounds.minX + padding * 2);
    const bh = Math.max(120, bounds.maxY - bounds.minY + padding * 2);
    const k = clamp(Math.min(WORLD.w / bw, WORLD.h / bh), MIN_K, maxK || 1.35);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return {
      k,
      x: WORLD.w / 2 - cx * k,
      y: WORLD.h / 2 - cy * k,
    };
  }

  function fitAll(animate) {
    const target = fitTarget(graphBounds(), 70, 1.05);
    if (animate) animateView(target, 460);
    else setView(target);
  }

  function fitNames(names, animate, padding = 90, maxK = 1.2) {
    const target = fitTarget(graphBounds(names), padding, maxK);
    if (animate) animateView(target, 480);
    else setView(target);
  }

  /* ------------------------------------------------------------------ */
  /* View transform                                                      */
  /* ------------------------------------------------------------------ */

  function maxZoom() {
    // On narrow screens the 1800-unit world is scaled down a lot by the
    // viewBox, so allow a higher in-world zoom to keep labels readable.
    const width = Math.max(280, Math.min(1100, window.innerWidth - 32));
    const base = width / WORLD.w;
    return clamp(MAX_K * (0.55 / base), MAX_K, 10);
  }

  function setView(next) {
    const k = clamp(next.k || 1, MIN_K, maxZoom());
    let cx = (WORLD.w / 2 - next.x) / k;
    let cy = (WORLD.h / 2 - next.y) / k;
    cx = clamp(cx, -WORLD.w * 0.2, WORLD.w * 1.2);
    cy = clamp(cy, -WORLD.h * 0.2, WORLD.h * 1.2);
    const x = WORLD.w / 2 - cx * k;
    const y = WORLD.h / 2 - cy * k;
    state.view = { x, y, k };

    if (state.dom.viewport) {
      state.dom.viewport.setAttribute(
        'transform',
        `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})`,
      );
    }
    if (state.dom.svg) {
      state.dom.svg.classList.toggle('zoom-far', k < 0.6);
      state.dom.svg.classList.toggle('zoom-mid', k >= 0.6 && k < 0.92);
    }
    const zoomLabel = $('#zoom-level');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(k * 100)}%`;
    updateMinimapViewport();
  }

  function animateView(target, duration = 440) {
    if (prefersReducedMotion()) {
      setView(target);
      return;
    }
    cancelAnimationFrame(state.animId);
    const start = { ...state.view };
    const started = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - p) ** 3;
      setView({
        k: start.k + (target.k - start.k) * eased,
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      });
      if (p < 1) state.animId = requestAnimationFrame(step);
    };
    state.animId = requestAnimationFrame(step);
  }

  function zoomAt(factor, vx = WORLD.w / 2, vy = WORLD.h / 2) {
    const { x, y, k } = state.view;
    const nextK = clamp(k * factor, MIN_K, maxZoom());
    if (Math.abs(nextK - k) < 0.0005) return;
    const wx = (vx - x) / k;
    const wy = (vy - y) / k;
    setView({ k: nextK, x: vx - wx * nextK, y: vy - wy * nextK });
  }

  function focusNode(fullName) {
    const node = state.nodeMap.get(fullName);
    if (!node) return;
    const k = Math.max(state.view.k, 1.18);
    animateView(
      {
        k,
        x: WORLD.w / 2 - node.x * k,
        y: WORLD.h / 2 - node.y * k,
      },
      480,
    );
  }

  function focusLayer(layerId) {
    const names = state.nodes.filter((n) => n.layer === layerId).map((n) => n.fullName);
    if (!names.length) return;
    fitNames(names, true, 80, 1.1);
    const layer = LAYER_BY_ID[layerId];
    if (layer) toast(`已聚焦「${layer.name}」分层`);
  }

  function svgPoint(clientX, clientY) {
    const svg = state.dom.svg;
    if (!svg) return { x: clientX, y: clientY };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    return pt.matrixTransform(ctm.inverse());
  }

  /* ------------------------------------------------------------------ */
  /* Graph rendering                                                     */
  /* ------------------------------------------------------------------ */

  function edgePath(a, b, seed) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const curve = Math.min(34, len * 0.1) * (hashString(seed) % 2 ? 1 : -1);
    const nx = -dy / len;
    const ny = dx / len;
    return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(mx + nx * curve).toFixed(1)},${(my + ny * curve).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }

  function renderGraph() {
    const svg = $('#graph');
    if (!svg) return;
    svg.innerHTML = '';
    svg.classList.add('zoom-far');
    svg.classList.remove('zoom-mid');

    const viewport = svgEl('g', { id: 'viewport' });
    svg.appendChild(viewport);

    const bandLayer = svgEl('g', { class: 'bands' });
    const edgeLayer = svgEl('g', { class: 'edges' });
    const nodeLayer = svgEl('g', { class: 'nodes' });
    viewport.append(bandLayer, edgeLayer, nodeLayer);

    layers.forEach((layer, index) => {
      const band = BANDS[layer.id];
      bandLayer.appendChild(
        svgEl('rect', {
          class: 'band-bg',
          x: 40,
          y: band.top,
          width: 1720,
          height: band.bottom - band.top,
          rx: 22,
        }),
      );
      bandLayer.appendChild(
        svgEl('rect', {
          class: 'band-accent',
          x: 40,
          y: band.top + 24,
          width: 3,
          height: band.bottom - band.top - 48,
          rx: 1.5,
          fill: layer.color,
        }),
      );

      const hit = svgEl('g', {
        class: 'band-hit',
        'data-layer': layer.id,
        tabindex: '0',
        role: 'button',
        'aria-label': `聚焦${layer.name}分层`,
      });
      hit.appendChild(
        svgEl('rect', {
          x: 40,
          y: band.top,
          width: 620,
          height: 64,
          fill: 'transparent',
        }),
      );
      hit.appendChild(svgEl('text', { class: 'band-index', x: 62, y: band.top + 31 }, `0${index + 1}`));
      hit.appendChild(svgEl('text', { class: 'band-name', x: 98, y: band.top + 34 }, layer.name));
      hit.appendChild(svgEl('text', { class: 'band-en', x: 98, y: band.top + 51 }, layer.en));
      hit.appendChild(
        svgEl('text', { class: 'band-desc', x: 340, y: band.top + 37 }, layer.desc),
      );
      const hint = svgEl('text', {
        class: 'band-focus-hint',
        x: 620,
        y: band.top + 37,
        'text-anchor': 'end',
        fill: layer.color,
        'font-size': 10,
        opacity: 0.75,
      }, '聚焦 ↗');
      if (!document.getElementById('band-hint-style')) {
        const style = document.createElement('style');
        style.id = 'band-hint-style';
        style.textContent =
          '.band-hit{cursor:pointer}.band-hit .band-focus-hint{opacity:0;transition:opacity .2s ease}.band-hit:hover .band-focus-hint,.band-hit:focus-visible .band-focus-hint{opacity:.8!important}.band-hit:focus{outline:none}';
        document.head.appendChild(style);
      }
      hit.appendChild(hint);
      hit.addEventListener('click', (event) => {
        if (state.suppressClick) return;
        event.stopPropagation();
        focusLayer(layer.id);
      });
      hit.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          focusLayer(layer.id);
        }
      });
      bandLayer.appendChild(hit);

      bandLayer.appendChild(
        svgEl('text', { class: 'band-watermark', x: 1736, y: band.top + 57 }, layer.en),
      );
    });

    const edgeEls = new Map();
    state.edges.forEach((edge) => {
      const a = state.nodeMap.get(edge.source);
      const b = state.nodeMap.get(edge.target);
      if (!a || !b) return;
      const path = svgEl('path', {
        class: `edge${a.layer !== b.layer ? ' is-cross' : ''}`,
        d: edgePath(a, b, edge.source + edge.target),
        'data-source': edge.source,
        'data-target': edge.target,
      });
      path.style.setProperty('--edge', CAT_BY_ID[a.category]?.color || '#6fd6ff');
      edgeLayer.appendChild(path);
      edgeEls.set(edgeKey(edge.source, edge.target), path);
    });

    const nodeEls = new Map();
    state.nodes.forEach((node) => {
      if (!Number.isFinite(node.x)) return;
      const cat = CAT_BY_ID[node.category] || { color: '#6fd6ff', name: '其他' };
      const layer = LAYER_BY_ID[node.layer] || layers[0];
      const r = radius(node);
      const group = svgEl('g', {
        class: `node${node.auto ? ' auto' : ''}${node.related ? ' related' : ''}`,
        'data-full': node.fullName,
        'data-layer': node.layer,
        transform: `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`,
        tabindex: '0',
        role: 'button',
        'aria-label': `${node.name}，${layer.name}，${cat.name}`,
      });
      group.style.setProperty('--c', cat.color);

      group.appendChild(svgEl('circle', { class: 'node-halo', r: r + 10 }));
      group.appendChild(svgEl('circle', { class: 'node-ring', r: r + 3.4 }));
      group.appendChild(svgEl('circle', { class: 'node-dot', r }));
      group.appendChild(svgEl('circle', { class: 'node-core', r: Math.max(2, r * 0.3) }));
      group.appendChild(
        svgEl(
          'text',
          { class: `node-label${node.labelAbove ? ' is-above' : ''}`, y: node.labelAbove ? -(r + 8) : r + 16 },
          truncate(node.name, 17),
        ),
      );
      group.appendChild(
        svgEl(
          'title',
          {},
          `${node.fullName}\n${layer.name} · ${cat.name}\n★ ${formatStars(node.stars)}\n${node.summary}`,
        ),
      );

      group.addEventListener('pointerenter', () => {
        if (pointerState.pointers.size) return;
        state.hoverId = node.fullName;
        refreshClasses();
      });
      group.addEventListener('pointerleave', () => {
        if (state.hoverId === node.fullName) state.hoverId = null;
        refreshClasses();
      });
      group.addEventListener('focus', () => {
        state.hoverId = node.fullName;
        refreshClasses();
      });
      group.addEventListener('blur', () => {
        if (state.hoverId === node.fullName) state.hoverId = null;
        refreshClasses();
      });
      group.addEventListener('click', (event) => {
        if (state.suppressClick) return;
        event.stopPropagation();
        selectNode(node.fullName);
      });
      group.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        selectNode(node.fullName);
        focusNode(node.fullName);
      });
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectNode(node.fullName);
        }
      });

      nodeLayer.appendChild(group);
      nodeEls.set(node.fullName, group);
    });

    state.dom = { svg, viewport, edgeEls, nodeEls };
    setView(state.view);
  }

  function refreshClasses() {
    const { edgeEls, nodeEls } = state.dom;
    if (!edgeEls || !nodeEls) return;
    const focus = state.hoverId || state.selectedId;
    const hoverFade = Boolean(state.hoverId);
    const neighbors = focus ? state.adjacency.get(focus) : null;
    const searchActive = Boolean(state.matches);

    state.nodes.forEach((node) => {
      const dom = nodeEls.get(node.fullName);
      if (!dom) return;
      const filterOk = state.visibleIds.has(node.fullName);
      const matched = state.matches ? state.matches.has(node.fullName) : false;
      const isFocus = focus === node.fullName;
      const isNear = Boolean(neighbors && neighbors.has(node.fullName));
      dom.classList.toggle('is-hidden', !filterOk);
      dom.classList.toggle('is-dim', filterOk && searchActive && !matched);
      dom.classList.toggle('is-match', matched);
      dom.classList.toggle('is-focus', isFocus);
      dom.classList.toggle('is-near', isNear && !isFocus);
      dom.classList.toggle('is-faded', hoverFade && !isFocus && !isNear && !matched);
    });

    state.edges.forEach((edge) => {
      const path = edgeEls.get(edgeKey(edge.source, edge.target));
      if (!path) return;
      const hidden = !state.visibleIds.has(edge.source) || !state.visibleIds.has(edge.target);
      const searchDim =
        searchActive && !(state.matches.has(edge.source) && state.matches.has(edge.target));
      const hot = Boolean(focus) && (edge.source === focus || edge.target === focus);
      path.classList.toggle('is-hidden', hidden);
      path.classList.toggle('is-dim', !hidden && searchDim);
      path.classList.toggle('is-hot', !hidden && hot);
      path.classList.toggle('is-faded', !hidden && hoverFade && !hot && !searchDim);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Minimap                                                             */
  /* ------------------------------------------------------------------ */

  const MINI = { pad: 6, w: 188, h: 138 };

  function renderMinimap() {
    const svg = $('#minimap');
    if (!svg) return;
    svg.innerHTML = '';
    state.nodes.forEach((node) => {
      if (!Number.isFinite(node.x)) return;
      const cat = CAT_BY_ID[node.category] || { color: '#6fd6ff' };
      svg.appendChild(
        svgEl('circle', {
          cx: MINI.pad + (node.x / WORLD.w) * MINI.w,
          cy: MINI.pad + (node.y / WORLD.h) * MINI.h,
          r: node.layer === 'engineering' ? 1.8 : 1.5,
          fill: cat.color,
          opacity: 0.72,
        }),
      );
    });
    const viewRect = svgEl('rect', {
      x: MINI.pad,
      y: MINI.pad,
      width: MINI.w,
      height: MINI.h,
      rx: 2,
      fill: 'rgba(111,214,255,0.07)',
      stroke: 'rgba(111,214,255,0.7)',
      'stroke-width': 1,
      'pointer-events': 'none',
    });
    svg.appendChild(viewRect);
    state.dom.miniViewport = viewRect;
    updateMinimapViewport();
  }

  function updateMinimapViewport() {
    const rect = state.dom.miniViewport;
    if (!rect) return;
    const { x, y, k } = state.view;
    let x0 = (0 - x) / k;
    let x1 = (WORLD.w - x) / k;
    let y0 = (0 - y) / k;
    let y1 = (WORLD.h - y) / k;
    x0 = clamp(x0, 0, WORLD.w);
    x1 = clamp(x1, 0, WORLD.w);
    y0 = clamp(y0, 0, WORLD.h);
    y1 = clamp(y1, 0, WORLD.h);
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      rect.style.display = 'none';
      return;
    }
    rect.style.display = '';
    rect.setAttribute('x', MINI.pad + (x0 / WORLD.w) * MINI.w);
    rect.setAttribute('y', MINI.pad + (y0 / WORLD.h) * MINI.h);
    rect.setAttribute('width', ((x1 - x0) / WORLD.w) * MINI.w);
    rect.setAttribute('height', ((y1 - y0) / WORLD.h) * MINI.h);
  }

  /* ------------------------------------------------------------------ */
  /* Search & filters                                                    */
  /* ------------------------------------------------------------------ */

  function tokenize(query) {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function applyFilters() {
    const tokens = tokenize(state.query);
    if (tokens.length) {
      state.matches = new Set(
        state.nodes.filter((node) => tokens.every((token) => node._hay.includes(token))).map((n) => n.fullName),
      );
    } else {
      state.matches = null;
    }

    state.visibleIds = new Set(
      state.nodes
        .filter((node) => state.layers.has(node.layer) && state.categories.has(node.category))
        .map((node) => node.fullName),
    );

    const total = state.nodes.length;
    const visible = state.visibleIds.size;
    if (state.matches) {
      let matchedVisible = 0;
      state.matches.forEach((name) => {
        if (state.visibleIds.has(name)) matchedVisible += 1;
      });
      setText('#visible-count', `匹配 ${matchedVisible} · 可见 ${visible} / ${total}`);
    } else {
      setText('#visible-count', `可见 ${visible} / ${total}`);
    }

    const clearBtn = $('#search-clear');
    if (clearBtn) clearBtn.hidden = !state.query;
    renderResults();
    refreshClasses();
  }

  function chip(kind, id, label, color, count, active, isAll) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip${isAll ? ' chip-all' : ''}${active ? ' is-active' : ''}`;
    button.dataset.kind = kind;
    button.dataset.id = id;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.style.setProperty('--c', color);
    if (!isAll) {
      const dot = el('span', 'chip-dot');
      button.appendChild(dot);
    }
    button.appendChild(el('span', '', label));
    button.appendChild(el('b', '', String(count)));
    return button;
  }

  function renderFilters() {
    const layerCounts = new Map(LAYER_ORDER.map((id) => [id, 0]));
    const catCounts = new Map(CAT_ORDER.map((id) => [id, 0]));
    state.nodes.forEach((node) => {
      layerCounts.set(node.layer, (layerCounts.get(node.layer) || 0) + 1);
      catCounts.set(node.category, (catCounts.get(node.category) || 0) + 1);
    });

    const layerWrap = $('#layer-chips');
    if (layerWrap) {
      layerWrap.innerHTML = '';
      layerWrap.appendChild(
        chip('layer', '__all', '全部', '#6fd6ff', state.nodes.length, state.layers.size === layers.length, true),
      );
      layers.forEach((layer) => {
        layerWrap.appendChild(
          chip(
            'layer',
            layer.id,
            layer.name,
            layer.color,
            layerCounts.get(layer.id) || 0,
            state.layers.has(layer.id),
            false,
          ),
        );
      });
    }

    const catWrap = $('#category-chips');
    if (catWrap) {
      catWrap.innerHTML = '';
      catWrap.appendChild(
        chip(
          'category',
          '__all',
          '全部',
          '#8cffb9',
          state.nodes.length,
          state.categories.size === categories.length,
          true,
        ),
      );
      categories.forEach((category) => {
        catWrap.appendChild(
          chip(
            'category',
            category.id,
            category.name,
            category.color,
            catCounts.get(category.id) || 0,
            state.categories.has(category.id),
            false,
          ),
        );
      });
    }
  }

  function onChipClick(event) {
    const button = event.target.closest('.chip');
    if (!button) return;
    const kind = button.dataset.kind;
    const id = button.dataset.id;
    const set = kind === 'layer' ? state.layers : state.categories;
    const allIds = kind === 'layer' ? LAYER_ORDER : CAT_ORDER;
    if (id === '__all') {
      allIds.forEach((item) => set.add(item));
    } else if (set.size === allIds.length) {
      // From the default "everything selected" state, clicking a chip means
      // "show only this one" rather than hiding it.
      set.clear();
      set.add(id);
    } else if (set.has(id)) {
      set.delete(id);
      if (!set.size) allIds.forEach((item) => set.add(item));
    } else {
      set.add(id);
    }
    renderFilters();
    applyFilters();
  }

  function matchTokensText(node) {
    return node._hay;
  }

  function sortedMatches() {
    if (!state.matches) return [];
    return state.nodes
      .filter((node) => state.matches.has(node.fullName))
      .sort((a, b) => {
        const av = state.visibleIds.has(a.fullName) ? 1 : 0;
        const bv = state.visibleIds.has(b.fullName) ? 1 : 0;
        return bv - av || (b.stars || 0) - (a.stars || 0);
      });
  }

  function renderResults() {
    const card = $('#search-results-card');
    const list = $('#search-results');
    if (!card || !list) return;
    if (!state.query.trim() || !state.matches) {
      card.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    card.classList.remove('hidden');
    setText('#search-count', `${state.matches.size} 个匹配`);
    const items = sortedMatches();

    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('p', 'result-empty', '没有匹配的项目，试试更短的关键词或清空筛选条件。'));
      return;
    }

    items.slice(0, 10).forEach((node) => {
      const cat = CAT_BY_ID[node.category] || { color: '#6fd6ff' };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'result-item';
      button.style.setProperty('--c', cat.color);
      button.appendChild(el('span', 'related-dot'));
      button.appendChild(el('span', 'result-name', node.name));
      button.appendChild(
        el('span', 'result-layer', (LAYER_BY_ID[node.layer] || layers[0]).name.slice(0, 2)),
      );
      button.addEventListener('click', () => {
        selectNode(node.fullName);
        focusNode(node.fullName);
      });
      list.appendChild(button);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Detail & side panels                                                */
  /* ------------------------------------------------------------------ */

  function pill(label, color, neutral) {
    const span = el('span', `pill${neutral ? ' pill-neutral' : ''}`);
    if (neutral) {
      span.style.setProperty('--c', '#96b1c8');
    } else {
      span.style.setProperty('--c', color);
      span.appendChild(el('span', 'pill-dot'));
    }
    span.appendChild(document.createTextNode(label));
    return span;
  }

  function renderDetail(node) {
    if (!node) return;
    const layer = LAYER_BY_ID[node.layer] || layers[0];
    const category = CAT_BY_ID[node.category] || categories[0];
    const badges = $('#project-badges');
    badges.innerHTML = '';
    badges.appendChild(pill(layer.name, layer.color, false));
    badges.appendChild(pill(category.name, category.color, false));
    if (node.related) badges.appendChild(pill('关联补充', '#96b1c8', true));
    else if (node.auto) badges.appendChild(pill('自动收录', '#8cffb9', true));
    else badges.appendChild(pill('已 Star', '#8cffb9', true));

    setText('#project-name', node.name);
    const repoLink = $('#project-repo');
    if (repoLink) {
      repoLink.textContent = node.fullName;
      repoLink.href = node.url;
    }

    const meta = $('#project-meta');
    meta.innerHTML = '';
    if (node.stars) {
      const star = el('span', 'star-meta', `★ ${formatStars(node.stars)}`);
      meta.appendChild(star);
    }
    if (node.language) meta.appendChild(el('span', '', node.language));
    if (node.pushedAt) meta.appendChild(el('span', '', `更新 ${relTime(node.pushedAt)}`));
    if (node.starredAt) meta.appendChild(el('span', '', `Star ${relTime(node.starredAt)}`));
    if (node.auto) meta.appendChild(el('span', '', '自动归类'));

    setText('#project-summary', node.summary);

    const tagWrap = $('#project-tags');
    tagWrap.innerHTML = '';
    const tags = [...new Set([...(node.tags || []), ...(node.topics || [])])].slice(0, 7);
    tags.forEach((tag) => tagWrap.appendChild(el('span', 'tag', tag)));

    const link = $('#project-link');
    link.href = node.url;
    link.textContent = 'GitHub ↗';
    const focusBtn = $('#focus-btn');
    focusBtn.onclick = () => {
      ensureVisible(node);
      focusNode(node.fullName);
    };

    const neighbors = [...(state.adjacency.get(node.fullName) || [])]
      .map((name) => state.nodeMap.get(name))
      .filter(Boolean)
      .sort((a, b) => (b.stars || 0) - (a.stars || 0))
      .slice(0, 6);
    setText('#related-count', neighbors.length ? `${neighbors.length}` : '');
    const relatedList = $('#related-list');
    relatedList.innerHTML = '';
    if (!neighbors.length) {
      relatedList.appendChild(el('p', 'related-empty', '暂无直接关联'));
    } else {
      neighbors.forEach((item) => {
        const cat = CAT_BY_ID[item.category] || { color: '#6fd6ff' };
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'related-item';
        button.style.setProperty('--c', cat.color);
        button.appendChild(el('span', 'related-dot'));
        button.appendChild(el('span', 'related-name', item.name));
        button.appendChild(
          el('span', 'related-layer', (LAYER_BY_ID[item.layer] || layers[0]).name.slice(0, 2)),
        );
        button.addEventListener('click', () => {
          selectNode(item.fullName);
          focusNode(item.fullName);
        });
        relatedList.appendChild(button);
      });
    }
  }

  function ensureVisible(node) {
    if (!node) return;
    let changed = false;
    if (!state.layers.has(node.layer)) {
      state.layers.add(node.layer);
      changed = true;
    }
    if (!state.categories.has(node.category)) {
      state.categories.add(node.category);
      changed = true;
    }
    if (changed) {
      renderFilters();
      applyFilters();
    }
  }

  function selectNode(fullName, options = {}) {
    const node = state.nodeMap.get(fullName);
    if (!node) return;
    ensureVisible(node);
    state.selectedId = fullName;
    renderDetail(node);
    refreshClasses();
    if (window.location.hash.slice(1) !== encodeURIComponent(fullName)) {
      try {
        history.replaceState(null, '', `#${encodeURIComponent(fullName)}`);
      } catch (error) {
        /* ignore */
      }
    }
    if (options.focus) focusNode(fullName);
    if (options.scroll && window.innerWidth <= 1120) {
      const card = $('#detail-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderStats() {
    const starred = state.nodes.filter((n) => n.starred).length;
    const related = state.nodes.filter((n) => n.related).length;
    const totalStars = state.nodes.reduce((sum, n) => sum + (n.stars || 0), 0);
    const reposEl = $('#kpi-repos');
    const starsEl = $('#kpi-stars');
    if (!state.statsAnimated) {
      animateNumber(reposEl, state.nodes.length, (v) => String(v));
      animateNumber(starsEl, totalStars, formatNum);
      state.statsAnimated = true;
    } else {
      setText(reposEl, String(state.nodes.length));
      setText(starsEl, formatNum(totalStars));
    }
    setText('#kpi-repos-sub', `${starred} 个 Star · ${related} 个关联补充`);
    const timeLabel = state.liveAt
      ? `实时同步 ${relTime(state.liveAt)}`
      : state.snapshotAt
        ? `快照同步 ${relTime(state.snapshotAt)}`
        : '本地精选数据';
    setText('#kpi-stars-sub', timeLabel);
    setText('#kpi-layers', String(layers.length));
    setText('#kpi-cats', String(categories.length));
  }

  function animateNumber(target, to, formatter) {
    if (!target) return;
    if (prefersReducedMotion()) {
      target.textContent = formatter(to);
      return;
    }
    const duration = 760;
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      target.textContent = formatter(Math.round(to * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderDistribution() {
    const layerWrap = $('#layer-bars');
    if (!layerWrap) return;
    layerWrap.innerHTML = '';
    const counts = new Map(LAYER_ORDER.map((id) => [id, 0]));
    state.nodes.forEach((node) => counts.set(node.layer, (counts.get(node.layer) || 0) + 1));
    const max = Math.max(1, ...counts.values());
    const total = Math.max(1, state.nodes.length);
    layers.forEach((layer) => {
      const count = counts.get(layer.id) || 0;
      const row = el('div', 'layer-bar');
      row.style.setProperty('--c', layer.color);
      const label = el('span', 'bar-label');
      label.appendChild(el('i'));
      label.appendChild(document.createTextNode(layer.name));
      row.appendChild(label);
      row.appendChild(el('span', 'bar-value', `${count} · ${Math.round((count / total) * 100)}%`));
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = `${(count / max) * 100}%`;
      track.appendChild(fill);
      row.appendChild(track);
      layerWrap.appendChild(row);
    });

    const catWrap = $('#category-legend');
    if (!catWrap) return;
    catWrap.innerHTML = '';
    const catCounts = new Map(CAT_ORDER.map((id) => [id, 0]));
    state.nodes.forEach((node) => catCounts.set(node.category, (catCounts.get(node.category) || 0) + 1));
    categories.forEach((category) => {
      const item = el('div', 'cat-legend-item');
      item.style.setProperty('--c', category.color);
      item.appendChild(el('i'));
      item.appendChild(document.createTextNode(category.name));
      item.appendChild(el('b', '', String(catCounts.get(category.id) || 0)));
      catWrap.appendChild(item);
    });
  }

  function renderRecent() {
    const wrap = $('#recent-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    const recent = state.nodes
      .filter((node) => node.starred)
      .sort((a, b) => {
        const ta = a.starredAt ? Date.parse(a.starredAt) : null;
        const tb = b.starredAt ? Date.parse(b.starredAt) : null;
        if (ta !== null || tb !== null) return (tb || 0) - (ta || 0);
        return a.recentRank - b.recentRank;
      })
      .slice(0, 6);

    recent.forEach((node) => {
      const cat = CAT_BY_ID[node.category] || { color: '#6fd6ff' };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-item';
      button.style.setProperty('--c', cat.color);
      button.appendChild(el('span', 'related-dot'));
      button.appendChild(el('span', 'recent-name', node.name));
      button.appendChild(el('span', 'recent-stars', node.stars ? `★ ${formatNum(node.stars)}` : '—'));
      button.addEventListener('click', () => {
        selectNode(node.fullName);
        focusNode(node.fullName);
      });
      wrap.appendChild(button);
    });
  }

  function renderLegend() {
    const wrap = $('#graph-legend');
    if (!wrap) return;
    wrap.innerHTML = '';
    categories.forEach((category) => {
      const item = el('span', 'legend-item');
      item.style.setProperty('--c', category.color);
      item.appendChild(el('span', 'legend-dot'));
      item.appendChild(document.createTextNode(category.name));
      wrap.appendChild(item);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Status, toast & sync                                                */
  /* ------------------------------------------------------------------ */

  let toastTimer = 0;

  function toast(message, isError) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('error', Boolean(isError));
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
  }

  function setStatus(kind, message) {
    const node = $('#sync-status');
    if (!node) return;
    node.dataset.kind = kind;
    setText('#sync-text', message);
  }

  function updateStatus() {
    const starred = state.nodes.filter((n) => n.starred).length;
    if (state.liveAt) {
      setStatus('live', `实时 · ${starred} 个 Star · ${relTime(state.liveAt)}`);
    } else if (state.snapshotAt) {
      setStatus('snapshot', `快照 · ${starred} 个 Star · ${relTime(state.snapshotAt)}`);
    } else if (state.nodes.length) {
      setStatus('snapshot', `精选数据 · ${starred} 个 Star`);
    } else {
      setStatus('error', '暂无数据');
    }
  }

  async function fetchJSON(url, timeout = 14000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-cache',
        headers: { Accept: 'application/vnd.github.star+json' },
      });
      if (response.status === 403 || response.status === 429) {
        const error = new Error('RATE_LIMIT');
        error.rateLimited = true;
        throw error;
      }
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadSnapshot() {
    try {
      const response = await fetch('data/starred.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const data = await response.json();
      state.snapshotAt = data.generatedAt || null;
      return Array.isArray(data.repos) ? data.repos : [];
    } catch (error) {
      console.warn('仓库快照加载失败，使用内置精选数据', error);
      return [];
    }
  }

  function loadLiveCache() {
    try {
      const raw = localStorage.getItem(LS_LIVE);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.repos) || !cached.repos.length) return null;
      if (!Number.isFinite(cached.fetchedAt) || Date.now() - cached.fetchedAt > LS_LIVE_TTL) {
        localStorage.removeItem(LS_LIVE);
        return null;
      }
      return cached;
    } catch (error) {
      return null;
    }
  }

  async function fetchLiveStars() {
    const all = [];
    const maxPages = 5;
    for (let page = 1; page <= maxPages; page += 1) {
      const url =
        `https://api.github.com/users/${encodeURIComponent(username)}/starred` +
        `?per_page=100&page=${page}&sort=created&direction=desc`;
      const data = await fetchJSON(url);
      if (!Array.isArray(data) || !data.length) break;
      data.forEach((item) => {
        const repo = item.repo || item;
        if (!repo || !repo.full_name) return;
        all.push({ ...repo, starred_at: item.starred_at || repo.starred_at || null });
      });
      if (data.length < 100) break;
    }
    return all;
  }

  async function syncLive(manual) {
    if (state.syncing) return;
    state.syncing = true;
    const button = $('#sync-btn');
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
    }
    if (manual) setStatus('loading', '正在同步 GitHub…');

    try {
      const repos = await fetchLiveStars();
      const before = new Set(state.nodes.map((n) => n.fullName));
      state.liveRepos = repos;
      state.liveAt = Date.now();
      try {
        localStorage.setItem(LS_LIVE, JSON.stringify({ fetchedAt: state.liveAt, username, repos }));
      } catch (error) {
        /* storage may be unavailable */
      }
      rebuild();
      const added = state.nodes.filter((node) => !before.has(node.fullName));
      updateStatus();
      if (manual) {
        toast(
          added.length
            ? `同步完成，新增 ${added.length} 个 Star 项目并加入图谱`
            : `同步完成，没有新的 Star 项目（共 ${repos.length} 个）`,
        );
      }
    } catch (error) {
      console.warn('GitHub 同步失败', error);
      if (manual) {
        const message = error.rateLimited
          ? 'GitHub API 已限流，当前展示仓库快照；请稍后再试。'
          : 'GitHub 同步失败，当前展示仓库快照。';
        setStatus('error', '同步失败 · 使用快照');
        toast(message, true);
      }
    } finally {
      state.syncing = false;
      if (button) {
        button.disabled = false;
        button.classList.remove('loading');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rebuild                                                             */
  /* ------------------------------------------------------------------ */

  function chooseDefaultSelection() {
    const hash = decodeHash();
    if (hash && state.nodeMap.has(hash)) return hash;
    const preferred = state.nodeMap.get('youngyangyang04/llm-master');
    if (preferred) return preferred.fullName;
    return [...state.nodes].sort((a, b) => (b.stars || 0) - (a.stars || 0))[0]?.fullName || null;
  }

  function rebuild() {
    const previous = state.positions;
    state.nodes = mergeNodes(state.snapshotRepos, state.liveRepos);
    state.nodeMap = new Map(state.nodes.map((node) => [node.fullName, node]));
    const graph = buildEdges(state.nodes);
    state.edges = graph.edges;
    state.adjacency = graph.adjacency;
    refreshHaystacks();

    state.positions = computeLayout(state.nodes, state.edges, previous);

    if (!state.selectedId || !state.nodeMap.has(state.selectedId)) {
      state.selectedId = chooseDefaultSelection();
    }

    renderFilters();
    renderGraph();
    renderMinimap();
    renderStats();
    renderDistribution();
    renderRecent();
    applyFilters();
    renderDetail(state.nodeMap.get(state.selectedId));
    updateStatus();
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  function bindGraphPointerEvents() {
    const svg = state.dom.svg;
    if (!svg || svg.dataset.pointerBound === '1') return;
    svg.dataset.pointerBound = '1';

    svg.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointerState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointerState.pointers.size === 1) {
        // Don't capture the pointer yet: capturing on pointerdown makes the
        // subsequent click target the SVG instead of the node under the
        // cursor. Capture only once a real drag starts.
        pointerState.panStart = {
          clientX: event.clientX,
          clientY: event.clientY,
          point: svgPoint(event.clientX, event.clientY),
          view: { ...state.view },
          moved: false,
        };
        pointerState.pinch = null;
        svg.classList.add('is-panning');
      } else if (pointerState.pointers.size === 2) {
        pointerState.pointers.forEach((_, id) => {
          try {
            svg.setPointerCapture(id);
          } catch (error) {
            /* ignore */
          }
        });
        pointerState.panStart = null;
        startPinch();
      }
    });

    svg.addEventListener('pointermove', (event) => {
      if (!pointerState.pointers.has(event.pointerId)) return;
      pointerState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointerState.pointers.size >= 2) {
        event.preventDefault();
        updatePinch();
        return;
      }

      const pan = pointerState.panStart;
      if (!pan) return;
      const point = svgPoint(event.clientX, event.clientY);
      const dxClient = event.clientX - pan.clientX;
      const dyClient = event.clientY - pan.clientY;
      if (!pan.moved && Math.hypot(dxClient, dyClient) > 4) pan.moved = true;
      if (pan.moved) {
        if (!svg.hasPointerCapture(event.pointerId)) {
          try {
            svg.setPointerCapture(event.pointerId);
          } catch (error) {
            /* ignore */
          }
        }
        setView({
          k: pan.view.k,
          x: pan.view.x + (point.x - pan.point.x),
          y: pan.view.y + (point.y - pan.point.y),
        });
      }
    });

    const endPointer = (event) => {
      if (!pointerState.pointers.has(event.pointerId)) return;
      try {
        if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
      const wasPinch = pointerState.pointers.size >= 2;
      pointerState.pointers.delete(event.pointerId);
      if (pointerState.pointers.size < 2) pointerState.pinch = null;

      if (pointerState.pointers.size === 0) {
        if (pointerState.panStart && pointerState.panStart.moved) {
          state.suppressClick = true;
          setTimeout(() => {
            state.suppressClick = false;
          }, 0);
        }
        pointerState.panStart = null;
        svg.classList.remove('is-panning');
      } else if (pointerState.pointers.size === 1 && wasPinch) {
        const [id, point] = [...pointerState.pointers.entries()][0];
        pointerState.panStart = {
          clientX: point.x,
          clientY: point.y,
          point: svgPoint(point.x, point.y),
          view: { ...state.view },
          moved: true,
        };
        pointerState.pointers.set(id, point);
      }
    };

    // Listen on the window so a release outside the graph still resets the
    // pointer state (capture is only taken once a drag actually starts).
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);

    svg.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const point = svgPoint(event.clientX, event.clientY);
        const factor = clamp(Math.exp(-event.deltaY * 0.0015), 0.5, 2);
        zoomAt(factor, point.x, point.y);
      },
      { passive: false },
    );

    svg.addEventListener('dblclick', (event) => {
      if (event.target.closest('.node')) return;
      const point = svgPoint(event.clientX, event.clientY);
      zoomAt(1.55, point.x, point.y);
    });

    svg.addEventListener('click', (event) => {
      if (state.suppressClick || event.target.closest('.node')) return;
      state.hoverId = null;
      refreshClasses();
    });
  }

  function startPinch() {
    const points = [...pointerState.pointers.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pointerState.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid,
      midPoint: svgPoint(mid.x, mid.y),
      view: { ...state.view },
    };
  }

  function updatePinch() {
    const points = [...pointerState.pointers.values()];
    const pinch = pointerState.pinch;
    if (points.length < 2 || !pinch) return;
    const [a, b] = points;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const k = clamp(pinch.view.k * (dist / pinch.dist), MIN_K, maxZoom());
    const wx = (pinch.midPoint.x - pinch.view.x) / pinch.view.k;
    const wy = (pinch.midPoint.y - pinch.view.y) / pinch.view.k;
    const midPoint = svgPoint(mid.x, mid.y);
    setView({
      k,
      x: midPoint.x - wx * k,
      y: midPoint.y - wy * k,
    });
  }

  function bindMinimap() {
    const minimap = $('#minimap');
    if (!minimap) return;

    const navigate = (event) => {
      const rect = minimap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = ((event.clientX - rect.left) / rect.width) * 200;
      const py = ((event.clientY - rect.top) / rect.height) * 150;
      const wx = clamp(((px - MINI.pad) / MINI.w) * WORLD.w, 0, WORLD.w);
      const wy = clamp(((py - MINI.pad) / MINI.h) * WORLD.h, 0, WORLD.h);
      const k = state.view.k;
      setView({ k, x: WORLD.w / 2 - wx * k, y: WORLD.h / 2 - wy * k });
    };

    minimap.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      pointerState.miniDragging = true;
      try {
        minimap.setPointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
      navigate(event);
    });
    minimap.addEventListener('pointermove', (event) => {
      if (!pointerState.miniDragging) return;
      event.preventDefault();
      navigate(event);
    });
    const stop = (event) => {
      pointerState.miniDragging = false;
      try {
        minimap.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
    };
    minimap.addEventListener('pointerup', stop);
    minimap.addEventListener('pointercancel', stop);
  }

  function bindUI() {
    $('#layer-chips')?.addEventListener('click', onChipClick);
    $('#category-chips')?.addEventListener('click', onChipClick);

    $('#filter-reset')?.addEventListener('click', () => {
      state.layers = new Set(LAYER_ORDER);
      state.categories = new Set(CAT_ORDER);
      renderFilters();
      applyFilters();
      toast('已重置筛选');
    });

    const search = $('#search');
    let searchTimer = 0;
    search?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = search.value;
        applyFilters();
      }, 120);
    });
    search?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (state.matches && state.matches.size) {
          const [first] = sortedMatches();
          if (first) {
            selectNode(first.fullName);
            focusNode(first.fullName);
          }
        }
      }
    });

    const clearSearch = () => {
      if (search) search.value = '';
      state.query = '';
      applyFilters();
      search?.focus();
    };
    $('#search-clear')?.addEventListener('click', clearSearch);
    $('#search-results-clear')?.addEventListener('click', clearSearch);

    $('#zoom-in')?.addEventListener('click', () => zoomAt(1.28));
    $('#zoom-out')?.addEventListener('click', () => zoomAt(1 / 1.28));
    $('#zoom-fit')?.addEventListener('click', () => fitAll(true));
    $('#zoom-level')?.addEventListener('click', () => fitAll(true));
    $('#zoom-reset')?.addEventListener('click', () => {
      fitAll(true);
      toast('视图已重置');
    });

    $('#sync-btn')?.addEventListener('click', () => syncLive(true));

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        search?.focus();
        search?.select();
        return;
      }
      if (event.key === 'Escape') {
        if (target === search) {
          if (search.value) {
            clearSearch();
          } else {
            search.blur();
          }
        }
        return;
      }
      if (typing) return;

      const key = event.key.toLowerCase();
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomAt(1.25);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomAt(1 / 1.25);
      } else if (event.key === '0' || key === 'f') {
        event.preventDefault();
        fitAll(true);
      } else if (event.key === '1') {
        focusLayer('foundation');
      } else if (event.key === '2') {
        focusLayer('engineering');
      } else if (event.key === '3') {
        focusLayer('research');
      }
    });

    window.addEventListener('hashchange', () => {
      const name = decodeHash();
      if (name && state.nodeMap.has(name) && name !== state.selectedId) {
        selectNode(name);
        focusNode(name);
      }
    });
  }

  function decodeHash() {
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch (error) {
      return '';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    renderLegend();
    renderFilters();
    setStatus('loading', '正在载入仓库快照…');

    const snapshotRepos = await loadSnapshot();
    state.snapshotRepos = snapshotRepos;

    const cached = loadLiveCache();
    if (cached) {
      state.liveRepos = cached.repos;
      state.liveAt = cached.fetchedAt;
    }

    rebuild();
    bindMinimap();
    fitAll(false);
    setView(state.view);

    const hash = decodeHash();
    if (hash && state.nodeMap.has(hash)) state.selectedId = hash;
    if (!state.selectedId && state.nodes.length) {
      state.selectedId = chooseDefaultSelection();
    }
    renderDetail(state.nodeMap.get(state.selectedId));

    const loading = $('#graph-loading');
    if (loading) loading.classList.add('is-hidden');
    setTimeout(() => $('#graph-hint')?.classList.add('is-hidden'), 9000);

    if (!state.liveAt) updateStatus();

    const stale =
      !state.snapshotAt || Date.now() - Date.parse(state.snapshotAt) > AUTO_SYNC_AGE;
    const cacheFresh = state.liveAt && Date.now() - state.liveAt < LIVE_CACHE_FRESH;
    if ((!snapshotRepos.length || stale) && !cacheFresh) {
      setTimeout(() => syncLive(false), 700);
    }
  }

  // Graph pointer events need the SVG created by renderGraph.
  const originalRebuild = rebuild;
  rebuild = function rebuildWithEvents() {
    originalRebuild();
    bindGraphPointerEvents();
  };

  bindUI();
  init();
})();
