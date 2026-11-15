/**
 * Jihu Slicer - Core Geometry, Mesh Slicing, & G-Code Engine
 * Designed for Creality CR-10 V3 Concrete Printer (Auger Screw + 500ml Piston Feed)
 */

window.JihuEngine = (function () {
  // =========================================================================
  // 1. STL / OBJ / 3MF PARSER & PROCEDURAL PRIMITIVES
  // =========================================================================

  function parseSTL(buffer) {
    const bytes = new Uint8Array(buffer);
    let headerText = '';
    for (let i = 0; i < Math.min(256, bytes.length); i++) {
      headerText += String.fromCharCode(bytes[i]);
    }
    if (headerText.trimStart().toLowerCase().startsWith('solid') && buffer.byteLength > 84) {
      const view = new DataView(buffer);
      const numTriangles = view.getUint32(80, true);
      const expectedBytes = 84 + numTriangles * 50;
      if (expectedBytes !== buffer.byteLength) {
        return parseASCIISTL(new TextDecoder().decode(bytes));
      }
    }
    return parseBinarySTL(buffer);
  }

  function parseBinarySTL(buffer) {
    const view = new DataView(buffer);
    const numTriangles = view.getUint32(80, true);
    const vertices = new Float32Array(numTriangles * 9);
    const normals = new Float32Array(numTriangles * 9);
    let offset = 84;

    for (let i = 0; i < numTriangles; i++) {
      const nx = view.getFloat32(offset, true);
      const ny = view.getFloat32(offset + 4, true);
      const nz = view.getFloat32(offset + 8, true);
      offset += 12;

      const baseIdx = i * 9;
      for (let v = 0; v < 3; v++) {
        vertices[baseIdx + v * 3] = view.getFloat32(offset, true);
        vertices[baseIdx + v * 3 + 1] = view.getFloat32(offset + 4, true);
        vertices[baseIdx + v * 3 + 2] = view.getFloat32(offset + 8, true);
        normals[baseIdx + v * 3] = nx;
        normals[baseIdx + v * 3 + 1] = ny;
        normals[baseIdx + v * 3 + 2] = nz;
        offset += 12;
      }
      offset += 2;
    }

    return recomputeFaceNormals({ vertices, normals, triangleCount: numTriangles });
  }

  function parseASCIISTL(text) {
    const verts = [];
    const norms = [];
    let currentNormal = [0, 0, 1];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('facet normal')) {
        const parts = line.split(/\s+/);
        currentNormal = [
          parseFloat(parts[2]) || 0,
          parseFloat(parts[3]) || 0,
          parseFloat(parts[4]) || 0
        ];
      } else if (line.startsWith('vertex')) {
        const parts = line.split(/\s+/);
        verts.push(
          parseFloat(parts[1]) || 0,
          parseFloat(parts[2]) || 0,
          parseFloat(parts[3]) || 0
        );
        norms.push(currentNormal[0], currentNormal[1], currentNormal[2]);
      }
    }

    return recomputeFaceNormals({
      vertices: new Float32Array(verts),
      normals: new Float32Array(norms),
      triangleCount: Math.floor(verts.length / 9)
    });
  }

  function parseOBJ(text) {
    const rawVerts = [];
    const outVerts = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('v ')) {
        const p = line.split(/\s+/);
        rawVerts.push([parseFloat(p[1]) || 0, parseFloat(p[2]) || 0, parseFloat(p[3]) || 0]);
      } else if (line.startsWith('f ')) {
        const p = line.split(/\s+/).slice(1);
        const idx = p.map(tok => {
          const vIdx = parseInt(tok.split('/')[0], 10);
          return vIdx > 0 ? vIdx - 1 : rawVerts.length + vIdx;
        });
        for (let k = 1; k < idx.length - 1; k++) {
          const a = rawVerts[idx[0]];
          const b = rawVerts[idx[k]];
          const c = rawVerts[idx[k + 1]];
          if (a && b && c) {
            outVerts.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
          }
        }
      }
    }
    const vertices = new Float32Array(outVerts);
    const normals = new Float32Array(outVerts.length);
    return recomputeFaceNormals({
      vertices,
      normals,
      triangleCount: Math.floor(vertices.length / 9)
    });
  }

  async function parse3MF(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let offset = 0;
    let modelXmlText = null;

    while (offset + 30 <= bytes.length) {
      const sig = view.getUint32(offset, true);
      if (sig !== 0x04034b50) break;
      const compression = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const fileName = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
      const dataStart = offset + 30 + nameLen + extraLen;
      const compData = bytes.subarray(dataStart, dataStart + compSize);

      if (fileName.toLowerCase().endsWith('.model')) {
        if (compression === 0) {
          modelXmlText = new TextDecoder().decode(compData);
        } else if (compression === 8 && typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(compData);
          writer.close();
          const resp = new Response(ds.readable);
          const ab = await resp.arrayBuffer();
          modelXmlText = new TextDecoder().decode(ab);
        }
        if (modelXmlText) break;
      }
      offset = dataStart + compSize;
    }

    if (!modelXmlText) {
      throw new Error('Could not extract 3D model XML from .3mf archive.');
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(modelXmlText, 'application/xml');
    const meshes = doc.getElementsByTagName('mesh');
    const outVerts = [];

    for (let m = 0; m < meshes.length; m++) {
      const vNodes = meshes[m].getElementsByTagName('vertex');
      const vList = new Array(vNodes.length);
      for (let i = 0; i < vNodes.length; i++) {
        vList[i] = [
          parseFloat(vNodes[i].getAttribute('x')) || 0,
          parseFloat(vNodes[i].getAttribute('y')) || 0,
          parseFloat(vNodes[i].getAttribute('z')) || 0
        ];
      }
      const tNodes = meshes[m].getElementsByTagName('triangle');
      for (let i = 0; i < tNodes.length; i++) {
        const v1 = vList[parseInt(tNodes[i].getAttribute('v1'), 10)];
        const v2 = vList[parseInt(tNodes[i].getAttribute('v2'), 10)];
        const v3 = vList[parseInt(tNodes[i].getAttribute('v3'), 10)];
        if (v1 && v2 && v3) {
          outVerts.push(v1[0], v1[1], v1[2], v2[0], v2[1], v2[2], v3[0], v3[1], v3[2]);
        }
      }
    }

    const vertices = new Float32Array(outVerts);
    const normals = new Float32Array(outVerts.length);
    return recomputeFaceNormals({
      vertices,
      normals,
      triangleCount: Math.floor(vertices.length / 9)
    });
  }

  function recomputeFaceNormals(mesh) {
    const v = mesh.vertices;
    const n = mesh.normals;
    for (let i = 0; i < v.length; i += 9) {
      const ux = v[i + 3] - v[i], uy = v[i + 4] - v[i + 1], uz = v[i + 5] - v[i + 2];
      const vx = v[i + 6] - v[i], vy = v[i + 7] - v[i + 1], vz = v[i + 8] - v[i + 2];
      let cx = uy * vz - uz * vy;
      let cy = uz * vx - ux * vz;
      let cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz) || 1;
      cx /= len; cy /= len; cz /= len;
      for (let k = 0; k < 9; k += 3) {
        n[i + k] = cx;
        n[i + k + 1] = cy;
        n[i + k + 2] = cz;
      }
    }
    return mesh;
  }

  // Built-in Concrete Test Primitives
  function createPrimitive(type) {
    const tris = [];
    function addTri(a, b, c) {
      tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
    function addQuad(a, b, c, d) {
      addTri(a, b, c);
      addTri(a, c, d);
    }

    if (type === 'vase_twisted') {
      const rings = 56;
      const segs = 48;
      const height = 140;
      const baseR = 46;
      const grid = [];

      for (let r = 0; r <= rings; r++) {
        const t = r / rings;
        const z = t * height;
        const profile = baseR + 10 * Math.sin(t * Math.PI * 1.15) - 4 * Math.cos(t * Math.PI * 2);
        const twist = t * (Math.PI / 2.2);
        const ringPts = [];
        for (let s = 0; s < segs; s++) {
          const ang = (s / segs) * Math.PI * 2 + twist;
          const ripple = 3.2 * Math.cos(6 * ((s / segs) * Math.PI * 2));
          const rad = profile + ripple;
          ringPts.push([Math.cos(ang) * rad, Math.sin(ang) * rad, z]);
        }
        grid.push(ringPts);
      }

      for (let r = 0; r < rings; r++) {
        for (let s = 0; s < segs; s++) {
          const ns = (s + 1) % segs;
          addQuad(grid[r][s], grid[r][ns], grid[r + 1][ns], grid[r + 1][s]);
        }
      }
      const botCenter = [0, 0, 0];
      const topCenter = [0, 0, height];
      for (let s = 0; s < segs; s++) {
        const ns = (s + 1) % segs;
        addTri(botCenter, grid[0][ns], grid[0][s]);
        addTri(topCenter, grid[rings][s], grid[rings][ns]);
      }
    } else if (type === 'cylinder') {
      const segs = 64;
      const rad = 50;
      const h = 120;
      for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * Math.PI * 2;
        const a1 = ((s + 1) / segs) * Math.PI * 2;
        const p0b = [Math.cos(a0) * rad, Math.sin(a0) * rad, 0];
        const p1b = [Math.cos(a1) * rad, Math.sin(a1) * rad, 0];
        const p0t = [Math.cos(a0) * rad, Math.sin(a0) * rad, h];
        const p1t = [Math.cos(a1) * rad, Math.sin(a1) * rad, h];
        addQuad(p0b, p1b, p1t, p0t);
        addTri([0, 0, 0], p1b, p0b);
        addTri([0, 0, h], p0t, p1t);
      }
    } else if (type === 'hollow_block') {
      const o = 60, i = 35, h = 90;
      const ob = [[-o, -o, 0], [o, -o, 0], [o, o, 0], [-o, o, 0]];
      const ot = [[-o, -o, h], [o, -o, h], [o, o, h], [-o, o, h]];
      const ib = [[-i, -i, 0], [i, -i, 0], [i, i, 0], [-i, i, 0]];
      const it = [[-i, -i, h], [i, -i, h], [i, i, h], [-i, i, h]];
      for (let k = 0; k < 4; k++) {
        const nk = (k + 1) % 4;
        addQuad(ob[k], ob[nk], ot[nk], ot[k]);
        addQuad(ib[nk], ib[k], it[k], it[nk]);
        addQuad(ot[k], ot[nk], it[nk], it[k]);
        addQuad(ob[nk], ob[k], ib[k], ib[nk]);
      }
    } else {
      const w = 50, d = 50, h = 80;
      const b = [[-w, -d, 0], [w, -d, 0], [w, d, 0], [-w, d, 0]];
      const t = [[-w, -d, h], [w, -d, h], [w, d, h], [-w, d, h]];
      for (let k = 0; k < 4; k++) {
        const nk = (k + 1) % 4;
        addQuad(b[k], b[nk], t[nk], t[k]);
      }
      addQuad(b[3], b[2], b[1], b[0]);
      addQuad(t[0], t[1], t[2], t[3]);
    }

    const vertices = new Float32Array(tris);
    const normals = new Float32Array(tris.length);
    return recomputeFaceNormals({
      vertices,
      normals,
      triangleCount: Math.floor(vertices.length / 9)
    });
  }

  // =========================================================================
  // 2. MESH TRANSFORMATION, "PLACE ON FACE" ROTATION, & BOUNDING BOX
  // =========================================================================

  function computeBounds(vertices) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertices.length; i += 3) {
      const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (minX === Infinity) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0, sizeX: 0, sizeY: 0, sizeZ: 0 };
    }
    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      sizeX: maxX - minX,
      sizeY: maxY - minY,
      sizeZ: maxZ - minZ
    };
  }

  function transformMesh(rawMesh, transform, bedSize) {
    const vIn = rawMesh.vertices;
    const vOut = new Float32Array(vIn.length);
    const nOut = new Float32Array(vIn.length);

    const rawBounds = computeBounds(vIn);
    const cx = (rawBounds.minX + rawBounds.maxX) * 0.5;
    const cy = (rawBounds.minY + rawBounds.maxY) * 0.5;
    const cz = (rawBounds.minZ + rawBounds.maxZ) * 0.5;

    const sx = (transform.scaleX || 100) / 100;
    const sy = (transform.scaleY || 100) / 100;
    const sz = (transform.scaleZ || 100) / 100;

    const rx = ((transform.rotX || 0) * Math.PI) / 180;
    const ry = ((transform.rotY || 0) * Math.PI) / 180;
    const rz = ((transform.rotZ || 0) * Math.PI) / 180;

    const cosX = Math.cos(rx), sinX = Math.sin(rx);
    const cosY = Math.cos(ry), sinY = Math.sin(ry);
    const cosZ = Math.cos(rz), sinZ = Math.sin(rz);

    let minZAfter = Infinity;

    for (let i = 0; i < vIn.length; i += 3) {
      let x = (vIn[i] - cx) * sx;
      let y = (vIn[i + 1] - cy) * sy;
      let z = (vIn[i + 2] - cz) * sz;

      // Rotate X
      let y1 = y * cosX - z * sinX;
      let z1 = y * sinX + z * cosX;
      y = y1; z = z1;

      // Rotate Y
      let x2 = x * cosY + z * sinY;
      let z2 = -x * sinY + z * cosY;
      x = x2; z = z2;

      // Rotate Z
      let x3 = x * cosZ - y * sinZ;
      let y3 = x * sinZ + y * cosZ;
      x = x3; y = y3;

      vOut[i] = x;
      vOut[i + 1] = y;
      vOut[i + 2] = z;
      if (z < minZAfter) minZAfter = z;
    }

    const bedCenterX = bedSize.x * 0.5 + (transform.posX || 0);
    const bedCenterY = bedSize.y * 0.5 + (transform.posY || 0);

    for (let i = 0; i < vOut.length; i += 3) {
      vOut[i] += bedCenterX;
      vOut[i + 1] += bedCenterY;
      vOut[i + 2] -= minZAfter;
    }

    const mesh = recomputeFaceNormals({
      vertices: vOut,
      normals: nOut,
      triangleCount: rawMesh.triangleCount
    });
    mesh.bounds = computeBounds(vOut);
    return mesh;
  }

  /**
   * Given a triangle index `triIdx` in `rawMesh` and current scale settings,
   * computes the exact Euler rotation angles (rotX, rotY, rotZ) in degrees
   * so that the selected triangle face lies completely flat on the build plate (normal -> [0, 0, -1]).
   */
  function computeLayOnFaceRotation(rawMesh, triIdx, transform) {
    const v = rawMesh.vertices;
    const base = triIdx * 9;
    const sx = (transform.scaleX || 100) / 100;
    const sy = (transform.scaleY || 100) / 180 ? (transform.scaleY || 100) / 100 : 1;
    const sz = (transform.scaleZ || 100) / 100;

    const ax = v[base] * sx, ay = v[base + 1] * sy, az = v[base + 2] * sz;
    const bx = v[base + 3] * sx, by = v[base + 4] * sy, bz = v[base + 5] * sz;
    const cx = v[base + 6] * sx, cy = v[base + 7] * sy, cz = v[base + 8] * sz;

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    // Rx(phi) followed by Ry(theta) maps (nx, ny, nz) -> (0, 0, -1):
    // phi = atan2(-ny, -nz)
    // theta = atan2(nx, hypot(ny, nz))
    const phiRad = Math.atan2(-ny, -nz);
    const thetaRad = Math.atan2(nx, Math.hypot(ny, nz));

    let rotX = (phiRad * 180) / Math.PI;
    let rotY = (thetaRad * 180) / Math.PI;

    // Snap near-cardinal angles (e.g. 89.999 -> 90)
    if (Math.abs(rotX - Math.round(rotX)) < 0.05) rotX = Math.round(rotX);
    if (Math.abs(rotY - Math.round(rotY)) < 0.05) rotY = Math.round(rotY);

    return {
      rotX: Number(rotX.toFixed(2)),
      rotY: Number(rotY.toFixed(2)),
      rotZ: 0
    };
  }

  // =========================================================================
  // 3. 2D POLYGON & CONTOUR ENGINE (SLICING, OFFSETTING, INFILL CLIPPING)
  // =========================================================================

  function sliceMeshAtZ(vertices, z) {
    const segments = [];
    const zPlane = z + 1e-4;

    for (let i = 0; i < vertices.length; i += 9) {
      const x0 = vertices[i], y0 = vertices[i + 1], z0 = vertices[i + 2];
      const x1 = vertices[i + 3], y1 = vertices[i + 4], z1 = vertices[i + 5];
      const x2 = vertices[i + 6], y2 = vertices[i + 7], z2 = vertices[i + 8];

      const minZ = Math.min(z0, z1, z2);
      const maxZ = Math.max(z0, z1, z2);
      if (zPlane < minZ || zPlane > maxZ) continue;

      const pts = [];
      const edges = [
        [x0, y0, z0, x1, y1, z1],
        [x1, y1, z1, x2, y2, z2],
        [x2, y2, z2, x0, y0, z0]
      ];

      for (let e = 0; e < 3; e++) {
        const [ax, ay, az, bx, by, bz] = edges[e];
        if ((az < zPlane && bz >= zPlane) || (bz < zPlane && az >= zPlane)) {
          const t = (zPlane - az) / (bz - az);
          pts.push({ x: ax + t * (bx - ax), y: ay + t * (by - ay) });
        }
      }

      if (pts.length === 2) {
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        if (dx * dx + dy * dy > 1e-8) {
          segments.push({ p1: pts[0], p2: pts[1] });
        }
      }
    }

    return chainSegmentsIntoPolygons(segments);
  }

  function chainSegmentsIntoPolygons(segments) {
    const used = new Uint8Array(segments.length);
    const polygons = [];
    const TOL = 0.08;
    const TOL2 = TOL * TOL;

    function dist2(a, b) {
      const dx = a.x - b.x, dy = a.y - b.y;
      return dx * dx + dy * dy;
    }

    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const poly = [segments[i].p1, segments[i].p2];

      let extended = true;
      while (extended) {
        extended = false;
        const tail = poly[poly.length - 1];
        let bestIdx = -1;
        let bestFlip = false;
        let bestD2 = TOL2;

        for (let j = 0; j < segments.length; j++) {
          if (used[j]) continue;
          const d1 = dist2(tail, segments[j].p1);
          if (d1 < bestD2) {
            bestD2 = d1;
            bestIdx = j;
            bestFlip = false;
          }
          const d2 = dist2(tail, segments[j].p2);
          if (d2 < bestD2) {
            bestD2 = d2;
            bestIdx = j;
            bestFlip = true;
          }
        }

        if (bestIdx !== -1) {
          used[bestIdx] = 1;
          const nextPt = bestFlip ? segments[bestIdx].p1 : segments[bestIdx].p2;
          if (dist2(nextPt, poly[0]) < TOL2 && poly.length >= 3) {
            break;
          }
          poly.push(nextPt);
          extended = true;
        }
      }

      if (poly.length >= 3) {
        const cleaned = cleanAndSimplifyPolygon(poly, 0.12);
        if (cleaned.length >= 3 && Math.abs(polygonSignedArea(cleaned)) > 0.5) {
          polygons.push(cleaned);
        }
      }
    }

    normalizePolygonHierarchy(polygons);
    return polygons;
  }

  function polygonSignedArea(poly) {
    let area = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % n];
      area += p1.x * p2.y - p2.x * p1.y;
    }
    return area * 0.5;
  }

  function getPolygonBounds(poly) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  }

  function isPointOnPolygonEdge(pt, poly, eps = 1e-3) {
    if (!poly || poly.length < 3) return false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p1 = poly[j], p2 = poly[i];
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq > 1e-10) {
        const t = ((pt.x - p1.x) * dx + (pt.y - p1.y) * dy) / lenSq;
        if (t >= -1e-4 && t <= 1 + 1e-4) {
          const px = p1.x + t * dx, py = p1.y + t * dy;
          const distSq = (pt.x - px) * (pt.x - px) + (pt.y - py) * (pt.y - py);
          if (distSq <= eps * eps) return true;
        }
      }
    }
    return false;
  }

  function pointInPolygonStrict(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(pt, poly) {
    if (isPointOnPolygonEdge(pt, poly, 1e-3)) return true;
    return pointInPolygonStrict(pt, poly);
  }

  function normalizePolygonHierarchy(polygons) {
    for (let i = 0; i < polygons.length; i++) {
      let depth = 0;
      const testPt = polygons[i][0];
      for (let j = 0; j < polygons.length; j++) {
        if (i === j) continue;
        if (pointInPolygon(testPt, polygons[j])) {
          depth++;
        }
      }
      const area = polygonSignedArea(polygons[i]);
      const shouldBeCCW = (depth % 2 === 0);
      if ((shouldBeCCW && area < 0) || (!shouldBeCCW && area > 0)) {
        polygons[i].reverse();
      }
      polygons[i].isHole = !shouldBeCCW;
    }
  }

  /**
   * Removes duplicate vertices, tiny micro-segments, spikes (180° turnbacks),
   * and ALL collinear intermediate vertices along straight edges of ANY length.
   */
  function cleanAndSimplifyPolygon(poly, minStep) {
    if (!poly || poly.length < 3) return [];
    const minStep2 = minStep * minStep;

    // Step 1: Merge vertices closer than minStep
    let pts = [];
    for (let i = 0; i < poly.length; i++) {
      const curr = poly[i];
      if (pts.length === 0) {
        pts.push(curr);
      } else {
        const prev = pts[pts.length - 1];
        const dx = curr.x - prev.x, dy = curr.y - prev.y;
        if (dx * dx + dy * dy >= minStep2) {
          pts.push(curr);
        }
      }
    }
    if (pts.length > 1) {
      const first = pts[0], last = pts[pts.length - 1];
      if ((first.x - last.x) ** 2 + (first.y - last.y) ** 2 < minStep2) {
        pts.pop();
      }
    }

    // Step 2: Iteratively remove collinear intermediate vertices and 180° spikes
    let changed = true;
    let pass = 0;
    while (changed && pts.length >= 3 && pass < 6) {
      changed = false;
      pass++;
      const nextPts = [];
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const pPrev = nextPts.length > 0 ? nextPts[nextPts.length - 1] : pts[(i - 1 + n) % n];
        const pCurr = pts[i];
        const pNext = pts[(i + 1) % n];

        const v1x = pCurr.x - pPrev.x, v1y = pCurr.y - pPrev.y;
        const v2x = pNext.x - pCurr.x, v2y = pNext.y - pCurr.y;
        const l1 = Math.hypot(v1x, v1y);
        const l2 = Math.hypot(v2x, v2y);

        if (l1 < 1e-4 || l2 < 1e-4) {
          changed = true;
          continue;
        }

        const nx1 = v1x / l1, ny1 = v1y / l1;
        const nx2 = v2x / l2, ny2 = v2y / l2;
        const cross = Math.abs(nx1 * ny2 - ny1 * nx2);
        const dot = nx1 * nx2 + ny1 * ny2;

        // If edges are collinear (same direction, sin(angle) < 0.015) OR spike turnback (dot < -0.98)
        if (cross < 0.015 && dot > 0.99) {
          changed = true;
          continue;
        }
        if (dot < -0.985) {
          changed = true;
          continue;
        }
        nextPts.push(pCurr);
      }
      pts = nextPts;
    }

    return pts;
  }

  /**
   * Robust parallel-edge inward polygon offset by distance `d` (mm).
   * Prevents self-intersecting corner spikes and rejects polygons that collapse or invert.
   */
  /**
   * Single small-step inward polygon offset (stepD <= 0.85 mm).
   * Pre-decimates micro-edges shorter than stepD so non-convex / star-shaped polygons
   * (like Twisted Vase) shrink all the way to their center without self-intersecting ear spikes.
   */
  function offsetPolygonStep(poly, stepD) {
    if (Math.abs(stepD) < 1e-4) return poly.slice();

    // Merge micro-edges shorter than stepD * 1.15 before offsetting
    const minEdge = Math.max(0.35, Math.abs(stepD) * 1.15);
    const decimated = [];
    for (let i = 0; i < poly.length; i++) {
      const pt = poly[i];
      if (decimated.length === 0) {
        decimated.push({ x: pt.x, y: pt.y });
      } else {
        const prev = decimated[decimated.length - 1];
        if (Math.hypot(pt.x - prev.x, pt.y - prev.y) >= minEdge) {
          decimated.push({ x: pt.x, y: pt.y });
        }
      }
    }
    if (decimated.length > 2) {
      const first = decimated[0];
      const last = decimated[decimated.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < minEdge) {
        decimated.pop();
      }
    }

    const cleanedInput = cleanAndSimplifyPolygon(decimated, 0.08);
    const n = cleanedInput.length;
    if (n < 3) return null;

    const origBounds = getPolygonBounds(cleanedInput);
    if (!poly.isHole && (origBounds.width <= 2 * stepD + 0.1 || origBounds.height <= 2 * stepD + 0.1)) {
      return null;
    }

    const origArea = polygonSignedArea(cleanedInput);
    if (Math.abs(origArea) < 0.25) return null;

    const edges = [];
    for (let i = 0; i < n; i++) {
      const p1 = cleanedInput[i];
      const p2 = cleanedInput[(i + 1) % n];
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) continue;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      edges.push({
        p1x: p1.x + nx * stepD,
        p1y: p1.y + ny * stepD,
        ux, uy,
        nx, ny,
        origLen: len
      });
    }

    const m = edges.length;
    if (m < 3) return null;

    const rawOffsetPts = [];
    for (let i = 0; i < m; i++) {
      const ePrev = edges[(i - 1 + m) % m];
      const eCurr = edges[i];

      const denom = ePrev.ux * eCurr.uy - ePrev.uy * eCurr.ux;
      if (Math.abs(denom) < 1e-3) {
        rawOffsetPts.push({ x: eCurr.p1x, y: eCurr.p1y, ux: eCurr.ux, uy: eCurr.uy });
      } else {
        const dx = eCurr.p1x - ePrev.p1x;
        const dy = eCurr.p1y - ePrev.p1y;
        const t = (dx * eCurr.uy - dy * eCurr.ux) / denom;
        const maxMiter = ePrev.origLen + Math.abs(stepD) * 1.8;
        const minMiter = -Math.abs(stepD) * 1.8;
        const tClamped = Math.max(minMiter, Math.min(maxMiter, t));
        rawOffsetPts.push({
          x: ePrev.p1x + tClamped * ePrev.ux,
          y: ePrev.p1y + tClamped * ePrev.uy,
          ux: eCurr.ux,
          uy: eCurr.uy
        });
      }
    }

    // Prune inverted edges using each vertex's own paired edge vector (a.ux, a.uy)
    let validPts = rawOffsetPts;
    for (let iter = 0; iter < 3; iter++) {
      const kLen = validPts.length;
      if (kLen < 3) return null;
      const filtered = [];
      for (let i = 0; i < kLen; i++) {
        const a = validPts[i];
        const b = validPts[(i + 1) % kLen];
        const dot = (b.x - a.x) * a.ux + (b.y - a.y) * a.uy;
        if (dot > -0.02) {
          filtered.push(a);
        }
      }
      validPts = filtered;
    }

    const finalPoly = cleanAndSimplifyPolygon(validPts, 0.08);
    if (finalPoly.length < 3) return null;

    const newArea = polygonSignedArea(finalPoly);
    if (origArea * newArea <= 0) return null;
    if (!poly.isHole && Math.abs(newArea) >= Math.abs(origArea)) return null;

    finalPoly.isHole = poly.isHole;
    return finalPoly;
  }

  /**
   * Multi-step inward polygon offset by distance `d` (mm).
   * Stepping in increments of <= 0.8 mm allows complex star/concave contours
   * to offset cleanly all the way to the center without premature termination.
   */
  function offsetPolygonInward(poly, d) {
    if (!poly || poly.length < 3) return null;
    if (Math.abs(d) < 1e-4) {
      const copy = poly.slice();
      copy.isHole = poly.isHole;
      return copy;
    }

    const origBounds = getPolygonBounds(poly);
    if (!poly.isHole && (origBounds.width <= 2 * d + 0.15 || origBounds.height <= 2 * d + 0.15)) {
      return null;
    }

    const numSteps = Math.max(1, Math.ceil(Math.abs(d) / 0.8));
    const stepD = d / numSteps;
    let current = poly;

    for (let s = 0; s < numSteps; s++) {
      const nextStep = offsetPolygonStep(current, stepD);
      if (!nextStep || nextStep.length < 3) {
        if (poly.isHole) {
          break;
        }
        return null;
      }
      current = nextStep;
    }

    if (!poly.isHole) {
      const newBounds = getPolygonBounds(current);
      if (
        newBounds.minX < origBounds.minX + d * 0.25 ||
        newBounds.maxX > origBounds.maxX - d * 0.25 ||
        newBounds.minY < origBounds.minY + d * 0.25 ||
        newBounds.maxY > origBounds.maxY - d * 0.25
      ) {
        return null;
      }
    }

    current.isHole = poly.isHole;
    return current;
  }

  function isHoleStrictlyInsideOuter(hole, outer) {
    if (!hole || !outer || hole.length < 3 || outer.length < 3) return false;
    const bH = getPolygonBounds(hole);
    const bO = getPolygonBounds(outer);
    if (bH.minX < bO.minX - 0.05 || bH.maxX > bO.maxX + 0.05 ||
        bH.minY < bO.minY - 0.05 || bH.maxY > bO.maxY + 0.05) {
      return false;
    }
    const areaH = Math.abs(polygonSignedArea(hole));
    const areaO = Math.abs(polygonSignedArea(outer));
    if (areaH >= areaO - 0.1) return false;

    const step = Math.max(1, Math.floor(hole.length / 8));
    for (let i = 0; i < hole.length; i += step) {
      if (!pointInPolygon(hole[i], outer)) return false;
    }
    return true;
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-10) return { d: Math.hypot(p.x - a.x, p.y - a.y), pt: { x: a.x, y: a.y } };
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: a.x + t * dx, y: a.y + t * dy };
    return { d: Math.hypot(p.x - proj.x, p.y - proj.y), pt: proj };
  }

  function closestPointOnPoly(p, poly) {
    let minD = Infinity;
    let bestPt = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const res = distToSegment(p, a, b);
      if (res.d < minD) {
        minD = res.d;
        bestPt = res.pt;
      }
    }
    return { d: minD, pt: bestPt };
  }

  function samplePolygon(poly, step) {
    const pts = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const count = Math.max(1, Math.round(len / step));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        pts.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
    }
    return pts;
  }

  function computeMedialCenterlineLoop(outerPoly, holePoly, lineWidth) {
    const sampled = samplePolygon(outerPoly, Math.max(2.0, lineWidth * 0.45));
    let maxClearance = 0;
    let minClearance = Infinity;
    const midPts = [];
    for (const pt of sampled) {
      const cp = closestPointOnPoly(pt, holePoly);
      if (cp.d > maxClearance) maxClearance = cp.d;
      if (cp.d < minClearance) minClearance = cp.d;
      midPts.push({ x: (pt.x + cp.pt.x) * 0.5, y: (pt.y + cp.pt.y) * 0.5, d: cp.d });
    }

    const cleaned = cleanAndSimplifyPolygon(midPts, 0.15);
    return { cleaned, maxClearance, minClearance };
  }

  function offsetPolygonsInward(polygons, dist) {
    const inputOuters = [];
    const inputHoles = [];
    for (let i = 0; i < polygons.length; i++) {
      const p = polygons[i];
      if (!p || p.length < 3) continue;
      if (p.isHole) inputHoles.push(p);
      else inputOuters.push(p);
    }

    const outers = [];
    for (let i = 0; i < inputOuters.length; i++) {
      const off = offsetPolygonInward(inputOuters[i], dist);
      if (off && off.length >= 3) {
        off._origOuter = inputOuters[i];
        outers.push(off);
      }
    }

    if (outers.length === 0) return [];

    // Expand every hole outward by `dist`. An expanding hole never disappears:
    // if offset fails or shrinks, retain the original hole so cavities are never lost.
    const rawHoles = [];
    for (let i = 0; i < inputHoles.length; i++) {
      const origH = inputHoles[i];
      const origArea = Math.abs(polygonSignedArea(origH));
      let offH = offsetPolygonInward(origH, dist);
      if (!offH || offH.length < 3 || Math.abs(polygonSignedArea(offH)) < origArea * 0.98) {
        offH = origH.slice();
        offH.isHole = true;
      }
      offH._origHole = origH;
      rawHoles.push(offH);
    }

    // Filter out outer polygons that have been completely eroded/swallowed by their expanded holes
    // (occurs when a hollow shell wall is thinner than or equal to 2 * dist).
    const survivingOuters = [];
    for (let o = 0; o < outers.length; o++) {
      const outer = outers[o];
      const areaO = Math.abs(polygonSignedArea(outer));
      const bO = getPolygonBounds(outer);
      let swallowedByHole = false;
      let enclosedHoleAreaSum = 0;

      for (let h = 0; h < rawHoles.length; h++) {
        const hole = rawHoles[h];
        const origH = hole._origHole || hole;
        const origO = outer._origOuter || outer;
        const wasChildHole = isHoleStrictlyInsideOuter(origH, origO) || pointInPolygon(origH[0], origO);

        if (isHoleStrictlyInsideOuter(outer, hole)) {
          swallowedByHole = true;
          break;
        }

        if (wasChildHole) {
          const areaH = Math.abs(polygonSignedArea(hole));
          enclosedHoleAreaSum += areaH;
          const bH = getPolygonBounds(hole);
          // If the expanded child hole has grown as large as or larger than the shrunk outer contour,
          // the hollow shell wall has been completely eroded away.
          if (
            areaH >= areaO - 1.5 ||
            (bH.minX <= bO.minX + 0.2 && bH.maxX >= bO.maxX - 0.2 &&
             bH.minY <= bO.minY + 0.2 && bH.maxY >= bO.maxY - 0.2)
          ) {
            swallowedByHole = true;
            break;
          }
        }
      }

      if (!swallowedByHole && enclosedHoleAreaSum >= areaO - 1.5) {
        swallowedByHole = true;
      }

      if (!swallowedByHole) {
        // Also verify at least one sample point inside `outer` is not inside any `rawHole`
        let hasRemainingSolid = true;
        if (rawHoles.length > 0) {
          hasRemainingSolid = false;
          const step = Math.max(1, Math.floor(outer.length / 16));
          for (let k = 0; k < outer.length; k += step) {
            const pt = outer[k];
            let insideAnyHole = false;
            for (let h = 0; h < rawHoles.length; h++) {
              if (pointInPolygonStrict(pt, rawHoles[h])) {
                insideAnyHole = true;
                break;
              }
            }
            if (!insideAnyHole) {
              hasRemainingSolid = true;
              break;
            }
          }
        }
        if (hasRemainingSolid) {
          survivingOuters.push(outer);
        }
      }
    }

    if (survivingOuters.length === 0) return [];

    // Keep all holes that overlap or lie inside any surviving outer polygon.
    // Never drop a hole simply because it locally touched an outer boundary!
    const validHoles = [];
    for (let h = 0; h < rawHoles.length; h++) {
      const hole = rawHoles[h];
      const bH = getPolygonBounds(hole);
      let relevantToOuter = false;
      for (let o = 0; o < survivingOuters.length; o++) {
        const bO = getPolygonBounds(survivingOuters[o]);
        if (bH.maxX >= bO.minX && bH.minX <= bO.maxX && bH.maxY >= bO.minY && bH.minY <= bO.maxY) {
          relevantToOuter = true;
          break;
        }
      }
      if (relevantToOuter) {
        validHoles.push(hole);
      }
    }

    return survivingOuters.concat(validHoles);
  }

  /**
   * Offsets the first perimeter wall inward by `dist`, with automatic thin-ribbon fallback
   * so C-shaped / U-shaped thin walls (where thickness ~= 2 * dist) preserve their full span.
   */
  function offsetOuterWallPolygons(polygons, dist) {
    const outers = [];
    const rawHoles = [];
    for (let i = 0; i < polygons.length; i++) {
      const poly = polygons[i];
      if (!poly || poly.length < 3) continue;
      let off = offsetPolygonInward(poly, dist);
      if (!poly.isHole) {
        const origB = getPolygonBounds(poly);
        const lostSpan = !off || off.length < 3 ||
          getPolygonBounds(off).width < origB.width - dist * 2.6 ||
          getPolygonBounds(off).height < origB.height - dist * 2.6;
        if (lostSpan && Math.max(origB.width, origB.height) > dist * 2.5) {
          for (const scale of [0.84, 0.72, 0.58, 0.42]) {
            const dTry = dist * scale;
            const candidate = offsetPolygonInward(poly, dTry);
            if (candidate && candidate.length >= 3) {
              const cb = getPolygonBounds(candidate);
              if (cb.width >= origB.width - dist * 2.6 && cb.height >= origB.height - dist * 2.6) {
                off = candidate;
                break;
              }
              if (!off || off.length < 3) off = candidate;
            }
          }
        }
      }
      if (off && off.length >= 3) {
        if (off.isHole) {
          off._origHole = poly;
          rawHoles.push(off);
        } else {
          off._origOuter = poly;
          outers.push(off);
        }
      }
    }

    if (outers.length === 0) return [];

    const validHoles = [];
    for (let h = 0; h < rawHoles.length; h++) {
      const hole = rawHoles[h];
      const origH = hole._origHole || hole;
      let insideAnOuter = false;
      for (let o = 0; o < outers.length; o++) {
        const outer = outers[o];
        const origO = outer._origOuter || outer;
        if (isHoleStrictlyInsideOuter(origH, origO)) {
          // Measure true wall thickness between original outer and inner hole contours
          const medial = computeMedialCenterlineLoop(origO, origH, dist * 2.0);
          // If the wall is a single-bead thin shell (thickness < 1.55 * lineWidth = 3.1 * dist),
          // two full perimeter beads would overlap heavily on top of each other.
          // Trace 1 clean medial wall along the center of the thin shell instead!
          if (medial.maxClearance < dist * 3.1 && medial.cleaned && medial.cleaned.length >= 3) {
            const medPoly = medial.cleaned;
            medPoly.isHole = false;
            medPoly._origOuter = origO;
            outers[o] = medPoly;
            insideAnOuter = false;
          } else if (isHoleStrictlyInsideOuter(hole, outer)) {
            insideAnOuter = true;
          }
          break;
        }
      }
      if (insideAnOuter) {
        validHoles.push(hole);
      }
    }

    return outers.concat(validHoles);
  }

  function isPointInsideBoundarySet(pt, boundaryPolygons) {
    if (!boundaryPolygons || boundaryPolygons.length === 0) return false;
    let outerCount = 0;
    let holeCount = 0;
    for (let i = 0; i < boundaryPolygons.length; i++) {
      const p = boundaryPolygons[i];
      if (p.isHole) {
        // Points ON the boundary of a hole belong to the solid boundary (not void),
        // only points strictly inside the interior of the hole void count as hole!
        if (pointInPolygonStrict(pt, p) && !isPointOnPolygonEdge(pt, p, 1e-3)) {
          holeCount++;
        }
      } else {
        // Points inside or on the boundary of an outer polygon are solid
        if (pointInPolygon(pt, p)) {
          outerCount++;
        }
      }
    }
    if (outerCount === 0) return false;
    return outerCount > holeCount;
  }

  // Clip an arbitrary polyline against boundaryPolygons using exact segment-edge intersections
  function clipPolylineToBoundary(pts, boundaryPolygons, minLen) {
    if (!pts || pts.length < 2 || !boundaryPolygons || boundaryPolygons.length === 0) return [];
    const insideSegs = [];

    for (let s = 0; s < pts.length - 1; s++) {
      const p1 = pts[s];
      const p2 = pts[s + 1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const segLen = Math.hypot(dx, dy);
      if (segLen < 1e-5) continue;

      const tValues = [0.0, 1.0];
      for (let pIdx = 0; pIdx < boundaryPolygons.length; pIdx++) {
        const poly = boundaryPolygons[pIdx];
        const n = poly.length;
        for (let i = 0; i < n; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % n];
          const ex = b.x - a.x;
          const ey = b.y - a.y;
          const denom = dx * ey - dy * ex;
          if (Math.abs(denom) < 1e-9) continue;
          const acx = a.x - p1.x;
          const acy = a.y - p1.y;
          const t = (acx * ey - acy * ex) / denom;
          const u = (acx * dy - acy * dx) / denom;
          if (t > 1e-5 && t < 1.0 - 1e-5 && u >= -1e-5 && u <= 1.0 + 1e-5) {
            tValues.push(t);
          }
        }
      }

      tValues.sort((a, b) => a - b);

      for (let k = 0; k < tValues.length - 1; k++) {
        const t0 = tValues[k];
        const t1 = tValues[k + 1];
        if (t1 - t0 < 1e-4) continue;
        const tMid = (t0 + t1) * 0.5;
        const midPt = { x: p1.x + tMid * dx, y: p1.y + tMid * dy };
        if (isPointInsideBoundarySet(midPt, boundaryPolygons)) {
          const aPt = { x: p1.x + t0 * dx, y: p1.y + t0 * dy };
          const bPt = { x: p1.x + t1 * dx, y: p1.y + t1 * dy };
          if (Math.hypot(bPt.x - aPt.x, bPt.y - aPt.y) >= minLen) {
            insideSegs.push({ p1: aPt, p2: bPt });
          }
        }
      }
    }

    if (insideSegs.length === 0) return [];

    // Chain contiguous inside segments into continuous paths
    const paths = [];
    let cur = [insideSegs[0].p1, insideSegs[0].p2];
    for (let i = 1; i < insideSegs.length; i++) {
      const prev = cur[cur.length - 1];
      const seg = insideSegs[i];
      if (Math.hypot(seg.p1.x - prev.x, seg.p1.y - prev.y) < 0.15) {
        cur.push(seg.p2);
      } else {
        paths.push({ points: cur, closed: false });
        cur = [seg.p1, seg.p2];
      }
    }
    paths.push({ points: cur, closed: false });
    return paths;
  }

  function getBoundaryBoundsAndCenter(boundaryPolygons) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let sumX = 0, sumY = 0, count = 0;
    for (const poly of boundaryPolygons) {
      for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        sumX += p.x;
        sumY += p.y;
        count++;
      }
    }
    const cx = count > 0 ? sumX / count : (minX + maxX) * 0.5;
    const cy = count > 0 ? sumY / count : (minY + maxY) * 0.5;
    const maxR = Math.hypot(Math.max(cx - minX, maxX - cx), Math.max(cy - minY, maxY - cy));
    return { minX, maxX, minY, maxY, cx, cy, maxR };
  }

  // Hilbert curve index d -> (x, y) on n x n grid (n = 2^order)
  function hilbertIndexToXY(n, d) {
    let x = 0, y = 0;
    let t = d;
    for (let s = 1; s < n; s *= 2) {
      const rx = 1 & (t >> 1);
      const ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) {
          x = s - 1 - x;
          y = s - 1 - y;
        }
        const tmp = x;
        x = y;
        y = tmp;
      }
      x += s * rx;
      y += s * ry;
      t >>= 2;
    }
    return { x, y };
  }

  function orientPolygonCCW(poly) {
    if (!poly || poly.length < 3) return poly || [];
    return polygonSignedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
  }

  function alignPolygonStartToPoint(poly, anchorPt) {
    const ccw = orientPolygonCCW(poly);
    const n = ccw.length;
    if (n < 3 || !anchorPt) return ccw;

    let bestDist = Infinity;
    let bestEdge = 0;
    let bestU = 0;
    let bestPt = ccw[0];

    for (let i = 0; i < n; i++) {
      const a = ccw[i];
      const b = ccw[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      let u = 0;
      if (lenSq > 1e-8) {
        u = ((anchorPt.x - a.x) * dx + (anchorPt.y - a.y) * dy) / lenSq;
        u = Math.max(0, Math.min(1, u));
      }
      const px = a.x + u * dx;
      const py = a.y + u * dy;
      const d = Math.hypot(px - anchorPt.x, py - anchorPt.y);
      if (d < bestDist) {
        bestDist = d;
        bestEdge = i;
        bestU = u;
        bestPt = { x: px, y: py };
      }
    }

    const a = ccw[bestEdge];
    const b = ccw[(bestEdge + 1) % n];
    const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);

    if (bestU * edgeLen <= 0.35) {
      return ccw.slice(bestEdge).concat(ccw.slice(0, bestEdge));
    }
    if ((1 - bestU) * edgeLen <= 0.35) {
      const nextIdx = (bestEdge + 1) % n;
      return ccw.slice(nextIdx).concat(ccw.slice(0, nextIdx));
    }

    const out = [{ x: bestPt.x, y: bestPt.y }];
    for (let k = 1; k <= n; k++) {
      out.push(ccw[(bestEdge + k) % n]);
    }
    return out;
  }

  function getPolygonArcTable(poly) {
    const n = poly.length;
    const cum = new Float64Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      total += Math.hypot(b.x - a.x, b.y - a.y);
      cum[i + 1] = total;
    }
    return { cum, total };
  }

  function pointAlongPolygonArc(poly, arcTable, s) {
    const n = poly.length;
    const total = arcTable.total;
    if (total <= 1e-6 || s <= 0) return { x: poly[0].x, y: poly[0].y };
    if (s >= total) return { x: poly[0].x, y: poly[0].y };

    const cum = arcTable.cum;
    for (let i = 0; i < n; i++) {
      if (s <= cum[i + 1] + 1e-7) {
        const segLen = cum[i + 1] - cum[i];
        const t = segLen > 1e-6 ? Math.max(0, Math.min(1, (s - cum[i]) / segLen)) : 0;
        const a = poly[i];
        const b = poly[(i + 1) % n];
        return {
          x: a.x + t * (b.x - a.x),
          y: a.y + t * (b.y - a.y)
        };
      }
    }
    return { x: poly[0].x, y: poly[0].y };
  }

  function slicePolygonArcVertices(poly, arcTable, sEnd) {
    const n = poly.length;
    const cum = arcTable.cum;
    const pts = [{ x: poly[0].x, y: poly[0].y }];
    if (sEnd <= 1e-5) return pts;

    for (let i = 0; i < n; i++) {
      if (cum[i + 1] < sEnd - 0.05) {
        const nextV = poly[(i + 1) % n];
        pts.push({ x: nextV.x, y: nextV.y });
      } else {
        const endPt = pointAlongPolygonArc(poly, arcTable, sEnd);
        const last = pts[pts.length - 1];
        if (Math.hypot(endPt.x - last.x, endPt.y - last.y) > 0.05) {
          pts.push(endPt);
        }
        break;
      }
    }
    return pts;
  }

  /**
   * Generates a single continuous contour-parallel concentric spiral path
   * that smoothly transitions from ring to ring without travel hops.
   */
  function generateContinuousConcentricSpiral(boundaryPolygons, stepDist, lineWidth, isSolidFill, anchorPt, outward) {
    const ringLevels = [];
    let current = boundaryPolygons.filter(p => !p.isHole && p.length >= 3);
    let safety = 0;

    while (current.length > 0 && safety < 64) {
      ringLevels.push(current.slice());
      const next = offsetPolygonsInward(current, stepDist).filter(p => !p.isHole && p.length >= 3);
      if (next.length === 0 && isSolidFill) {
        const extra = [];
        for (const p of current) {
          const b = getPolygonBounds(p);
          const minSpan = Math.min(b.width, b.height);
          if (minSpan > lineWidth * 0.72) {
            const halfStep = offsetPolygonInward(p, minSpan * 0.36);
            if (halfStep && halfStep.length >= 3) {
              extra.push(halfStep);
            }
          }
        }
        if (extra.length > 0) {
          ringLevels.push(extra);
        }
      }
      current = next;
      safety++;
    }

    if (ringLevels.length === 0) return [];

    const alignedRings = [];
    let curAnchor = anchorPt || ringLevels[0][0][0];

    for (let lvl = 0; lvl < ringLevels.length; lvl++) {
      const polys = ringLevels[lvl];
      polys.sort((a, b) => Math.abs(polygonSignedArea(b)) - Math.abs(polygonSignedArea(a)));
      const aligned = alignPolygonStartToPoint(polys[0], curAnchor);
      alignedRings.push(aligned);
      curAnchor = aligned[0];
    }

    const spiralPts = [];
    const numRings = alignedRings.length;
    const arcTables = alignedRings.map(r => getPolygonArcTable(r));

    for (let j = 0; j < numRings; j++) {
      const ring = alignedRings[j];
      const table = arcTables[j];
      const isLast = (j === numRings - 1);
      const rampLen = isLast
        ? Math.min(table.total * 0.10, lineWidth * 0.45)
        : Math.min(table.total * 0.18, lineWidth * 0.90);
      const bodyEnd = Math.max(0.2, table.total - rampLen);

      const bodyPts = slicePolygonArcVertices(ring, table, bodyEnd);
      for (let k = 0; k < bodyPts.length; k++) {
        if (spiralPts.length === 0) {
          spiralPts.push(bodyPts[k]);
        } else {
          const prev = spiralPts[spiralPts.length - 1];
          if (Math.hypot(bodyPts[k].x - prev.x, bodyPts[k].y - prev.y) > 0.05) {
            spiralPts.push(bodyPts[k]);
          }
        }
      }

      if (!isLast) {
        const nextRing = alignedRings[j + 1];
        const nextTable = arcTables[j + 1];
        const nextRampLen = Math.min(nextTable.total * 0.18, lineWidth * 0.90);
        const rampSteps = 5;
        for (let s = 1; s < rampSteps; s++) {
          const u = s / rampSteps;
          const alpha = 0.5 - 0.5 * Math.cos(Math.PI * u);
          const pA = pointAlongPolygonArc(ring, table, table.total - (1 - u) * rampLen);
          const pB = pointAlongPolygonArc(nextRing, nextTable, nextTable.total - (1 - u) * nextRampLen);
          spiralPts.push({
            x: (1 - alpha) * pA.x + alpha * pB.x,
            y: (1 - alpha) * pA.y + alpha * pB.y
          });
        }
      } else if (isSolidFill) {
        const b = getPolygonBounds(ring);
        const cx = (b.minX + b.maxX) * 0.5;
        const cy = (b.minY + b.maxY) * 0.5;
        const minSpan = Math.min(b.width, b.height);
        const maxSpan = Math.max(b.width, b.height);
        if (maxSpan > lineWidth * 0.60) {
          if (maxSpan - minSpan > lineWidth * 0.55) {
            const dx = Math.max(0, (b.width - lineWidth * 0.75) * 0.42);
            const dy = Math.max(0, (b.height - lineWidth * 0.75) * 0.42);
            const p1 = b.width >= b.height ? { x: cx - dx, y: cy } : { x: cx, y: cy - dy };
            const p2 = b.width >= b.height ? { x: cx + dx, y: cy } : { x: cx, y: cy + dy };
            const lastPt = spiralPts[spiralPts.length - 1];
            if (Math.hypot(p1.x - lastPt.x, p1.y - lastPt.y) <= Math.hypot(p2.x - lastPt.x, p2.y - lastPt.y)) {
              spiralPts.push(p1, p2);
            } else {
              spiralPts.push(p2, p1);
            }
          } else {
            spiralPts.push({ x: cx, y: cy });
          }
        }
      }
    }

    if (outward) {
      spiralPts.reverse();
    }

    const outPaths = [];
    if (spiralPts.length >= 2) {
      outPaths.push({ points: spiralPts, closed: false, continuousSpiral: true });
    }
    return outPaths;
  }

  // Generate surface or sparse infill strictly clipped inside `boundaryPolygons`
  function generateInfillSegments(boundaryPolygons, spacing, angleDeg, pattern, lineWidth, phaseOffset, isSolidFill, options) {
    if (!boundaryPolygons || boundaryPolygons.length === 0 || spacing <= 0) return [];
    const minSegLen = Math.max(0.18, lineWidth * 0.15);

    // 1A. CONTINUOUS 1-LINE CONCENTRIC SPIRAL (Connects all concentric rings into 1 unbroken path)
    if (pattern === 'concentric_spiral' || (pattern === 'concentric' && options && options.continuousSpiral)) {
      const stepDist = isSolidFill ? spacing * 0.90 : spacing;
      const anchorPt = options && options.anchorPt ? options.anchorPt : null;
      const outward = Boolean(options && options.outward);
      return generateContinuousConcentricSpiral(boundaryPolygons, stepDist, lineWidth, isSolidFill, anchorPt, outward);
    }

    // 1B. CONCENTRIC (Contour-parallel inward rings all the way to the center with central gap-fill)
    if (pattern === 'concentric') {
      const paths = [];
      let current = boundaryPolygons.slice();
      const stepDist = isSolidFill ? spacing * 0.90 : spacing;
      let safety = 0;
      while (current.length > 0 && safety < 64) {
        for (const p of current) {
          if (p.length >= 3) {
            let allInside = true;
            let anyInside = false;
            for (let i = 0; i < p.length; i++) {
              const a = p[i];
              const b = p[(i + 1) % p.length];
              const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
              const inA = isPointInsideBoundarySet(a, boundaryPolygons);
              const inMid = isPointInsideBoundarySet(mid, boundaryPolygons);
              if (inA || inMid) anyInside = true;
              if (!inA || !inMid) allInside = false;
            }
            if (allInside) {
              paths.push({ points: p.slice(), closed: true });
            } else if (anyInside) {
              // Poly partially crosses a hole or outer boundary: clip polyline to solid boundary
              const loopPts = p.concat([p[0]]);
              const clipped = clipPolylineToBoundary(loopPts, boundaryPolygons, minSegLen);
              for (const cPath of clipped) {
                if (cPath.points && cPath.points.length >= 2) {
                  paths.push(cPath);
                }
              }
            }
          }
        }
        let next = offsetPolygonsInward(current, stepDist);
        // Crossover protection: If remaining outer and hole contours have clearance < 1.6 * stepDist,
        // stop further inward offsetting to prevent crossed-over ghost passes!
        const nextOuters = next.filter(p => !p.isHole);
        const nextHoles = next.filter(p => p.isHole);
        if (nextOuters.length > 0 && nextHoles.length > 0) {
          let hasCrossoverRisk = false;
          for (const hPoly of nextHoles) {
            for (const oPoly of nextOuters) {
              const bH = getPolygonBounds(hPoly);
              const bO = getPolygonBounds(oPoly);
              const gapX = Math.min(bH.minX - bO.minX, bO.maxX - bH.maxX);
              const gapY = Math.min(bH.minY - bO.minY, bO.maxY - bH.maxY);
              if (gapX < stepDist * 0.75 || gapY < stepDist * 0.75) {
                hasCrossoverRisk = true;
                break;
              }
            }
          }
          if (hasCrossoverRisk) {
            next = [];
          }
        }
        if (next.length === 0 && isSolidFill) {
          // Check if any innermost ring still has an open center that needs a final closing ring/spine
          for (const p of current) {
            if (p.isHole) continue;
            const b = getPolygonBounds(p);
            const minSpan = Math.min(b.width, b.height);
            if (minSpan > lineWidth * 0.75) {
              const halfStep = offsetPolygonInward(p, minSpan * 0.36);
              if (halfStep && halfStep.length >= 3 && isPointInsideBoundarySet(halfStep[0], boundaryPolygons)) {
                paths.push({ points: halfStep.slice(), closed: true });
              } else {
                // Emit a short center fill segment across the centroid only if inside solid boundary
                const cx = (b.minX + b.maxX) * 0.5;
                const cy = (b.minY + b.maxY) * 0.5;
                if (isPointInsideBoundarySet({ x: cx, y: cy }, boundaryPolygons)) {
                  const dx = Math.max(0.6, (b.width - lineWidth * 0.7) * 0.4);
                  const dy = Math.max(0.6, (b.height - lineWidth * 0.7) * 0.4);
                  if (b.width >= b.height) {
                    paths.push({ points: [{ x: cx - dx, y: cy }, { x: cx + dx, y: cy }], closed: false });
                  } else {
                    paths.push({ points: [{ x: cx, y: cy - dy }, { x: cx, y: cy + dy }], closed: false });
                  }
                }
              }
            }
          }
        }
        current = next;
        safety++;
      }
      return paths;
    }

    // 2. ARCHIMEDEAN CHORDS (Continuous Archimedean spiral clipped to boundary)
    if (pattern === 'archimedean') {
      const info = getBoundaryBoundsAndCenter(boundaryPolygons);
      const effSpacing = isSolidFill ? spacing * 0.88 : spacing;
      const b = effSpacing / (2 * Math.PI);
      const maxTheta = ((info.maxR + effSpacing * 1.5) / b);
      const pts = [{ x: info.cx, y: info.cy }];
      let theta = 0.15;
      const chordStep = Math.max(1.8, lineWidth * 0.45);
      while (theta <= maxTheta) {
        const r = b * theta;
        pts.push({
          x: info.cx + r * Math.cos(theta),
          y: info.cy + r * Math.sin(theta)
        });
        const dTheta = Math.min(0.28, chordStep / Math.max(r, effSpacing * 0.35));
        theta += dTheta;
      }
      return clipPolylineToBoundary(pts, boundaryPolygons, minSegLen);
    }

    // 3. OCTAGRAM SPIRAL (OrcaSlicer 8-pointed star wave spiral clipped to boundary)
    if (pattern === 'octagram') {
      const info = getBoundaryBoundsAndCenter(boundaryPolygons);
      const effSpacing = isSolidFill ? spacing * 0.86 : spacing;
      const b = effSpacing / (2 * Math.PI);
      const maxTheta = ((info.maxR + effSpacing * 1.8) / b);
      const pts = [{ x: info.cx, y: info.cy }];
      let theta = 0.15;
      const chordStep = Math.max(1.8, lineWidth * 0.42);
      while (theta <= maxTheta) {
        const baseR = b * theta;
        const starWave = 1.0 + 0.22 * (1.0 - Math.abs(((theta * 4.0 / Math.PI) % 2.0) - 1.0) * 2.0);
        const r = baseR * starWave;
        pts.push({
          x: info.cx + r * Math.cos(theta),
          y: info.cy + r * Math.sin(theta)
        });
        const dTheta = Math.min(0.16, chordStep / Math.max(baseR, effSpacing * 0.35));
        theta += dTheta;
      }
      return clipPolylineToBoundary(pts, boundaryPolygons, minSegLen);
    }

    // 4. HILBERT CURVE (Space-filling fractal curve clipped to boundary)
    if (pattern === 'hilbert') {
      const info = getBoundaryBoundsAndCenter(boundaryPolygons);
      const effSpacing = isSolidFill ? spacing * 0.86 : spacing;
      const span = Math.max(info.maxX - info.minX, info.maxY - info.minY) + effSpacing * 0.5;
      const targetCells = Math.max(4, Math.round(span / Math.max(effSpacing, lineWidth * 0.8)));
      const order = Math.max(2, Math.min(6, Math.round(Math.log2(targetCells))));
      const n = 1 << order;
      const totalPts = n * n;
      const startX = info.cx - span * 0.5;
      const startY = info.cy - span * 0.5;
      const step = span / Math.max(1, n - 1);

      const pts = new Array(totalPts);
      for (let d = 0; d < totalPts; d++) {
        const h = hilbertIndexToXY(n, d);
        pts[d] = {
          x: startX + h.x * step,
          y: startY + h.y * step
        };
      }
      return clipPolylineToBoundary(pts, boundaryPolygons, minSegLen);
    }

    // 5. HONEYCOMB (Hexagonal corrugated wave lines)
    if (pattern === 'honeycomb') {
      const info = getBoundaryBoundsAndCenter(boundaryPolygons);
      const rad = (angleDeg * Math.PI) / 180;
      const cosInv = Math.cos(rad), sinInv = Math.sin(rad);
      const span = info.maxR * 1.35;
      const rowStep = spacing * 0.866;
      const segA = spacing * 0.55;
      const allPaths = [];
      let rowIdx = 0;

      for (let y = -span; y <= span; y += rowStep, rowIdx++) {
        const pts = [];
        const parity = rowIdx % 2;
        let stepIdx = 0;
        for (let x = -span; x <= span; x += segA * 1.5, stepIdx++) {
          const yOff = ((stepIdx + parity) % 2 === 0) ? -rowStep * 0.28 : rowStep * 0.28;
          const x0 = x;
          const x1 = x + segA * 0.85;
          const pA = {
            x: info.cx + x0 * cosInv - (y + yOff) * sinInv,
            y: info.cy + x0 * sinInv + (y + yOff) * cosInv
          };
          const pB = {
            x: info.cx + x1 * cosInv - (y + yOff) * sinInv,
            y: info.cy + x1 * sinInv + (y + yOff) * cosInv
          };
          pts.push(pA, pB);
        }
        const clipped = clipPolylineToBoundary(pts, boundaryPolygons, minSegLen);
        for (const cp of clipped) allPaths.push(cp);
      }
      return allPaths;
    }

    // 6. SCANLINE PATTERNS: monotonic, monotonic_lines, rectilinear, aligned_rectilinear, zigzag, lines
    const rad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(-rad), sinA = Math.sin(-rad);
    const cosInv = Math.cos(rad), sinInv = Math.sin(rad);

    let minY = Infinity, maxY = -Infinity;
    let sumX = 0, sumY = 0, ptCount = 0;
    const rotPolys = boundaryPolygons.map(poly =>
      poly.map(pt => {
        sumX += pt.x;
        sumY += pt.y;
        ptCount++;
        const rx = pt.x * cosA - pt.y * sinA;
        const ry = pt.x * sinA + pt.y * cosA;
        if (ry < minY) minY = ry;
        if (ry > maxY) maxY = ry;
        return { x: rx, y: ry };
      })
    );

    const yValues = [];
    if (isSolidFill) {
      // Solid fill: tightly pack scanlines from minY + 0.22*W to maxY - 0.22*W with zero edge gaps
      const edgePad = Math.min(lineWidth * 0.22, (maxY - minY) * 0.2);
      const yStart = minY + edgePad;
      const yEnd = maxY - edgePad;
      if (yEnd >= yStart) {
        const span = yEnd - yStart;
        const count = Math.max(1, Math.ceil(span / spacing));
        const actualStep = count > 0 ? span / count : spacing;
        for (let k = 0; k <= count; k++) {
          yValues.push(yStart + k * actualStep);
        }
      } else {
        yValues.push((minY + maxY) * 0.5);
      }
    } else {
      // Sparse infill: anchor grid lines to fixed world center (150, 150) so layers stack vertically!
      const anchorX = 150;
      const anchorY = 150;
      const anchorRotY = anchorX * sinA + anchorY * cosA + (Number(phaseOffset) || 0);
      const kMin = Math.ceil((minY - anchorRotY) / spacing);
      const kMax = Math.floor((maxY - anchorRotY) / spacing);
      for (let k = kMin; k <= kMax; k++) {
        yValues.push(anchorRotY + k * spacing);
      }
      // If a narrow section falls between sparse grid lines, place a line through its center so every layer has infill support
      if (yValues.length === 0 && (maxY - minY) > lineWidth * 0.5) {
        yValues.push((minY + maxY) * 0.5);
      }
    }

    const scanSegments = [];
    const unidirectional = (pattern === 'monotonic_lines' || pattern === 'lines');

    for (let lineIdx = 0; lineIdx < yValues.length; lineIdx++) {
      const y = yValues[lineIdx];
      const xHits = [];
      for (const poly of rotPolys) {
        const n = poly.length;
        for (let i = 0; i < n; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % n];
          if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
            const t = (y - a.y) / (b.y - a.y);
            xHits.push(a.x + t * (b.x - a.x));
          }
        }
      }
      xHits.sort((a, b) => a - b);

      // Evaluate 1D scanline intervals against boundaryPolygons (Outers minus Holes)
      // and merge contiguous valid sub-intervals so scanlines never cross a hole!
      const validIntervals = [];
      for (let k = 0; k + 1 < xHits.length; k++) {
        const xA = xHits[k];
        const xB = xHits[k + 1];
        if (xB - xA < 1e-3) continue;
        const xMid = 0.5 * (xA + xB);
        const midWorld = {
          x: xMid * cosInv - y * sinInv,
          y: xMid * sinInv + y * cosInv
        };
        if (isPointInsideBoundarySet(midWorld, boundaryPolygons)) {
          if (validIntervals.length > 0 && Math.abs(xA - validIntervals[validIntervals.length - 1].x2) < 1e-2) {
            validIntervals[validIntervals.length - 1].x2 = xB;
          } else {
            validIntervals.push({ x1: xA, x2: xB });
          }
        }
      }

      for (let k = 0; k < validIntervals.length; k++) {
        const x1 = validIntervals[k].x1;
        const x2 = validIntervals[k].x2;
        if (x2 - x1 >= minSegLen) {
          const pStart = {
            x: x1 * cosInv - y * sinInv,
            y: x1 * sinInv + y * cosInv
          };
          const pEnd = {
            x: x2 * cosInv - y * sinInv,
            y: x2 * sinInv + y * cosInv
          };
          if (!unidirectional && (lineIdx % 2 === 1)) {
            scanSegments.push({ p1: pEnd, p2: pStart, row: lineIdx });
          } else {
            scanSegments.push({ p1: pStart, p2: pEnd, row: lineIdx });
          }
        }
      }
    }

    const connectAdjacent = (
      pattern === 'zigzag' ||
      pattern === 'rectilinear' ||
      pattern === 'aligned_rectilinear' ||
      pattern === 'monotonic'
    );

    if (connectAdjacent && scanSegments.length > 1) {
      const connected = [];
      let currentPts = [scanSegments[0].p1, scanSegments[0].p2];
      for (let i = 1; i < scanSegments.length; i++) {
        const prev = currentPts[currentPts.length - 1];
        const seg = scanSegments[i];
        const d = Math.hypot(seg.p1.x - prev.x, seg.p1.y - prev.y);
        const midPt = { x: (prev.x + seg.p1.x) * 0.5, y: (prev.y + seg.p1.y) * 0.5 };
        if (d < spacing * 2.1 && isPointInsideBoundarySet(midPt, boundaryPolygons)) {
          currentPts.push(seg.p1, seg.p2);
        } else {
          connected.push({ points: currentPts, closed: false });
          currentPts = [seg.p1, seg.p2];
        }
      }
      connected.push({ points: currentPts, closed: false });
      return connected;
    }

    return scanSegments.map(s => ({ points: [s.p1, s.p2], closed: false }));
  }

  function appendInfillPathsToMoves(moves, paths, z, width, height, moveType, connectFromPrev) {
    for (let pIdx = 0; pIdx < paths.length; pIdx++) {
      const p = paths[pIdx];
      if (p.closed) {
        appendClosedPathMoves(moves, p.points, z, width, height, moveType);
      } else {
        if (connectFromPrev && pIdx === 0 && moves.length > 0 && p.points.length >= 2) {
          const prevMv = moves[moves.length - 1];
          const firstPt = p.points[0];
          const d = Math.hypot(firstPt.x - prevMv.x2, firstPt.y - prevMv.y2, z - prevMv.z2);
          if (d > 0.05) {
            moves.push({
              type: moveType,
              x1: prevMv.x2, y1: prevMv.y2, z1: prevMv.z2,
              x2: firstPt.x, y2: firstPt.y, z2: z,
              width,
              height,
              extrude: true,
              continuousJoin: true
            });
          }
        }
        const startMoveIdx = moves.length;
        appendOpenPathMoves(moves, p.points, z, width, height, moveType);
        if (p.continuousSpiral) {
          for (let k = startMoveIdx; k < moves.length; k++) {
            moves[k].continuousJoin = true;
          }
        }
      }
    }
  }

  function resolveSolidPatternForLayer(layerIdx, isTopShell, isBottomShell, numLayers, settings) {
    const topSurfacePattern = settings.topSurfacePattern || 'monotonic';
    const bottomSurfacePattern = settings.bottomSurfacePattern || 'monotonic';
    const internalSolidPattern = settings.internalSolidInfillPattern || 'match_surface';

    let activeSolidPattern = internalSolidPattern;
    if (isTopShell && (layerIdx === numLayers - 1 || internalSolidPattern === 'match_surface')) {
      activeSolidPattern = topSurfacePattern;
    } else if (isBottomShell && (layerIdx === 0 || internalSolidPattern === 'match_surface')) {
      activeSolidPattern = bottomSurfacePattern;
    } else if (isTopShell) {
      activeSolidPattern = (internalSolidPattern === 'auto') ? topSurfacePattern : internalSolidPattern;
    } else if (isBottomShell) {
      activeSolidPattern = (internalSolidPattern === 'auto') ? bottomSurfacePattern : internalSolidPattern;
    }
    return activeSolidPattern;
  }

  /**
   * Generates Solid Shell (Top / Bottom / Internal Solid) moves inside `innermostWallPolys`
   * with proper OrcaSlicer wall-infill overlap so zero gaps remain between walls and shells.
   */
  function appendSolidShellForLayer(moves, innermostWallPolys, lastWallWidth, infillLineWidth, z, h, layerIdx, isTopShell, isBottomShell, numLayers, settings, options) {
    if (!innermostWallPolys || innermostWallPolys.length === 0) return;

    const activeSolidPattern = resolveSolidPatternForLayer(layerIdx, isTopShell, isBottomShell, numLayers, settings);
    const isConcentricType = (activeSolidPattern === 'concentric' || activeSolidPattern === 'concentric_spiral');
    const useContinuousSpiral = (activeSolidPattern === 'concentric_spiral') ||
      (activeSolidPattern === 'concentric' && ((settings && settings.printMode === 'spiral_vase') || Boolean(options && options.continuousSpiral)));

    const wallOuters = innermostWallPolys.filter(p => !p.isHole);
    const wallHoles = innermostWallPolys.filter(p => p.isHole);

    // ADAPTIVE THIN-WALL MEDIAL AXIS INFILL FOR CONCENTRIC SOLID SHELLS:
    // When a wall section is bounded by outer perimeter and inner hole perimeter (e.g. 15mm flange with 5mm nozzle),
    // strictly respect the CAD model geometry:
    // If clearance between walls only accommodates 1 infill line (7mm <= D < 15mm with 5mm nozzle):
    // generate EXACTLY 1 infill line along the medial centerline midway between opposing walls!
    // Total lines across wall: 1 outer wall + 1 centerline infill + 1 inner wall = 3 lines = 15mm!
    if (isConcentricType && wallHoles.length > 0 && wallOuters.length > 0) {
      let allThinWallsHandled = true;
      const medialRings = [];
      for (const holePoly of wallHoles) {
        const enclosingOuter = wallOuters.find(o => isHoleStrictlyInsideOuter(holePoly, o));
        if (!enclosingOuter) {
          allThinWallsHandled = false;
          break;
        }
        const medial = computeMedialCenterlineLoop(enclosingOuter, holePoly, infillLineWidth);
        const effClearance = Math.min(medial.maxClearance, (medial.minClearance + medial.maxClearance) * 0.5 * 1.15);
        if (effClearance < 1.4 * infillLineWidth) {
          // Wall beads already meet/overlap (0 infill lines needed)
        } else if (effClearance < 3.0 * infillLineWidth) {
          // Thin wall section where exactly 1 centerline infill pass fits!
          if (medial.cleaned && medial.cleaned.length >= 3) {
            medialRings.push(medial.cleaned);
          }
        } else {
          // Wide solid area requiring multiple concentric rings
          allThinWallsHandled = false;
          break;
        }
      }

      if (allThinWallsHandled) {
        if (medialRings.length > 0) {
          for (const ring of medialRings) {
            const ordered = orderPolygonWithSeam(ring, settings.seamPosition, layerIdx);
            appendClosedPathMoves(moves, ordered, z, infillLineWidth, h, 'solid_infill');
          }
        }
        return;
      }
    }

    // For Concentric rings (which run parallel to the wall), offset by (lastWallWidth + infillLineWidth)*0.42 (16% side overlap).
    // For Open-line patterns, offset by (lastWallWidth + infillLineWidth)*0.36 so both parallel turnaround bridges
    // and protruding 3D rounded nozzle endcaps bond into the inner wall with zero gap and zero exterior bleed!
    const insetDist = isConcentricType
      ? (lastWallWidth + infillLineWidth) * 0.42
      : (lastWallWidth + infillLineWidth) * 0.36;

    const rawSlicePolys = (options && options.rawSlicePolys) ? options.rawSlicePolys : null;
    const totalWallOffset = (options && typeof options.totalWallOffset === 'number') ? options.totalWallOffset : 0;
    const solidBoundary = (rawSlicePolys && totalWallOffset > 0)
      ? offsetPolygonsInward(rawSlicePolys, totalWallOffset + insetDist)
      : offsetPolygonsInward(innermostWallPolys, insetDist);
    if (solidBoundary.length === 0) return;

    const solidAngle = (activeSolidPattern === 'aligned_rectilinear')
      ? 45
      : ((layerIdx % 2 === 0) ? 45 : 135);
    const solidSpacing = infillLineWidth * 0.86; // 14% bead-to-bead overlap for watertight concrete surface

    let anchorPt = (options && options.anchorPt) ? options.anchorPt : null;
    if (!anchorPt && moves.length > 0) {
      const prevMv = moves[moves.length - 1];
      anchorPt = { x: prevMv.x2, y: prevMv.y2 };
    }

    const solidMoves = [];
    if (activeSolidPattern === 'grid') {
      const pathsA = generateInfillSegments(solidBoundary, solidSpacing * 1.35, 45, 'lines', infillLineWidth, 0, true);
      const pathsB = generateInfillSegments(solidBoundary, solidSpacing * 1.35, 135, 'lines', infillLineWidth, 0, true);
      appendInfillPathsToMoves(solidMoves, pathsA, z, infillLineWidth, h, 'solid_infill', false);
      appendInfillPathsToMoves(solidMoves, pathsB, z, infillLineWidth, h, 'solid_infill', false);
    } else {
      const solidPaths = generateInfillSegments(
        solidBoundary,
        solidSpacing,
        solidAngle,
        activeSolidPattern,
        infillLineWidth,
        0,
        true,
        {
          continuousSpiral: useContinuousSpiral,
          anchorPt,
          outward: Boolean(options && options.outward)
        }
      );
      appendInfillPathsToMoves(solidMoves, solidPaths, z, infillLineWidth, h, 'solid_infill', useContinuousSpiral);
    }

    // Protection: Ensure no solid infill move ever lies inside any hole of innermostWallPolys or rawSlicePolys
    const rawHoles = rawSlicePolys ? rawSlicePolys.filter(p => p.isHole) : [];
    const allForbiddenHoles = wallHoles.concat(rawHoles);
    for (let k = 0; k < solidMoves.length; k++) {
      const sm = solidMoves[k];
      if (sm.extrude && allForbiddenHoles.length > 0) {
        const mx = (sm.x1 + sm.x2) * 0.5;
        const my = (sm.y1 + sm.y2) * 0.5;
        let inHole = false;
        for (let hIdx = 0; hIdx < allForbiddenHoles.length; hIdx++) {
          if (pointInPolygonStrict({ x: mx, y: my }, allForbiddenHoles[hIdx]) && !isPointOnPolygonEdge({ x: mx, y: my }, allForbiddenHoles[hIdx], 1e-3)) {
            inHole = true;
            break;
          }
        }
        if (inHole) continue;
      }
      moves.push(sm);
    }
  }

  // =========================================================================
  // 4. MAIN SLICING PIPELINE (3 MODES + G-CODE + MATERIAL CALCULATOR)
  // =========================================================================

  function parsePauseLayers(input) {
    if (!input) return new Set();
    const set = new Set();
    const parts = String(input).split(/[,;\s]+/);
    for (const p of parts) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      const clean = trimmed.replace(/^[lL]/, '');
      if (clean.includes('-')) {
        const segs = clean.split('-');
        if (segs.length === 2) {
          const start = parseInt(segs[0], 10);
          const end = parseInt(segs[1], 10);
          if (!Number.isNaN(start) && !Number.isNaN(end) && start > 0 && end > 0) {
            const min = Math.min(start, end);
            const max = Math.max(start, end);
            for (let k = min; k <= max; k++) set.add(k);
          }
        }
      } else {
        const val = parseInt(clean, 10);
        if (!Number.isNaN(val) && val > 0) {
          set.add(val);
        }
      }
    }
    return set;
  }

  function sliceModel(transformedMesh, settings) {
    const t0 = performance.now();
    const bounds = transformedMesh.bounds;
    const totalHeight = bounds.maxZ - bounds.minZ;

    const lineWidth = Math.max(1.0, Number(settings.lineWidth) || Number(settings.nozzleDiameter) || 5);
    const nozzleDia = lineWidth;
    const layerHeight = Math.max(0.5, Number(settings.layerHeight) || lineWidth * 0.5);
    // In concrete & ceramic 3D printing, layer height and bead width are strictly uniform across all layers
    const firstLayerHeight = Math.max(0.5, Number(settings.firstLayerHeight) || layerHeight);

    // Uniform bead geometry: In 3D concrete/ceramic extrusion, the circular nozzle orifice is fixed.
    // To ensure 100% constant extrusion amount and motor speed, outer wall, inner wall, and infill use the unified lineWidth.
    const outerWallWidth = lineWidth;
    const innerWallWidth = lineWidth;
    const infillLineWidth = lineWidth;

    const printMode = settings.printMode || 'standard';

    // Support Strategy (Manual Sacrificial Block Placement / Layer Pauses)
    const isSupportEnabled = Boolean(settings.enableSupport);
    const pauseLayersSet = parsePauseLayers(settings.supportPauseLayers);

    // Top & Bottom shell layers are supported across all 3 modes (Standard, Single Wall, Spiralize Vase)
    const parsedBottom = parseInt(settings.bottomLayers, 10);
    const bottomLayers = Number.isNaN(parsedBottom) ? 2 : Math.max(0, parsedBottom);

    const parsedTop = parseInt(settings.topLayers, 10);
    const topLayers = Number.isNaN(parsedTop) ? 2 : Math.max(0, parsedTop);

    const layerZs = [];
    if (totalHeight > 0.1) {
      let z = firstLayerHeight;
      if (z > totalHeight) z = totalHeight * 0.5;
      while (z <= totalHeight - 0.05) {
        layerZs.push(z);
        z += layerHeight;
      }
      if (layerZs.length === 0) {
        layerZs.push(Math.min(firstLayerHeight, totalHeight * 0.5));
      }
    }

    const numLayers = layerZs.length;
    const rawSlices = new Array(numLayers);
    for (let i = 0; i < numLayers; i++) {
      const sampleZ = i === 0 ? firstLayerHeight * 0.5 : layerZs[i] - layerHeight * 0.5;
      const clampedSampleZ = Math.min(totalHeight - 0.05, Math.max(0.05, sampleZ));
      rawSlices[i] = sliceMeshAtZ(transformedMesh.vertices, clampedSampleZ);
    }

    const layers = [];

    if (printMode === 'spiral_vase') {
      const spiralBaseLayer = Boolean(settings.vaseBottomLayer);
      let prevPt = null;
      let prevEndZ = 0;
      let prevPtIsFromBottomShell = false;

      for (let i = 0; i < numLayers; i++) {
        const zEnd = layerZs[i];
        const h = i === 0 ? firstLayerHeight : layerHeight;
        const isBottomShell = (bottomLayers > 0) && (i < bottomLayers);
        const isTopShell = (topLayers > 0) && (i >= numLayers - topLayers);

        const outerPolys = rawSlices[i].filter(p => !p.isHole);
        if (outerPolys.length === 0) continue;

        outerPolys.sort((a, b) => Math.abs(polygonSignedArea(b)) - Math.abs(polygonSignedArea(a)));
        const offsetOuter = offsetPolygonInward(outerPolys[0], outerWallWidth * 0.5) || outerPolys[0];

        if (isBottomShell || isTopShell) {
          const moves = [];
          const activePat = resolveSolidPatternForLayer(i, isTopShell, isBottomShell, numLayers, settings);
          const isContConcentric = (activePat === 'concentric' || activePat === 'concentric_spiral');

          if (isContConcentric) {
            const anchorCorner = prevPt || offsetOuter[0];
            const alignedOuter = alignPolygonStartToPoint(offsetOuter, anchorCorner);
            const cornerPt = alignedOuter[0];

            // Determine spiral direction so Bottom Shell ends on the outer wall (ready for spiral_wall)
            // and Top Shell starts from the outer wall (directly continuing from spiral_wall)
            let goOutward = false;
            if (isBottomShell && !isTopShell) {
              goOutward = ((bottomLayers - 1 - i) % 2 === 0);
            } else if (isTopShell) {
              const topIdx = i - (numLayers - topLayers);
              goOutward = (topIdx % 2 === 1);
            }

            if (goOutward) {
              // 1. Outward continuous concentric spiral: Center -> ... -> R_0
              const tempMoves = [];
              appendSolidShellForLayer(
                tempMoves,
                [alignedOuter],
                outerWallWidth,
                infillLineWidth,
                zEnd,
                h,
                i,
                isTopShell,
                isBottomShell,
                numLayers,
                settings,
                { continuousSpiral: true, outward: true, anchorPt: cornerPt }
              );

              if (tempMoves.length > 0 && prevPt && i > 0) {
                const firstM = tempMoves[0];
                const dPrev = Math.hypot(firstM.x1 - prevPt.x, firstM.y1 - prevPt.y, zEnd - prevEndZ);
                if (dPrev > 0.05) {
                  moves.push({
                    type: 'solid_infill',
                    x1: prevPt.x, y1: prevPt.y, z1: prevEndZ,
                    x2: firstM.x1, y2: firstM.y1, z2: zEnd,
                    width: infillLineWidth,
                    height: h,
                    extrude: true,
                    continuousJoin: true
                  });
                }
              }
              for (const tm of tempMoves) moves.push(tm);

              // 2. Connect directly from R_0 onto alignedOuter[0] and trace outer perimeter as 'spiral_wall'
              if (moves.length > 0) {
                const lastInfill = moves[moves.length - 1];
                if (Math.hypot(cornerPt.x - lastInfill.x2, cornerPt.y - lastInfill.y2) > 0.05) {
                  moves.push({
                    type: 'spiral_wall',
                    x1: lastInfill.x2, y1: lastInfill.y2, z1: zEnd,
                    x2: cornerPt.x, y2: cornerPt.y, z2: zEnd,
                    width: outerWallWidth,
                    height: h,
                    extrude: true,
                    continuousJoin: true
                  });
                }
              }
              const denseOuter = subdividePolygon(alignedOuter, Math.max(2.0, nozzleDia * 0.5));
              for (let k = 0; k < denseOuter.length; k++) {
                const pA = denseOuter[k];
                const pB = denseOuter[(k + 1) % denseOuter.length];
                moves.push({
                  type: 'spiral_wall',
                  x1: pA.x, y1: pA.y, z1: zEnd,
                  x2: pB.x, y2: pB.y, z2: zEnd,
                  width: outerWallWidth,
                  height: h,
                  extrude: true,
                  continuousJoin: true,
                  continuousLayerJoin: (k === denseOuter.length - 1)
                });
              }
              prevPt = { x: cornerPt.x, y: cornerPt.y };
              prevEndZ = zEnd;
              prevPtIsFromBottomShell = false;
            } else {
              // 1. Outer perimeter first (climbing from prevEndZ to zEnd if seamlessly continuing from spiral_wall)
              const denseOuter = subdividePolygon(alignedOuter, Math.max(2.0, nozzleDia * 0.5));
              const zStartOuter = (i > 0 && prevEndZ > 0) ? prevEndZ : zEnd;
              let totalPerim = 0;
              const segLens = [];
              for (let k = 0; k < denseOuter.length; k++) {
                const pA = denseOuter[k];
                const pB = denseOuter[(k + 1) % denseOuter.length];
                const l = Math.hypot(pB.x - pA.x, pB.y - pA.y);
                segLens.push(l);
                totalPerim += l;
              }
              if (prevPt && i > 0 && Math.hypot(denseOuter[0].x - prevPt.x, denseOuter[0].y - prevPt.y) > 0.05) {
                moves.push({
                  type: 'spiral_wall',
                  x1: prevPt.x, y1: prevPt.y, z1: zStartOuter,
                  x2: denseOuter[0].x, y2: denseOuter[0].y, z2: zStartOuter,
                  width: outerWallWidth,
                  height: h,
                  extrude: true,
                  continuousJoin: true
                });
              }
              let accLen = 0;
              for (let k = 0; k < denseOuter.length; k++) {
                const pA = denseOuter[k];
                const pB = denseOuter[(k + 1) % denseOuter.length];
                const zA = zStartOuter + (accLen / (totalPerim || 1)) * (zEnd - zStartOuter);
                accLen += segLens[k];
                const zB = zStartOuter + (accLen / (totalPerim || 1)) * (zEnd - zStartOuter);
                moves.push({
                  type: 'spiral_wall',
                  x1: pA.x, y1: pA.y, z1: zA,
                  x2: pB.x, y2: pB.y, z2: zB,
                  width: outerWallWidth,
                  height: h,
                  extrude: true,
                  continuousJoin: true
                });
              }

              // 2. Inward continuous concentric spiral: R_0 -> ... -> Center (directly connected from cornerPt!)
              appendSolidShellForLayer(
                moves,
                [alignedOuter],
                outerWallWidth,
                infillLineWidth,
                zEnd,
                h,
                i,
                isTopShell,
                isBottomShell,
                numLayers,
                settings,
                { continuousSpiral: true, outward: false, anchorPt: cornerPt }
              );
              if (moves.length > 0) {
                const lastMv = moves[moves.length - 1];
                lastMv.continuousLayerJoin = true;
                prevPt = { x: lastMv.x2, y: lastMv.y2 };
                prevEndZ = zEnd;
                prevPtIsFromBottomShell = false;
              }
            }
          } else {
            // Non-concentric pattern on Top/Bottom shell in Spiralize mode
            const ordered = orderPolygonWithSeam(offsetOuter, settings.seamPosition, i);
            appendClosedPathMoves(moves, ordered, zEnd, outerWallWidth, h, 'outer_wall');
            appendSolidShellForLayer(
              moves,
              [offsetOuter],
              outerWallWidth,
              infillLineWidth,
              zEnd,
              h,
              i,
              isTopShell,
              isBottomShell,
              numLayers,
              settings
            );
            prevPt = offsetOuter[0] || ordered[0] || null;
            prevEndZ = zEnd;
            prevPtIsFromBottomShell = true;
          }

          layers.push({
            index: i,
            z: zEnd,
            height: h,
            shellRole: isTopShell ? 'top_shell' : 'bottom_shell',
            isPauseLayer: isSupportEnabled && pauseLayersSet.has(i + 1),
            moves
          });
          continue;
        }

        const zStart = i === 0 ? (spiralBaseLayer ? zEnd : firstLayerHeight * 0.25) : layerZs[i - 1];
        const denseRing = subdividePolygon(offsetOuter, Math.max(2.0, nozzleDia * 0.5));
        if (denseRing.length < 3) continue;

        if (prevPt) {
          let bestIdx = 0;
          let bestDist = Infinity;
          for (let k = 0; k < denseRing.length; k++) {
            const d = Math.hypot(denseRing[k].x - prevPt.x, denseRing[k].y - prevPt.y);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = k;
            }
          }
          if (bestIdx > 0) {
            const rotated = denseRing.slice(bestIdx).concat(denseRing.slice(0, bestIdx));
            denseRing.length = 0;
            denseRing.push(...rotated);
          }
        }

        let totalPerim = 0;
        const segLens = [];
        for (let k = 0; k < denseRing.length; k++) {
          const pA = denseRing[k];
          const pB = denseRing[(k + 1) % denseRing.length];
          const l = Math.hypot(pB.x - pA.x, pB.y - pA.y);
          segLens.push(l);
          totalPerim += l;
        }

        const spiralMoves = [];
        let accLen = 0;

        const startPt = denseRing[0];
        const isContinuousSpiralJoin = Boolean(prevPt && !prevPtIsFromBottomShell);
        spiralMoves.push({
          type: isContinuousSpiralJoin ? 'spiral_wall' : 'travel',
          x1: prevPt ? prevPt.x : startPt.x,
          y1: prevPt ? prevPt.y : startPt.y,
          z1: zStart,
          x2: startPt.x,
          y2: startPt.y,
          z2: zStart,
          width: outerWallWidth,
          height: h,
          extrude: isContinuousSpiralJoin,
          continuousJoin: isContinuousSpiralJoin
        });
        prevPtIsFromBottomShell = false;

        for (let k = 0; k < denseRing.length; k++) {
          const pA = denseRing[k];
          const pB = denseRing[(k + 1) % denseRing.length];
          const zA = zStart + (accLen / (totalPerim || 1)) * (zEnd - zStart);
          accLen += segLens[k];
          const zB = zStart + (accLen / (totalPerim || 1)) * (zEnd - zStart);

          spiralMoves.push({
            type: 'spiral_wall',
            x1: pA.x,
            y1: pA.y,
            z1: zA,
            x2: pB.x,
            y2: pB.y,
            z2: zB,
            width: outerWallWidth,
            height: h,
            extrude: true,
            continuousJoin: true,
            continuousLayerJoin: (k === denseRing.length - 1)
          });
        }

        prevPt = denseRing[0];
        prevEndZ = zEnd;
        layers.push({
          index: i,
          z: zEnd,
          height: h,
          shellRole: 'spiral',
          isPauseLayer: isSupportEnabled && pauseLayersSet.has(i + 1),
          moves: spiralMoves
        });
      }
    } else if (printMode === 'single_wall') {
      const includeHoles = Boolean(settings.singleWallIncludeInnerHoles);
      for (let i = 0; i < numLayers; i++) {
        const z = layerZs[i];
        const h = i === 0 ? firstLayerHeight : layerHeight;
        const isBottomShell = (bottomLayers > 0) && (i < bottomLayers);
        const isTopShell = (topLayers > 0) && (i >= numLayers - topLayers);

        const sourcePolys = includeHoles ? rawSlices[i] : rawSlices[i].filter(p => !p.isHole);
        const wallPolys = offsetOuterWallPolygons(sourcePolys, outerWallWidth * 0.5);
        const moves = [];

        for (const poly of wallPolys) {
          const ordered = orderPolygonWithSeam(poly, settings.seamPosition, i);
          appendClosedPathMoves(moves, ordered, z, outerWallWidth, h, 'outer_wall');
        }

        if (isBottomShell || isTopShell) {
          appendSolidShellForLayer(
            moves,
            wallPolys,
            outerWallWidth,
            infillLineWidth,
            z,
            h,
            i,
            isTopShell,
            isBottomShell,
            numLayers,
            settings
          );
        }

        layers.push({
          index: i,
          z,
          height: h,
          shellRole: isTopShell ? 'top_shell' : (isBottomShell ? 'bottom_shell' : 'sparse'),
          isPauseLayer: isSupportEnabled && pauseLayersSet.has(i + 1),
          moves
        });
      }
    } else {
      // MODE 1: STANDARD SLICER MODE (WALLS + TOP/BOTTOM SHELLS + SPARSE INFILL)
      const parsedWalls = parseInt(settings.wallCount, 10);
      const wallCount = Number.isNaN(parsedWalls) ? 2 : Math.max(1, parsedWalls);

      const parsedDensity = Number(settings.infillDensity);
      const infillDensity = Number.isNaN(parsedDensity) ? 15 : Math.max(0, Math.min(100, parsedDensity));
      const infillPattern = settings.infillPattern || 'grid';

      for (let i = 0; i < numLayers; i++) {
        const z = layerZs[i];
        const h = i === 0 ? firstLayerHeight : layerHeight;
        const moves = [];

        // 1. Outer Wall
        const outerWallPolys = offsetOuterWallPolygons(rawSlices[i], outerWallWidth * 0.5);
        for (const poly of outerWallPolys) {
          const ordered = orderPolygonWithSeam(poly, settings.seamPosition, i);
          appendClosedPathMoves(moves, ordered, z, outerWallWidth, h, 'outer_wall');
        }

        // 2. Inner Walls (computed with cumulative offset from rawSlices[i] so thin-wall holes are respected)
        let currentPolys = outerWallPolys;
        let cumWallDist = outerWallWidth * 0.5;
        for (let w = 1; w < wallCount; w++) {
          const stepDist = w === 1 ? (outerWallWidth + innerWallWidth) * 0.5 : innerWallWidth;
          cumWallDist += stepDist;
          currentPolys = offsetPolygonsInward(rawSlices[i], cumWallDist);
          for (const poly of currentPolys) {
            appendClosedPathMoves(moves, poly, z, innerWallWidth, h, 'inner_wall');
          }
        }

        const lastWallWidth = wallCount > 1 ? innerWallWidth : outerWallWidth;

        // 3. Top Shell / Bottom Shell / Sparse Infill
        const isBottomShell = (bottomLayers > 0) && (i < bottomLayers);
        const isTopShell = (topLayers > 0) && (i >= numLayers - topLayers);
        const isSolidLayer = isBottomShell || isTopShell;

        if (isSolidLayer) {
          appendSolidShellForLayer(
            moves,
            currentPolys,
            lastWallWidth,
            infillLineWidth,
            z,
            h,
            i,
            isTopShell,
            isBottomShell,
            numLayers,
            settings,
            { rawSlicePolys: rawSlices[i], totalWallOffset: cumWallDist }
          );
        } else if (infillDensity > 0 && currentPolys.length > 0) {
          const sparseInset = (infillPattern === 'concentric' || infillPattern === 'concentric_spiral')
            ? (lastWallWidth + infillLineWidth) * 0.42
            : (lastWallWidth + infillLineWidth) * 0.36;
          // Offset directly from rawSlices[i] by (cumWallDist + sparseInset) so thin-wall holes are never lost
          const infillBoundary = offsetPolygonsInward(rawSlices[i], cumWallDist + sparseInset);

          if (infillBoundary.length > 0) {
            // Scale sparse pitch smoothly for thick concrete nozzles so 10-25% density forms a multi-cell lattice
            const factor = Math.pow(100 / infillDensity, 0.76);
            const baseSpacing = infillLineWidth * factor;
            const sparseMoves = [];

            if (infillPattern === 'grid') {
              const gridSpacing = baseSpacing * 1.15;
              const pathsA = generateInfillSegments(infillBoundary, gridSpacing, 45, 'lines', infillLineWidth, 0, false);
              const pathsB = generateInfillSegments(infillBoundary, gridSpacing, 135, 'lines', infillLineWidth, 0, false);
              appendInfillPathsToMoves(sparseMoves, pathsA, z, infillLineWidth, h, 'sparse_infill');
              appendInfillPathsToMoves(sparseMoves, pathsB, z, infillLineWidth, h, 'sparse_infill');
            } else if (infillPattern === 'triangles') {
              const triSpacing = baseSpacing * 1.38;
              for (const ang of [0, 60, 120]) {
                const paths = generateInfillSegments(infillBoundary, triSpacing, ang, 'lines', infillLineWidth, 0, false);
                appendInfillPathsToMoves(sparseMoves, paths, z, infillLineWidth, h, 'sparse_infill');
              }
            } else if (infillPattern === 'tri_hexagon') {
              const thSpacing = baseSpacing * 1.38;
              const p0 = generateInfillSegments(infillBoundary, thSpacing, 0, 'lines', infillLineWidth, thSpacing * 0.25, false);
              const p60 = generateInfillSegments(infillBoundary, thSpacing, 60, 'lines', infillLineWidth, thSpacing * 0.25, false);
              const p120 = generateInfillSegments(infillBoundary, thSpacing, 120, 'lines', infillLineWidth, thSpacing * 0.75, false);
              appendInfillPathsToMoves(sparseMoves, p0, z, infillLineWidth, h, 'sparse_infill');
              appendInfillPathsToMoves(sparseMoves, p60, z, infillLineWidth, h, 'sparse_infill');
              appendInfillPathsToMoves(sparseMoves, p120, z, infillLineWidth, h, 'sparse_infill');
            } else {
              const angle = (infillPattern === 'aligned_rectilinear')
                ? 45
                : ((i % 2 === 0) ? 45 : 135);
              const paths = generateInfillSegments(infillBoundary, baseSpacing, angle, infillPattern, infillLineWidth, 0, false);
              appendInfillPathsToMoves(sparseMoves, paths, z, infillLineWidth, h, 'sparse_infill');
            }

            // Protection: Ensure no sparse infill move ever crosses any hole of rawSlices[i] or infillBoundary
            const forbiddenHoles = rawSlices[i].filter(p => p.isHole).concat(infillBoundary.filter(p => p.isHole));
            for (let k = 0; k < sparseMoves.length; k++) {
              const sm = sparseMoves[k];
              if (sm.extrude && forbiddenHoles.length > 0) {
                const mx = (sm.x1 + sm.x2) * 0.5;
                const my = (sm.y1 + sm.y2) * 0.5;
                let inHole = false;
                for (let hIdx = 0; hIdx < forbiddenHoles.length; hIdx++) {
                  if (pointInPolygonStrict({ x: mx, y: my }, forbiddenHoles[hIdx]) && !isPointOnPolygonEdge({ x: mx, y: my }, forbiddenHoles[hIdx], 1e-3)) {
                    inHole = true;
                    break;
                  }
                }
                if (inHole) continue;
              }
              moves.push(sm);
            }
          }
        }

        layers.push({
          index: i,
          z,
          height: h,
          shellRole: isTopShell ? 'top_shell' : (isBottomShell ? 'bottom_shell' : 'sparse'),
          isPauseLayer: isSupportEnabled && pauseLayersSet.has(i + 1),
          moves
        });
      }
    }

    const result = compileToolpathAndMetrics(layers, settings, performance.now() - t0);
    return result;
  }

  function subdividePolygon(poly, maxSegLen) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      out.push(a);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist > maxSegLen) {
        const steps = Math.ceil(dist / maxSegLen);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
        }
      }
    }
    return out;
  }

  function orderPolygonWithSeam(poly, seamMode, layerIndex) {
    if (!poly || poly.length < 3) return poly || [];
    const n = poly.length;

    if (seamMode === 'random') {
      const idx = (layerIndex * 17) % n;
      return poly.slice(idx).concat(poly.slice(0, idx));
    }

    if (seamMode === 'sharpest') {
      let bestIdx = 0;
      let minDot = 2;
      for (let i = 0; i < n; i++) {
        const p0 = poly[(i - 1 + n) % n];
        const p1 = poly[i];
        const p2 = poly[(i + 1) % n];
        const v1x = p1.x - p0.x, v1y = p1.y - p0.y;
        const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
        const l1 = Math.hypot(v1x, v1y) || 1;
        const l2 = Math.hypot(v2x, v2y) || 1;
        const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
        if (dot < minDot) {
          minDot = dot;
          bestIdx = i;
        }
      }
      return poly.slice(bestIdx).concat(poly.slice(0, bestIdx));
    }

    // For 'aligned' (front-left) or 'aligned_back' (rear), shoot a ray from polygon centroid
    // in the target seam direction to create a clean, vertically aligned Z-seam across layers.
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      cx += poly[i].x;
      cy += poly[i].y;
    }
    cx /= n;
    cy /= n;

    // Target ray direction: front-left (-0.42, -0.91) for 'aligned', rear (0.0, 1.0) for 'aligned_back'
    const dirX = seamMode === 'aligned_back' ? 0.0 : -0.42;
    const dirY = seamMode === 'aligned_back' ? 1.0 : -0.9075;

    let bestHit = null;
    let bestRayT = -Infinity;
    let bestEdgeIdx = -1;

    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      // Ray: P = C + t * dir (t > 0), Segment: Q = A + u * E (0 <= u <= 1)
      const denom = dirX * ey - dirY * ex;
      if (Math.abs(denom) < 1e-8) continue;
      const acx = a.x - cx;
      const acy = a.y - cy;
      const t = (acx * ey - acy * ex) / denom;
      const u = (acx * dirY - acy * dirX) / denom;
      if (t > 0 && u >= -1e-5 && u <= 1 + 1e-5) {
        if (t > bestRayT) {
          bestRayT = t;
          bestEdgeIdx = i;
          const uClamped = Math.max(0, Math.min(1, u));
          bestHit = {
            x: a.x + uClamped * ex,
            y: a.y + uClamped * ey,
            u: uClamped
          };
        }
      }
    }

    if (bestHit && bestEdgeIdx !== -1) {
      const a = poly[bestEdgeIdx];
      const b = poly[(bestEdgeIdx + 1) % n];
      if (Math.hypot(bestHit.x - a.x, bestHit.y - a.y) < 0.25) {
        return poly.slice(bestEdgeIdx).concat(poly.slice(0, bestEdgeIdx));
      }
      if (Math.hypot(bestHit.x - b.x, bestHit.y - b.y) < 0.25) {
        const nextIdx = (bestEdgeIdx + 1) % n;
        return poly.slice(nextIdx).concat(poly.slice(0, nextIdx));
      }
      const seamPt = { x: bestHit.x, y: bestHit.y };
      const reordered = [seamPt];
      for (let k = 1; k <= n; k++) {
        reordered.push(poly[(bestEdgeIdx + k) % n]);
      }
      return reordered;
    }

    // Fallback to vertex score
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const score = seamMode === 'aligned_back'
        ? (poly[i].y * 10 - poly[i].x)
        : (-poly[i].y * 10 - poly[i].x * 2);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return poly.slice(bestIdx).concat(poly.slice(0, bestIdx));
  }

  function appendClosedPathMoves(moves, poly, z, width, height, type) {
    if (!poly || poly.length < 2) return;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      moves.push({
        type,
        x1: a.x, y1: a.y, z1: z,
        x2: b.x, y2: b.y, z2: z,
        width,
        height,
        extrude: true,
        isSeamStart: (i === 0 && type === 'outer_wall'),
        isSeamEnd: (i === poly.length - 1 && type === 'outer_wall')
      });
    }
  }

  function appendOpenPathMoves(moves, pts, z, width, height, type) {
    if (!pts || pts.length < 2) return;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      moves.push({
        type,
        x1: a.x, y1: a.y, z1: z,
        x2: b.x, y2: b.y, z2: z,
        width,
        height,
        extrude: true
      });
    }
  }

  function calcBeadAreaMm2(width, height, crossSectionModel) {
    if (crossSectionModel === 'rectangular' || width <= height) {
      return width * height;
    }
    return (width - height) * height + Math.PI * Math.pow(height * 0.5, 2);
  }

  function compileToolpathAndMetrics(rawLayers, settings, sliceDurationMs) {
    const flowRatio = Number(settings.flowRatio) || 1.0;
    const crossSectionModel = settings.crossSectionModel || 'capsule';

    // In concrete and ceramic 3D printing, paste extrusion physics requires that all extrusion moves
    // (outer wall, inner wall, infill, shells, and first layer) run at the EXACT SAME uniform print speed.
    // This maintains constant auger screw RPM, steady pressure in the delivery hose, and uniform bead output.
    const speedPrint = Math.max(1, Number(settings.printSpeed || settings.outerWallSpeed) || 25);
    const speedTravel = Math.max(5, Number(settings.travelSpeed) || 80);

    const retractEnabled = Boolean(settings.retractEnabled) && settings.printMode !== 'spiral_vase';
    const retractDist = Math.max(0, Number(settings.retractDistance) || 1.5);
    const retractSpeed = Math.max(1, Number(settings.retractSpeed) || 15);

    const eAxisMode = settings.eAxisMode || 'filament';
    const equivFilamentDia = Math.max(0.5, Number(settings.equivFilamentDia) || 1.75);
    const equivFilamentArea = Math.PI * Math.pow(equivFilamentDia * 0.5, 2);
    const augerMmPerMl = Math.max(0.01, Number(settings.augerMmPerMl) || 10.0);

    let totalExtrudedVolumeMm3 = 0;
    let totalExtrudedLengthMm = 0;
    let totalTravelLengthMm = 0;
    let totalPrintTimeSec = 0;
    let totalE = 0;

    let curX = 0, curY = 0, curZ = 0;
    let cumExtrudedVolumeMl = 0;
    const compiledLayers = [];

    for (let l = 0; l < rawLayers.length; l++) {
      const layer = rawLayers[l];
      const layerMoves = [];
      let layerExtrudedVolumeMm3 = 0;

      for (let m = 0; m < layer.moves.length; m++) {
        const mv = layer.moves[m];
        const distToStart = Math.hypot(mv.x1 - curX, mv.y1 - curY, mv.z1 - curZ);

        if (distToStart > 0.15) {
          if (retractEnabled && totalExtrudedLengthMm > 0 && distToStart > (Number(settings.lineWidth) || Number(settings.nozzleDiameter) || 5) * 1.2) {
            totalPrintTimeSec += (retractDist / retractSpeed) * 2;
          }
          const travelTime = distToStart / speedTravel + 0.03;
          totalPrintTimeSec += travelTime;
          totalTravelLengthMm += distToStart;

          layerMoves.push({
            type: 'travel',
            x1: curX, y1: curY, z1: curZ,
            x2: mv.x1, y2: mv.y1, z2: mv.z1,
            width: 0.6,
            height: 0.6,
            extrude: false,
            speed: speedTravel,
            dE: 0,
            volumeMm3: 0
          });
        }

        const segLen = Math.hypot(mv.x2 - mv.x1, mv.y2 - mv.y1, mv.z2 - mv.z1);
        if (segLen < 1e-4) continue;

        // All extrusion moves move at speedPrint; only travel moves at speedTravel
        const speed = mv.extrude ? speedPrint : speedTravel;

        let segVolumeMm3 = 0;
        let dE = 0;

        if (mv.extrude) {
          // In concrete/ceramic printing, bead area is strictly constant per unit distance
          const w = mv.width || Number(settings.lineWidth) || Number(settings.nozzleDiameter) || 5.0;
          const h = mv.height || Number(settings.layerHeight) || 2.5;
          const areaMm2 = calcBeadAreaMm2(w, h, crossSectionModel);
          segVolumeMm3 = areaMm2 * segLen * flowRatio;
          totalExtrudedVolumeMm3 += segVolumeMm3;
          layerExtrudedVolumeMm3 += segVolumeMm3;
          totalExtrudedLengthMm += segLen;

          if (eAxisMode === 'volumetric') {
            dE = segVolumeMm3;
          } else if (eAxisMode === 'mm_per_ml') {
            dE = (segVolumeMm3 / 1000.0) * augerMmPerMl;
          } else {
            dE = segVolumeMm3 / equivFilamentArea;
          }
          totalE += dE;
        }

        const segTime = segLen / speed + 0.008;
        totalPrintTimeSec += segTime;

        layerMoves.push({
          type: mv.type,
          x1: mv.x1, y1: mv.y1, z1: mv.z1,
          x2: mv.x2, y2: mv.y2, z2: mv.z2,
          width: mv.width,
          height: mv.height,
          extrude: mv.extrude,
          isSeamStart: Boolean(mv.isSeamStart),
          isSeamEnd: Boolean(mv.isSeamEnd),
          speed,
          dE,
          volumeMm3: segVolumeMm3
        });

        curX = mv.x2;
        curY = mv.y2;
        curZ = mv.z2;
      }

      const layerVolumeMl = layerExtrudedVolumeMm3 / 1000.0;
      cumExtrudedVolumeMl += layerVolumeMl;

      compiledLayers.push({
        index: layer.index,
        z: layer.z,
        height: layer.height,
        shellRole: layer.shellRole,
        isPauseLayer: Boolean(layer.isPauseLayer),
        isPistonPause: false,
        isSupportPause: Boolean(layer.isPauseLayer && settings.enableSupport),
        pauseReason: layer.isPauseLayer ? (settings.enableSupport ? 'support' : 'manual') : null,
        volumeMl: layerVolumeMl,
        cumulativeVolumeMl: cumExtrudedVolumeMl,
        moves: layerMoves
      });
    }

    const tubeIdMm = Math.max(1, Number(settings.ptfeInnerDia) || 6.0);
    const tubeLengthMm = Math.max(0, Number(settings.ptfeLengthMm) || 800);
    const tubeDeadVolumeMm3 = Math.PI * Math.pow(tubeIdMm * 0.5, 2) * tubeLengthMm;
    const tubeDeadVolumeMl = tubeDeadVolumeMm3 / 1000.0;

    const totalExtrudedVolumeMl = totalExtrudedVolumeMm3 / 1000.0;

    // -------------------------------------------------------------
    // PISTON REFILL AUTO-PAUSE LOGIC
    // When print material volume exceeds 1 piston (500ml), automatically schedule
    // print pauses at 90% (450ml) of each piston cylinder charge to allow safe refill.
    // -------------------------------------------------------------
    const pistonCapMl = Math.max(50, Number(settings.pistonCapacityMl) || 500);
    const pistonThresholdPct = Math.max(10, Math.min(99, Number(settings.pistonPauseThreshold) || 90));
    const pistonThresholdMl = pistonCapMl * (pistonThresholdPct / 100.0); // e.g. 500 * 0.9 = 450 ml
    const pistonAutoPause = settings.pistonAutoPause !== false;

    const pistonPauseLayers = [];
    if (pistonAutoPause && totalExtrudedVolumeMl > pistonCapMl && compiledLayers.length > 0) {
      let cylinderIndex = 1;
      let targetTriggerVol = pistonThresholdMl; // 450ml for 1st cylinder

      while (targetTriggerVol < totalExtrudedVolumeMl) {
        // Find the layer where cumulative volume reaches or exceeds targetTriggerVol
        let pauseLayerIdx = -1;
        for (let i = 0; i < compiledLayers.length; i++) {
          const cl = compiledLayers[i];
          const volBefore = i > 0 ? compiledLayers[i - 1].cumulativeVolumeMl : 0;
          if (volBefore < targetTriggerVol && cl.cumulativeVolumeMl >= targetTriggerVol) {
            pauseLayerIdx = i;
            break;
          }
        }

        if (pauseLayerIdx !== -1) {
          const pLayer = compiledLayers[pauseLayerIdx];
          pLayer.isPauseLayer = true;
          pLayer.isPistonPause = true;
          pLayer.pauseReason = 'piston';
          const volBefore = pauseLayerIdx > 0 ? compiledLayers[pauseLayerIdx - 1].cumulativeVolumeMl : 0;
          pLayer.pistonDetails = {
            cylinderIndex,
            thresholdMl: targetTriggerVol,
            volBeforeMl: volBefore,
            volumeBeforeMl: volBefore,
            cumVolMl: pLayer.cumulativeVolumeMl,
            pistonCapMl,
            thresholdPct: pistonThresholdPct
          };
          pistonPauseLayers.push(pauseLayerIdx + 1);
        }

        cylinderIndex++;
        targetTriggerVol = (cylinderIndex - 1) * pistonThresholdMl + pistonThresholdMl; // 900ml, 1350ml...
      }
    }

    return {
      layers: compiledLayers,
      layerCount: compiledLayers.length,
      totalExtrudedVolumeMm3,
      totalExtrudedVolumeMl,
      totalExtrudedLengthMm,
      totalTravelLengthMm,
      totalPrintTimeSec,
      totalE,
      pistonPauseLayers,
      pistonThresholdMl,
      pistonCapMl,
      tubeDeadVolumeMl,
      sliceDurationMs,
      settingsSnapshot: Object.assign({}, settings)
    };
  }

  // =========================================================================
  // 5. G-CODE GENERATOR FOR CR-10 V3 CONCRETE AUGER EXTRUDER
  // =========================================================================

  function generateGCode(sliceResult, settings, mixMetrics) {
    if (!mixMetrics || typeof mixMetrics.printWeightGrams !== 'number') {
      mixMetrics = calculateMixMetrics(
        sliceResult,
        (mixMetrics && mixMetrics.recipe) ? mixMetrics.recipe : { name: 'Standard Cement Paste', cylinderVolumeMl: 500, ingredients: [] },
        settings
      );
    }
    const lines = [];
    const now = new Date().toISOString();
    lines.push(`; =================================================================`);
    lines.push(`; Generated by CIM Slicer 0.4.0 - Jihu Studio`);
    lines.push(`; Timestamp           : ${now}`);
    lines.push(`; Printer Volume      : ${settings.bedX || 300}x${settings.bedY || 300}x${settings.bedZ || 380} mm`);
    lines.push(`; Extruder System     : Auger Screw + External ${settings.pistonCapacityMl || 500}ml Piston (${settings.ptfeInnerDia || 6}mm Feed Tube)`);
    lines.push(`; Print Mode          : ${settings.printMode.toUpperCase()}`);
    lines.push(`; Layer Height        : ${settings.layerHeight} mm (First: ${settings.firstLayerHeight} mm)`);
    lines.push(`; Line Width          : ${settings.lineWidth} mm`);
    lines.push(`; Print Speed (All)   : ${settings.printSpeed || settings.outerWallSpeed || 25} mm/s (Constant Extrusion Feedrate F${Math.round((settings.printSpeed || settings.outerWallSpeed || 25) * 60)})`);
    lines.push(`; Travel Speed        : ${settings.travelSpeed || 80} mm/s (F${Math.round((settings.travelSpeed || 80) * 60)})`);
    lines.push(`; Estimated Time      : ${formatDuration(sliceResult.totalPrintTimeSec)}`);
    lines.push(`; Material Volume     : ${sliceResult.totalExtrudedVolumeMl.toFixed(2)} ml (cm3)`);
    if (settings && settings.materialType === 'ceramic') {
      lines.push(`; Material Type       : Ceramic (Volume Mode)`);
    } else {
      lines.push(`; Material Weight     : ${mixMetrics.printWeightGrams.toFixed(1)} g (${(mixMetrics.printWeightGrams / 1000).toFixed(3)} kg)`);
      lines.push(`; Active Mix Recipe   : ${mixMetrics.recipeName} (Density: ${mixMetrics.densityGPerMl.toFixed(3)} g/ml)`);
    }
    lines.push(`; ${mixMetrics.refVolumeMl}ml Piston Fills  : ${mixMetrics.pistonCylindersNeeded.toFixed(2)} cylinders`);
    if (sliceResult.pistonPauseLayers && sliceResult.pistonPauseLayers.length > 0) {
      lines.push(`; Piston 90% Pauses   : Before Layer ${sliceResult.pistonPauseLayers.join(', ')} (Safe ${(mixMetrics.refVolumeMl * 0.9).toFixed(0)}ml Refill Trigger)`);
    }
    if (settings.enableSupport) {
      lines.push(`; Support Strategy    : Manual Block Placement (Paused Layers: ${settings.supportPauseLayers || 'None'})`);
    }
    lines.push(`; =================================================================`);
    lines.push('');

    lines.push(`; --- START G-CODE ---`);
    const startLines = (settings.startGcode || '').split(/\r?\n/);
    for (const l of startLines) lines.push(l);
    lines.push('G90 ; Absolute positioning');
    lines.push('M82 ; Absolute extrusion mode');
    lines.push('G92 E0 ; Reset Auger E-axis');
    lines.push('');

    const retractEnabled = Boolean(settings.retractEnabled) && settings.printMode !== 'spiral_vase';
    const retractDist = Math.max(0, Number(settings.retractDistance) || 1.5);
    const retractSpeedF = Math.round((Number(settings.retractSpeed) || 15) * 60);
    const zHop = Math.max(0, Number(settings.zHop) || 0);

    let ePos = 0;
    let isRetracted = false;

    for (let l = 0; l < sliceResult.layers.length; l++) {
      const layer = sliceResult.layers[l];
      lines.push(`; LAYER:${l} Z:${layer.z.toFixed(3)}`);

      let startMoveIdx = 0;
      if (layer.isPauseLayer) {
        const pauseRetract = Math.max(0, Number(settings.supportRetractDist != null ? settings.supportRetractDist : 2.5));
        const parkLift = Math.max(0, Number(settings.supportParkLiftZ != null ? settings.supportParkLiftZ : 10.0));
        const parkX = Number(settings.supportParkX != null ? settings.supportParkX : 10);
        const parkY = Number(settings.supportParkY != null ? settings.supportParkY : 10);
        const pauseCmd = (settings.supportPauseCommand || 'M0').trim();
        const speedTravelF = Math.round((Math.max(5, Number(settings.travelSpeed) || 80)) * 60);

        lines.push('; =================================================================');
        let pausePromptMsg = `Layer ${l + 1} Pause`;
        if (layer.isPistonPause) {
          const pd = layer.pistonDetails || {};
          const volB = pd.volBeforeMl != null ? pd.volBeforeMl : (pd.volumeBeforeMl != null ? pd.volumeBeforeMl : 0);
          const pct = pd.thresholdPct != null ? pd.thresholdPct : 90;
          const cap = pd.pistonCapMl != null ? pd.pistonCapMl : 500;
          const cyl = pd.cylinderIndex != null ? pd.cylinderIndex : 1;
          lines.push(`; ⏸ PAUSE BEFORE LAYER ${l + 1} (Z=${layer.z.toFixed(2)}mm) — 90% PISTON REFILL REQUIRED`);
          lines.push(`; Material Extruded   : ${Number(volB).toFixed(1)} ml (Reached ${pct}% limit of ${cap}ml Piston #${cyl})`);
          lines.push(`; Action Required     : Refill or swap 500ml cement paste cylinder, then resume print`);
          pausePromptMsg = `Refill ${cap}ml Piston #${cyl} (${pct}% capacity reached)`;
        } else if (settings.enableSupport) {
          lines.push(`; ⏸ PAUSE BEFORE LAYER ${l + 1} (Z=${layer.z.toFixed(2)}mm) FOR SUPPORT PLACEMENT`);
          pausePromptMsg = `Insert support block at Layer ${l + 1}`;
        } else {
          lines.push(`; ⏸ PAUSE BEFORE LAYER ${l + 1} (Z=${layer.z.toFixed(2)}mm) — MANUAL PAUSE`);
        }
        lines.push('; =================================================================');

        if (retractEnabled && pauseRetract > 0) {
          ePos -= pauseRetract;
          lines.push(`G1 E${ePos.toFixed(4)} F900 ; Decompress auger before pause`);
        }

        const safeLiftZ = layer.z + parkLift;
        lines.push(`G0 Z${safeLiftZ.toFixed(3)} F1200 ; Safe Z-lift for pause routine`);
        lines.push(`G0 X${parkX.toFixed(3)} Y${parkY.toFixed(3)} F${speedTravelF} ; Park toolhead for pause routine`);
        lines.push(`${pauseCmd} ${pausePromptMsg} ; Pause execution`);

        if (layer.moves && layer.moves.length > 0) {
          const firstMv = layer.moves[0];
          const targetX = firstMv.extrude ? firstMv.x1 : firstMv.x2;
          const targetY = firstMv.extrude ? firstMv.y1 : firstMv.y2;
          const targetZ = layer.z;

          lines.push(`G0 X${targetX.toFixed(3)} Y${targetY.toFixed(3)} F${speedTravelF} ; Return above layer start`);
          lines.push(`G0 Z${targetZ.toFixed(3)} F1200 ; Lower back to print layer height`);
          if (retractEnabled && pauseRetract > 0) {
            ePos += pauseRetract;
            lines.push(`G1 E${ePos.toFixed(4)} F600 ; Re-prime auger screw with cement paste`);
          }
          isRetracted = false;
          if (!firstMv.extrude) {
            startMoveIdx = 1;
          }
        }
      }

      for (let m = startMoveIdx; m < layer.moves.length; m++) {
        const mv = layer.moves[m];
        const feedrate = Math.round(mv.speed * 60);

        if (!mv.extrude) {
          const dist = Math.hypot(mv.x2 - mv.x1, mv.y2 - mv.y1);
          if (retractEnabled && !isRetracted && dist > (Number(settings.lineWidth) || Number(settings.nozzleDiameter) || 5) * 1.2 && ePos > 0) {
            ePos -= retractDist;
            lines.push(`G1 E${ePos.toFixed(4)} F${retractSpeedF} ; Auger decompression retract`);
            isRetracted = true;
            if (zHop > 0) {
              lines.push(`G0 Z${(mv.z1 + zHop).toFixed(3)} F1200 ; Z-hop lift`);
            }
          }
          lines.push(`G0 X${mv.x2.toFixed(3)} Y${mv.y2.toFixed(3)} Z${mv.z2.toFixed(3)} F${feedrate}`);
        } else {
          if (isRetracted) {
            if (zHop > 0) {
              lines.push(`G0 Z${mv.z1.toFixed(3)} F1200 ; Z-hop restore`);
            }
            ePos += retractDist;
            lines.push(`G1 E${ePos.toFixed(4)} F${retractSpeedF} ; Auger prime`);
            isRetracted = false;
          }
          ePos += mv.dE;
          if (settings.printMode === 'spiral_vase') {
            lines.push(`G1 X${mv.x2.toFixed(3)} Y${mv.y2.toFixed(3)} Z${mv.z2.toFixed(3)} E${ePos.toFixed(4)} F${feedrate}`);
          } else {
            lines.push(`G1 X${mv.x2.toFixed(3)} Y${mv.y2.toFixed(3)} E${ePos.toFixed(4)} F${feedrate}`);
          }
        }
      }

      if (settings.printMode !== 'spiral_vase' && ePos > 5000) {
        lines.push('G92 E0');
        ePos = 0;
      }
    }

    lines.push('');
    lines.push('; --- END G-CODE ---');
    const endLines = (settings.endGcode || '').split(/\r?\n/);
    for (const l of endLines) lines.push(l);

    return lines.join('\n');
  }

  // =========================================================================
  // 6. CONCRETE MIX RECIPE & ABSOLUTE VOLUME/WEIGHT CALCULATOR
  // =========================================================================

  /**
   * Returns true physical Specific Gravity (density in g/ml = g/cm³) for concrete/paste components.
   * Used by the Absolute Volume Method (절대용적배합법): V_i (ml) = m_i (g) / rho_i (g/ml).
   */
  function inferIngredientDensityGPerMl(name, explicitDensity) {
    const exp = Number(explicitDensity);
    if (!Number.isNaN(exp) && exp > 0.1 && exp < 20) {
      return exp;
    }
    const n = String(name || '').toLowerCase();
    if (
      n.includes('hpmc') ||
      n.includes('cellulose') ||
      n.includes('보수제') ||
      n.includes('증점제') ||
      n.includes('thickener') ||
      n.includes('retainer') ||
      n.includes('vma')
    ) {
      return 1.26; // Hydroxypropyl Methylcellulose (HPMC)
    }
    if (n.includes('citric') || n.includes('citrique') || n.includes('구연산') || n.includes('retarder') || n.includes('지연제')) {
      return 1.665; // Citric Acid Anhydrous (C6H8O7)
    }
    if (
      n.includes('superplasticizer') ||
      n.includes('superplastifiant') ||
      n.includes('pce') ||
      n.includes('감수제') ||
      n.includes('유동화제') ||
      n.includes('plasticizer') ||
      n.includes('water reducer')
    ) {
      return 1.08; // Polycarboxylate Ether (PCE) Superplasticizer
    }
    if (n.includes('cement') || n.includes('opc') || n.includes('ciment') || n.includes('시멘트')) {
      return 3.15; // Ordinary Portland Cement (CEM I)
    }
    if (n.includes('water') || n.includes('eau') || n.includes('물') || n.includes('배합수')) {
      return 1.00; // Mixing Water
    }
    if (n.includes('silica') || n.includes('fume') || n.includes('실리카')) {
      return 2.20;
    }
    if (n.includes('fly ash') || n.includes('플라이애시') || n.includes('고로슬래그') || n.includes('slag')) {
      return 2.30;
    }
    if (n.includes('sand') || n.includes('aggregate') || n.includes('모래') || n.includes('규사') || n.includes('골재')) {
      return 2.65;
    }
    return 2.00;
  }

  function calculateMixMetrics(sliceResult, recipe, settings) {
    const safeRecipe = recipe || {};
    const isCeramic = Boolean(settings && settings.materialType === 'ceramic');
    const refVolumeMl = Math.max(1, isCeramic
      ? (Number(settings && settings.pistonCapacityMl) || Number(safeRecipe.cylinderVolumeMl) || 500)
      : (Number(safeRecipe.cylinderVolumeMl) || Number(settings && settings.pistonCapacityMl) || 500));
    const ingredients = Array.isArray(safeRecipe.ingredients) ? safeRecipe.ingredients : [];

    let rawBatchWeightG = 0;
    let computedBatchVolumeMl = 0;
    let cementG = 0;
    let waterG = 0;
    let citricG = 0;
    let spG = 0;
    let hpmcG = 0;

    const enrichedIngredients = ingredients.map(ing => {
      const wG = Math.max(0, Number(ing.weightGrams) || 0);
      const rho = inferIngredientDensityGPerMl(ing.name, ing.densityGPerMl);
      const vMl = rho > 0 ? wG / rho : 0;

      rawBatchWeightG += wG;
      computedBatchVolumeMl += vMl;

      const n = String(ing.name || '').toLowerCase();
      if (n.includes('hpmc') || n.includes('cellulose') || n.includes('보수제') || n.includes('증점제') || n.includes('thickener') || n.includes('retainer')) {
        hpmcG += wG;
      } else if (n.includes('citric') || n.includes('citrique') || n.includes('구연산') || n.includes('retarder') || n.includes('지연제')) {
        citricG += wG;
      } else if (n.includes('superplasticizer') || n.includes('superplastifiant') || n.includes('pce') || n.includes('감수제') || n.includes('plasticizer')) {
        spG += wG;
      } else if (n.includes('cement') || n.includes('opc') || n.includes('ciment') || n.includes('시멘트')) {
        cementG += wG;
      } else if (n.includes('water') || n.includes('eau') || n.includes('물') || n.includes('배합수')) {
        waterG += wG;
      }

      return {
        name: ing.name,
        unit: ing.unit || 'g',
        weightGrams: wG,
        densityGPerMl: rho,
        volumeMl: vMl
      };
    });

    // True physical Wet Paste Density (g/ml) via Absolute Volume sum: rho_paste = sum(m_i) / sum(m_i / rho_i)
    const densityGPerMl = computedBatchVolumeMl > 1e-6
      ? (rawBatchWeightG / computedBatchVolumeMl)
      : (rawBatchWeightG > 0 ? rawBatchWeightG / refVolumeMl : 2.095);

    const activeBatchVolumeMl = computedBatchVolumeMl > 1e-6 ? computedBatchVolumeMl : refVolumeMl;
    const scaleToRefCylinder = refVolumeMl / activeBatchVolumeMl;
    const batchTotalWeightG = rawBatchWeightG;
    const cylinderNormalizedWeightG = refVolumeMl * densityGPerMl;

    const printVolumeMl = sliceResult ? sliceResult.totalExtrudedVolumeMl : 0;
    const includeTubeDeadVolume = !isCeramic && Boolean(settings && settings.includeTubeInMixCalc);
    const tubeDeadVolumeMl = sliceResult ? sliceResult.tubeDeadVolumeMl : 0;
    const effectiveVolumeMl = printVolumeMl + (includeTubeDeadVolume ? tubeDeadVolumeMl : 0);

    const printWeightGrams = printVolumeMl * densityGPerMl;
    const tubeDeadWeightGrams = tubeDeadVolumeMl * densityGPerMl;
    const effectiveWeightGrams = effectiveVolumeMl * densityGPerMl;

    const pistonCylindersNeeded = printVolumeMl / refVolumeMl;
    const pistonCylindersWithTube = effectiveVolumeMl / refVolumeMl;

    // Scale against the true physical volume of the batch so conservation of mass & volume holds strictly:
    // sum(forPrintGrams_i) === printWeightGrams and sum(forPrintVolumeMl_i) === printVolumeMl
    const scaleFactorPrint = printVolumeMl / activeBatchVolumeMl;
    const scaleFactorWithTube = effectiveVolumeMl / activeBatchVolumeMl;

    const ingredientBreakdown = enrichedIngredients.map(ing => {
      const wRef = ing.weightGrams;
      const vRef = ing.volumeMl;
      const pctWeight = rawBatchWeightG > 0 ? (wRef / rawBatchWeightG) * 100 : 0;
      const pctVolume = computedBatchVolumeMl > 0 ? (vRef / computedBatchVolumeMl) * 100 : 0;
      const bwocPct = cementG > 0 ? (wRef / cementG) * 100 : 0;

      return {
        name: ing.name,
        unit: ing.unit,
        densityGPerMl: ing.densityGPerMl,
        perBatchGrams: wRef,
        perBatchVolumeMl: vRef,
        perCylinderGrams: wRef * scaleToRefCylinder,
        perCylinderVolumeMl: vRef * scaleToRefCylinder,
        pctWeight,
        pctVolume,
        bwocPct,
        forPrintGrams: wRef * scaleFactorPrint,
        forPrintVolumeMl: vRef * scaleFactorPrint,
        forPrintPlusTubeGrams: wRef * scaleFactorWithTube,
        forPrintPlusTubeVolumeMl: vRef * scaleFactorWithTube
      };
    });

    const wcRatio = cementG > 0 ? waterG / cementG : 0;
    const citricBwocPct = cementG > 0 ? (citricG / cementG) * 100 : 0;
    const spBwocPct = cementG > 0 ? (spG / cementG) * 100 : 0;
    const hpmcBwocPct = cementG > 0 ? (hpmcG / cementG) * 100 : 0;

    // Estimate open time (working window) based on Citric Acid dosage (% by weight of cement)
    let openTimeLabel = '30–45 min';
    if (citricBwocPct >= 0.35) {
      openTimeLabel = '120–180 min (2–3 h)';
    } else if (citricBwocPct >= 0.20) {
      openTimeLabel = '90–120 min (1.5–2 h)';
    } else if (citricBwocPct >= 0.12) {
      openTimeLabel = '60–90 min (1–1.5 h)';
    } else if (citricBwocPct >= 0.05) {
      openTimeLabel = '45–60 min';
    }

    return {
      recipeName: safeRecipe.name || 'Custom Cement Mix',
      refVolumeMl,
      computedBatchVolumeMl,
      batchTotalWeightG,
      cylinderNormalizedWeightG,
      densityGPerMl,
      wcRatio,
      citricBwocPct,
      spBwocPct,
      hpmcBwocPct,
      openTimeLabel,
      printVolumeMl,
      tubeDeadVolumeMl,
      tubeDeadWeightGrams,
      effectiveVolumeMl,
      printWeightGrams,
      effectiveWeightGrams,
      pistonCylindersNeeded,
      pistonCylindersWithTube,
      ingredientBreakdown
    };
  }

  function formatDuration(totalSec) {
    if (!totalSec || totalSec <= 0) return '0m 0s';
    const sec = Math.round(totalSec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  }

  // =========================================================================
  // 7. ADAPTIVE OVERHANG DETECTION & HOLLOW SUPPORT MESH GENERATOR (STL EXPORT)
  // =========================================================================

  /**
   * Detects overhang regions and internal unsupported cavities from the transformed 3D mesh
   * and sliced toolpath, and constructs an adaptive, hollow, fast-printing 3D support mesh
   * (sleeve/box-girder architecture with conformal top & bottom plates, side walls, and ribs).
   */
  function detectOverhangsAndGenerateSupport(transformedMesh, settings, sliceResult) {
    const t0 = performance.now();
    if (!transformedMesh || !transformedMesh.vertices || transformedMesh.triangleCount === 0) {
      return {
        hasOverhang: false,
        regionCount: 0,
        mesh: null,
        regions: [],
        pauseLayers: [],
        autoPauseLayers: [],
        savedPercent: 0,
        supportVolumeMl: 0,
        solidVolumeMl: 0,
        solidVolumeMm3: 0,
        hollowVolumeMm3: 0,
        materialSavedPct: 0,
        durationMs: 0
      };
    }

    const bounds = transformedMesh.bounds || computeBounds(transformedMesh.vertices);
    const v = transformedMesh.vertices;
    const n = transformedMesh.normals;
    const triCount = transformedMesh.triangleCount;

    const lineWidth = Number(settings && settings.lineWidth) || Number(settings && settings.nozzleDiameter) || 5;
    const layerHeight = Math.max(0.5, Number(settings && settings.layerHeight) || lineWidth * 0.5);
    const firstLayerHeight = Math.max(0.5, Number(settings && settings.firstLayerHeight) || layerHeight);

    // Overhang angle threshold from vertical (default 30 deg -> sin(30) = 0.50)
    const overhangAngleDeg = Math.max(10, Math.min(75, Number(settings && settings.supportOverhangAngle) || 30));
    const sinThresh = Math.sin((overhangAngleDeg * Math.PI) / 180);

    // Clearances & hollow wall thickness for FDM 3D printed support
    const clearanceXY = Math.max(0.1, Number(settings && settings.supportClearanceXY != null ? settings.supportClearanceXY : 0.8));
    const clearanceZ = Math.max(0.0, Number(settings && settings.supportClearanceZ != null ? settings.supportClearanceZ : 0.4));
    const wallThickness = Math.max(1.6, Number(settings && settings.supportWallThickness != null ? settings.supportWallThickness : 3.5));
    const minSupportHeight = Math.max(layerHeight * 1.5, 4.5);

    // Choose adaptive 2D grid step (~2.2 - 2.5 mm)
    const maxSpanXY = Math.max(bounds.sizeX, bounds.sizeY, 10);
    const step = Math.max(1.8, Math.min(2.5, maxSpanXY / 115));
    const nx = Math.max(2, Math.ceil(bounds.sizeX / step));
    const ny = Math.max(2, Math.ceil(bounds.sizeY / step));

    // Build spatial hash of non-vertical triangles for fast vertical raycasting
    const binSize = 16.0;
    const binsX = Math.max(1, Math.ceil(bounds.sizeX / binSize));
    const binsY = Math.max(1, Math.ceil(bounds.sizeY / binSize));
    const triBins = new Array(binsX * binsY);
    for (let i = 0; i < triBins.length; i++) triBins[i] = [];

    for (let i = 0; i < triCount; i++) {
      const base = i * 9;
      const nz = n[base + 2];
      if (Math.abs(nz) < 1e-3) continue;

      const x0 = v[base], y0 = v[base + 1], z0 = v[base + 2];
      const x1 = v[base + 3], y1 = v[base + 4], z1 = v[base + 5];
      const x2 = v[base + 6], y2 = v[base + 7], z2 = v[base + 8];

      const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2);
      const minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2);
      const minZ = Math.min(z0, z1, z2), maxZ = Math.max(z0, z1, z2);
      const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(denom) < 1e-8) continue;

      const triObj = {
        x0, y0, z0, x1, y1, z1, x2, y2, z2,
        nz, minX, maxX, minY, maxY, minZ, maxZ,
        invDenom: 1.0 / denom
      };

      const bx0 = Math.max(0, Math.floor((minX - bounds.minX) / binSize));
      const bx1 = Math.min(binsX - 1, Math.floor((maxX - bounds.minX) / binSize));
      const by0 = Math.max(0, Math.floor((minY - bounds.minY) / binSize));
      const by1 = Math.min(binsY - 1, Math.floor((maxY - bounds.minY) / binSize));

      for (let bx = bx0; bx <= bx1; bx++) {
        for (let by = by0; by <= by1; by++) {
          triBins[by * binsX + bx].push(triObj);
        }
      }
    }

    // Raycast vertical columns across (ix, iy)
    const cellMap = new Map();
    const intervals = [];

    for (let ix = 0; ix < nx; ix++) {
      const x = bounds.minX + (ix + 0.5) * step;
      const bx = Math.max(0, Math.min(binsX - 1, Math.floor((x - bounds.minX) / binSize)));
      for (let iy = 0; iy < ny; iy++) {
        const y = bounds.minY + (iy + 0.5) * step;
        const by = Math.max(0, Math.min(binsY - 1, Math.floor((y - bounds.minY) / binSize)));
        const candidateTris = triBins[by * binsX + bx];
        if (candidateTris.length === 0) continue;

        const hits = [];
        for (let tIdx = 0; tIdx < candidateTris.length; tIdx++) {
          const t = candidateTris[tIdx];
          if (x < t.minX || x > t.maxX || y < t.minY || y > t.maxY) continue;
          const u = ((t.y1 - t.y2) * (x - t.x2) + (t.x2 - t.x1) * (y - t.y2)) * t.invDenom;
          if (u < -1e-4 || u > 1.0001) continue;
          const w = ((t.y2 - t.y0) * (x - t.x2) + (t.x0 - t.x2) * (y - t.y2)) * t.invDenom;
          if (w < -1e-4 || u + w > 1.0001) continue;
          const w3 = 1.0 - u - w;
          const zHit = u * t.z0 + w * t.z1 + w3 * t.z2;
          hits.push({ z: zHit, nz: t.nz, triMinZ: t.minZ });
        }

        if (hits.length === 0) continue;
        hits.sort((a, b) => a.z - b.z);

        const dedup = [];
        for (let k = 0; k < hits.length; k++) {
          const h = hits[k];
          if (dedup.length === 0 || Math.abs(h.z - dedup[dedup.length - 1].z) > 0.15) {
            dedup.push(h);
          } else if (h.nz < dedup[dedup.length - 1].nz) {
            dedup[dedup.length - 1] = h;
          }
        }

        const cellList = [];
        for (let k = 0; k < dedup.length; k++) {
          const h = dedup[k];
          // Downward-facing overhang surface above first layer
          if (h.nz < -0.16 && h.z > firstLayerHeight + 1.0) {
            const zTop = h.z;
            const zBot = k > 0 ? dedup[k - 1].z : 0;
            // Strictly respect the user's Overhang threshold angle (`sinThresh`),
            // while also catching internal enclosed cavities (k > 0) when angle threshold <= 32 deg
            const isSteepOverhang = h.nz < -sinThresh;
            const isEnclosedCavityRoof = (k > 0) && (overhangAngleDeg <= 32) && (h.nz < -0.32) && ((h.triMinZ - zBot) > layerHeight * 2.5);
            if ((isSteepOverhang || isEnclosedCavityRoof) && (zTop - zBot) >= minSupportHeight) {
              const item = {
                ix, iy, x, y,
                zBot, zTop,
                nz: h.nz,
                used: false,
                valid: true
              };
              intervals.push(item);
              cellList.push(item);
            }
          }
        }

        if (cellList.length > 0) {
          cellMap.set(`${ix},${iy}`, cellList);
        }
      }
    }

    if (intervals.length === 0) {
      return {
        hasOverhang: false,
        regionCount: 0,
        mesh: null,
        regions: [],
        pauseLayers: [],
        autoPauseLayers: [],
        savedPercent: 0,
        supportVolumeMl: 0,
        solidVolumeMl: 0,
        solidVolumeMm3: 0,
        hollowVolumeMm3: 0,
        materialSavedPct: 0,
        durationMs: performance.now() - t0
      };
    }

    // Prune 1-cell-wide isolated cracks while preserving >= 2-cell-wide structural features
    const maxStepJump = step * 3.6;
    function hasMatchingNeighbor(it, dx, dy) {
      const nbs = cellMap.get(`${it.ix + dx},${it.iy + dy}`);
      if (!nbs) return false;
      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        if (Math.abs(nb.zTop - it.zTop) <= maxStepJump && Math.abs(nb.zBot - it.zBot) <= maxStepJump) {
          return true;
        }
      }
      return false;
    }

    for (let i = 0; i < intervals.length; i++) {
      const it = intervals[i];
      const hasX = hasMatchingNeighbor(it, 1, 0) || hasMatchingNeighbor(it, -1, 0);
      const hasY = hasMatchingNeighbor(it, 0, 1) || hasMatchingNeighbor(it, 0, -1);
      it.valid = hasX && hasY;
    }

    // Cluster connected overhang intervals into 3D support regions
    const rawClusters = [];
    for (let i = 0; i < intervals.length; i++) {
      const start = intervals[i];
      if (start.used || !start.valid) continue;
      start.used = true;
      const queue = [start];

      for (let qIdx = 0; qIdx < queue.length; qIdx++) {
        const cur = queue[qIdx];
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let d = 0; d < 4; d++) {
          const nbs = cellMap.get(`${cur.ix + dirs[d][0]},${cur.iy + dirs[d][1]}`);
          if (!nbs) continue;
          for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];
            if (!nb.used && nb.valid &&
                Math.abs(nb.zTop - cur.zTop) <= maxStepJump &&
                Math.abs(nb.zBot - cur.zBot) <= maxStepJump) {
              nb.used = true;
              queue.push(nb);
            }
          }
        }
      }

      // Minimum footprint area ~65 mm^2
      if (queue.length * step * step >= 65.0) {
        rawClusters.push(queue);
      }
    }

    const outVerts = [];
    function emitTri(ax, ay, az, bx, by, bz, cx, cy, cz) {
      outVerts.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    function emitQuad(a, b, c, d) {
      emitTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      emitTri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }

    let totalSolidVolumeMm3 = 0;
    let totalHollowVolumeMm3 = 0;
    const regionsInfo = [];
    const pauseLayerSet = new Set();
    const layers = (sliceResult && Array.isArray(sliceResult.layers)) ? sliceResult.layers : [];

    function findLayerForZ(targetZ) {
      if (layers.length === 0) {
        return Math.max(2, Math.round(targetZ / layerHeight));
      }
      let bestLayerNum = layers[layers.length - 1].index + 1;
      for (let l = 0; l < layers.length; l++) {
        if (layers[l].z >= targetZ - 0.15) {
          bestLayerNum = layers[l].index + 1;
          break;
        }
      }
      return Math.max(2, bestLayerNum);
    }

    // Build adaptive hollow support mesh for each cluster
    for (let cIdx = 0; cIdx < rawClusters.length; cIdx++) {
      const cluster = rawClusters[cIdx];

      // Map (ix, iy) -> cell inside this cluster
      const grid = new Map();
      let minIX = Infinity, maxIX = -Infinity;
      let minIY = Infinity, maxIY = -Infinity;
      for (let i = 0; i < cluster.length; i++) {
        const c = cluster[i];
        grid.set(`${c.ix},${c.iy}`, c);
        if (c.ix < minIX) minIX = c.ix;
        if (c.ix > maxIX) maxIX = c.ix;
        if (c.iy < minIY) minIY = c.iy;
        if (c.iy > maxIY) maxIY = c.iy;
      }

      // Fill isolated 1-cell interior pinholes surrounded by >= 3 neighbors
      for (let ix = minIX; ix <= maxIX; ix++) {
        for (let iy = minIY; iy <= maxIY; iy++) {
          const key = `${ix},${iy}`;
          if (grid.has(key)) continue;
          const nbs = [];
          const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (let d = 0; d < 4; d++) {
            const nb = grid.get(`${ix + dirs[d][0]},${iy + dirs[d][1]}`);
            if (nb) nbs.push(nb);
          }
          if (nbs.length >= 3) {
            let sumBot = 0, sumTop = 0, sumNz = 0;
            for (let k = 0; k < nbs.length; k++) {
              sumBot += nbs[k].zBot;
              sumTop += nbs[k].zTop;
              sumNz += nbs[k].nz;
            }
            const filled = {
              ix, iy,
              x: bounds.minX + (ix + 0.5) * step,
              y: bounds.minY + (iy + 0.5) * step,
              zBot: sumBot / nbs.length,
              zTop: sumTop / nbs.length,
              nz: sumNz / nbs.length
            };
            grid.set(key, filled);
            cluster.push(filled);
          }
        }
      }

      // Measure bounding box and slope directions of zTop
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZBot = Infinity, maxZBot = -Infinity;
      let minZTop = Infinity, maxZTop = -Infinity;
      let sumGradX = 0, countGradX = 0;
      let sumGradY = 0, countGradY = 0;

      for (let i = 0; i < cluster.length; i++) {
        const c = cluster[i];
        if (c.x - step * 0.5 < minX) minX = c.x - step * 0.5;
        if (c.x + step * 0.5 > maxX) maxX = c.x + step * 0.5;
        if (c.y - step * 0.5 < minY) minY = c.y - step * 0.5;
        if (c.y + step * 0.5 > maxY) maxY = c.y + step * 0.5;
        if (c.zBot < minZBot) minZBot = c.zBot;
        if (c.zBot > maxZBot) maxZBot = c.zBot;
        if (c.zTop < minZTop) minZTop = c.zTop;
        if (c.zTop > maxZTop) maxZTop = c.zTop;

        const nbX = grid.get(`${c.ix + 1},${c.iy}`);
        if (nbX) {
          sumGradX += Math.abs(nbX.zTop - c.zTop);
          countGradX++;
        }
        const nbY = grid.get(`${c.ix},${c.iy + 1}`);
        if (nbY) {
          sumGradY += Math.abs(nbY.zTop - c.zTop);
          countGradY++;
        }
      }

      const spanX = maxX - minX;
      const spanY = maxY - minY;
      const avgGradX = countGradX > 0 ? sumGradX / countGradX : 0;
      const avgGradY = countGradY > 0 ? sumGradY / countGradY : 0;
      const zTopDelta = maxZTop - minZTop;

      // Determine tunnel axis (open pass-through direction like reference hollow frame):
      // - For sloped overhangs: open perpendicular to the primary slope direction so the cross-section
      //   is an extruded hollow profile that can also be laid flat on an FDM bed with 0 supports!
      // - Exception: if a sloped channel flares in Y along X (like the horn bore), keep side walls on Y-boundaries (tunnel along X).
      // - For flat ceilings/cavities: open along the shorter horizontal axis (matching reference image).
      let tunnelAlongX = false;
      if (zTopDelta > 8.0) {
        if (avgGradY > avgGradX * 1.15) {
          tunnelAlongX = true; // Slopes along Y -> tunnel opens along X
        } else {
          // Slopes along X -> check if Y boundaries flare along X
          let yBoundsVary = false;
          let firstSpanY = -1;
          for (let ix = minIX; ix <= maxIX; ix += 2) {
            let y0 = Infinity, y1 = -Infinity;
            for (let iy = minIY; iy <= maxIY; iy++) {
              if (grid.has(`${ix},${iy}`)) {
                if (iy < y0) y0 = iy;
                if (iy > y1) y1 = iy;
              }
            }
            if (y1 >= y0) {
              const sY = y1 - y0;
              if (firstSpanY < 0) firstSpanY = sY;
              else if (Math.abs(sY - firstSpanY) >= 3) {
                yBoundsVary = true;
                break;
              }
            }
          }
          tunnelAlongX = yBoundsVary; // Flared horn bore -> side walls on Y, open at throat/mouth (X)
        }
      } else {
        tunnelAlongX = (spanX <= spanY);
      }

      // Compute lateral wall & internal stiffening rib mask `isMidWall` for each cell
      const wallCells = Math.max(1, Math.ceil(wallThickness / step));
      const ribSpacingMm = 115.0; // Add internal rib only when span exceeds ~145mm

      for (let i = 0; i < cluster.length; i++) {
        const c = cluster[i];
        const localH = (c.zTop - clearanceZ) - (c.zBot <= 0.6 ? 0 : c.zBot + clearanceZ);
        if (localH <= wallThickness * 2.15) {
          c.isMidWall = true;
          continue;
        }

        let onSideWall = false;
        if (tunnelAlongX) {
          // Tunnel runs along X -> side walls are on the -Y and +Y boundaries of the cluster
          for (let k = 1; k <= wallCells; k++) {
            if (!grid.has(`${c.ix},${c.iy - k}`) || !grid.has(`${c.ix},${c.iy + k}`)) {
              onSideWall = true;
              break;
            }
          }
          if (!onSideWall && spanY > 145.0) {
            const numRibBays = Math.max(2, Math.round(spanY / ribSpacingMm));
            const bayWidth = spanY / numRibBays;
            const relY = c.y - minY;
            for (let r = 1; r < numRibBays; r++) {
              if (Math.abs(relY - r * bayWidth) <= wallThickness * 0.55) {
                onSideWall = true;
                break;
              }
            }
          }
        } else {
          // Tunnel runs along Y -> side walls are on the -X and +X boundaries of the cluster
          for (let k = 1; k <= wallCells; k++) {
            if (!grid.has(`${c.ix - k},${c.iy}`) || !grid.has(`${c.ix + k},${c.iy}`)) {
              onSideWall = true;
              break;
            }
          }
          if (!onSideWall && spanX > 145.0) {
            const numRibBays = Math.max(2, Math.round(spanX / ribSpacingMm));
            const bayWidth = spanX / numRibBays;
            const relX = c.x - minX;
            for (let r = 1; r < numRibBays; r++) {
              if (Math.abs(relX - r * bayWidth) <= wallThickness * 0.55) {
                onSideWall = true;
                break;
              }
            }
          }
        }

        c.isMidWall = onSideWall;
      }

      // Build shared corner vertex table (vx, vy) for all active cells
      const nodeMap = new Map();
      function getOrCreateNode(vx, vy) {
        const k = `${vx},${vy}`;
        let nd = nodeMap.get(k);
        if (!nd) {
          nd = {
            vx, vy,
            x: bounds.minX + vx * step,
            y: bounds.minY + vy * step,
            zBotSum: 0,
            zTopSum: 0,
            count: 0,
            isBoundary: false,
            nx: 0,
            ny: 0
          };
          nodeMap.set(k, nd);
        }
        return nd;
      }

      for (let i = 0; i < cluster.length; i++) {
        const c = cluster[i];
        const corners = [
          getOrCreateNode(c.ix, c.iy),
          getOrCreateNode(c.ix + 1, c.iy),
          getOrCreateNode(c.ix + 1, c.iy + 1),
          getOrCreateNode(c.ix, c.iy + 1)
        ];
        for (let k = 0; k < 4; k++) {
          corners[k].zBotSum += c.zBot;
          corners[k].zTopSum += c.zTop;
          corners[k].count++;
        }
      }

      // Identify boundary nodes and compute inward normal for clearanceXY inset & contour fairing
      const boundaryEdgesByNode = new Map();
      function addBoundaryEdge(nA, nB, inX, inY) {
        nA.isBoundary = true;
        nB.isBoundary = true;
        nA.nx += inX; nA.ny += inY;
        nB.nx += inX; nB.ny += inY;
        const kA = `${nA.vx},${nA.vy}`;
        const kB = `${nB.vx},${nB.vy}`;
        if (!boundaryEdgesByNode.has(kA)) boundaryEdgesByNode.set(kA, []);
        if (!boundaryEdgesByNode.has(kB)) boundaryEdgesByNode.set(kB, []);
        boundaryEdgesByNode.get(kA).push(nB);
        boundaryEdgesByNode.get(kB).push(nA);
      }

      for (let i = 0; i < cluster.length; i++) {
        const c = cluster[i];
        const n00 = nodeMap.get(`${c.ix},${c.iy}`);
        const n10 = nodeMap.get(`${c.ix + 1},${c.iy}`);
        const n11 = nodeMap.get(`${c.ix + 1},${c.iy + 1}`);
        const n01 = nodeMap.get(`${c.ix},${c.iy + 1}`);

        if (!grid.has(`${c.ix},${c.iy - 1}`)) addBoundaryEdge(n00, n10, 0, 1);
        if (!grid.has(`${c.ix + 1},${c.iy}`)) addBoundaryEdge(n10, n11, -1, 0);
        if (!grid.has(`${c.ix},${c.iy + 1}`)) addBoundaryEdge(n11, n01, 0, -1);
        if (!grid.has(`${c.ix - 1},${c.iy}`)) addBoundaryEdge(n01, n00, 1, 0);
      }

      // Inset boundary nodes by clearanceXY so support never collides with printed walls
      const effectiveInset = Math.min(clearanceXY, step * 0.38);
      for (const nd of nodeMap.values()) {
        const avgBot = nd.zBotSum / Math.max(1, nd.count);
        const avgTop = nd.zTopSum / Math.max(1, nd.count);
        nd.zBot = avgBot;
        nd.zTop = avgTop;
        if (nd.isBoundary) {
          const len = Math.hypot(nd.nx, nd.ny);
          if (len > 1e-4) {
            nd.x += (nd.nx / len) * effectiveInset;
            nd.y += (nd.ny / len) * effectiveInset;
          }
        }
      }

      // Smooth staircase diagonal/curved boundaries into smooth contours while preserving true 90-deg corners
      for (let iter = 0; iter < 8; iter++) {
        const updates = [];
        for (const [k, nbs] of boundaryEdgesByNode.entries()) {
          if (nbs.length !== 2) continue;
          const nd = nodeMap.get(k);
          const a = nbs[0];
          const b = nbs[1];
          // Check if (a -> nd -> b) is a true macroscopic straight corner (at least 2 consecutive axis-aligned steps on each side)
          const dx1 = nd.vx - a.vx, dy1 = nd.vy - a.vy;
          const dx2 = b.vx - nd.vx, dy2 = b.vy - nd.vy;
          const aNbs = boundaryEdgesByNode.get(`${a.vx},${a.vy}`) || [];
          const bNbs = boundaryEdgesByNode.get(`${b.vx},${b.vy}`) || [];
          const aPrev = aNbs.find(p => p !== nd);
          const bNext = bNbs.find(p => p !== nd);
          let isMacroCorner = false;
          if (aPrev && bNext && (dx1 * dx2 + dy1 * dy2 === 0)) {
            const adx = a.vx - aPrev.vx, ady = a.vy - aPrev.vy;
            const bdx = bNext.vx - b.vx, bdy = bNext.vy - b.vy;
            if (adx === dx1 && ady === dy1 && bdx === dx2 && bdy === dy2) {
              const aPrevNbs = boundaryEdgesByNode.get(`${aPrev.vx},${aPrev.vy}`) || [];
              const bNextNbs = boundaryEdgesByNode.get(`${bNext.vx},${bNext.vy}`) || [];
              const aPrev2 = aPrevNbs.find(p => p !== a);
              const bNext2 = bNextNbs.find(p => p !== b);
              if (
                aPrev2 && bNext2 &&
                (aPrev.vx - aPrev2.vx) === dx1 && (aPrev.vy - aPrev2.vy) === dy1 &&
                (bNext2.vx - bNext.vx) === dx2 && (bNext2.vy - bNext.vy) === dy2
              ) {
                isMacroCorner = true;
              }
            }
          }
          if (!isMacroCorner) {
            updates.push({
              nd,
              nx: 0.4 * nd.x + 0.3 * (a.x + b.x),
              ny: 0.4 * nd.y + 0.3 * (a.y + b.y),
              nzBot: 0.4 * nd.zBot + 0.3 * (a.zBot + b.zBot),
              nzTop: 0.4 * nd.zTop + 0.3 * (a.zTop + b.zTop)
            });
          }
        }
        for (let u = 0; u < updates.length; u++) {
          updates[u].nd.x = updates[u].nx;
          updates[u].nd.y = updates[u].ny;
          updates[u].nd.zBot = updates[u].nzBot;
          updates[u].nd.zTop = updates[u].nzTop;
        }
      }

      // Compute final 4-tier Z levels (z0 <= z1 <= z2 <= z3) at every node
      for (const nd of nodeMap.values()) {
        const z0 = nd.zBot <= 0.6 ? 0.0 : nd.zBot + clearanceZ;
        const z3 = Math.max(z0 + 1.0, nd.zTop - clearanceZ);
        const zMid = 0.5 * (z0 + z3);
        const z1 = Math.min(z0 + wallThickness, zMid);
        const z2 = Math.max(z3 - wallThickness, zMid);
        nd.z = [z0, z1, z2, z3];
      }

      // Helper to check if hexahedron (ix, iy, tier) is occupied
      function isOccupied(ix, iy, tier) {
        if (tier < 0 || tier > 2) return false;
        const c = grid.get(`${ix},${iy}`);
        if (!c) return false;
        if (tier === 0 || tier === 2) return true;
        return Boolean(c.isMidWall);
      }

      // Emit watertight manifold faces for each active cell and tier
      let clusterSolidVol = 0;
      let clusterHollowVol = 0;

      for (let i = 0; i < cluster.length; i++) {
        const c = cluster[i];
        const n00 = nodeMap.get(`${c.ix},${c.iy}`);
        const n10 = nodeMap.get(`${c.ix + 1},${c.iy}`);
        const n11 = nodeMap.get(`${c.ix + 1},${c.iy + 1}`);
        const n01 = nodeMap.get(`${c.ix},${c.iy + 1}`);

        const cellArea = step * step;
        const fullH = Math.max(0, (n00.z[3] - n00.z[0] + n10.z[3] - n10.z[0] + n11.z[3] - n11.z[0] + n01.z[3] - n01.z[0]) * 0.25);
        clusterSolidVol += cellArea * fullH;

        for (let tier = 0; tier <= 2; tier++) {
          if (!isOccupied(c.ix, c.iy, tier)) continue;

          const b00 = [n00.x, n00.y, n00.z[tier]];
          const b10 = [n10.x, n10.y, n10.z[tier]];
          const b11 = [n11.x, n11.y, n11.z[tier]];
          const b01 = [n01.x, n01.y, n01.z[tier]];

          const t00 = [n00.x, n00.y, n00.z[tier + 1]];
          const t10 = [n10.x, n10.y, n10.z[tier + 1]];
          const t11 = [n11.x, n11.y, n11.z[tier + 1]];
          const t01 = [n01.x, n01.y, n01.z[tier + 1]];

          const tierH = Math.max(0, (t00[2] - b00[2] + t10[2] - b10[2] + t11[2] - b11[2] + t01[2] - b01[2]) * 0.25);
          clusterHollowVol += cellArea * tierH;

          // -Z bottom face (outward normal -Z)
          if (!isOccupied(c.ix, c.iy, tier - 1)) {
            emitQuad(b00, b01, b11, b10);
          }
          // +Z top face (outward normal +Z)
          if (!isOccupied(c.ix, c.iy, tier + 1)) {
            emitQuad(t00, t10, t11, t01);
          }
          // -Y face (iy - 1)
          if (!isOccupied(c.ix, c.iy - 1, tier)) {
            emitQuad(b00, b10, t10, t00);
          }
          // +X face (ix + 1)
          if (!isOccupied(c.ix + 1, c.iy, tier)) {
            emitQuad(b10, b11, t11, t10);
          }
          // +Y face (iy + 1)
          if (!isOccupied(c.ix, c.iy + 1, tier)) {
            emitQuad(b11, b01, t01, t11);
          }
          // -X face (ix - 1)
          if (!isOccupied(c.ix - 1, c.iy, tier)) {
            emitQuad(b01, b00, t00, t01);
          }
        }
      }

      totalSolidVolumeMm3 += clusterSolidVol;
      totalHollowVolumeMm3 += clusterHollowVol;

      // Determine recommended pause layer(s) for placing this support piece
      let pauseLayer = findLayerForZ(maxZTop);
      if (zTopDelta > layerHeight * 3.0 && (minZTop - minZBot) > 12.0) {
        // Overhang starts elevated in mid-air and then slopes upward (e.g. throat at Z=135 flaring to Z=280)
        const onsetLayer = findLayerForZ(minZTop);
        pauseLayerSet.add(onsetLayer);
        pauseLayer = onsetLayer;
      }
      pauseLayerSet.add(pauseLayer);

      regionsInfo.push({
        id: cIdx + 1,
        minX, maxX, minY, maxY,
        minZ: minZBot <= 0.6 ? 0 : minZBot,
        maxZ: maxZTop,
        sizeX: spanX,
        sizeY: spanY,
        sizeZ: maxZTop - (minZBot <= 0.6 ? 0 : minZBot),
        isSloped: zTopDelta > layerHeight * 2.5,
        pauseLayer
      });
    }

    if (outVerts.length === 0) {
      return {
        hasOverhang: false,
        regionCount: 0,
        mesh: null,
        regions: [],
        pauseLayers: [],
        autoPauseLayers: [],
        savedPercent: 0,
        supportVolumeMl: 0,
        solidVolumeMl: 0,
        solidVolumeMm3: 0,
        hollowVolumeMm3: 0,
        materialSavedPct: 0,
        durationMs: performance.now() - t0
      };
    }

    const vertices = new Float32Array(outVerts);
    const normals = new Float32Array(outVerts.length);
    const supportMesh = recomputeFaceNormals({
      vertices,
      normals,
      triangleCount: Math.floor(vertices.length / 9)
    });
    supportMesh.bounds = computeBounds(vertices);

    const autoPauseLayers = Array.from(pauseLayerSet).sort((a, b) => a - b);
    const materialSavedPct = totalSolidVolumeMm3 > 0
      ? Math.max(0, Math.min(95, (1.0 - totalHollowVolumeMm3 / totalSolidVolumeMm3) * 100))
      : 0;

    return {
      hasOverhang: regionsInfo.length > 0 && supportMesh.triangleCount > 0,
      regionCount: regionsInfo.length,
      mesh: supportMesh,
      regions: regionsInfo,
      pauseLayers: autoPauseLayers,
      autoPauseLayers,
      savedPercent: materialSavedPct,
      supportVolumeMl: totalHollowVolumeMm3 / 1000.0,
      solidVolumeMl: totalSolidVolumeMm3 / 1000.0,
      solidVolumeMm3: totalSolidVolumeMm3,
      hollowVolumeMm3: totalHollowVolumeMm3,
      materialSavedPct,
      durationMs: performance.now() - t0
    };
  }

  /**
   * Serializes a triangle mesh ({ vertices, normals, triangleCount }) into a standard Binary STL Uint8Array.
   */
  function meshToBinarySTL(mesh, headerLabel) {
    if (!mesh || !mesh.vertices || mesh.triangleCount === 0) {
      return null;
    }
    const triCount = mesh.triangleCount;
    const buffer = new ArrayBuffer(84 + triCount * 50);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    const header = (headerLabel || 'CIM Slicer 0.4.0 Adaptive Hollow Support STL').slice(0, 79);
    for (let i = 0; i < header.length; i++) {
      bytes[i] = header.charCodeAt(i) & 0x7f;
    }

    view.setUint32(80, triCount, true);

    const v = mesh.vertices;
    const n = mesh.normals;
    let offset = 84;

    for (let i = 0; i < triCount; i++) {
      const base = i * 9;
      view.setFloat32(offset, n ? n[base] : 0, true);
      view.setFloat32(offset + 4, n ? n[base + 1] : 0, true);
      view.setFloat32(offset + 8, n ? n[base + 2] : 1, true);
      offset += 12;

      for (let k = 0; k < 9; k++) {
        view.setFloat32(offset, v[base + k], true);
        offset += 4;
      }

      view.setUint16(offset, 0, true);
      offset += 2;
    }

    return bytes;
  }

    return {
      parseSTL,
      parseOBJ,
      parse3MF,
      createPrimitive,
      computeBounds,
      transformMesh,
      computeLayOnFaceRotation,
      sliceModel,
      generateGCode,
      calculateMixMetrics,
      inferIngredientDensityGPerMl,
      formatDuration,
      sliceMeshAtZ,
      offsetPolygonsInward,
      parsePauseLayers,
      detectOverhangsAndGenerateSupport,
      meshToBinarySTL
    };
})();
