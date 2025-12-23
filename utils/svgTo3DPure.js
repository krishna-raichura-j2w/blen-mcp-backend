/**
 * Pure JavaScript SVG to 3D Converter
 * NO BLENDER - Pure geometry math
 * 
 * Pipeline:
 * 1. SVG → 2D Polygon (parse & normalize)
 * 2. 2D Polygon → 3D Extrusion (controlled depth)
 * 3. Mesh Generation (triangulate, create geometry)
 * 4. GLB Export with colors (glTF)
 * 
 * Result: Clean, deterministic, fast 3D models with colors
 */

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const earcutModule = require('earcut');
const earcut = earcutModule.default || earcutModule;
const { Document, NodeIO } = require('@gltf-transform/core');

/**
 * Parse color from SVG format to RGB array [r, g, b] (0-1 range)
 */
function parseColor(colorStr) {
  // Handle hex colors
  if (colorStr.startsWith('#')) {
    const hex = colorStr.slice(1);
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b];
  }
  
  // Handle rgb() format
  if (colorStr.startsWith('rgb')) {
    const match = colorStr.match(/\d+/g);
    if (match && match.length >= 3) {
      return [
        parseInt(match[0]) / 255,
        parseInt(match[1]) / 255,
        parseInt(match[2]) / 255
      ];
    }
  }
  
  // Handle named colors (basic set)
  const namedColors = {
    'red': [1, 0, 0],
    'green': [0, 1, 0],
    'blue': [0, 0, 1],
    'white': [1, 1, 1],
    'black': [0, 0, 0],
    'yellow': [1, 1, 0],
    'cyan': [0, 1, 1],
    'magenta': [1, 0, 1],
    'gray': [0.5, 0.5, 0.5],
    'grey': [0.5, 0.5, 0.5]
  };
  
  const colorLower = colorStr.toLowerCase();
  if (namedColors[colorLower]) {
    return namedColors[colorLower];
  }
  
  // Default gray
  return [0.5, 0.5, 0.5];
}

/**
 * STEP 1: Parse SVG to 2D Polygons WITH COLORS
 * - Extract closed paths
 * - Flatten curves to line segments
 * - Normalize to [-1, 1] range
 * - Center at (0, 0)
 * - Extract fill colors
 */
