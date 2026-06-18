// city.js — Hyper-real 3D city renderer for VaultCity
// Combines the best of VaultGraph4D (Electron) + VaultCity (Tauri)
// Bloom • Shadows • Day/Night • Window Textures • Wireframes • Props • Stars

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// Deterministic PRNG so the city looks the same across reloads
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic per-district color
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export class City {
  constructor(canvas) {
    this.canvas = canvas;
    this.buildings = new Map();
    this.props = [];
    this.roads = null;
    this.timeOfDay = 0.25;
    this.onSelect = () => {};
    this._windowTextureCache = {};
    this._init();
  }

  _init() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    // Renderer with shadows + tone mapping
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x070a14, 0.0012);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 8000);
    this.camera.position.set(140, 160, 220);

    // Orbit controls — wide open for city exploration
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minPolarAngle = 0.05;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 4000;
    this.controls.panSpeed = 1.2;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 1.5;

    // Ground plane (dark asphalt)
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x08080d, roughness: 0.95, metalness: 0.0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(10000, 10000), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Star field sky
    this._createSky();

    // Hemisphere light
    this.hemi = new THREE.HemisphereLight(0x9fb4ff, 0x202028, 0.6);
    this.scene.add(this.hemi);

    // Directional light (sun/moon) with shadows
    this.sun = new THREE.DirectionalLight(0xfff1d0, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 2000;
    const d = 800;
    Object.assign(this.sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Ambient fill for night
    this.ambientNight = new THREE.AmbientLight(0x404060, 0.3);
    this.scene.add(this.ambientNight);

    // Post-processing: bloom for glowing windows at night
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.4, 0.85);
    this.composer.addPass(this.bloom);

    // Raycaster for picking buildings
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.canvas.addEventListener('pointerdown', (e) => this._pick(e));

    window.addEventListener('resize', () => this._resize());
    this._resize();

    this.setTimeOfDay(this.timeOfDay);
    this._animate();
  }

  _createSky() {
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 512;
    skyCanvas.height = 512;
    const ctx = skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#01010a');
    grad.addColorStop(0.4, '#070a18');
    grad.addColorStop(0.7, '#0a0e1a');
    grad.addColorStop(1, '#1a0a2e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);

    // Stars
    for (let i = 0; i < 1200; i++) {
      const brightness = Math.random() * 0.8;
      ctx.fillStyle = `rgba(255,255,255,${brightness})`;
      const size = Math.random() > 0.98 ? 2 : 1;
      ctx.fillRect(Math.random() * 512, Math.random() * 300, size, size);
    }

    this._skyTexture = new THREE.CanvasTexture(skyCanvas);
    this.scene.background = this._skyTexture;
  }

  _resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  setTimeOfDay(t) {
    this.timeOfDay = t;

    // Sun arc
    const ang = Math.PI * (0.15 + 0.7 * t);
    this.sun.position.set(Math.cos(ang) * 600, Math.sin(ang) * 700 + 80, 400);
    this.sun.target.position.set(0, 0, 0);

    const day = THREE.MathUtils.clamp(t, 0, 1);

    // Sky/fog: night navy → day blue
    const night = new THREE.Color(0x070a14);
    const noon = new THREE.Color(0x213049);
    const sky = night.clone().lerp(noon, day);
    this.scene.fog.color.copy(sky);

    // Light intensities
    this.sun.intensity = 0.4 + day * 2.2;
    this.hemi.intensity = 0.25 + day * 0.6;
    this.ambientNight.intensity = 0.4 - day * 0.3;

    // Bloom: windows glow more at night
    this.bloom.strength = 1.2 - day * 0.8;

    // Toggle window emissive intensity on all buildings
    const lit = 1 - day;
    this.buildings.forEach((m) => {
      const glow = m.userData.glow || 0.5;
      if (Array.isArray(m.material)) {
        m.material.forEach(mat => {
          if (mat.emissiveIntensity !== undefined) {
            mat.emissiveIntensity = lit * glow;
          }
        });
      } else if (m.material.emissiveIntensity !== undefined) {
        m.material.emissiveIntensity = lit * glow;
      }
    });
  }

  // Window texture generation — each building gets unique lit windows
  _getWindowTexture(baseColor, height) {
    const key = baseColor + '_' + Math.round(height);
    if (this._windowTextureCache[key]) return this._windowTextureCache[key];

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = Math.max(64, Math.round(height * 2));
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const winW = 5, winH = 7, gapX = 5, gapY = 7;
    const cols = Math.floor((canvas.width - gapX) / (winW + gapX));
    const rows = Math.floor((canvas.height - gapY) / (winH + gapY));
    const startX = (canvas.width - cols * (winW + gapX) + gapX) / 2;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = startX + col * (winW + gapX);
        const y = gapY + row * (winH + gapY);
        const isLit = Math.random() > 0.35;
        if (isLit) {
          const warmth = Math.random();
          if (warmth > 0.7) ctx.fillStyle = 'rgba(255,200,80,1)';
          else if (warmth > 0.4) ctx.fillStyle = 'rgba(255,150,50,0.9)';
          else ctx.fillStyle = 'rgba(150,200,255,0.8)';
        } else {
          ctx.fillStyle = 'rgba(10,10,15,1)';
        }
        ctx.fillRect(x, y, winW, winH);
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    this._windowTextureCache[key] = tex;
    return tex;
  }

  // Build a single building mesh with window textures + neon wireframe + antenna
  _makeBuilding(foot, height, hue, node, rng) {
    const geo = new THREE.BoxGeometry(foot, height, foot);
    geo.translate(0, height / 2, 0);

    // Tag-driven saturation tint
    const sat = THREE.MathUtils.clamp(0.25 + node.tags.length * 0.08, 0.25, 0.7);
    const base = new THREE.Color().setHSL(hue / 360, sat, 0.55);
    const baseHex = '#' + base.getHexString();

    // Window texture
    const windowTex = this._getWindowTexture(baseHex, height);

    // Materials: sides with window texture, top dark, bottom black
    const sideMat = new THREE.MeshStandardMaterial({
      map: windowTex,
      emissive: 0xffffff,
      emissiveMap: windowTex,
      emissiveIntensity: 0.8,
      metalness: 0.3,
      roughness: 0.7,
      color: 0x111111
    });

    const topMat = new THREE.MeshStandardMaterial({ color: 0x080808, metalness: 0.8, roughness: 0.2 });
    const bottomMat = new THREE.MeshStandardMaterial({ color: 0x000000 });

    const mesh = new THREE.Mesh(geo, [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Neon wireframe edges
    const edges = new THREE.EdgesGeometry(geo);
    const edgeMat = new THREE.LineBasicMaterial({ color: base, transparent: true, opacity: 0.7 });
    const wireframe = new THREE.LineSegments(edges, edgeMat);
    mesh.add(wireframe);

    // Antenna on tall buildings
    if (height > 60) {
      const antennaGeo = new THREE.CylinderGeometry(0.2, 0.2, height * 0.15, 4);
      antennaGeo.translate(0, height + height * 0.075, 0);
      const antennaMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
      mesh.add(new THREE.Mesh(antennaGeo, antennaMat));
    }

    // Glow factor for bloom — taller/more-connected buildings glow brighter
    mesh.userData.glow = THREE.MathUtils.clamp(node.degree / 10, 0.2, 1.0);
    mesh.userData.node = node;

    return mesh;
  }

  // Streetlight prop
  _makeStreetlight(x, z) {
    const group = new THREE.Group();
    const poleGeo = new THREE.CylinderGeometry(0.2, 0.3, 12, 6);
    poleGeo.translate(0, 6, 0);
    group.add(new THREE.Mesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.4 })));

    const bulbGeo = new THREE.SphereGeometry(0.8, 8, 6);
    bulbGeo.translate(0, 11.5, 0);
    group.add(new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0xffaa44 })));

    const glowGeo = new THREE.CircleGeometry(8, 16);
    glowGeo.rotateX(-Math.PI / 2);
    glowGeo.translate(0, 0.1, 0);
    group.add(new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending })));

    group.position.set(x, 0, z);
    return group;
  }

  // Tree prop
  _makeTree(x, z) {
    const group = new THREE.Group();
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.5, 4, 4);
    trunkGeo.translate(0, 2, 0);
    group.add(new THREE.Mesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a1a })));

    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x0a1a0a, roughness: 1 });
    const c1 = new THREE.ConeGeometry(3, 6, 5);
    c1.translate(0, 6, 0);
    group.add(new THREE.Mesh(c1, canopyMat));

    group.position.set(x, 0, z);
    return group;
  }

  // Build the entire city from graph data
  build(graph) {
    // Clear existing
    this.buildings.forEach((m) => {
      this.scene.remove(m);
      m.geometry.dispose();
      if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose());
      else m.material.dispose();
    });
    this.buildings.clear();
    this.props.forEach(p => this.scene.remove(p));
    this.props = [];
    if (this.roads) {
      this.scene.remove(this.roads);
      this.roads = null;
    }
    this._windowTextureCache = {};

    const rng = mulberry32(1337);
    const districts = graph.districts.length ? graph.districts : ['root'];
    const cols = Math.ceil(Math.sqrt(districts.length));
    const districtGap = 240;

    // Group nodes per district
    const groups = new Map();
    districts.forEach((d) => groups.set(d, []));
    graph.nodes.forEach((n) => {
      if (!groups.has(n.folder)) groups.set(n.folder, []);
      groups.get(n.folder).push(n);
    });

    const maxDeg = graph.nodes.reduce((mx, n) => Math.max(mx, n.degree), 1);
    const positions = new Map();
    const occupied = new Set();

    let di = 0;
    for (const [district, nodes] of groups) {
      const gx = (di % cols) * districtGap - (cols * districtGap) / 2;
      const gz = Math.floor(di / cols) * districtGap - (cols * districtGap) / 2;
      di++;

      const side = Math.ceil(Math.sqrt(nodes.length || 1));
      const spacing = 26;
      const hue = hashHue(district);

      nodes.forEach((n, i) => {
        const bx = gx + ((i % side) - side / 2) * spacing + (rng() - 0.5) * 4;
        const bz = gz + (Math.floor(i / side) - side / 2) * spacing + (rng() - 0.5) * 4;

        // Size: footprint from word_count, height from degree
        const foot = THREE.MathUtils.clamp(6 + Math.sqrt(n.word_count || 0) * 0.5, 6, 18);
        const height = 8 + (n.degree / maxDeg) * 150 + (n.word_count || 0) * 0.01;

        const mesh = this._makeBuilding(foot, height, hue, n, rng);
        mesh.position.set(bx, 0, bz);
        this.scene.add(mesh);
        this.buildings.set(n.id, mesh);
        positions.set(n.id, new THREE.Vector3(bx, 0, bz));
        occupied.add(`${Math.round(bx / 10)},${Math.round(bz / 10)}`);
      });
    }

    this._buildRoads(graph, positions);
    this._buildProps(graph, positions, occupied, rng);

    this.frameAll(positions);
    this.setTimeOfDay(this.timeOfDay);
  }

  _buildRoads(graph, positions) {
    const edges = graph.edges || graph.links || [];
    const pts = [];
    edges.forEach((e) => {
      const a = positions.get(e.source);
      const b = positions.get(e.target);
      if (a && b) {
        pts.push(a.x, 0.3, a.z, b.x, 0.3, b.z);
      }
    });
    if (!pts.length) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.LineBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.25 });
    this.roads = new THREE.LineSegments(g, m);
    this.scene.add(this.roads);
  }

  _buildProps(graph, positions, occupied, rng) {
    const nodeCount = graph.nodes.length;

    // Trees
    const maxTrees = Math.min(300, Math.floor(nodeCount * 0.15));
    let treeCount = 0;
    for (let i = 0; i < maxTrees * 4 && treeCount < maxTrees; i++) {
      const nodes = graph.nodes;
      const n = nodes[Math.floor(rng() * nodes.length)];
      const pos = positions.get(n.id);
      if (!pos) continue;
      const x = pos.x + (rng() - 0.5) * 40;
      const z = pos.z + (rng() - 0.5) * 40;
      const key = `${Math.round(x / 10)},${Math.round(z / 10)}`;
      if (!occupied.has(key)) {
        const tree = this._makeTree(x, z);
        this.scene.add(tree);
        this.props.push(tree);
        occupied.add(key);
        treeCount++;
      }
    }

    // Streetlights along roads
    const edges = graph.edges || graph.links || [];
    const maxLights = Math.min(100, Math.floor(edges.length * 0.05));
    let lightCount = 0;
    for (let i = 0; i < edges.length && lightCount < maxLights; i++) {
      if (rng() > 0.08) continue;
      const e = edges[i];
      const a = positions.get(e.source);
      const b = positions.get(e.target);
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2 + (rng() - 0.5) * 8;
      const mz = (a.z + b.z) / 2 + (rng() - 0.5) * 8;
      const key = `${Math.round(mx / 10)},${Math.round(mz / 10)}`;
      if (occupied.has(key)) continue;
      const light = this._makeStreetlight(mx, mz);
      this.scene.add(light);
      this.props.push(light);
      occupied.add(key);
      lightCount++;
    }
  }

  frameAll(positions) {
    if (!positions.size) return;
    const box = new THREE.Box3();
    positions.forEach((p) => box.expandByPoint(p));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z) || 300;
    this.controls.target.copy(c);
    this.camera.position.set(c.x + r * 0.5, r * 0.6 + 100, c.z + r * 0.8);
  }

  highlight(id) {
    const m = this.buildings.get(id);
    if (m) {
      const p = m.position;
      this.controls.target.copy(new THREE.Vector3(p.x, 0, p.z));
      this.camera.position.set(p.x + 50, 70, p.z + 60);
    }
  }

  toggleDistrict(district, visible) {
    this.buildings.forEach((m) => {
      if (m.userData.node.folder === district) m.visible = visible;
    });
  }

  _pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.buildings.values()]);
    if (hits.length) this.onSelect(hits[0].object.userData.node);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.composer.render();
  }
}
