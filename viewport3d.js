/**
 * Jihu Slicer - Hardware-Accelerated WebGL 3D Viewport Renderer
 * Features:
 *  - True WebGL Hardware Z-Buffer Depth Testing (gl.DEPTH_TEST) — zero X-ray bleed-through or sort artifacts
 *  - High-Resolution 3D Capsule/Stadium Tube Geometry for Every Extruded Bead (Cura / OrcaSlicer quality)
 *  - Per-Pixel Capsule Curvature Shading + Inter-Layer Cavity Ambient Occlusion (matches reference Screenshot 2)
 *  - Physical 3D Rounded End-Cap Z-Seam Groove on Every Layer
 *  - Dark Rich Feature Color Palette (Dark Orange, Dark Yellow, Burgundy Red, Deep Green)
 *  - Interactive 3D Raycast "Place on Face" (Lay on Bed) in Prepare Mode
 */

window.JihuViewport3D = function (canvas) {
  // Create a transparent 2D HUD canvas overlay for crisp typography (axis labels, bed title, banners)
  let hudCanvas = null;
  let hudCtx = null;
  if (canvas.parentElement) {
    hudCanvas = canvas.parentElement.querySelector('.viewport-hud-overlay');
    if (!hudCanvas) {
      hudCanvas = document.createElement('canvas');
      hudCanvas.className = 'viewport-hud-overlay';
      hudCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;';
      canvas.parentElement.appendChild(hudCanvas);
    }
    hudCtx = hudCanvas.getContext('2d');
  }

  const gl = canvas.getContext('webgl', {
    antialias: true,
    depth: true,
    alpha: false,
    premultipliedAlpha: false
  });

  // Camera state (spherical orbit around target)
  const camera = {
    yaw: -0.68,
    pitch: 0.56,
    distance: 460,
    targetX: 150,
    targetY: 150,
    targetZ: 65,
    fov: 42
  };

  // Dark, rich feature color palette (normalized 0..1 for WebGL)
  const FEATURE_COLORS = {
    outer_wall:    [0.74, 0.31, 0.09], // Dark Orange (#bd4f17)
    spiral_wall:   [0.74, 0.31, 0.09], // Dark Orange (#bd4f17)
    inner_wall:    [0.64, 0.50, 0.08], // Dark Yellow / Ochre (#a38014)
    solid_infill:  [0.54, 0.12, 0.20], // Burgundy Red (#8a1f33)
    sparse_infill: [0.11, 0.42, 0.25], // Deep Green (#1c6b40)
    travel:        [0.16, 0.40, 0.55]  // Deep Steel Blue (#29668c)
  };

  let bedSize = { x: 300, y: 300, z: 380 };
  let viewMode = 'prepare'; // 'prepare' | 'preview'
  let previewRenderStyle = 'extruded_form'; // 'extruded_form' | 'toolpath_lines' | 'hybrid_xray'
  let previewColorScheme = 'feature'; // 'feature' | 'speed' | 'concrete_realistic'

  let currentMesh = null;
  let currentSlice = null;
  let maxVisibleLayer = Infinity;
  let singleLayerOnly = false;
  let showTravelMoves = false;
  let showZSeams = true;
  let showGhostMeshInPreview = false;

  // Interactive "Place on Face" state
  let placeOnFaceActive = false;
  let hoveredTriIndex = -1;
  let hoveredNormal = null;
  let onFaceSelectedCallback = null;

  // Mouse interaction state
  let isDragging = false;
  let dragMovedDistance = 0;
  let dragButton = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let needsRender = false;

  // WebGL resources & buffer caches
  let extUintIndex = null;
  let solidProgram = null;
  let lineProgram = null;

  let bedBuffers = null;
  let bedBuiltForSize = '';

  let meshBuffer = null;
  let meshFeatureLineBuffer = null;
  let meshShadowBuffer = null;
  let meshDirty = true;

  let currentSupportMesh = null;
  let showSupportMesh = true;
  let supportBuffer = null;
  let supportFeatureLineBuffer = null;
  let supportDirty = true;

  let sliceBeadChunks = [];
  let sliceLineBuffer = null;
  let sliceTravelBuffer = null;
  let sliceSeamPointBuffer = null;
  let sliceBuffersDirty = true;

  // =========================================================================
  // 1. WEBGL SHADERS & INITIALIZATION
  // =========================================================================

  const SOLID_VS = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec3 aColor;
    attribute vec2 aLayerAndProfile;

    uniform mat4 uViewProj;
    uniform vec3 uModelOffset;
    uniform float uMinLayer;
    uniform float uMaxLayer;

    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec3 vColor;
    varying float vProfile;
    varying float vLayerIdx;

    void main() {
      float layerIdx = aLayerAndProfile.x;
      if (layerIdx >= 0.0 && (layerIdx < uMinLayer - 0.1 || layerIdx > uMaxLayer + 0.1)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      vec3 pos = aPosition + uModelOffset;
      vWorldPos = pos;
      vNormal = aNormal;
      vColor = aColor;
      vProfile = aLayerAndProfile.y;
      vLayerIdx = layerIdx;
      gl_Position = uViewProj * vec4(pos, 1.0);
    }
  `;

  const SOLID_FS = `
    precision highp float;

    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec3 vColor;
    varying float vProfile;
    varying float vLayerIdx;

    uniform vec3 uCameraPos;
    uniform vec3 uCameraRight;
    uniform vec3 uCameraUp;
    uniform float uAlpha;

    void main() {
      vec3 viewDir = normalize(uCameraPos - vWorldPos);
      vec3 N = normalize(vNormal);

      // Key light attached to upper-left of camera + world overhead light for consistent 3D perception
      vec3 keyLight = normalize(viewDir * 0.52 - uCameraRight * 0.25 + uCameraUp * 0.48 + vec3(0.0, 0.0, 0.45));
      vec3 fillLight = normalize(viewDir * 0.35 + uCameraRight * 0.40 - uCameraUp * 0.20);

      if (vProfile <= 1.5) {
        // -------------------------------------------------------------------
        // UNIFIED 3D ROUNDED CAPSULE BEAD SHADING (Cura / OrcaSlicer WebGL look)
        // vProfile ranges continuously from +1.0 (top flat crown) through
        // +0.6 (upper rounded shoulder), 0.0 (equator), -0.6 (lower overhang)
        // down to -1.0 (bottom layer crease). Zero branch discontinuities!
        // -------------------------------------------------------------------
        float p = clamp(vProfile, -1.0, 1.0);

        float diffKey = max(0.0, dot(N, keyLight));
        float diffFill = max(0.0, dot(N, fillLight));

        // Smooth cylindrical roll: bright upper shoulder (+0.15..+0.75), rich equator (0.0),
        // and deep smooth shadow on the lower overhang (-0.10..-0.98) into the layer groove
        float baseUndersideShadow = mix(0.22, 1.0, smoothstep(-0.94, 0.08, p));
        // When camera rotates underneath looking up at the bottom of the print, illuminate bottom faces cleanly
        float viewUnderside = smoothstep(0.10, -0.25, viewDir.z);
        float undersideShadow = mix(baseUndersideShadow, 1.0, viewUnderside);
        float upperCrownBoost = 1.0 + 0.14 * smoothstep(-0.10, 0.55, p) * (1.0 - smoothstep(0.65, 0.98, p));
        float topShoulderEdge = 1.0 - 0.16 * smoothstep(0.72, 0.96, p) * (1.0 - smoothstep(0.96, 1.0, p));

        // Warm specular highlight along the rounded upper-outer ridge of each bead
        vec3 halfVec = normalize(keyLight + viewDir);
        float specMask = smoothstep(-0.35, 0.35, p) * (1.0 - 0.5 * smoothstep(0.85, 1.0, p));
        float spec = pow(max(0.0, dot(N, halfVec)), 26.0) * 0.19 * specMask;

        float lighting = (0.32 + 0.54 * diffKey + 0.16 * diffFill) * undersideShadow * upperCrownBoost * topShoulderEdge;
        vec3 litColor = vColor * lighting + vec3(spec);
        gl_FragColor = vec4(clamp(litColor, 0.0, 1.0), uAlpha);
      } else if (vProfile > 8.0) {
        // -------------------------------------------------------------------
        // BUILD PLATE CONTACT SHADOW (vProfile > 8.0)
        // -------------------------------------------------------------------
        gl_FragColor = vec4(vColor, 0.40 * uAlpha);
      } else {
        // -------------------------------------------------------------------
        // PREPARE MODE 3D MESH SHADING (vProfile == 5.0)
        // High-End CAD Studio Look: Key + Fill + HemiSky + Fresnel Rim + Satin Specular
        // -------------------------------------------------------------------
        bool isBack = dot(N, viewDir) < 0.0;
        if (isBack) {
          N = -N;
        }

        // Key light: Warm upper-left studio light
        float diffKey = max(0.0, dot(N, keyLight));
        // Fill light: Soft cool studio fill from lower opposite angle
        float diffFill = max(0.0, dot(N, fillLight));
        // Sky-ground hemisphere ambient: gently lighter from above (+Z)
        float hemiLight = 0.5 + 0.5 * N.z;

        // Fresnel glancing rim light: outlines 3D silhouettes crisply against dark canvas
        float NdotV = max(0.0, dot(N, viewDir));
        float fresnel = pow(1.0 - NdotV, 3.2);
        vec3 rimColor = vec3(0.38, 0.72, 0.85) * fresnel * 0.40;

        // Satin Blinn-Phong specular highlights
        vec3 halfVec = normalize(keyLight + viewDir);
        float specKey = pow(max(0.0, dot(N, halfVec)), 32.0) * 0.28;
        vec3 fillHalf = normalize(fillLight + viewDir);
        float specFill = pow(max(0.0, dot(N, fillHalf)), 18.0) * 0.08;

        // Inner cavity / backface depth factor: gives natural depth to hollow tubes and throat
        float cavityFactor = isBack ? 0.70 : 1.0;

        float diffuse = 0.24 + 0.52 * diffKey + 0.18 * diffFill + 0.10 * hemiLight;
        vec3 litColor = (vColor * diffuse * cavityFactor) + rimColor + vec3(specKey + specFill);
        gl_FragColor = vec4(clamp(litColor, 0.0, 1.0), uAlpha);
      }
    }
  `;

  const LINE_VS = `
    attribute vec3 aPosition;
    attribute vec4 aColor;
    attribute float aLayerIndex;

    uniform mat4 uViewProj;
    uniform vec3 uModelOffset;
    uniform float uMinLayer;
    uniform float uMaxLayer;
    uniform float uPointSize;

    varying vec4 vColor;

    void main() {
      if (aLayerIndex >= 0.0 && (aLayerIndex < uMinLayer - 0.1 || aLayerIndex > uMaxLayer + 0.1)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      vec3 pos = aPosition + uModelOffset;
      vColor = aColor;
      gl_Position = uViewProj * vec4(pos, 1.0);
      gl_PointSize = uPointSize;
    }
  `;

  const LINE_FS = `
    precision mediump float;
    varying vec4 vColor;
    void main() {
      gl_FragColor = vColor;
    }
  `;

  function compileShader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(s));
    }
    return s;
  }

  function createProgram(vsSource, fsSource, attribs, uniforms) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog));
    }
    const attribLocs = {};
    for (const a of attribs) attribLocs[a] = gl.getAttribLocation(prog, a);
    const uniformLocs = {};
    for (const u of uniforms) uniformLocs[u] = gl.getUniformLocation(prog, u);
    return { prog, attribs: attribLocs, uniforms: uniformLocs };
  }

  function initWebGL() {
    if (!gl) return;
    extUintIndex = gl.getExtension('OES_element_index_uint');

    solidProgram = createProgram(
      SOLID_VS,
      SOLID_FS,
      ['aPosition', 'aNormal', 'aColor', 'aLayerAndProfile'],
      ['uViewProj', 'uModelOffset', 'uCameraPos', 'uCameraRight', 'uCameraUp', 'uMinLayer', 'uMaxLayer', 'uAlpha']
    );

    lineProgram = createProgram(
      LINE_VS,
      LINE_FS,
      ['aPosition', 'aColor', 'aLayerIndex'],
      ['uViewProj', 'uModelOffset', 'uMinLayer', 'uMaxLayer', 'uPointSize']
    );

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  initWebGL();

  // =========================================================================
  // 2. CAMERA & MATRICES
  // =========================================================================

  function getCameraBasis(width, height) {
    const cosP = Math.cos(camera.pitch);
    const sinP = Math.sin(camera.pitch);
    const cosY = Math.cos(camera.yaw);
    const sinY = Math.sin(camera.yaw);

    const camX = camera.targetX + camera.distance * cosP * sinY;
    const camY = camera.targetY - camera.distance * cosP * cosY;
    const camZ = camera.targetZ + camera.distance * sinP;

    let fx = camera.targetX - camX;
    let fy = camera.targetY - camY;
    let fz = camera.targetZ - camZ;
    const flen = Math.hypot(fx, fy, fz) || 1;
    fx /= flen; fy /= flen; fz /= flen;

    let rx = fy;
    let ry = -fx;
    let rz = 0;
    const rlen = Math.hypot(rx, ry, rz) || 1;
    rx /= rlen; ry /= rlen; rz /= rlen;

    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const aspect = width / Math.max(1, height);
    const fovRad = (camera.fov * Math.PI) / 180;
    const f = 1.0 / Math.tan(fovRad * 0.5);
    const near = 4.0;
    const far = 5000.0;

    // View matrix (column-major)
    const view = new Float32Array([
      rx, ux, -fx, 0,
      ry, uy, -fy, 0,
      rz, uz, -fz, 0,
      -(rx * camX + ry * camY + rz * camZ),
      -(ux * camX + uy * camY + uz * camZ),
      (fx * camX + fy * camY + fz * camZ),
      1
    ]);

    // Perspective matrix (column-major)
    const nf = 1.0 / (near - far);
    const proj = new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, (2 * far * near) * nf, 0
    ]);

    // Multiply proj * view
    const viewProj = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += proj[k * 4 + row] * view[col * 4 + k];
        }
        viewProj[col * 4 + row] = sum;
      }
    }

    const focal = (height * 0.5) * f;
    return {
      camX, camY, camZ,
      fx, fy, fz,
      rx, ry, rz,
      ux, uy, uz,
      focal,
      cx: width * 0.5,
      cy: height * 0.5,
      viewProj
    };
  }

  function projectPoint2D(x, y, z, basis) {
    const dx = x - basis.camX;
    const dy = y - basis.camY;
    const dz = z - basis.camZ;
    const vz = dx * basis.fx + dy * basis.fy + dz * basis.fz;
    if (vz <= 4) return null;
    const vx = dx * basis.rx + dy * basis.ry + dz * basis.rz;
    const vy = dx * basis.ux + dy * basis.uy + dz * basis.uz;
    const scale = basis.focal / vz;
    return {
      x: basis.cx + vx * scale,
      y: basis.cy - vy * scale,
      depth: vz
    };
  }

  // =========================================================================
  // 3. BUILD PLATE, GRID & CAGE BUFFERS
  // =========================================================================

  function ensureBedBuffers() {
    const key = `${bedSize.x}_${bedSize.y}_${bedSize.z}`;
    if (bedBuffers && bedBuiltForSize === key) return;
    bedBuiltForSize = key;

    const bx = bedSize.x;
    const by = bedSize.y;
    const bz = bedSize.z;

    // 1. Transparent Bed Grid & Cage lines (stride = 8 floats: x,y,z, r,g,b,a, layerIdx)
    const lines = [];
    function pushLine(x1, y1, z1, x2, y2, z2, r, g, b, a) {
      lines.push(x1, y1, z1, r, g, b, a, -1);
      lines.push(x2, y2, z2, r, g, b, a, -1);
    }

    const gz = -0.04;
    // Internal 10mm grid lines (minor 10mm, major 50mm)
    for (let x = 0; x <= bx; x += 10) {
      const major = (x % 50 === 0);
      const c = major ? 0.32 : 0.16;
      const a = major ? 0.85 : 0.40;
      pushLine(x, 0, gz, x, by, gz, c, c, c + 0.02, a);
    }
    for (let y = 0; y <= by; y += 10) {
      const major = (y % 50 === 0);
      const c = major ? 0.32 : 0.16;
      const a = major ? 0.85 : 0.40;
      pushLine(0, y, gz, bx, y, gz, c, c, c + 0.02, a);
    }

    // Outer border of the transparent bed plate (crisp perimeter)
    const bc = 0.45;
    pushLine(0, 0, gz, bx, 0, gz, bc, bc, bc + 0.02, 1.0);
    pushLine(bx, 0, gz, bx, by, gz, bc, bc, bc + 0.02, 1.0);
    pushLine(bx, by, gz, 0, by, gz, bc, bc, bc + 0.02, 1.0);
    pushLine(0, by, gz, 0, 0, gz, bc, bc, bc + 0.02, 1.0);

    // Wireframe height cage
    const cc = 0.22;
    pushLine(0, 0, 0, 0, 0, bz, cc, cc, cc, 0.85);
    pushLine(bx, 0, 0, bx, 0, bz, cc, cc, cc, 0.85);
    pushLine(bx, by, 0, bx, by, bz, cc, cc, cc, 0.85);
    pushLine(0, by, 0, 0, by, bz, cc, cc, cc, 0.85);

    pushLine(0, 0, bz, bx, 0, bz, cc, cc, cc, 0.85);
    pushLine(bx, 0, bz, bx, by, bz, cc, cc, cc, 0.85);
    pushLine(bx, by, bz, 0, by, bz, cc, cc, cc, 0.85);
    pushLine(0, by, bz, 0, 0, bz, cc, cc, cc, 0.85);

    // Origin X, Y, Z axes
    pushLine(0, 0, 0.1, 45, 0, 0.1, 0.95, 0.95, 0.98, 1.0);
    pushLine(0, 0, 0.1, 0, 45, 0.1, 0.72, 0.72, 0.78, 1.0);
    pushLine(0, 0, 0.1, 0, 0, 45, 0.55, 0.55, 0.62, 1.0);

    const lineArr = new Float32Array(lines);
    const lineVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, lineArr, gl.STATIC_DRAW);

    bedBuffers = {
      lineVbo,
      lineCount: lines.length / 8
    };
  }

  // =========================================================================
  // 4. PREPARE MODE: 3D MODEL MESH BUFFER & RAYCAST FACE PICKING
  // =========================================================================

  // -------------------------------------------------------------------------
  // Crease-Preserving Smooth Normals (Blends normals across curved faces < 42°,
  // preserving sharp mechanical corners >= 42° like OrcaSlicer / Fusion 360)
  // -------------------------------------------------------------------------
  function computeSmoothNormals(mesh, maxAngleDeg = 42) {
    if (mesh._smoothNormals && mesh._smoothNormalsAngle === maxAngleDeg) {
      return mesh._smoothNormals;
    }
    const v = mesh.vertices;
    const triCount = mesh.triangleCount;
    const fn = new Float32Array(triCount * 3);

    for (let i = 0; i < triCount; i++) {
      const idx = i * 9;
      const ux = v[idx + 3] - v[idx], uy = v[idx + 4] - v[idx + 1], uz = v[idx + 5] - v[idx + 2];
      const vx = v[idx + 6] - v[idx], vy = v[idx + 7] - v[idx + 1], vz = v[idx + 8] - v[idx + 2];
      let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz) || 1;
      fn[i * 3] = cx / len;
      fn[i * 3 + 1] = cy / len;
      fn[i * 3 + 2] = cz / len;
    }

    const vertexMap = new Map();
    for (let i = 0; i < triCount; i++) {
      const idx = i * 9;
      for (let k = 0; k < 3; k++) {
        const key = Math.round(v[idx + k * 3] * 50) + '_' + Math.round(v[idx + k * 3 + 1] * 50) + '_' + Math.round(v[idx + k * 3 + 2] * 50);
        let list = vertexMap.get(key);
        if (!list) {
          list = [];
          vertexMap.set(key, list);
        }
        list.push(i);
      }
    }

    const cosThresh = Math.cos((maxAngleDeg * Math.PI) / 180);
    const sn = new Float32Array(triCount * 9);

    for (let i = 0; i < triCount; i++) {
      const idx = i * 9;
      const fnx = fn[i * 3], fny = fn[i * 3 + 1], fnz = fn[i * 3 + 2];

      for (let k = 0; k < 3; k++) {
        const key = Math.round(v[idx + k * 3] * 50) + '_' + Math.round(v[idx + k * 3 + 1] * 50) + '_' + Math.round(v[idx + k * 3 + 2] * 50);
        const sharing = vertexMap.get(key);
        let sx = 0, sy = 0, sz = 0;
        if (sharing) {
          for (let s = 0; s < sharing.length; s++) {
            const o = sharing[s];
            const dot = fnx * fn[o * 3] + fny * fn[o * 3 + 1] + fnz * fn[o * 3 + 2];
            if (dot >= cosThresh) {
              sx += fn[o * 3];
              sy += fn[o * 3 + 1];
              sz += fn[o * 3 + 2];
            }
          }
        }
        const slen = Math.hypot(sx, sy, sz) || 1;
        sn[idx + k * 3] = sx / slen;
        sn[idx + k * 3 + 1] = sy / slen;
        sn[idx + k * 3 + 2] = sz / slen;
      }
    }

    mesh._smoothNormals = sn;
    mesh._smoothNormalsAngle = maxAngleDeg;
    mesh._faceNormals = fn;
    return sn;
  }

  // -------------------------------------------------------------------------
  // Extract Sharp Mechanical Feature Lines (Edges > 32° or open boundaries)
  // -------------------------------------------------------------------------
  function buildFeatureEdges(mesh, angleThresholdDeg = 32) {
    const v = mesh.vertices;
    const triCount = mesh.triangleCount;
    computeSmoothNormals(mesh);
    const fn = mesh._faceNormals;

    const edgeMap = new Map();
    function edgeKey(x1, y1, z1, x2, y2, z2) {
      const k1 = Math.round(x1 * 50) + '_' + Math.round(y1 * 50) + '_' + Math.round(z1 * 50);
      const k2 = Math.round(x2 * 50) + '_' + Math.round(y2 * 50) + '_' + Math.round(z2 * 50);
      return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
    }

    for (let i = 0; i < triCount; i++) {
      const idx = i * 9;
      for (let k = 0; k < 3; k++) {
        const kNext = (k + 1) % 3;
        const x1 = v[idx + k * 3], y1 = v[idx + k * 3 + 1], z1 = v[idx + k * 3 + 2];
        const x2 = v[idx + kNext * 3], y2 = v[idx + kNext * 3 + 1], z2 = v[idx + kNext * 3 + 2];
        const key = edgeKey(x1, y1, z1, x2, y2, z2);
        let entry = edgeMap.get(key);
        if (!entry) {
          entry = { x1, y1, z1, x2, y2, z2, tris: [i] };
          edgeMap.set(key, entry);
        } else {
          entry.tris.push(i);
        }
      }
    }

    const cosThresh = Math.cos((angleThresholdDeg * Math.PI) / 180);
    const lines = [];
    for (const entry of edgeMap.values()) {
      let isFeature = false;
      if (entry.tris.length === 1) {
        isFeature = true;
      } else if (entry.tris.length === 2) {
        const t1 = entry.tris[0], t2 = entry.tris[1];
        const dot = fn[t1 * 3] * fn[t2 * 3] + fn[t1 * 3 + 1] * fn[t2 * 3 + 1] + fn[t1 * 3 + 2] * fn[t2 * 3 + 2];
        if (dot <= cosThresh) {
          isFeature = true;
        }
      }
      if (isFeature) {
        lines.push(
          entry.x1, entry.y1, entry.z1, 0.08, 0.12, 0.16, 0.50, -1.0,
          entry.x2, entry.y2, entry.z2, 0.08, 0.12, 0.16, 0.50, -1.0
        );
      }
    }
    return new Float32Array(lines);
  }

  // -------------------------------------------------------------------------
  // Build Plate Soft Contact Shadow (anchors model footprint on the bed)
  // -------------------------------------------------------------------------
  function buildContactShadow(bounds) {
    if (!bounds || bounds.minZ > 8.0) return null;
    const cx = (bounds.minX + bounds.maxX) * 0.5;
    const cy = (bounds.minY + bounds.maxY) * 0.5;
    const rx = Math.max(10, bounds.sizeX * 0.54);
    const ry = Math.max(10, bounds.sizeY * 0.54);
    const segs = 36;
    const verts = [];
    const z = 0.015;

    for (let i = 0; i < segs; i++) {
      const a1 = (i / segs) * Math.PI * 2;
      const a2 = ((i + 1) / segs) * Math.PI * 2;
      const x1 = cx + rx * Math.cos(a1), y1 = cy + ry * Math.sin(a1);
      const x2 = cx + rx * Math.cos(a2), y2 = cy + ry * Math.sin(a2);

      // Stride 11: x,y,z, nx,ny,nz, r,g,b, layerIdx(-1), profileV(9.0)
      // Center (darkest shadow core)
      verts.push(cx, cy, z, 0, 0, 1, 0.02, 0.02, 0.03, -1.0, 9.0);
      // Vertex 1 (soft perimeter fade)
      verts.push(x1, y1, z, 0, 0, 1, 0.086, 0.086, 0.098, -1.0, 9.0);
      // Vertex 2 (soft perimeter fade)
      verts.push(x2, y2, z, 0, 0, 1, 0.086, 0.086, 0.098, -1.0, 9.0);
    }
    return new Float32Array(verts);
  }

  function ensureMeshBuffer() {
    if (!meshDirty) return;
    meshDirty = false;

    if (meshBuffer && meshBuffer.vbo) {
      gl.deleteBuffer(meshBuffer.vbo);
      meshBuffer = null;
    }
    if (meshFeatureLineBuffer && meshFeatureLineBuffer.vbo) {
      gl.deleteBuffer(meshFeatureLineBuffer.vbo);
      meshFeatureLineBuffer = null;
    }
    if (meshShadowBuffer && meshShadowBuffer.vbo) {
      gl.deleteBuffer(meshShadowBuffer.vbo);
      meshShadowBuffer = null;
    }
    if (!currentMesh || !currentMesh.vertices || !currentMesh.triangleCount) return;

    const v = currentMesh.vertices;
    const triCount = currentMesh.triangleCount;
    const sn = computeSmoothNormals(currentMesh, 42);
    const fn = currentMesh._faceNormals;

    // Stride = 11 floats: x,y,z, nx,ny,nz, r,g,b, layerIdx(-1), profileV(5.0)
    const data = new Float32Array(triCount * 3 * 11);
    let ptr = 0;

    for (let i = 0; i < triCount; i++) {
      const idx = i * 9;
      const fnx = fn[i * 3], fny = fn[i * 3 + 1], fnz = fn[i * 3 + 2];

      let isHovered = false;
      if (placeOnFaceActive && hoveredNormal) {
        const dot = fnx * hoveredNormal.x + fny * hoveredNormal.y + fnz * hoveredNormal.z;
        if (dot > 0.992) isHovered = true;
      }

      // OrcaSlicer-style elegant satin CAD teal: #2ea896 (or gold #ffb703 if hovered in Place on Face)
      const r = isHovered ? 0.98 : 0.20;
      const g = isHovered ? 0.82 : 0.63;
      const b = isHovered ? 0.20 : 0.58;

      for (let k = 0; k < 3; k++) {
        const vIdx = idx + k * 3;
        data[ptr++] = v[vIdx];
        data[ptr++] = v[vIdx + 1];
        data[ptr++] = v[vIdx + 2];
        data[ptr++] = sn[vIdx];
        data[ptr++] = sn[vIdx + 1];
        data[ptr++] = sn[vIdx + 2];
        data[ptr++] = r;
        data[ptr++] = g;
        data[ptr++] = b;
        data[ptr++] = -1.0;
        data[ptr++] = 5.0;
      }
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    meshBuffer = { vbo, vertexCount: triCount * 3 };

    // Build crisp feature edge line buffer for mechanical edge clarity
    const edgeData = buildFeatureEdges(currentMesh, 32);
    if (edgeData && edgeData.length > 0) {
      const eVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, eVbo);
      gl.bufferData(gl.ARRAY_BUFFER, edgeData, gl.STATIC_DRAW);
      meshFeatureLineBuffer = { vbo: eVbo, count: edgeData.length / 8 };
    }

    // Build soft contact shadow on the build plate
    const shadowData = buildContactShadow(currentMesh.bounds);
    if (shadowData && shadowData.length > 0) {
      const sVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, sVbo);
      gl.bufferData(gl.ARRAY_BUFFER, shadowData, gl.STATIC_DRAW);
      meshShadowBuffer = { vbo: sVbo, vertexCount: shadowData.length / 11 };
    }
  }

  function ensureSupportBuffer() {
    if (!supportDirty) return;
    supportDirty = false;

    if (supportBuffer && supportBuffer.vbo) {
      gl.deleteBuffer(supportBuffer.vbo);
      supportBuffer = null;
    }
    if (supportFeatureLineBuffer && supportFeatureLineBuffer.vbo) {
      gl.deleteBuffer(supportFeatureLineBuffer.vbo);
      supportFeatureLineBuffer = null;
    }
    if (!currentSupportMesh || !currentSupportMesh.vertices || !currentSupportMesh.triangleCount) return;

    const v = currentSupportMesh.vertices;
    const triCount = currentSupportMesh.triangleCount;
    const sn = computeSmoothNormals(currentSupportMesh, 36);

    const data = new Float32Array(triCount * 3 * 11);
    let ptr = 0;

    // Distinct engineered polymer support color (cool silver-cyan / amber highlight)
    const r = 0.28, g = 0.78, b = 0.92;

    for (let i = 0; i < triCount; i++) {
      const idx = i * 9;
      for (let k = 0; k < 3; k++) {
        const vIdx = idx + k * 3;
        data[ptr++] = v[vIdx];
        data[ptr++] = v[vIdx + 1];
        data[ptr++] = v[vIdx + 2];
        data[ptr++] = sn[vIdx];
        data[ptr++] = sn[vIdx + 1];
        data[ptr++] = sn[vIdx + 2];
        data[ptr++] = r;
        data[ptr++] = g;
        data[ptr++] = b;
        data[ptr++] = -1.0;
        data[ptr++] = 5.0;
      }
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    supportBuffer = { vbo, vertexCount: triCount * 3 };

    const edgeData = buildFeatureEdges(currentSupportMesh, 28);
    if (edgeData && edgeData.length > 0) {
      const eVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, eVbo);
      gl.bufferData(gl.ARRAY_BUFFER, edgeData, gl.STATIC_DRAW);
      supportFeatureLineBuffer = { vbo: eVbo, count: edgeData.length / 8 };
    }
  }

  // Exact 3D Ray-Triangle Intersection (Möller–Trumbore) for "Place on Face"
  function raycastMesh(mx, my, width, height) {
    if (!currentMesh || !currentMesh.vertices || !currentMesh.triangleCount) return null;
    const basis = getCameraBasis(width, height);

    const ndcX = mx - basis.cx;
    const ndcY = basis.cy - my;

    let dirX = basis.fx * basis.focal + basis.rx * ndcX + basis.ux * ndcY;
    let dirY = basis.fy * basis.focal + basis.ry * ndcX + basis.uy * ndcY;
    let dirZ = basis.fz * basis.focal + basis.rz * ndcX + basis.uz * ndcY;
    const dlen = Math.hypot(dirX, dirY, dirZ) || 1;
    dirX /= dlen; dirY /= dlen; dirZ /= dlen;

    const origX = basis.camX;
    const origY = basis.camY;
    const origZ = basis.camZ;

    const v = currentMesh.vertices;
    const n = currentMesh.normals;
    const triCount = currentMesh.triangleCount;

    let bestT = Infinity;
    let bestTri = -1;

    for (let i = 0; i < triCount; i++) {
      const idx = i * 9;
      const v0x = v[idx],     v0y = v[idx + 1], v0z = v[idx + 2];
      const v1x = v[idx + 3], v1y = v[idx + 4], v1z = v[idx + 5];
      const v2x = v[idx + 6], v2y = v[idx + 7], v2z = v[idx + 8];

      const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
      const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;

      const hx = dirY * e2z - dirZ * e2y;
      const hy = dirZ * e2x - dirX * e2z;
      const hz = dirX * e2y - dirY * e2x;

      const a = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(a) < 1e-7) continue;

      const f = 1.0 / a;
      const sx = origX - v0x, sy = origY - v0y, sz = origZ - v0z;
      const u = f * (sx * hx + sy * hy + sz * hz);
      if (u < 0.0 || u > 1.0) continue;

      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;

      const vParam = f * (dirX * qx + dirY * qy + dirZ * qz);
      if (vParam < 0.0 || u + vParam > 1.0) continue;

      const t = f * (e2x * qx + e2y * qy + e2z * qz);
      if (t > 1.0 && t < bestT) {
        bestT = t;
        bestTri = i;
      }
    }

    if (bestTri !== -1) {
      const nIdx = bestTri * 9;
      return {
        triIndex: bestTri,
        nx: n[nIdx],
        ny: n[nIdx + 1],
        nz: n[nIdx + 2]
      };
    }
    return null;
  }

  // =========================================================================
  // 5. PREVIEW MODE: 3D VOLUMETRIC EXTRUDED CAPSULE/TUBE GENERATOR
  // =========================================================================

  function getMoveColorRGB(mv, slice) {
    if (previewColorScheme === 'concrete_realistic') {
      if (mv.type === 'outer_wall' || mv.type === 'spiral_wall') return [0.64, 0.64, 0.62];
      if (mv.type === 'inner_wall') return [0.54, 0.54, 0.52];
      if (mv.type === 'solid_infill') return [0.58, 0.58, 0.56];
      return [0.47, 0.47, 0.45];
    }
    if (previewColorScheme === 'speed') {
      const spd = mv.speed || 25;
      const t = Math.max(0, Math.min(1, (spd - 10) / 35));
      return [0.16 + t * 0.65, 0.30 + (1 - Math.abs(t - 0.5) * 2) * 0.32, 0.68 * (1 - t)];
    }
    return FEATURE_COLORS[mv.type] || FEATURE_COLORS.outer_wall;
  }

  /**
   * 12-vertex continuous rounded stadium/capsule cross-section profile:
   * Every vertex has a smooth 3D normal (normLat, normZ) and continuous profileV in [-1.0, +1.0].
   */
  const RING_VERTS = 12;
  // [sideSign (-1 left, +1 right), capCos (0..1 lateral roundness), zSin (-1..+1 vertical), normLat, normZ, profileV]
  const CAPSULE_PROFILE = [
    // Top flat crown (gentle pillowed normal across top surface)
    [-1, 0.05,  1.00, -0.14,  0.99,  0.98], // 0: Top-left crown
    [ 1, 0.05,  1.00,  0.14,  0.99,  0.98], // 1: Top-right crown

    // Right rounded capsule wall (curving from top shoulder around equator into bottom groove)
    [ 1, 0.48,  0.86,  0.52,  0.85,  0.76], // 2: Right upper shoulder
    [ 1, 0.86,  0.50,  0.86,  0.50,  0.44], // 3: Right upper-mid
    [ 1, 1.00,  0.00,  1.00,  0.00,  0.00], // 4: Right equator (full width +W/2)
    [ 1, 0.86, -0.50,  0.86, -0.50, -0.44], // 5: Right lower-mid
    [ 1, 0.48, -0.86,  0.52, -0.85, -0.76], // 6: Right lower overhang

    // Bottom base
    [ 1, 0.05, -1.00,  0.14, -0.99, -0.98], // 7: Bottom-right base
    [-1, 0.05, -1.00, -0.14, -0.99, -0.98], // 8: Bottom-left base

    // Left rounded capsule wall (curving from bottom groove around equator up to top shoulder)
    [-1, 0.48, -0.86, -0.52, -0.85, -0.76], // 9:  Left lower overhang
    [-1, 0.86, -0.50, -0.86, -0.50, -0.44], // 10: Left lower-mid
    [-1, 1.00,  0.00, -1.00,  0.00,  0.00], // 11: Left equator (full width -W/2)
    [-1, 0.86,  0.50, -0.86,  0.50,  0.44], // 12: Left upper-mid
    [-1, 0.48,  0.86, -0.52,  0.85,  0.76]  // 13: Left upper shoulder
  ];
  const NUM_RING_VERTS = CAPSULE_PROFILE.length; // 14

  function normalizeChainSeamEnds(rawSegs, minEndLen) {
    if (rawSegs.length <= 3) return rawSegs;
    const segs = rawSegs.slice();
    while (segs.length > 3) {
      const s0 = segs[0];
      const len0 = Math.hypot(s0.x2 - s0.x1, s0.y2 - s0.y1);
      if (len0 >= minEndLen) break;
      const s1 = segs[1];
      segs[0] = Object.assign({}, s0, { x2: s1.x2, y2: s1.y2, z2: s1.z2 });
      segs.splice(1, 1);
    }
    while (segs.length > 3) {
      const lastIdx = segs.length - 1;
      const sL = segs[lastIdx];
      const lenL = Math.hypot(sL.x2 - sL.x1, sL.y2 - sL.y1);
      if (lenL >= minEndLen) break;
      const sPrev = segs[lastIdx - 1];
      segs[lastIdx - 1] = Object.assign({}, sPrev, { x2: sL.x2, y2: sL.y2, z2: sL.z2 });
      segs.pop();
    }
    return segs;
  }

  function createBeadMeshBuilder(onChunkFlush, maxVertsPerChunk) {
    const ctx = {
      curVerts: [],
      curIndices: [],
      curVertCount: 0,
      maxVertsPerChunk: maxVertsPerChunk || 58000,
      flushChunk() {
        if (ctx.curVertCount === 0 || ctx.curIndices.length === 0) return;
        onChunkFlush(new Float32Array(ctx.curVerts), new Uint16Array(ctx.curIndices));
        ctx.curVerts = [];
        ctx.curIndices = [];
        ctx.curVertCount = 0;
      }
    };

    function emitRing(px, py, pzTop, nx, ny, tx, ty, tangentTilt, width, height, widthScale, heightScale, rgb, layerIdx) {
      const baseIdx = ctx.curVertCount;
      const rw = Math.max(0.2, width * 0.5 * widthScale);
      const rh = Math.max(0.15, height * 0.525 * heightScale);
      const zCenter = pzTop - height * 0.5;

      const rCap = Math.min(rw * 0.84, rh * 1.08);
      const wFlat = Math.max(0.0, rw - rCap);

      const cosTilt = Math.sqrt(Math.max(0.0, 1.0 - tangentTilt * tangentTilt));

      for (let k = 0; k < NUM_RING_VERTS; k++) {
        const prof = CAPSULE_PROFILE[k];
        const sideSign = prof[0];
        const capCos = prof[1];
        const zSin = prof[2];
        const normLat = prof[3];
        const normZ = prof[4];
        const profileV = prof[5];

        const latOffset = sideSign * (wFlat + rCap * capCos);
        const zOffset = rh * zSin;

        const vx = px + nx * latOffset;
        const vy = py + ny * latOffset;
        const vz = zCenter + zOffset;

        const vnx = (nx * normLat) * cosTilt + tx * tangentTilt;
        const vny = (ny * normLat) * cosTilt + ty * tangentTilt;
        const vnz = normZ * cosTilt;

        ctx.curVerts.push(
          vx, vy, vz,
          vnx, vny, vnz,
          rgb[0], rgb[1], rgb[2],
          layerIdx, profileV
        );
      }
      ctx.curVertCount += NUM_RING_VERTS;
      return baseIdx;
    }

    function connectRings(ringA, ringB) {
      for (let k = 0; k < NUM_RING_VERTS; k++) {
        const nextK = (k + 1) % NUM_RING_VERTS;
        const a0 = ringA + k;
        const a1 = ringA + nextK;
        const b0 = ringB + k;
        const b1 = ringB + nextK;
        ctx.curIndices.push(a0, b0, b1, a0, b1, a1);
      }
    }

    function emitEndCapFan(ringIdx, tipX, tipY, tipZ, tipNx, tipNy, rgb, layerIdx, isStartCap) {
      const tipVertIdx = ctx.curVertCount;
      ctx.curVerts.push(
        tipX, tipY, tipZ,
        tipNx, tipNy, 0.0,
        rgb[0], rgb[1], rgb[2],
        layerIdx, 0.0
      );
      ctx.curVertCount += 1;

      for (let k = 0; k < NUM_RING_VERTS; k++) {
        const nextK = (k + 1) % NUM_RING_VERTS;
        if (isStartCap) {
          ctx.curIndices.push(tipVertIdx, ringIdx + nextK, ringIdx + k);
        } else {
          ctx.curIndices.push(ringIdx + k, ringIdx + nextK, tipVertIdx);
        }
      }
    }

    function emitChainTube(chain) {
      let segs = chain.segs;
      if (segs.length === 0) return;

      const first0 = segs[0];
      const width = first0.width || 5.0;
      const height = first0.height || 2.5;

      segs = normalizeChainSeamEnds(segs, width * 0.42);
      const nSegs = segs.length;

      const estVerts = (nSegs + 8) * NUM_RING_VERTS * 2;
      if (ctx.curVertCount + estVerts > ctx.maxVertsPerChunk) {
        ctx.flushChunk();
      }

      const first = segs[0];
      const last = segs[nSegs - 1];
      const rgb = getMoveColorRGB(first, currentSlice);
      const defaultLayerIdx = chain.layerIdx;

      const closeDist = Math.hypot(last.x2 - first.x1, last.y2 - first.y1, last.z2 - first.z1);
      const isClosedLoop = closeDist < 0.25 && nSegs >= 3;
      const weldSeamlessLoop = isClosedLoop && !(showZSeams && first.type === 'outer_wall');

      const tx = new Float32Array(nSegs);
      const ty = new Float32Array(nSegs);
      const nx = new Float32Array(nSegs);
      const ny = new Float32Array(nSegs);
      const segLen = new Float32Array(nSegs);

      for (let i = 0; i < nSegs; i++) {
        const s = segs[i];
        const dx = s.x2 - s.x1;
        const dy = s.y2 - s.y1;
        const l = Math.hypot(dx, dy) || 1e-5;
        segLen[i] = l;
        tx[i] = dx / l;
        ty[i] = dy / l;
        nx[i] = ty[i];
        ny[i] = -tx[i];
      }

      if (weldSeamlessLoop) {
        let firstRing = -1;
        let prevRing = -1;

        for (let i = 0; i < nSegs; i++) {
          const prevI = (i - 1 + nSegs) % nSegs;
          const ptX = segs[i].x1;
          const ptY = segs[i].y1;
          const ptZ = segs[i].z1;
          const lIdx = segs[i]._layerIdx !== undefined ? segs[i]._layerIdx : defaultLayerIdx;
          const dot = tx[prevI] * tx[i] + ty[prevI] * ty[i];

          if (dot > 0.45) {
            let jnx = nx[prevI] + nx[i];
            let jny = ny[prevI] + ny[i];
            const jlen = Math.hypot(jnx, jny) || 1;
            jnx /= jlen; jny /= jlen;
            const miter = Math.min(1.35, 1.0 / Math.max(0.6, jnx * nx[i] + jny * ny[i]));

            const rIdx = emitRing(ptX, ptY, ptZ, jnx, jny, tx[i], ty[i], 0.0, width, height, miter, 1.0, rgb, lIdx);
            if (prevRing !== -1) connectRings(prevRing, rIdx);
            else firstRing = rIdx;
            prevRing = rIdx;
          } else {
            let jnx = nx[prevI] + nx[i];
            let jny = ny[prevI] + ny[i];
            const jlen = Math.hypot(jnx, jny) || 1;
            jnx /= jlen; jny /= jlen;
            const miter = Math.min(1.42, 1.0 / Math.max(0.55, jnx * nx[i] + jny * ny[i]));

            const rIn = emitRing(ptX, ptY, ptZ, nx[prevI], ny[prevI], tx[prevI], ty[prevI], 0.0, width, height, 1.0, 1.0, rgb, lIdx);
            if (prevRing !== -1) connectRings(prevRing, rIn);
            else firstRing = rIn;

            const rMid = emitRing(ptX, ptY, ptZ, jnx, jny, tx[i], ty[i], 0.0, width, height, miter * 0.96, 1.0, rgb, lIdx);
            connectRings(rIn, rMid);

            const rOut = emitRing(ptX, ptY, ptZ, nx[i], ny[i], tx[i], ty[i], 0.0, width, height, 1.0, 1.0, rgb, lIdx);
            connectRings(rMid, rOut);
            prevRing = rOut;
          }
        }
        if (prevRing !== -1 && firstRing !== -1) {
          connectRings(prevRing, firstRing);
        }
        return;
      }

      const firstLIdx = first._layerIdx !== undefined ? first._layerIdx : defaultLayerIdx;
      let s0x, s0y, sMidX, sMidY, sFullX, sFullY;
      if (isClosedLoop) {
        const capInset = Math.min(width * 0.22, segLen[0] * 0.36);
        s0x = first.x1 + tx[0] * (capInset * 0.08);
        s0y = first.y1 + ty[0] * (capInset * 0.08);
        sMidX = first.x1 + tx[0] * (capInset * 0.45);
        sMidY = first.y1 + ty[0] * (capInset * 0.45);
        sFullX = first.x1 + tx[0] * capInset;
        sFullY = first.y1 + ty[0] * capInset;
      } else {
        const capProtrude = Math.min(width * 0.36, Math.max(width * 0.18, segLen[0] * 0.35));
        sFullX = first.x1;
        sFullY = first.y1;
        sMidX = first.x1 - tx[0] * (capProtrude * 0.55);
        sMidY = first.y1 - ty[0] * (capProtrude * 0.55);
        s0x = first.x1 - tx[0] * capProtrude;
        s0y = first.y1 - ty[0] * capProtrude;
      }

      const rStartNose = emitRing(
        sMidX, sMidY, first.z1,
        nx[0], ny[0], tx[0], ty[0], -0.68,
        width, height, 0.68, 0.85, rgb, firstLIdx
      );
      emitEndCapFan(
        rStartNose,
        s0x, s0y, first.z1 - height * 0.5,
        -tx[0], -ty[0], rgb, firstLIdx, true
      );

      let prevRing = emitRing(
        sFullX, sFullY, first.z1,
        nx[0], ny[0], tx[0], ty[0], 0.0,
        width, height, 1.0, 1.0, rgb, firstLIdx
      );
      connectRings(rStartNose, prevRing);

      for (let i = 1; i < nSegs; i++) {
        const ptX = segs[i].x1;
        const ptY = segs[i].y1;
        const ptZ = segs[i].z1;
        const lIdx = segs[i]._layerIdx !== undefined ? segs[i]._layerIdx : defaultLayerIdx;
        const dot = tx[i - 1] * tx[i] + ty[i - 1] * ty[i];

        if (dot > 0.45) {
          let jnx = nx[i - 1] + nx[i];
          let jny = ny[i - 1] + ny[i];
          const jlen = Math.hypot(jnx, jny) || 1;
          jnx /= jlen; jny /= jlen;
          const miter = Math.min(1.35, 1.0 / Math.max(0.6, jnx * nx[i] + jny * ny[i]));

          const rIdx = emitRing(ptX, ptY, ptZ, jnx, jny, tx[i], ty[i], 0.0, width, height, miter, 1.0, rgb, lIdx);
          connectRings(prevRing, rIdx);
          prevRing = rIdx;

          if (ctx.curVertCount + NUM_RING_VERTS * 6 > ctx.maxVertsPerChunk && i < nSegs - 1) {
            ctx.flushChunk();
            prevRing = emitRing(ptX, ptY, ptZ, jnx, jny, tx[i], ty[i], 0.0, width, height, miter, 1.0, rgb, lIdx);
          }
        } else {
          let jnx = nx[i - 1] + nx[i];
          let jny = ny[i - 1] + ny[i];
          const jlen = Math.hypot(jnx, jny) || 1;
          jnx /= jlen; jny /= jlen;
          const miter = Math.min(1.42, 1.0 / Math.max(0.55, jnx * nx[i] + jny * ny[i]));

          const rIn = emitRing(ptX, ptY, ptZ, nx[i - 1], ny[i - 1], tx[i - 1], ty[i - 1], 0.0, width, height, 1.0, 1.0, rgb, lIdx);
          connectRings(prevRing, rIn);

          const rMid = emitRing(ptX, ptY, ptZ, jnx, jny, tx[i], ty[i], 0.0, width, height, miter * 0.96, 1.0, rgb, lIdx);
          connectRings(rIn, rMid);

          const rOut = emitRing(ptX, ptY, ptZ, nx[i], ny[i], tx[i], ty[i], 0.0, width, height, 1.0, 1.0, rgb, lIdx);
          connectRings(rMid, rOut);
          prevRing = rOut;

          if (ctx.curVertCount + NUM_RING_VERTS * 6 > ctx.maxVertsPerChunk && i < nSegs - 1) {
            ctx.flushChunk();
            prevRing = emitRing(ptX, ptY, ptZ, nx[i], ny[i], tx[i], ty[i], 0.0, width, height, 1.0, 1.0, rgb, lIdx);
          }
        }
      }

      const lastIdx = nSegs - 1;
      const lastLIdx = last._layerIdx !== undefined ? last._layerIdx : defaultLayerIdx;
      let eFullX, eFullY, eMidX, eMidY, e0x, e0y;
      if (isClosedLoop) {
        const endInset = Math.min(width * 0.22, segLen[lastIdx] * 0.36);
        eFullX = last.x2 - tx[lastIdx] * endInset;
        eFullY = last.y2 - ty[lastIdx] * endInset;
        eMidX = last.x2 - tx[lastIdx] * (endInset * 0.45);
        eMidY = last.y2 - tx[lastIdx] * (endInset * 0.45);
        e0x = last.x2 - tx[lastIdx] * (endInset * 0.08);
        e0y = last.y2 - tx[lastIdx] * (endInset * 0.08);
      } else {
        const endProtrude = Math.min(width * 0.36, Math.max(width * 0.18, segLen[lastIdx] * 0.35));
        eFullX = last.x2;
        eFullY = last.y2;
        eMidX = last.x2 + tx[lastIdx] * (endProtrude * 0.55);
        eMidY = last.y2 + ty[lastIdx] * (endProtrude * 0.55);
        e0x = last.x2 + tx[lastIdx] * endProtrude;
        e0y = last.y2 + ty[lastIdx] * endProtrude;
      }

      const rEndFull = emitRing(
        eFullX, eFullY, last.z2,
        nx[lastIdx], ny[lastIdx], tx[lastIdx], ty[lastIdx], 0.0,
        width, height, 1.0, 1.0, rgb, lastLIdx
      );
      connectRings(prevRing, rEndFull);

      const rEndNose = emitRing(
        eMidX, eMidY, last.z2,
        nx[lastIdx], ny[lastIdx], tx[lastIdx], ty[lastIdx], 0.68,
        width, height, 0.68, 0.85, rgb, lastLIdx
      );
      connectRings(rEndFull, rEndNose);

      emitEndCapFan(
        rEndNose,
        e0x, e0y, last.z2 - height * 0.5,
        tx[lastIdx], ty[lastIdx], rgb, lastLIdx, false
      );
    }

    return {
      emitChainTube,
      flush: () => ctx.flushChunk()
    };
  }

  function generateBeadMeshSingleChunk(moves, defaultLayerIdx) {
    if (!moves || moves.length === 0) return null;
    let chunk = null;
    const builder = createBeadMeshBuilder((verts, indices) => {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

      chunk = { vbo, ibo, indexCount: indices.length };
    }, 65000);

    let activeChain = null;
    for (let m = 0; m < moves.length; m++) {
      const mv = moves[m];
      if (!mv.extrude) continue;

      if (activeChain) {
        const prevMv = activeChain.segs[activeChain.segs.length - 1];
        const gap = Math.hypot(mv.x1 - prevMv.x2, mv.y1 - prevMv.y2, mv.z1 - prevMv.z2);
        if (mv.type === activeChain.type && gap < 0.25 && !mv.isSeamStart) {
          activeChain.segs.push(mv);
        } else {
          builder.emitChainTube(activeChain);
          activeChain = { type: mv.type, layerIdx: defaultLayerIdx, segs: [mv] };
        }
      } else {
        activeChain = { type: mv.type, layerIdx: defaultLayerIdx, segs: [mv] };
      }
    }
    if (activeChain) {
      builder.emitChainTube(activeChain);
      activeChain = null;
    }
    builder.flush();
    return chunk;
  }

  // =========================================================================
  // 5B. 3D NOZZLE MODEL & NOZZLE MOTION STATE
  // =========================================================================

  let nozzleBuffers = null;
  let nozzleGlowBuffers = null;
  let nozzleGuideRingBuffer = null;
  let builtNozzleDia = -1;

  function ensureNozzleBuffers(nozzleDia) {
    const dia = Math.max(2.0, Number(nozzleDia) || 5.0);
    if (nozzleBuffers && builtNozzleDia === dia) return;
    builtNozzleDia = dia;

    if (nozzleBuffers) {
      if (nozzleBuffers.vbo) gl.deleteBuffer(nozzleBuffers.vbo);
      if (nozzleBuffers.ibo) gl.deleteBuffer(nozzleBuffers.ibo);
    }
    if (nozzleGlowBuffers) {
      if (nozzleGlowBuffers.vbo) gl.deleteBuffer(nozzleGlowBuffers.vbo);
      if (nozzleGlowBuffers.ibo) gl.deleteBuffer(nozzleGlowBuffers.ibo);
    }
    if (nozzleGuideRingBuffer) {
      if (nozzleGuideRingBuffer.vbo) gl.deleteBuffer(nozzleGuideRingBuffer.vbo);
    }

    const segments = 24;
    const verts = [];
    const indices = [];

    const rTip = dia * 0.5;
    const rConeTop = Math.max(7.5, dia * 1.5);
    const rNut = rConeTop + 1.8;
    const rBarrel = rConeTop + 1.2;

    const zTip = 0.0;
    const zConeTop = 13.0;
    const zNutTop = 17.5;
    const zBarrelTop = 50.0;

    const coneSlopeH = zConeTop - zTip;
    const coneSlopeDr = rConeTop - rTip;
    const coneSlopeLen = Math.hypot(coneSlopeH, coneSlopeDr) || 1;
    const coneNormR = coneSlopeH / coneSlopeLen;
    const coneNormZ = -coneSlopeDr / coneSlopeLen;

    function pushVert(x, y, z, nx, ny, nz, r, g, b, profile) {
      const idx = verts.length / 11;
      verts.push(x, y, z, nx, ny, nz, r, g, b, -1.0, profile);
      return idx;
    }

    const brassColor = [0.86, 0.68, 0.22];
    const nutColor = [0.72, 0.55, 0.18];
    const barrelColor = [0.65, 0.67, 0.72];
    const topCapColor = [0.42, 0.44, 0.48];
    const innerOrificeColor = [0.08, 0.08, 0.10];

    // 1. Lower Conical Nozzle Tip
    const coneBottomRing = [];
    const coneTopRing = [];
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const nx = cos * coneNormR;
      const ny = sin * coneNormR;
      const nz = coneNormZ;

      coneBottomRing.push(pushVert(rTip * cos, rTip * sin, zTip, nx, ny, nz, brassColor[0], brassColor[1], brassColor[2], 5.0));
      coneTopRing.push(pushVert(rConeTop * cos, rConeTop * sin, zConeTop, nx, ny, nz, brassColor[0], brassColor[1], brassColor[2], 5.0));
    }
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(coneBottomRing[i], coneBottomRing[next], coneTopRing[next]);
      indices.push(coneBottomRing[i], coneTopRing[next], coneTopRing[i]);
    }

    // 2. Collar / Nut
    const nutBottomRing = [];
    const nutTopRing = [];
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      nutBottomRing.push(pushVert(rNut * cos, rNut * sin, zConeTop, cos, sin, 0.0, nutColor[0], nutColor[1], nutColor[2], 5.0));
      nutTopRing.push(pushVert(rNut * cos, rNut * sin, zNutTop, cos, sin, 0.0, nutColor[0], nutColor[1], nutColor[2], 5.0));
    }
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(nutBottomRing[i], nutBottomRing[next], nutTopRing[next]);
      indices.push(nutBottomRing[i], nutTopRing[next], nutTopRing[i]);
    }

    // 3. Extruder Cylinder Barrel
    const barrelBottomRing = [];
    const barrelTopRing = [];
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      barrelBottomRing.push(pushVert(rBarrel * cos, rBarrel * sin, zNutTop, cos, sin, 0.0, barrelColor[0], barrelColor[1], barrelColor[2], 5.0));
      barrelTopRing.push(pushVert(rBarrel * cos, rBarrel * sin, zBarrelTop, cos, sin, 0.0, barrelColor[0], barrelColor[1], barrelColor[2], 5.0));
    }
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(barrelBottomRing[i], barrelBottomRing[next], barrelTopRing[next]);
      indices.push(barrelBottomRing[i], barrelTopRing[next], barrelTopRing[i]);
    }

    // 4. Barrel Top Cap Flat Circle
    const centerTopIdx = pushVert(0, 0, zBarrelTop, 0, 0, 1.0, topCapColor[0], topCapColor[1], topCapColor[2], 5.0);
    const capRing = [];
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      capRing.push(pushVert(rBarrel * Math.cos(th), rBarrel * Math.sin(th), zBarrelTop, 0, 0, 1.0, topCapColor[0], topCapColor[1], topCapColor[2], 5.0));
    }
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(centerTopIdx, capRing[i], capRing[next]);
    }

    // 5. Orifice Tip Recess Opening
    const centerOrificeIdx = pushVert(0, 0, zTip, 0, 0, -1.0, innerOrificeColor[0], innerOrificeColor[1], innerOrificeColor[2], 5.0);
    const orificeRing = [];
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      orificeRing.push(pushVert(rTip * 0.72 * Math.cos(th), rTip * 0.72 * Math.sin(th), zTip, 0, 0, -1.0, innerOrificeColor[0], innerOrificeColor[1], innerOrificeColor[2], 5.0));
    }
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(centerOrificeIdx, orificeRing[next], orificeRing[i]);
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    nozzleBuffers = { vbo, ibo, indexCount: indices.length };

    // 6. Extrusion Glow Ring at Tip
    const glowVerts = [];
    const glowIndices = [];
    const rGlowOut = rTip * 1.15;
    const glowZ0 = -0.4;
    const glowZ1 = 0.4;

    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      glowVerts.push(
        rGlowOut * cos, rGlowOut * sin, glowZ0, cos, sin, 0.0, 1.0, 0.5, 0.1, -1.0, 9.0,
        rGlowOut * cos, rGlowOut * sin, glowZ1, cos, sin, 0.0, 1.0, 0.5, 0.1, -1.0, 9.0
      );
      const nextI = (i + 1) % segments;
      const base0 = i * 2;
      const baseNext = nextI * 2;
      glowIndices.push(base0, baseNext, baseNext + 1, base0, baseNext + 1, base0 + 1);
    }

    const gVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(glowVerts), gl.DYNAMIC_DRAW);

    const gIbo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(glowIndices), gl.STATIC_DRAW);

    nozzleGlowBuffers = { vbo: gVbo, ibo: gIbo, indexCount: glowIndices.length, verts: glowVerts };

    // 7. Guide Ring (circular line on active layer)
    const guideLines = [];
    const rGuide = dia * 0.55;
    for (let i = 0; i < 32; i++) {
      const th0 = (i / 32) * Math.PI * 2;
      const th1 = ((i + 1) / 32) * Math.PI * 2;
      guideLines.push(
        rGuide * Math.cos(th0), rGuide * Math.sin(th0), 0.0, 0.9, 0.9, 0.95, 0.65, -1.0,
        rGuide * Math.cos(th1), rGuide * Math.sin(th1), 0.0, 0.9, 0.9, 0.95, 0.65, -1.0
      );
    }
    const guideVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, guideVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(guideLines), gl.STATIC_DRAW);
    nozzleGuideRingBuffer = { vbo: guideVbo, count: guideLines.length / 8 };
  }

  function updateNozzleGlowColor(rgb) {
    if (!nozzleGlowBuffers || !nozzleGlowBuffers.verts) return;
    const v = nozzleGlowBuffers.verts;
    const vertCount = v.length / 11;
    for (let i = 0; i < vertCount; i++) {
      const base = i * 11;
      v[base + 6] = rgb[0];
      v[base + 7] = rgb[1];
      v[base + 8] = rgb[2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, nozzleGlowBuffers.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(v));
  }

  // Active Nozzle Simulation State
  let nozzlePlayback = {
    active: false,
    layerIdx: 0,
    moveIdx: 0,
    fraction: 1.0,
    nozzleX: 150,
    nozzleY: 150,
    nozzleZ: 2.5,
    isExtruding: true,
    moveType: 'outer_wall',
    speed: 25
  };

  let partialBeadChunk = null;
  let partialLineBuffer = null;
  let upcomingLineBuffer = null;

  function updatePartialLayerBuffers() {
    if (!currentSlice || !currentSlice.layers) return;
    const lIdx = Math.max(0, Math.min(currentSlice.layers.length - 1, nozzlePlayback.layerIdx));
    const layer = currentSlice.layers[lIdx];
    if (!layer || !layer.moves || layer.moves.length === 0) return;

    const totalMoves = layer.moves.length;
    const mIdx = Math.max(0, Math.min(totalMoves - 1, nozzlePlayback.moveIdx));
    const frac = Math.max(0, Math.min(1.0, nozzlePlayback.fraction));

    const curMv = layer.moves[mIdx];
    nozzlePlayback.nozzleX = curMv.x1 + (curMv.x2 - curMv.x1) * frac;
    nozzlePlayback.nozzleY = curMv.y1 + (curMv.y2 - curMv.y1) * frac;
    nozzlePlayback.nozzleZ = curMv.z1 + (curMv.z2 - curMv.z1) * frac;
    nozzlePlayback.isExtruding = Boolean(curMv.extrude);
    nozzlePlayback.moveType = curMv.type;
    nozzlePlayback.speed = curMv.speed || 25;

    if (nozzlePlayback.isExtruding) {
      const rgb = getMoveColorRGB(curMv, currentSlice);
      updateNozzleGlowColor(rgb);
    }

    if (mIdx === totalMoves - 1 && frac >= 0.999) {
      if (partialBeadChunk) {
        if (partialBeadChunk.vbo) gl.deleteBuffer(partialBeadChunk.vbo);
        if (partialBeadChunk.ibo) gl.deleteBuffer(partialBeadChunk.ibo);
        partialBeadChunk = null;
      }
      if (partialLineBuffer && partialLineBuffer.vbo) {
        gl.deleteBuffer(partialLineBuffer.vbo);
        partialLineBuffer = null;
      }
      if (upcomingLineBuffer && upcomingLineBuffer.vbo) {
        gl.deleteBuffer(upcomingLineBuffer.vbo);
        upcomingLineBuffer = null;
      }
      return;
    }

    const partialMoves = [];
    const partialLines = [];
    for (let i = 0; i <= mIdx; i++) {
      const mv = layer.moves[i];
      let endX = mv.x2, endY = mv.y2, endZ = mv.z2;
      if (i === mIdx) {
        endX = nozzlePlayback.nozzleX;
        endY = nozzlePlayback.nozzleY;
        endZ = nozzlePlayback.nozzleZ;
      }
      const mvCopy = Object.assign({}, mv, {
        x2: endX,
        y2: endY,
        z2: endZ,
        _layerIdx: lIdx
      });

      if (mv.extrude) {
        const segDist = Math.hypot(endX - mv.x1, endY - mv.y1, endZ - mv.z1);
        if (segDist > 1e-4) {
          partialMoves.push(mvCopy);
          const col = getMoveColorRGB(mv, currentSlice);
          partialLines.push(
            mv.x1, mv.y1, mv.z1, col[0], col[1], col[2], 0.95, lIdx,
            endX, endY, endZ, col[0], col[1], col[2], 0.95, lIdx
          );
        }
      }
    }

    if (partialBeadChunk) {
      if (partialBeadChunk.vbo) gl.deleteBuffer(partialBeadChunk.vbo);
      if (partialBeadChunk.ibo) gl.deleteBuffer(partialBeadChunk.ibo);
      partialBeadChunk = null;
    }
    if (partialMoves.length > 0) {
      partialBeadChunk = generateBeadMeshSingleChunk(partialMoves, lIdx);
    }

    if (partialLineBuffer && partialLineBuffer.vbo) gl.deleteBuffer(partialLineBuffer.vbo);
    partialLineBuffer = null;
    if (partialLines.length > 0) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(partialLines), gl.DYNAMIC_DRAW);
      partialLineBuffer = { vbo, count: partialLines.length / 8 };
    }

    const upcomingLines = [];
    if (frac < 0.999 && curMv.extrude) {
      upcomingLines.push(
        nozzlePlayback.nozzleX, nozzlePlayback.nozzleY, nozzlePlayback.nozzleZ, 0.50, 0.52, 0.58, 0.28, lIdx,
        curMv.x2, curMv.y2, curMv.z2, 0.50, 0.52, 0.58, 0.28, lIdx
      );
    }
    for (let i = mIdx + 1; i < totalMoves; i++) {
      const mv = layer.moves[i];
      if (mv.extrude) {
        upcomingLines.push(
          mv.x1, mv.y1, mv.z1, 0.50, 0.52, 0.58, 0.28, lIdx,
          mv.x2, mv.y2, mv.z2, 0.50, 0.52, 0.58, 0.28, lIdx
        );
      }
    }

    if (upcomingLineBuffer && upcomingLineBuffer.vbo) gl.deleteBuffer(upcomingLineBuffer.vbo);
    upcomingLineBuffer = null;
    if (upcomingLines.length > 0) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(upcomingLines), gl.DYNAMIC_DRAW);
      upcomingLineBuffer = { vbo, count: upcomingLines.length / 8 };
    }
  }

  function ensureSliceBuffers() {
    if (!sliceBuffersDirty) return;
    sliceBuffersDirty = false;

    for (const chunk of sliceBeadChunks) {
      if (chunk.vbo) gl.deleteBuffer(chunk.vbo);
      if (chunk.ibo) gl.deleteBuffer(chunk.ibo);
    }
    sliceBeadChunks = [];
    if (sliceLineBuffer && sliceLineBuffer.vbo) gl.deleteBuffer(sliceLineBuffer.vbo);
    if (sliceTravelBuffer && sliceTravelBuffer.vbo) gl.deleteBuffer(sliceTravelBuffer.vbo);
    if (sliceSeamPointBuffer && sliceSeamPointBuffer.vbo) gl.deleteBuffer(sliceSeamPointBuffer.vbo);
    sliceLineBuffer = null;
    sliceTravelBuffer = null;
    sliceSeamPointBuffer = null;

    if (!currentSlice || !currentSlice.layers) return;

    const builder = createBeadMeshBuilder((verts, indices) => {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

      sliceBeadChunks.push({
        vbo,
        ibo,
        indexCount: indices.length
      });
    }, 58000);

    const centerLines = [];
    const travelLines = [];
    const seamPoints = [];
    let activeChain = null;

    for (let lIdx = 0; lIdx < currentSlice.layers.length; lIdx++) {
      const layer = currentSlice.layers[lIdx];

      for (let m = 0; m < layer.moves.length; m++) {
        const mv = layer.moves[m];
        mv._layerIdx = lIdx;

        if (!mv.extrude) {
          if (activeChain) {
            builder.emitChainTube(activeChain);
            activeChain = null;
          }
          const tCol = FEATURE_COLORS.travel;
          travelLines.push(
            mv.x1, mv.y1, mv.z1, tCol[0], tCol[1], tCol[2], 0.85, lIdx,
            mv.x2, mv.y2, mv.z2, tCol[0], tCol[1], tCol[2], 0.85, lIdx
          );
          continue;
        }

        const segDist = Math.hypot(mv.x2 - mv.x1, mv.y2 - mv.y1, mv.z2 - mv.z1);
        if (segDist < 1e-4) continue;

        const cCol = getMoveColorRGB(mv, currentSlice);
        centerLines.push(
          mv.x1, mv.y1, mv.z1, cCol[0], cCol[1], cCol[2], 0.95, lIdx,
          mv.x2, mv.y2, mv.z2, cCol[0], cCol[1], cCol[2], 0.95, lIdx
        );

        if (mv.isSeamStart) {
          seamPoints.push(mv.x1, mv.y1, mv.z1, 0.92, 0.92, 0.96, 1.0, lIdx);
        }

        if (activeChain) {
          const prevMv = activeChain.segs[activeChain.segs.length - 1];
          const gap = Math.hypot(mv.x1 - prevMv.x2, mv.y1 - prevMv.y2, mv.z1 - prevMv.z2);
          const sameLayerOrSpiral = (prevMv._layerIdx === lIdx) || (mv.type === 'spiral_wall' && prevMv.type === 'spiral_wall');
          if (mv.type === activeChain.type && sameLayerOrSpiral && gap < 0.25 && !mv.isSeamStart) {
            activeChain.segs.push(mv);
          } else {
            builder.emitChainTube(activeChain);
            activeChain = { type: mv.type, layerIdx: lIdx, segs: [mv] };
          }
        } else {
          activeChain = { type: mv.type, layerIdx: lIdx, segs: [mv] };
        }
      }

      if (activeChain && activeChain.type !== 'spiral_wall') {
        builder.emitChainTube(activeChain);
        activeChain = null;
      }
    }

    if (activeChain) {
      builder.emitChainTube(activeChain);
      activeChain = null;
    }

    builder.flush();

    if (centerLines.length > 0) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(centerLines), gl.STATIC_DRAW);
      sliceLineBuffer = { vbo, count: centerLines.length / 8 };
    }

    if (travelLines.length > 0) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(travelLines), gl.STATIC_DRAW);
      sliceTravelBuffer = { vbo, count: travelLines.length / 8 };
    }

    if (seamPoints.length > 0) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(seamPoints), gl.STATIC_DRAW);
      sliceSeamPointBuffer = { vbo, count: seamPoints.length / 8 };
    }
  }

  // =========================================================================
  // 6. MAIN RENDER FRAME (WEBGL + 2D HUD)
  // =========================================================================

  function drawSolidBuffer(vbo, vertexCount, basis, minLayer, maxLayer, alpha) {
    gl.useProgram(solidProgram.prog);
    gl.uniformMatrix4fv(solidProgram.uniforms.uViewProj, false, basis.viewProj);
    gl.uniform3f(solidProgram.uniforms.uModelOffset, 0.0, 0.0, 0.0);
    gl.uniform3f(solidProgram.uniforms.uCameraPos, basis.camX, basis.camY, basis.camZ);
    gl.uniform3f(solidProgram.uniforms.uCameraRight, basis.rx, basis.ry, basis.rz);
    gl.uniform3f(solidProgram.uniforms.uCameraUp, basis.ux, basis.uy, basis.uz);
    gl.uniform1f(solidProgram.uniforms.uMinLayer, minLayer);
    gl.uniform1f(solidProgram.uniforms.uMaxLayer, maxLayer);
    gl.uniform1f(solidProgram.uniforms.uAlpha, alpha);

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = 11 * 4;
    gl.enableVertexAttribArray(solidProgram.attribs.aPosition);
    gl.vertexAttribPointer(solidProgram.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(solidProgram.attribs.aNormal);
    gl.vertexAttribPointer(solidProgram.attribs.aNormal, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(solidProgram.attribs.aColor);
    gl.vertexAttribPointer(solidProgram.attribs.aColor, 3, gl.FLOAT, false, stride, 6 * 4);
    gl.enableVertexAttribArray(solidProgram.attribs.aLayerAndProfile);
    gl.vertexAttribPointer(solidProgram.attribs.aLayerAndProfile, 2, gl.FLOAT, false, stride, 9 * 4);

    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  function drawIndexedBeadChunks(basis, minLayer, maxLayer, alpha) {
    if (sliceBeadChunks.length === 0) return;

    gl.useProgram(solidProgram.prog);
    gl.uniformMatrix4fv(solidProgram.uniforms.uViewProj, false, basis.viewProj);
    gl.uniform3f(solidProgram.uniforms.uModelOffset, 0.0, 0.0, 0.0);
    gl.uniform3f(solidProgram.uniforms.uCameraPos, basis.camX, basis.camY, basis.camZ);
    gl.uniform3f(solidProgram.uniforms.uCameraRight, basis.rx, basis.ry, basis.rz);
    gl.uniform3f(solidProgram.uniforms.uCameraUp, basis.ux, basis.uy, basis.uz);
    gl.uniform1f(solidProgram.uniforms.uMinLayer, minLayer);
    gl.uniform1f(solidProgram.uniforms.uMaxLayer, maxLayer);
    gl.uniform1f(solidProgram.uniforms.uAlpha, alpha);

    const stride = 11 * 4;
    gl.enableVertexAttribArray(solidProgram.attribs.aPosition);
    gl.enableVertexAttribArray(solidProgram.attribs.aNormal);
    gl.enableVertexAttribArray(solidProgram.attribs.aColor);
    gl.enableVertexAttribArray(solidProgram.attribs.aLayerAndProfile);

    for (let i = 0; i < sliceBeadChunks.length; i++) {
      const chunk = sliceBeadChunks[i];
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.vbo);
      gl.vertexAttribPointer(solidProgram.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(solidProgram.attribs.aNormal, 3, gl.FLOAT, false, stride, 3 * 4);
      gl.vertexAttribPointer(solidProgram.attribs.aColor, 3, gl.FLOAT, false, stride, 6 * 4);
      gl.vertexAttribPointer(solidProgram.attribs.aLayerAndProfile, 2, gl.FLOAT, false, stride, 9 * 4);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunk.ibo);
      gl.drawElements(gl.TRIANGLES, chunk.indexCount, gl.UNSIGNED_SHORT, 0);
    }
  }

  function drawSingleIndexedBeadChunk(chunk, basis, alpha) {
    if (!chunk || !chunk.vbo || !chunk.ibo || chunk.indexCount === 0) return;

    gl.useProgram(solidProgram.prog);
    gl.uniformMatrix4fv(solidProgram.uniforms.uViewProj, false, basis.viewProj);
    gl.uniform3f(solidProgram.uniforms.uModelOffset, 0.0, 0.0, 0.0);
    gl.uniform3f(solidProgram.uniforms.uCameraPos, basis.camX, basis.camY, basis.camZ);
    gl.uniform3f(solidProgram.uniforms.uCameraRight, basis.rx, basis.ry, basis.rz);
    gl.uniform3f(solidProgram.uniforms.uCameraUp, basis.ux, basis.uy, basis.uz);
    gl.uniform1f(solidProgram.uniforms.uMinLayer, -999.0);
    gl.uniform1f(solidProgram.uniforms.uMaxLayer, 999999.0);
    gl.uniform1f(solidProgram.uniforms.uAlpha, alpha);

    const stride = 11 * 4;
    gl.enableVertexAttribArray(solidProgram.attribs.aPosition);
    gl.enableVertexAttribArray(solidProgram.attribs.aNormal);
    gl.enableVertexAttribArray(solidProgram.attribs.aColor);
    gl.enableVertexAttribArray(solidProgram.attribs.aLayerAndProfile);

    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.vbo);
    gl.vertexAttribPointer(solidProgram.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(solidProgram.attribs.aNormal, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.vertexAttribPointer(solidProgram.attribs.aColor, 3, gl.FLOAT, false, stride, 6 * 4);
    gl.vertexAttribPointer(solidProgram.attribs.aLayerAndProfile, 2, gl.FLOAT, false, stride, 9 * 4);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunk.ibo);
    gl.drawElements(gl.TRIANGLES, chunk.indexCount, gl.UNSIGNED_SHORT, 0);
  }

  function drawNozzleModel(basis) {
    if (!nozzleBuffers) ensureNozzleBuffers(builtNozzleDia > 0 ? builtNozzleDia : 5.0);
    if (!nozzleBuffers) return;

    const nx = nozzlePlayback.nozzleX;
    const ny = nozzlePlayback.nozzleY;
    const nz = nozzlePlayback.nozzleZ;

    // 1. Draw 3D Nozzle Body (Brass Cone + Collar + Auger Barrel)
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.useProgram(solidProgram.prog);
    gl.uniformMatrix4fv(solidProgram.uniforms.uViewProj, false, basis.viewProj);
    gl.uniform3f(solidProgram.uniforms.uModelOffset, nx, ny, nz);
    gl.uniform3f(solidProgram.uniforms.uCameraPos, basis.camX, basis.camY, basis.camZ);
    gl.uniform3f(solidProgram.uniforms.uCameraRight, basis.rx, basis.ry, basis.rz);
    gl.uniform3f(solidProgram.uniforms.uCameraUp, basis.ux, basis.uy, basis.uz);
    gl.uniform1f(solidProgram.uniforms.uMinLayer, -999.0);
    gl.uniform1f(solidProgram.uniforms.uMaxLayer, 999999.0);
    gl.uniform1f(solidProgram.uniforms.uAlpha, 1.0);

    const stride = 11 * 4;
    gl.enableVertexAttribArray(solidProgram.attribs.aPosition);
    gl.enableVertexAttribArray(solidProgram.attribs.aNormal);
    gl.enableVertexAttribArray(solidProgram.attribs.aColor);
    gl.enableVertexAttribArray(solidProgram.attribs.aLayerAndProfile);

    gl.bindBuffer(gl.ARRAY_BUFFER, nozzleBuffers.vbo);
    gl.vertexAttribPointer(solidProgram.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(solidProgram.attribs.aNormal, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.vertexAttribPointer(solidProgram.attribs.aColor, 3, gl.FLOAT, false, stride, 6 * 4);
    gl.vertexAttribPointer(solidProgram.attribs.aLayerAndProfile, 2, gl.FLOAT, false, stride, 9 * 4);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, nozzleBuffers.ibo);
    gl.drawElements(gl.TRIANGLES, nozzleBuffers.indexCount, gl.UNSIGNED_SHORT, 0);

    // 2. Draw Extrusion Glow Ring if extruding
    if (nozzlePlayback.isExtruding && nozzleGlowBuffers) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, nozzleGlowBuffers.vbo);
      gl.vertexAttribPointer(solidProgram.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(solidProgram.attribs.aNormal, 3, gl.FLOAT, false, stride, 3 * 4);
      gl.vertexAttribPointer(solidProgram.attribs.aColor, 3, gl.FLOAT, false, stride, 6 * 4);
      gl.vertexAttribPointer(solidProgram.attribs.aLayerAndProfile, 2, gl.FLOAT, false, stride, 9 * 4);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, nozzleGlowBuffers.ibo);
      gl.drawElements(gl.TRIANGLES, nozzleGlowBuffers.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
    }

    // Reset uModelOffset to zero
    gl.uniform3f(solidProgram.uniforms.uModelOffset, 0.0, 0.0, 0.0);

    // 3. Draw Guide Ring on Bed / Layer
    if (nozzleGuideRingBuffer) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(lineProgram.prog);
      gl.uniformMatrix4fv(lineProgram.uniforms.uViewProj, false, basis.viewProj);
      gl.uniform3f(lineProgram.uniforms.uModelOffset, nx, ny, nz);
      gl.uniform1f(lineProgram.uniforms.uMinLayer, -999.0);
      gl.uniform1f(lineProgram.uniforms.uMaxLayer, 999999.0);

      gl.bindBuffer(gl.ARRAY_BUFFER, nozzleGuideRingBuffer.vbo);
      const lStride = 8 * 4;
      gl.enableVertexAttribArray(lineProgram.attribs.aPosition);
      gl.vertexAttribPointer(lineProgram.attribs.aPosition, 3, gl.FLOAT, false, lStride, 0);
      gl.enableVertexAttribArray(lineProgram.attribs.aColor);
      gl.vertexAttribPointer(lineProgram.attribs.aColor, 4, gl.FLOAT, false, lStride, 3 * 4);
      gl.enableVertexAttribArray(lineProgram.attribs.aLayerIndex);
      gl.vertexAttribPointer(lineProgram.attribs.aLayerIndex, 1, gl.FLOAT, false, lStride, 7 * 4);

      gl.drawArrays(gl.LINES, 0, nozzleGuideRingBuffer.count);
      gl.uniform3f(lineProgram.uniforms.uModelOffset, 0.0, 0.0, 0.0);
      gl.disable(gl.BLEND);
    }
  }

  function drawLineBuffer(buf, mode, basis, minLayer, maxLayer, pointSize) {
    if (!buf || !buf.count) return;
    gl.useProgram(lineProgram.prog);
    gl.uniformMatrix4fv(lineProgram.uniforms.uViewProj, false, basis.viewProj);
    gl.uniform3f(lineProgram.uniforms.uModelOffset, 0.0, 0.0, 0.0);
    gl.uniform1f(lineProgram.uniforms.uMinLayer, minLayer);
    gl.uniform1f(lineProgram.uniforms.uMaxLayer, maxLayer);
    gl.uniform1f(lineProgram.uniforms.uPointSize, pointSize || 5.0);

    gl.bindBuffer(gl.ARRAY_BUFFER, buf.vbo);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(lineProgram.attribs.aPosition);
    gl.vertexAttribPointer(lineProgram.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(lineProgram.attribs.aColor);
    gl.vertexAttribPointer(lineProgram.attribs.aColor, 4, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(lineProgram.attribs.aLayerIndex);
    gl.vertexAttribPointer(lineProgram.attribs.aLayerIndex, 1, gl.FLOAT, false, stride, 7 * 4);

    gl.drawArrays(mode, 0, buf.count);
  }

  function renderHudOverlay(width, height, basis) {
    if (!hudCtx) return;
    hudCtx.clearRect(0, 0, width, height);

    const px = projectPoint2D(52, 0, 0, basis);
    const py = projectPoint2D(0, 52, 0, basis);
    const pz = projectPoint2D(0, 0, 52, basis);
    hudCtx.font = '700 11px Inter, sans-serif';
    if (px) { hudCtx.fillStyle = '#ffffff'; hudCtx.fillText('X', px.x - 4, px.y + 4); }
    if (py) { hudCtx.fillStyle = '#c4c4ce'; hudCtx.fillText('Y', py.x - 4, py.y + 4); }
    if (pz) { hudCtx.fillStyle = '#9e9ea8'; hudCtx.fillText('Z', pz.x - 4, pz.y + 4); }

    if (viewMode === 'prepare' && placeOnFaceActive) {
      hudCtx.save();
      hudCtx.font = '700 12px Inter, sans-serif';
      const msg = hoveredNormal
        ? 'CLICK HIGHLIGHTED FACE TO LAY FLAT ON BED (ESC TO CANCEL)'
        : 'HOVER OVER ANY MODEL FACE & CLICK TO ALIGN WITH BED';
      const tw = hudCtx.measureText(msg).width + 28;
      const bx = (width - tw) * 0.5;
      hudCtx.fillStyle = 'rgba(242, 242, 244, 0.95)';
      hudCtx.fillRect(bx, 14, tw, 30);
      hudCtx.fillStyle = '#111113';
      hudCtx.textAlign = 'center';
      hudCtx.fillText(msg, width * 0.5, 33);
      hudCtx.restore();
    }
  }

  function renderFrame() {
    needsRender = false;
    if (!canvas.parentElement || !gl) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const width = Math.max(300, rect.width);
    const height = Math.max(200, rect.height);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.086, 0.086, 0.098, 1.0); // #161619 dark studio background
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const basis = getCameraBasis(width, height);
    ensureBedBuffers();

    // 1. Draw Transparent Build Plate Grid & Height Cage (depthMask=false so bottom of print is 100% visible)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    drawLineBuffer(
      { vbo: bedBuffers.lineVbo, count: bedBuffers.lineCount },
      gl.LINES,
      basis,
      -10,
      100000,
      1.0
    );
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    if (viewMode === 'prepare') {
      ensureMeshBuffer();
      // 1. Soft ambient contact shadow on build plate beneath model
      if (meshShadowBuffer) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        drawSolidBuffer(meshShadowBuffer.vbo, meshShadowBuffer.vertexCount, basis, -10, 100000, 1.0);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
      // 2. High-precision 3D model with crease-preserving smooth normals
      if (meshBuffer) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        drawSolidBuffer(meshBuffer.vbo, meshBuffer.vertexCount, basis, -10, 100000, 1.0);
      }
      // 3. Crisp mechanical feature edge lines (like OrcaSlicer / Fusion 360)
      if (meshFeatureLineBuffer && meshFeatureLineBuffer.count > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthFunc(gl.LEQUAL);
        drawLineBuffer(meshFeatureLineBuffer, gl.LINES, basis, -10, 100000, 1.0);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
      }
      // 4. Adaptive 3D Overhang Support Mesh (when generated & visible)
      if (showSupportMesh && currentSupportMesh) {
        ensureSupportBuffer();
        if (supportBuffer) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(true);
          drawSolidBuffer(supportBuffer.vbo, supportBuffer.vertexCount, basis, -10, 100000, 0.78);
          if (supportFeatureLineBuffer && supportFeatureLineBuffer.count > 0) {
            gl.depthFunc(gl.LEQUAL);
            drawLineBuffer(supportFeatureLineBuffer, gl.LINES, basis, -10, 100000, 1.0);
            gl.depthFunc(gl.LESS);
          }
          gl.disable(gl.BLEND);
        }
      }
    } else {
      ensureSliceBuffers();
      const totalLayers = currentSlice && currentSlice.layers ? currentSlice.layers.length : 0;
      const maxL = Math.min(totalLayers - 1, maxVisibleLayer);
      const minL = singleLayerOnly ? maxL : 0;

      const layerMoves = (currentSlice && currentSlice.layers && currentSlice.layers[maxL])
        ? currentSlice.layers[maxL].moves
        : [];
      const totalMovesInMaxL = layerMoves.length;
      const isPartialActive = nozzlePlayback.active && totalMovesInMaxL > 0 &&
        (nozzlePlayback.moveIdx < totalMovesInMaxL - 1 || nozzlePlayback.fraction < 0.999);
      const staticMaxL = isPartialActive ? (maxL - 1) : maxL;

      if (staticMaxL >= minL) {
        if (previewRenderStyle === 'extruded_form') {
          // Opaque 3D hardware-depth-tested capsule beads (matches Screenshot 2!)
          gl.disable(gl.BLEND);
          gl.depthMask(true);
          drawIndexedBeadChunks(basis, minL, staticMaxL, 1.0);
        } else if (previewRenderStyle === 'toolpath_lines') {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          drawLineBuffer(sliceLineBuffer, gl.LINES, basis, minL, staticMaxL, 1.0);
          if (showZSeams && sliceSeamPointBuffer) {
            drawLineBuffer(sliceSeamPointBuffer, gl.POINTS, basis, minL, staticMaxL, 5.5);
          }
          gl.disable(gl.BLEND);
        } else if (previewRenderStyle === 'hybrid_xray') {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          drawIndexedBeadChunks(basis, minL, staticMaxL, 0.34);
          gl.depthMask(true);
          drawLineBuffer(sliceLineBuffer, gl.LINES, basis, minL, staticMaxL, 1.0);
          gl.disable(gl.BLEND);
        }
      }

      // Draw partial active layer beads/lines up to current nozzle position
      if (isPartialActive) {
        if (previewRenderStyle === 'extruded_form') {
          if (partialBeadChunk) {
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            drawSingleIndexedBeadChunk(partialBeadChunk, basis, 1.0);
          }
        } else if (previewRenderStyle === 'toolpath_lines') {
          if (partialLineBuffer) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            drawLineBuffer(partialLineBuffer, gl.LINES, basis, -10, 100000, 1.0);
            gl.disable(gl.BLEND);
          }
        } else if (previewRenderStyle === 'hybrid_xray') {
          if (partialBeadChunk) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            drawSingleIndexedBeadChunk(partialBeadChunk, basis, 0.34);
            gl.depthMask(true);
          }
          if (partialLineBuffer) {
            drawLineBuffer(partialLineBuffer, gl.LINES, basis, -10, 100000, 1.0);
          }
        }

        // Draw upcoming moves of current layer in faint translucent lines
        if (upcomingLineBuffer) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          drawLineBuffer(upcomingLineBuffer, gl.LINES, basis, -10, 100000, 1.0);
          gl.depthMask(true);
          gl.disable(gl.BLEND);
        }
      }

      if (showTravelMoves && sliceTravelBuffer) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        drawLineBuffer(sliceTravelBuffer, gl.LINES, basis, minL, maxL, 1.0);
        gl.disable(gl.BLEND);
      }

      if (showGhostMeshInPreview && currentMesh) {
        ensureMeshBuffer();
        if (meshBuffer) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          drawSolidBuffer(meshBuffer.vbo, meshBuffer.vertexCount, basis, -10, 100000, 0.14);
          gl.depthMask(true);
          gl.disable(gl.BLEND);
        }
      }

      if (showSupportMesh && currentSupportMesh) {
        ensureSupportBuffer();
        if (supportBuffer) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          drawSolidBuffer(supportBuffer.vbo, supportBuffer.vertexCount, basis, -10, 100000, 0.56);
          if (supportFeatureLineBuffer && supportFeatureLineBuffer.count > 0) {
            gl.depthFunc(gl.LEQUAL);
            drawLineBuffer(supportFeatureLineBuffer, gl.LINES, basis, -10, 100000, 1.0);
            gl.depthFunc(gl.LESS);
          }
          gl.depthMask(true);
          gl.disable(gl.BLEND);
        }
      }

      // Draw 3D Nozzle model at current nozzle position
      if (nozzlePlayback.active) {
        drawNozzleModel(basis);
      }
    }

    renderHudOverlay(width, height, basis);
  }

  function resize() {
    if (!canvas.parentElement) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(300, rect.width);
    const h = Math.max(200, rect.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    if (hudCanvas && hudCtx) {
      hudCanvas.width = Math.floor(w * dpr);
      hudCanvas.height = Math.floor(h * dpr);
      hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    renderFrame();
  }

  function requestRender() {
    if (!needsRender) {
      needsRender = true;
      requestAnimationFrame(renderFrame);
    }
  }

  // =========================================================================
  // 7. MOUSE, WHEEL & KEYBOARD INTERACTION
  // =========================================================================

  canvas.addEventListener('mousedown', e => {
    isDragging = true;
    dragMovedDistance = 0;
    dragButton = e.button;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  window.addEventListener('mousemove', e => {
    if (!isDragging) {
      if (placeOnFaceActive && viewMode === 'prepare') {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = raycastMesh(mx, my, rect.width, rect.height);
        const prevTri = hoveredTriIndex;
        if (hit) {
          hoveredTriIndex = hit.triIndex;
          hoveredNormal = { x: hit.nx, y: hit.ny, z: hit.nz };
          canvas.style.cursor = 'pointer';
        } else {
          hoveredTriIndex = -1;
          hoveredNormal = null;
          canvas.style.cursor = 'crosshair';
        }
        if (hoveredTriIndex !== prevTri) {
          meshDirty = true;
          requestRender();
        }
      }
      return;
    }

    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    dragMovedDistance += Math.hypot(dx, dy);
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    if (dragButton === 0 && !e.shiftKey) {
      camera.yaw -= dx * 0.0075;
      camera.pitch = Math.max(-1.45, Math.min(1.52, camera.pitch + dy * 0.0075));
    } else {
      const rect = canvas.parentElement.getBoundingClientRect();
      const basis = getCameraBasis(rect.width, rect.height);
      const panFactor = camera.distance * 0.0014;
      camera.targetX -= (basis.rx * dx - basis.ux * dy) * panFactor;
      camera.targetY -= (basis.ry * dx - basis.uy * dy) * panFactor;
      camera.targetZ -= (basis.rz * dx - basis.uz * dy) * panFactor;
    }
    requestRender();
  });

  window.addEventListener('mouseup', e => {
    if (isDragging) {
      const wasClick = dragMovedDistance < 5 && e.button === 0;
      isDragging = false;

      if (wasClick && placeOnFaceActive && viewMode === 'prepare' && hoveredTriIndex !== -1) {
        const pickedIdx = hoveredTriIndex;
        if (typeof onFaceSelectedCallback === 'function') {
          onFaceSelectedCallback(pickedIdx);
        }
      }
      requestRender();
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && placeOnFaceActive) {
      placeOnFaceActive = false;
      hoveredTriIndex = -1;
      hoveredNormal = null;
      meshDirty = true;
      canvas.style.cursor = 'grab';
      if (typeof onFaceSelectedCallback === 'function') {
        onFaceSelectedCallback(-1);
      }
      requestRender();
    }
  });

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 1.09 : 0.91;
    camera.distance = Math.max(50, Math.min(1800, camera.distance * zoomFactor));
    requestRender();
  }, { passive: false });

  window.addEventListener('resize', resize);
  resize();

  return {
    setBedSize(x, y, z) {
      bedSize = { x: Number(x) || 300, y: Number(y) || 300, z: Number(z) || 380 };
      camera.targetX = bedSize.x * 0.5;
      camera.targetY = bedSize.y * 0.5;
      requestRender();
    },
    setMesh(mesh) {
      currentMesh = mesh;
      meshDirty = true;
      requestRender();
    },
    setSupportMesh(mesh) {
      currentSupportMesh = mesh || null;
      supportDirty = true;
      requestRender();
    },
    setShowSupportMesh(visible) {
      showSupportMesh = Boolean(visible);
      requestRender();
    },
    setSliceResult(slice) {
      currentSlice = slice;
      sliceBuffersDirty = true;
      if (slice && slice.layers) {
        maxVisibleLayer = slice.layers.length - 1;
      }
      requestRender();
    },
    setViewMode(mode) {
      viewMode = mode;
      if (mode !== 'prepare') {
        placeOnFaceActive = false;
        hoveredTriIndex = -1;
        hoveredNormal = null;
        meshDirty = true;
        canvas.style.cursor = 'grab';
      }
      requestRender();
    },
    setPlaceOnFaceMode(active, callback) {
      placeOnFaceActive = Boolean(active);
      onFaceSelectedCallback = callback || null;
      hoveredTriIndex = -1;
      hoveredNormal = null;
      meshDirty = true;
      canvas.style.cursor = placeOnFaceActive ? 'crosshair' : 'grab';
      requestRender();
    },
    isPlaceOnFaceActive() {
      return placeOnFaceActive;
    },
    setLayerFilter(maxLayer, singleOnly) {
      maxVisibleLayer = maxLayer;
      singleLayerOnly = Boolean(singleOnly);
      requestRender();
    },
    setPreviewOptions(opts) {
      if (opts.showTravel !== undefined) showTravelMoves = Boolean(opts.showTravel);
      if (opts.showSeams !== undefined && Boolean(opts.showSeams) !== showZSeams) {
        showZSeams = Boolean(opts.showSeams);
        sliceBuffersDirty = true;
      }
      if (opts.showGhost !== undefined) showGhostMeshInPreview = Boolean(opts.showGhost);
      if (opts.renderStyle !== undefined) previewRenderStyle = opts.renderStyle;
      if (opts.colorScheme !== undefined && opts.colorScheme !== previewColorScheme) {
        previewColorScheme = opts.colorScheme;
        sliceBuffersDirty = true;
      }
      requestRender();
    },
    setNozzlePlayback(opts) {
      if (!opts) return;
      if (opts.active !== undefined) nozzlePlayback.active = Boolean(opts.active);
      if (opts.layerIdx !== undefined) nozzlePlayback.layerIdx = parseInt(opts.layerIdx, 10) || 0;
      if (opts.moveIdx !== undefined) nozzlePlayback.moveIdx = parseInt(opts.moveIdx, 10) || 0;
      if (opts.fraction !== undefined) nozzlePlayback.fraction = Math.max(0, Math.min(1.0, Number(opts.fraction) || 0));
      if (opts.nozzleDiameter !== undefined) {
        ensureNozzleBuffers(opts.nozzleDiameter);
      }
      updatePartialLayerBuffers();
      requestRender();
    },
    getNozzlePlayback() {
      return Object.assign({}, nozzlePlayback);
    },
    resetCamera(preset) {
      camera.targetX = bedSize.x * 0.5;
      camera.targetY = bedSize.y * 0.5;
      camera.targetZ = currentMesh && currentMesh.bounds ? currentMesh.bounds.maxZ * 0.45 : 65;
      if (preset === 'top') {
        camera.yaw = 0;
        camera.pitch = 1.53;
        camera.distance = 450;
      } else if (preset === 'front') {
        camera.yaw = 0;
        camera.pitch = 0.08;
        camera.distance = 450;
      } else {
        camera.yaw = -0.68;
        camera.pitch = 0.56;
        camera.distance = 460;
      }
      requestRender();
    },
    resize
  };
};