function parseSVGToPolygons(svgPath) {
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  
  const polygons = [];
  
  // Get SVG dimensions
  const svg = doc.getElementsByTagName('svg')[0];
  const viewBox = svg.getAttribute('viewBox');
  let width = parseFloat(svg.getAttribute('width')) || 100;
  let height = parseFloat(svg.getAttribute('height')) || 100;
  
  if (viewBox) {
    const vb = viewBox.split(/\s+|,/).map(v => parseFloat(v));
    width = vb[2] || width;
    height = vb[3] || height;
  }
  
  const scale = Math.max(width, height);
  
  // Parse <path> elements
  const paths = doc.getElementsByTagName('path');
  for (let i = 0; i < paths.length; i++) {
    const d = paths[i].getAttribute('d');
    const fill = paths[i].getAttribute('fill') || '#888888';
    
    if (d) {
      const points = parseSVGPath(d);
      if (points.length >= 3) {
        // Simplify polygon (remove duplicate/close points)
        const simplified = simplifyPolygon(points, 0.01);
        
        // Skip polygons that are still too complex
        if (simplified.length >= 3 && simplified.length < 5000) {
          const normalized = simplified.map(p => ({
            x: ((p.x - width / 2) / scale) * 2,
            y: -((p.y - height / 2) / scale) * 2
          }));
          polygons.push({ 
            points: normalized,
            color: parseColor(fill)
          });
        } else if (simplified.length >= 5000) {
          console.log(`   ⚠️  Skipping polygon ${i + 1} (${simplified.length} points - too complex)`);
        }
      }
    }
  }
  
  // Parse <polygon> elements
  const polyElements = doc.getElementsByTagName('polygon');
  for (let i = 0; i < polyElements.length; i++) {
    const pointsStr = polyElements[i].getAttribute('points');
    const fill = polyElements[i].getAttribute('fill') || '#888888';
    
    if (pointsStr) {
      const points = parsePolygonPoints(pointsStr);
      if (points.length >= 3) {
        const normalized = points.map(p => ({
          x: ((p.x - width / 2) / scale) * 2,
          y: -((p.y - height / 2) / scale) * 2
        }));
        polygons.push({
          points: normalized,
          color: parseColor(fill)
        });
      }
    }
  }
  
  // Parse <rect> elements
  const rects = doc.getElementsByTagName('rect');
  for (let i = 0; i < rects.length; i++) {
    const x = parseFloat(rects[i].getAttribute('x')) || 0;
    const y = parseFloat(rects[i].getAttribute('y')) || 0;
    const w = parseFloat(rects[i].getAttribute('width')) || 0;
    const h = parseFloat(rects[i].getAttribute('height')) || 0;
    const fill = rects[i].getAttribute('fill') || '#888888';
    
    const points = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h }
    ];
    
    const normalized = points.map(p => ({
      x: ((p.x - width / 2) / scale) * 2,
      y: -((p.y - height / 2) / scale) * 2
    }));
    polygons.push({
      points: normalized,
      color: parseColor(fill)
    });
  }
  
  // Parse <circle> elements (approximate as polygon)
  const circles = doc.getElementsByTagName('circle');
  for (let i = 0; i < circles.length; i++) {
    const cx = parseFloat(circles[i].getAttribute('cx')) || 0;
    const cy = parseFloat(circles[i].getAttribute('cy')) || 0;
    const r = parseFloat(circles[i].getAttribute('r')) || 0;
    const fill = circles[i].getAttribute('fill') || '#888888';
    
    // Create circle as polygon with 32 segments
    const segments = 32;
    const points = [];
    for (let j = 0; j < segments; j++) {
      const angle = (j / segments) * Math.PI * 2;
      points.push({
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r
      });
    }
    
    const normalized = points.map(p => ({
      x: ((p.x - width / 2) / scale) * 2,
      y: -((p.y - height / 2) / scale) * 2
    }));
    polygons.push({
      points: normalized,
      color: parseColor(fill)
    });
  }
  
  // Parse <ellipse> elements (approximate as polygon)
  const ellipses = doc.getElementsByTagName('ellipse');
  for (let i = 0; i < ellipses.length; i++) {
    const cx = parseFloat(ellipses[i].getAttribute('cx')) || 0;
    const cy = parseFloat(ellipses[i].getAttribute('cy')) || 0;
    const rx = parseFloat(ellipses[i].getAttribute('rx')) || 0;
    const ry = parseFloat(ellipses[i].getAttribute('ry')) || 0;
    const fill = ellipses[i].getAttribute('fill') || '#888888';
    
    // Create ellipse as polygon with 32 segments
    const segments = 32;
    const points = [];
    for (let j = 0; j < segments; j++) {
      const angle = (j / segments) * Math.PI * 2;
      points.push({
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry
      });
    }
    
    const normalized = points.map(p => ({
      x: ((p.x - width / 2) / scale) * 2,
      y: -((p.y - height / 2) / scale) * 2
    }));
    polygons.push({
      points: normalized,
      color: parseColor(fill)
    });
  }
  
  return polygons;
}

/**
 * Simplify polygon by removing points that are too close together
 * Uses Douglas-Peucker-like approach (simple distance threshold)
 */
function simplifyPolygon(points, tolerance = 0.01) {
  if (points.length <= 3) return points;
  
  const simplified = [points[0]]; // Always keep first point
  
  for (let i = 1; i < points.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const curr = points[i];
    
    // Calculate distance from previous kept point
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Only keep if distance exceeds tolerance
    if (dist > tolerance) {
      simplified.push(curr);
    }
  }
  
  // Always keep last point
  simplified.push(points[points.length - 1]);
  
  return simplified;
}

