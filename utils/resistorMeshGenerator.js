/**
 * Resistor Mesh Generator
 * Creates realistic 3D resistor models with wire leads and color bands
 */

/**
 * Generate a cylinder segment
 */
function generateCylinder(radius, height, radialSegments, startY, color) {
  const vertices = [];
  const normals = [];
  const indices = [];
  
  // Generate side vertices
  for (let i = 0; i <= radialSegments; i++) {
    const angle = (i / radialSegments) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    
    // Bottom circle
    vertices.push(x, startY, z);
    normals.push(Math.cos(angle), 0, Math.sin(angle));
    
    // Top circle
    vertices.push(x, startY + height, z);
    normals.push(Math.cos(angle), 0, Math.sin(angle));
  }
  
  // Generate side faces
  for (let i = 0; i < radialSegments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = (i + 1) * 2;
    const d = c + 1;
    
    indices.push(a, b, d);
    indices.push(a, d, c);
  }
  
  // Bottom cap
  const bottomCenterIdx = vertices.length / 3;
  vertices.push(0, startY, 0);
  normals.push(0, -1, 0);
  
  for (let i = 0; i < radialSegments; i++) {
    const a = i * 2;
    const c = ((i + 1) % radialSegments) * 2;
    indices.push(bottomCenterIdx, a, c);
  }
  
  // Top cap
  const topCenterIdx = vertices.length / 3;
  vertices.push(0, startY + height, 0);
  normals.push(0, 1, 0);
  
  for (let i = 0; i < radialSegments; i++) {
    const b = i * 2 + 1;
    const d = ((i + 1) % radialSegments) * 2 + 1;
    indices.push(topCenterIdx, d, b);
  }
  
  return {
    vertices: new Float32Array(vertices),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    color
  };
}

/**
 * Generate a complete resistor with wire leads and color bands
 */
function generateResistor(options = {}) {
  const {
    totalHeight = 2.0,
    bodyRadius = 0.15,
    colorBands = [], // Array of [r, g, b] colors
    radialSegments = 32
  } = options;
  
  console.log('   🔌 Creating resistor mesh:');
  console.log(`      Total length: ${totalHeight.toFixed(3)}`);
  console.log(`      Body radius: ${bodyRadius.toFixed(3)}`);
  console.log(`      Color bands: ${colorBands.length}`);
  
  const segments = [];
  
  // Calculate dimensions
  const bodyLength = totalHeight * 0.55; // Body is 55% of total
  const wireLength = totalHeight * 0.225; // Each wire is 22.5%
  const wireRadius = bodyRadius * 0.12; // Thin wires (12% of body radius)
  
  // Validate we have bands
  const numBands = Math.min(colorBands.length, 4);
  const bandWidth = bodyLength * 0.07; // Each band is 7% of body
  
  let currentY = 0;
  
  // === LEFT WIRE LEAD ===
  console.log(`      Left wire: ${wireLength.toFixed(3)} length, ${wireRadius.toFixed(4)} radius`);
  segments.push(generateCylinder(
    wireRadius,
    wireLength,
    radialSegments,
    currentY,
    [0.72, 0.72, 0.75] // Metallic silver-gray
  ));
  currentY += wireLength;
  
  // === RESISTOR BODY with COLOR BANDS ===
  const bodyStart = currentY;
  const bodyEnd = currentY + bodyLength;
  
  // Calculate band positions
  const spacing = (bodyLength - (numBands * bandWidth)) / (numBands + 1);
  
  console.log(`      Body: ${bodyLength.toFixed(3)} length`);
  console.log(`      Band width: ${bandWidth.toFixed(4)}, spacing: ${spacing.toFixed(4)}`);
  
  // First body section (before first band)
  segments.push(generateCylinder(
    bodyRadius,
    spacing,
    radialSegments,
    currentY,
    [0.87, 0.77, 0.67] // Tan/beige resistor body
  ));
  currentY += spacing;
  
  // Add bands with body sections between them
  for (let i = 0; i < numBands; i++) {
    // Color band
    console.log(`      Band ${i + 1}: position ${currentY.toFixed(4)}, color [${colorBands[i].map(c => c.toFixed(2)).join(', ')}]`);
    segments.push(generateCylinder(
      bodyRadius * 1.01, // Slightly larger to sit on top
      bandWidth,
      radialSegments,
      currentY,
      colorBands[i]
    ));
    currentY += bandWidth;
    
    // Body section after this band (if not last)
    if (i < numBands - 1) {
      segments.push(generateCylinder(
        bodyRadius,
        spacing,
        radialSegments,
        currentY,
        [0.87, 0.77, 0.67]
      ));
      currentY += spacing;
    }
  }
  
  // Final body section (after last band)
  const finalBodyLength = bodyEnd - currentY;
  if (finalBodyLength > 0.001) {
    segments.push(generateCylinder(
      bodyRadius,
      finalBodyLength,
      radialSegments,
      currentY,
      [0.87, 0.77, 0.67]
    ));
    currentY += finalBodyLength;
  }
  
  // === RIGHT WIRE LEAD ===
  console.log(`      Right wire: ${wireLength.toFixed(3)} length, ${wireRadius.toFixed(4)} radius`);
  segments.push(generateCylinder(
    wireRadius,
    wireLength,
    radialSegments,
    currentY,
    [0.72, 0.72, 0.75] // Metallic silver-gray
  ));
  currentY += wireLength;
  
  console.log(`      Total assembled length: ${currentY.toFixed(3)}`);
  console.log(`      Mesh segments: ${segments.length}`);
  
  return segments;
}

/**
 * Combine multiple mesh segments into one
 */
function combineSegments(segments) {
  let totalVertices = 0;
  let totalIndices = 0;
  
  for (const seg of segments) {
    totalVertices += seg.vertices.length;
    totalIndices += seg.indices.length;
  }
  
  const vertices = new Float32Array(totalVertices);
  const normals = new Float32Array(totalVertices);
  const colors = new Float32Array(totalVertices);
  const indices = new Uint32Array(totalIndices);
  
  let vertexOffset = 0;
  let indexOffset = 0;
  let vertexCount = 0;
  
  for (const seg of segments) {
    // Copy vertices and normals
    vertices.set(seg.vertices, vertexOffset);
    normals.set(seg.normals, vertexOffset);
    
    // Fill colors
    const numVerts = seg.vertices.length / 3;
    for (let i = 0; i < numVerts; i++) {
      colors[vertexOffset / 3 * 3 + i * 3] = seg.color[0];
      colors[vertexOffset / 3 * 3 + i * 3 + 1] = seg.color[1];
      colors[vertexOffset / 3 * 3 + i * 3 + 2] = seg.color[2];
    }
    
    // Adjust and copy indices
    for (let i = 0; i < seg.indices.length; i++) {
      indices[indexOffset + i] = seg.indices[i] + vertexCount;
    }
    
    vertexOffset += seg.vertices.length;
    indexOffset += seg.indices.length;
    vertexCount += numVerts;
  }
  
  return {
    vertices,
    normals,
    colors,
    indices
  };
}

module.exports = {
  generateResistor,
  combineSegments
};
