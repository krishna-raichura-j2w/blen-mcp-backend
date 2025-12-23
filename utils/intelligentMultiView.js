/**
 * Intelligent Multi-View SVG to 3D Converter
 * Uses Azure OpenAI GPT-4.1 to analyze views and reconstruct accurate 3D geometry
 * 
 * Pipeline:
 * 1. Parse all SVG views and extract measurements
 * 2. Use AI to understand spatial relationships between views
 * 3. Calculate accurate 3D dimensions from multiple perspectives
 * 4. Generate precise 3D mesh with proper proportions
 * 5. Export colored GLB
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const svgTo3DPure = require('./svgTo3DPure');
const resistorGenerator = require('./resistorMeshGenerator');

/**
 * Analyze SVG with Azure OpenAI to understand shapes and measurements
 */
async function analyzeSVGWithAI(svgPath, viewName) {
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  
  const prompt = `You are an expert in 3D modeling and technical drawing analysis.

Analyze this ${viewName} view SVG and extract:
1. Main shape type (rectangular, cylindrical, spherical, etc.)
2. Key dimensions (width, height, depth visible in this view)
3. Features (holes, protrusions, tapers, etc.)
4. Symmetry axes
5. Estimated proportions

SVG Content:
${svgContent}

Provide a JSON response with:
{
  "shapeType": "cylinder|box|sphere|custom",
  "dimensions": {
    "width": number (in SVG units),
    "height": number (in SVG units),
    "depth": number (estimated from visual cues)
  },
  "features": ["feature1", "feature2"],
  "symmetry": {
    "horizontal": boolean,
    "vertical": boolean,
    "radial": boolean
  },
  "crossSection": "circular|rectangular|elliptical|irregular",
  "confidence": number (0-1)
}`;

  try {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const model = process.env.AZURE_OPENAI_MODEL;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    
    const url = `${endpoint}openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
    
    const response = await axios.post(
      url,
      {
        messages: [
          {
            role: 'system',
            content: 'You are an expert 3D modeling assistant. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 1000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey
        }
      }
    );

    const content = response.data.choices[0].message.content;
    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
    const analysis = JSON.parse(jsonMatch ? jsonMatch[1] || jsonMatch[0] : content);
    
    console.log(`   🤖 AI Analysis (${viewName}):`, JSON.stringify(analysis, null, 2));
    return analysis;
    
  } catch (error) {
    console.warn(`   ⚠️  AI analysis failed for ${viewName}:`);
    console.warn(`      Error: ${error.message}`);
    if (error.response) {
      console.warn(`      Status: ${error.response.status}`);
      console.warn(`      Data: ${JSON.stringify(error.response.data)}`);
    }
    console.warn(`      Using fallback analysis...`);
    return {
      shapeType: 'box',
      dimensions: { width: 100, height: 100, depth: 50 },
      features: [],
      symmetry: { horizontal: true, vertical: true, radial: false },
      crossSection: 'rectangular',
      confidence: 0.3
    };
  }
}

/**
 * Combine AI analyses from multiple views to determine 3D shape
 */
async function combineViewAnalyses(viewAnalyses) {
  const analysesText = Object.entries(viewAnalyses)
    .map(([view, analysis]) => `${view}: ${JSON.stringify(analysis)}`)
    .join('\n');
  
  const prompt = `You are a 3D reconstruction expert.

Given these analyses from different views of the same object:

${analysesText}

Determine the accurate 3D shape and dimensions. Consider:
- Front view shows width and height
- Side view shows depth and height  
- Top view shows width and depth
- Cylindrical objects appear as rectangles in some views and circles in others
- Cross-sections help determine if object is round or rectangular

Provide a reconstruction plan as JSON:
{
  "finalShape": "cylinder|box|sphere|custom",
  "dimensions": {
    "width": number (normalized 0-2 range),
    "height": number (normalized 0-2 range),
    "depth": number (normalized 0-2 range)
  },
  "crossSection": "circular|rectangular|elliptical",
  "shouldRotate": boolean (if object needs rotation to match views),
  "confidence": number (0-1),
  "reasoning": "explanation of how dimensions were determined"
}`;

  try {
    const response = await axios.post(
      `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_MODEL}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`,
      {
        messages: [
          {
            role: 'system',
            content: 'You are an expert 3D reconstruction assistant. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 1500
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': process.env.AZURE_OPENAI_API_KEY
        }
      }
    );

    const content = response.data.choices[0].message.content;
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
    const reconstruction = JSON.parse(jsonMatch ? jsonMatch[1] || jsonMatch[0] : content);
    
    console.log('\n🧠 AI Reconstruction Plan:', JSON.stringify(reconstruction, null, 2));
    return reconstruction;
    
  } catch (error) {
    console.warn('   ⚠️  AI reconstruction failed:');
    console.warn(`      Error: ${error.message}`);
    if (error.response) {
      console.warn(`      Status: ${error.response.status}`);
      console.warn(`      Data: ${JSON.stringify(error.response.data)}`);
    }
    console.warn(`      Using fallback reconstruction...`);
    return {
      finalShape: 'box',
      dimensions: { width: 1.0, height: 0.6, depth: 0.4 },
      crossSection: 'rectangular',
      shouldRotate: false,
      confidence: 0.3,
      reasoning: 'Fallback to box shape due to AI error'
    };
  }
}

/**
 * Generate 3D mesh based on AI reconstruction plan
 */
function generateMeshFromPlan(reconstruction, polygonsData) {
  const { finalShape, dimensions, crossSection } = reconstruction;
  
  console.log('\n🔨 Generating 3D mesh from AI plan...');
  console.log(`   Shape: ${finalShape}`);
  console.log(`   Dimensions: ${dimensions.width.toFixed(2)} x ${dimensions.height.toFixed(2)} x ${dimensions.depth.toFixed(2)}`);
  console.log(`   Cross-section: ${crossSection}`);
  
  // If it's a cylinder, generate proper cylindrical mesh
  if (finalShape === 'cylinder' || crossSection === 'circular' || crossSection === 'elliptical') {
    console.log('   🎯 Creating PROPER cylindrical mesh!');
    
    // Extract colors from polygon data
    const colors = polygonsData.map(p => p.color).filter(c => c && c.length === 3);
    
    // Use average radius from height and depth
    const radius = (dimensions.height + dimensions.depth) / 4; // Divide by 4 to get radius, not diameter
    const height = dimensions.width;
    
    // Check if we have color bands (like a resistor)
    const hasMultipleColors = colors.length > 2;
    
    if (hasMultipleColors && colors.length >= 4) {
      // Generate COMPLETE resistor with wire leads!
      console.log(`   🔌 Detected ${colors.length} colored bands - creating RESISTOR with WIRE LEADS`);
      
      const segments = resistorGenerator.generateResistor({
        totalHeight: height,
        bodyRadius: radius,
        colorBands: colors.slice(1, 5), // Use middle 4 colors as bands (skip body color)
        radialSegments: 32
      });
      
      const geometryData = resistorGenerator.combineSegments(segments);
      
      return {
        geometryData,
        depth: height,
        shouldUseCylindricalMapping: true,
        usedProceduralMesh: true
      };
    } else {
      // Simple solid cylinder
      console.log('   🎯 Creating simple solid cylinder');
      const geometryData = meshGenerator.generateCylinder({
        radius,
        height,
        radialSegments: 32,
        color: colors[0] || [0.8, 0.7, 0.6]
      });
      
      return {
        geometryData,
        depth: height,
        shouldUseCylindricalMapping: true,
        usedProceduralMesh: true
      };
    }
  } else {
    // For box shapes, use depth from AI analysis
    console.log('   📦 Creating box extrusion');
    return {
      depth: dimensions.depth,
      shouldUseCylindricalMapping: false,
      usedProceduralMesh: false
    };
  }
}

/**
 * Main intelligent multi-view converter
 */
async function convertMultiViewSVGto3DIntelligent(svgFiles, options = {}) {
  const outputPath = options.outputPath || path.join(
    path.dirname(svgFiles[0].path),
    '../exports',
    `intelligent-multiview-${Date.now()}.glb`
  );
  
  console.log('🎯 INTELLIGENT Multi-View SVG to 3D Pipeline');
  console.log(`📁 Processing ${svgFiles.length} view(s) with AI analysis`);
  console.log('================================================\n');
  
  // Step 1: Parse all views
  const views = {};
  for (const file of svgFiles) {
    console.log(`📷 Parsing ${file.view} view: ${path.basename(file.path)}`);
    const polygons = svgTo3DPure.parseSVGToPolygons(file.path);
    views[file.view] = {
      polygons,
      path: file.path
    };
    console.log(`   ✅ Found ${polygons.length} shapes with colors`);
  }
  
  // Step 2: AI analysis of each view
  console.log('\n🤖 Analyzing views with Azure OpenAI GPT-4.1...');
  const viewAnalyses = {};
  
  for (const file of svgFiles) {
    console.log(`\n   Analyzing ${file.view} view...`);
    viewAnalyses[file.view] = await analyzeSVGWithAI(file.path, file.view);
  }
  
  // Step 3: Combine analyses to determine 3D shape
  console.log('\n🧠 Combining analyses for 3D reconstruction...');
  const reconstruction = await combineViewAnalyses(viewAnalyses);
  
  // Step 4: Generate mesh based on AI plan
  const primaryView = views.front || views.side || views.top;
  const meshPlan = generateMeshFromPlan(reconstruction, primaryView.polygons);
  
  // Step 5: Create geometry - either procedural or extruded from SVG
  const depth = options.depth || meshPlan.depth || 0.2;
  
  console.log('\n3️⃣ Creating 3D mesh with AI-determined parameters...');
  console.log(`   Using depth: ${depth.toFixed(3)}`);
  console.log(`   AI Confidence: ${(reconstruction.confidence * 100).toFixed(0)}%`);
  console.log(`   Reasoning: ${reconstruction.reasoning}`);
  
  // Create GLB
  const { Document, NodeIO } = require('@gltf-transform/core');
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh();
  
  // If we have a procedurally generated mesh, use it!
  if (meshPlan.usedProceduralMesh && meshPlan.geometryData) {
    console.log('   ✨ Using AI-generated procedural mesh');
    
    const geometryData = meshPlan.geometryData;
    
    const positionAccessor = doc.createAccessor()
      .setType('VEC3')
      .setArray(geometryData.vertices)
      .setBuffer(buffer);
    
    const normalAccessor = doc.createAccessor()
      .setType('VEC3')
      .setArray(geometryData.normals)
      .setBuffer(buffer);
    
    const indicesAccessor = doc.createAccessor()
      .setType('SCALAR')
      .setArray(geometryData.indices)
      .setBuffer(buffer);
    
    // Use vertex colors if available
    let colorAccessor = null;
    if (geometryData.colors) {
      colorAccessor = doc.createAccessor()
        .setType('VEC3')
        .setArray(geometryData.colors)
        .setBuffer(buffer);
    }
    
    const material = doc.createMaterial()
      .setName('ProceduralMesh')
      .setBaseColorFactor([0.8, 0.7, 0.6, 1.0])
      .setMetallicFactor(0.3)
      .setRoughnessFactor(0.7);
    
    const primitive = doc.createPrimitive()
      .setMode(4)
      .setAttribute('POSITION', positionAccessor)
      .setAttribute('NORMAL', normalAccessor)
      .setIndices(indicesAccessor)
      .setMaterial(material);
    
    if (colorAccessor) {
      primitive.setAttribute('COLOR_0', colorAccessor);
    }
    
    mesh.addPrimitive(primitive);
    
  } else {
    // Fall back to SVG extrusion
    console.log('   📐 Using SVG extrusion method');
    const polygonsData = primaryView.polygons;
    
    for (let polyIdx = 0; polyIdx < polygonsData.length; polyIdx++) {
      const polygonObj = polygonsData[polyIdx];
      const polygon = polygonObj.points;
      const color = polygonObj.color;
      
      // Extrude with AI-determined depth
      const geometryData = svgTo3DPure.extrudePolygonTo3D(polygon, depth);
    
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
    
      const material = doc.createMaterial()
        .setName(`Material_${polyIdx}`)
        .setBaseColorFactor([...color, 1.0])
        .setMetallicFactor(meshPlan.shouldUseCylindricalMapping ? 0.3 : 0.0)
        .setRoughnessFactor(0.7);
      
      const primitive = doc.createPrimitive()
        .setMode(4)
        .setAttribute('POSITION', positionAccessor)
        .setAttribute('NORMAL', normalAccessor)
        .setIndices(indicesAccessor)
        .setMaterial(material);
      
      mesh.addPrimitive(primitive);
    }
  }  const node = doc.createNode().setMesh(mesh);
  const scene = doc.createScene().addChild(node);
  doc.getRoot().setDefaultScene(scene);
  
  const exportsDir = path.dirname(outputPath);
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  
  const io = new NodeIO();
  await io.write(outputPath, doc);
  
  const fileStats = fs.statSync(outputPath);
  
  console.log('\n✅ INTELLIGENT MULTI-VIEW PIPELINE COMPLETE!');
  console.log(`📦 Output: ${path.basename(outputPath)}`);
  console.log(`📊 Size: ${(fileStats.size / 1024).toFixed(2)} KB`);
  console.log(`🎨 Views analyzed: ${Object.keys(views).join(', ')}`);
  console.log(`🤖 AI Shape: ${reconstruction.finalShape}`);
  console.log(`📏 Final Depth: ${depth.toFixed(3)}`);
  console.log(`✨ Procedural Mesh: ${meshPlan.usedProceduralMesh ? 'YES' : 'No (SVG extrusion)'}`);
  
  return {
    success: true,
    glbPath: outputPath,
    stats: {
      views: Object.keys(views),
      totalPolygons: meshPlan.usedProceduralMesh ? 'procedural' : primaryView.polygons.length,
      aiAnalysis: reconstruction,
      depth: depth,
      hasColors: true,
      aiPowered: true
    }
  };
}

module.exports = {
  convertMultiViewSVGto3DIntelligent,
  analyzeSVGWithAI,
  combineViewAnalyses
};