/**
 * Parse SVG path data to points
 * Handles: M, L, H, V, C, S, Q, T, Z
 * Approximates curves with line segments
 */
function parseSVGPath(d) {
  const points = [];
  const commands = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  
  let x = 0, y = 0;
  let startX = 0, startY = 0;
  let lastControlX = 0, lastControlY = 0;
  
  if (!commands) return points;
  
  commands.forEach(cmd => {
    const type = cmd[0];
    const isRelative = type === type.toLowerCase();
    const typeUpper = type.toUpperCase();
    const values = cmd.slice(1).trim().split(/[\s,]+/).map(v => parseFloat(v)).filter(v => !isNaN(v));
    
    switch (typeUpper) {
      case 'M': // Move
        x = isRelative ? x + values[0] : values[0];
        y = isRelative ? y + values[1] : values[1];
        startX = x;
        startY = y;
        points.push({ x, y });
        break;
        
      case 'L': // Line
        for (let i = 0; i < values.length; i += 2) {
          x = isRelative ? x + values[i] : values[i];
          y = isRelative ? y + values[i + 1] : values[i + 1];
          points.push({ x, y });
        }
        break;
        
      case 'H': // Horizontal
        x = isRelative ? x + values[0] : values[0];
        points.push({ x, y });
        break;
        
      case 'V': // Vertical
        y = isRelative ? y + values[0] : values[0];
        points.push({ x, y });
        break;
        
      case 'C': // Cubic Bezier
        for (let i = 0; i < values.length; i += 6) {
          const cp1x = isRelative ? x + values[i] : values[i];
          const cp1y = isRelative ? y + values[i + 1] : values[i + 1];
          const cp2x = isRelative ? x + values[i + 2] : values[i + 2];
          const cp2y = isRelative ? y + values[i + 3] : values[i + 3];
          const endX = isRelative ? x + values[i + 4] : values[i + 4];
          const endY = isRelative ? y + values[i + 5] : values[i + 5];
          
          // Approximate curve with 5 segments (reduce polygon complexity)
          for (let t = 0; t <= 1; t += 0.2) {
            const cx = cubicBezier(x, cp1x, cp2x, endX, t);
            const cy = cubicBezier(y, cp1y, cp2y, endY, t);
            points.push({ x: cx, y: cy });
          }
          
          lastControlX = cp2x;
          lastControlY = cp2y;
          x = endX;
          y = endY;
        }
        break;
        
      case 'S': // Smooth Cubic Bezier
        for (let i = 0; i < values.length; i += 4) {
          const cp1x = 2 * x - lastControlX;
          const cp1y = 2 * y - lastControlY;
          const cp2x = isRelative ? x + values[i] : values[i];
          const cp2y = isRelative ? y + values[i + 1] : values[i + 1];
          const endX = isRelative ? x + values[i + 2] : values[i + 2];
          const endY = isRelative ? y + values[i + 3] : values[i + 3];
          
          for (let t = 0; t <= 1; t += 0.2) {
            const cx = cubicBezier(x, cp1x, cp2x, endX, t);
            const cy = cubicBezier(y, cp1y, cp2y, endY, t);
            points.push({ x: cx, y: cy });
          }
          
          lastControlX = cp2x;
          lastControlY = cp2y;
          x = endX;
          y = endY;
        }
        break;
        
      case 'Q': // Quadratic Bezier
        for (let i = 0; i < values.length; i += 4) {
          const cpx = isRelative ? x + values[i] : values[i];
          const cpy = isRelative ? y + values[i + 1] : values[i + 1];
          const endX = isRelative ? x + values[i + 2] : values[i + 2];
          const endY = isRelative ? y + values[i + 3] : values[i + 3];
          
          for (let t = 0; t <= 1; t += 0.2) {
            const qx = quadraticBezier(x, cpx, endX, t);
            const qy = quadraticBezier(y, cpy, endY, t);
            points.push({ x: qx, y: qy });
          }
          
          lastControlX = cpx;
          lastControlY = cpy;
          x = endX;
          y = endY;
        }
        break;
        
      case 'Z': // Close
        x = startX;
        y = startY;
        break;
    }
  });
  
  return points;
}

/**
 * Cubic Bezier calculation
 */
function cubicBezier(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  
  return mt3 * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3 * p3;
}

/**
 * Quadratic Bezier calculation
 */
function quadraticBezier(p0, p1, p2, t) {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

/**
 * Parse polygon points attribute
 */
function parsePolygonPoints(pointsStr) {
  const values = pointsStr.trim().split(/[\s,]+/).map(v => parseFloat(v));
  const points = [];
  
  for (let i = 0; i < values.length; i += 2) {
    if (!isNaN(values[i]) && !isNaN(values[i + 1])) {
      points.push({ x: values[i], y: values[i + 1] });
    }
  }
  
  return points;
}

/**
 * STEP 2: Extrude 2D Polygon to 3D
 * - Create top and bottom faces
 * - Create side walls
 * - Triangulate faces using earcut
 * - Result: Clean manifold mesh
 */
function extrudePolygonTo3D(polygon, depth = 0.1) {
  const vertices = [];
  const indices = [];
  const normals = [];
  
  // Triangulate the 2D polygon
  const flatCoords = [];
  polygon.forEach(p => {
    flatCoords.push(p.x, p.y);
  });
  
  const triangles = earcut(flatCoords);
  
  // Create BOTTOM face (z = 0)
  const bottomOffset = 0;
  polygon.forEach(p => {
    vertices.push(p.x, p.y, 0);
    normals.push(0, 0, -1); // Normal pointing down
  });
  
  // Add bottom triangles
  triangles.forEach(idx => {
    indices.push(bottomOffset + idx);
  });
  
  // Create TOP face (z = depth)
  const topOffset = polygon.length;
  polygon.forEach(p => {
    vertices.push(p.x, p.y, depth);
    normals.push(0, 0, 1); // Normal pointing up
  });
  
  // Add top triangles (reversed winding)
  for (let i = triangles.length - 1; i >= 0; i -= 3) {
    indices.push(topOffset + triangles[i]);
    indices.push(topOffset + triangles[i - 1]);
    indices.push(topOffset + triangles[i - 2]);
  }
  
  // Create SIDE walls
  const sideOffset = vertices.length / 3;
  const numPoints = polygon.length;
  
  for (let i = 0; i < numPoints; i++) {
    const next = (i + 1) % numPoints;
    const p1 = polygon[i];
    const p2 = polygon[next];
    
    // Calculate side normal (perpendicular to edge)
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = -dy / len;
    const ny = dx / len;
    
    // Bottom-left vertex
    vertices.push(p1.x, p1.y, 0);
    normals.push(nx, ny, 0);
    
    // Bottom-right vertex
    vertices.push(p2.x, p2.y, 0);
    normals.push(nx, ny, 0);
    
    // Top-right vertex
    vertices.push(p2.x, p2.y, depth);
    normals.push(nx, ny, 0);
    
    // Top-left vertex
    vertices.push(p1.x, p1.y, depth);
    normals.push(nx, ny, 0);
    
    // Create two triangles for this side
    const base = sideOffset + i * 4;
    
    // Triangle 1
    indices.push(base, base + 1, base + 2);
    
    // Triangle 2
    indices.push(base, base + 2, base + 3);
  }
  
  return { vertices, indices, normals };
}

/**
 * STEP 3 & 4: Create glTF Document with colored meshes and Export to GLB
 * Each polygon becomes a separate primitive with its own color
 */
async function createGLBFromPolygons(polygonsData, depth, outputPath) {
  // Create glTF document
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh();
  
  // Create a primitive for each polygon (so each can have its own color)
  for (let polyIdx = 0; polyIdx < polygonsData.length; polyIdx++) {
    const polygonObj = polygonsData[polyIdx];
    const polygon = polygonObj.points;
    const color = polygonObj.color;
    
    // Extrude this polygon to 3D
    const geometryData = extrudePolygonTo3D(polygon, depth);
    
    // Create accessors for this primitive
    const positionAccessor = doc.createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array(geometryData.vertices))
      .setBuffer(buffer);
    
    const normalAccessor = doc.createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array(geometryData.normals))
      .setBuffer(buffer);
    
    const indicesAccessor = doc.createAccessor()
      .setType('SCALAR')
      .setArray(new Uint32Array(geometryData.indices))
      .setBuffer(buffer);
    
    // Create material with polygon's color
    const material = doc.createMaterial()
      .setName(`Material_${polyIdx}`)
      .setBaseColorFactor([...color, 1.0]) // Add alpha channel
      .setMetallicFactor(0.0)
      .setRoughnessFactor(0.8);
    
    // Create primitive
    const primitive = doc.createPrimitive()
      .setMode(4) // TRIANGLES
      .setAttribute('POSITION', positionAccessor)
      .setAttribute('NORMAL', normalAccessor)
      .setIndices(indicesAccessor)
      .setMaterial(material);
    
    // Add primitive to mesh
    mesh.addPrimitive(primitive);
  }
  
  // Create node and scene
  const node = doc.createNode()
    .setMesh(mesh);
  
  const scene = doc.createScene()
    .addChild(node);
  
  doc.getRoot().setDefaultScene(scene);
  
  // Write GLB file
  const io = new NodeIO();
  await io.write(outputPath, doc);
  
  return outputPath;
}

/**
 * MAIN PIPELINE: SVG → GLB with Colors
 */
async function convertSVGto3D(svgPath, options = {}) {
  const depth = options.depth || 0.1;
  const outputPath = options.outputPath || path.join(
    path.dirname(svgPath),
    '../exports',
    `${path.basename(svgPath, '.svg')}_3d.glb`
  );
  
  console.log('🎯 Pure JS SVG to 3D Pipeline');
  console.log('📁 Input:', svgPath);
  console.log('📏 Depth:', depth);
  
  // Step 1: Parse SVG with colors
  console.log('\\n1️⃣ Parsing SVG...');
  const polygons = parseSVGToPolygons(svgPath);
  console.log(`✅ Found ${polygons.length} polygon(s) with colors`);
  
  if (polygons.length === 0) {
    throw new Error('No valid polygons found in SVG');
  }
  
  // Count total stats
  let totalVertices = 0;
  let totalTriangles = 0;
  
  console.log('\\n2️⃣ Processing polygons...');
  polygons.forEach((polyObj, idx) => {
    const pointCount = polyObj.points.length;
    console.log(`   Polygon ${idx + 1}/${polygons.length}: ${pointCount} points, color: rgb(${polyObj.color.map(c => Math.round(c*255)).join(', ')})`);
  });
  
  // Step 3 & 4: Create glTF with colors and Export GLB
  console.log('\\n3️⃣ Creating glTF document with colors and exporting GLB...');
  
  // Ensure exports directory exists
  const exportsDir = path.dirname(outputPath);
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  
  await createGLBFromPolygons(polygons, depth, outputPath);
  console.log(`✅ Exported: ${outputPath}`);
  
  return {
    success: true,
    glbPath: outputPath,
    stats: {
      polygons: polygons.length,
      hasColors: true
    }
  };
}

/**
 * Validation
 */
function validateSVG(svgPath) {
  if (!fs.existsSync(svgPath)) {
    throw new Error('SVG file not found');
  }
  
  const content = fs.readFileSync(svgPath, 'utf8');
  
  if (!content.includes('<svg')) {
    throw new Error('Not a valid SVG file');
  }
  
  if (!content.match(/<(path|polygon|rect)/)) {
    throw new Error('SVG must contain path, polygon, or rect elements');
  }
  
  return true;
}

module.exports = {
  convertSVGto3D,
  validateSVG,
  parseSVGToPolygons,
  extrudePolygonTo3D
};
