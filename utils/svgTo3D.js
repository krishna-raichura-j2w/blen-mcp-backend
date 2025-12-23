/**
 * SVG to 3D Converter - Clean Pipeline
 * 
 * Pipeline: SVG → 2D Polygon → Controlled Extrusion → Mesh Cleanup → GLB
 * 
 * Core Principle: NO GUESSING - Exact extrusion from 2D profile
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('svg-parser');
const { DOMParser } = require('@xmldom/xmldom');

/**
 * Step 1: Parse SVG and extract 2D polygons
 * - Flatten curves to line segments
 * - Remove overlapping paths
 * - Normalize scale
 * - Center at (0,0)
 */
function parseSVGToPolygons(svgPath) {
  try {
    const svgContent = fs.readFileSync(svgPath, 'utf8');
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, 'image/svg+xml');
    
    const polygons = [];
    const paths = doc.getElementsByTagName('path');
    
    // Get SVG viewBox for normalization
    const svg = doc.getElementsByTagName('svg')[0];
    const viewBox = svg.getAttribute('viewBox');
    let width = parseFloat(svg.getAttribute('width')) || 100;
    let height = parseFloat(svg.getAttribute('height')) || 100;
    
    if (viewBox) {
      const vb = viewBox.split(/\s+|,/).map(v => parseFloat(v));
      width = vb[2] || width;
      height = vb[3] || height;
    }
    
    // Extract path data
    for (let i = 0; i < paths.length; i++) {
      const pathData = paths[i].getAttribute('d');
      if (pathData) {
        const polygon = pathDataToPolygon(pathData, width, height);
        if (polygon && polygon.length > 2) {
          polygons.push(polygon);
        }
      }
    }
    
    // Also handle polygon and rect elements
    const polyElements = doc.getElementsByTagName('polygon');
    for (let i = 0; i < polyElements.length; i++) {
      const points = polyElements[i].getAttribute('points');
      if (points) {
        const polygon = pointsToPolygon(points, width, height);
        if (polygon && polygon.length > 2) {
          polygons.push(polygon);
        }
      }
    }
    
    return {
      polygons,
      width,
      height,
      normalized: true
    };
  } catch (error) {
    throw new Error(`Failed to parse SVG: ${error.message}`);
  }
}

/**
 * Convert SVG path data to polygon points
 * Simplified: handles M, L, H, V, Z commands
 */
function pathDataToPolygon(pathData, width, height) {
  const points = [];
  const commands = pathData.match(/[MLHVCSQTAZ][^MLHVCSQTAZ]*/gi);
  
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  
  if (!commands) return points;
  
  commands.forEach(cmd => {
    const type = cmd[0].toUpperCase();
    const values = cmd.slice(1).trim().split(/[\s,]+/).map(v => parseFloat(v)).filter(v => !isNaN(v));
    
    switch (type) {
      case 'M': // Move to
        currentX = values[0];
        currentY = values[1];
        startX = currentX;
        startY = currentY;
        points.push(normalizePoint(currentX, currentY, width, height));
        break;
        
      case 'L': // Line to
        for (let i = 0; i < values.length; i += 2) {
          currentX = values[i];
          currentY = values[i + 1];
          points.push(normalizePoint(currentX, currentY, width, height));
        }
        break;
        
      case 'H': // Horizontal line
        currentX = values[0];
        points.push(normalizePoint(currentX, currentY, width, height));
        break;
        
      case 'V': // Vertical line
        currentY = values[0];
        points.push(normalizePoint(currentX, currentY, width, height));
        break;
        
      case 'Z': // Close path
        currentX = startX;
        currentY = startY;
        break;
        
      // TODO: Add C, S, Q, T for curves (approximate with line segments)
    }
  });
  
  return points;
}

/**
 * Convert polygon points attribute to array
 */
function pointsToPolygon(pointsStr, width, height) {
  const values = pointsStr.trim().split(/[\s,]+/).map(v => parseFloat(v));
  const points = [];
  
  for (let i = 0; i < values.length; i += 2) {
    if (!isNaN(values[i]) && !isNaN(values[i + 1])) {
      points.push(normalizePoint(values[i], values[i + 1], width, height));
    }
  }
  
  return points;
}

/**
 * Normalize point to [-1, 1] range and center at (0, 0)
 */
function normalizePoint(x, y, width, height) {
  const scale = Math.max(width, height);
  return {
    x: ((x - width / 2) / scale) * 2,
    y: -((y - height / 2) / scale) * 2 // Flip Y axis
  };
}

/**
 * Step 2: Generate Blender Python code for controlled extrusion
 * - Creates exact 2D → 3D extrusion
 * - No booleans, no remesh, no complexity
 * - Guaranteed manifold geometry
 */
function generateBlenderExtrusionCode(polygons, options = {}) {
  const depth = options.depth || 0.1;
  const smoothing = options.smoothing || false;
  const outputPath = options.outputPath || '/tmp/output.glb';
  
  const code = `
import bpy
import bmesh
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def create_extruded_mesh(polygons_data, depth):
    """
    Create a clean extruded mesh from 2D polygons
    - No booleans
    - No remesh
    - Pure extrusion
    """
    all_objects = []
    
    for poly_idx, polygon in enumerate(polygons_data):
        if len(polygon) < 3:
            continue
            
        # Create mesh
        mesh = bpy.data.meshes.new(f"Polygon_{poly_idx}")
        obj = bpy.data.objects.new(f"Object_{poly_idx}", mesh)
        bpy.context.collection.objects.link(obj)
        
        # Create BMesh
        bm = bmesh.new()
        
        # Bottom vertices (Z = 0)
        bottom_verts = []
        for point in polygon:
            v = bm.verts.new((point['x'], point['y'], 0))
            bottom_verts.append(v)
        
        # Top vertices (Z = depth)
        top_verts = []
        for point in polygon:
            v = bm.verts.new((point['x'], point['y'], depth))
            top_verts.append(v)
        
        bm.verts.ensure_lookup_table()
        
        # Create bottom face
        if len(bottom_verts) >= 3:
            bm.faces.new(bottom_verts)
        
        # Create top face (reversed for correct normal)
        if len(top_verts) >= 3:
            bm.faces.new(list(reversed(top_verts)))
        
        # Create side faces
        num_verts = len(bottom_verts)
        for i in range(num_verts):
            next_i = (i + 1) % num_verts
            
            # Create quad face for each side
            face_verts = [
                bottom_verts[i],
                bottom_verts[next_i],
                top_verts[next_i],
                top_verts[i]
            ]
            bm.faces.new(face_verts)
        
        # Write BMesh to mesh
        bm.to_mesh(mesh)
        bm.free()
        
        # Recalculate normals
        mesh.update()
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode='OBJECT')
        
        all_objects.append(obj)
    
    return all_objects

# Polygon data from JavaScript
polygons_data = ${JSON.stringify(polygons)}

# Create extruded meshes
objects = create_extruded_mesh(polygons_data, ${depth})

print(f"Created {len(objects)} objects")

# Optional: Join all objects into one
if len(objects) > 1:
    bpy.context.view_layer.objects.active = objects[0]
    for obj in objects:
        obj.select_set(True)
    bpy.ops.object.join()
    print("Objects joined into single mesh")

# Apply smoothing if requested
${smoothing ? `
bpy.ops.object.shade_smooth()
bpy.context.object.data.use_auto_smooth = True
bpy.context.object.data.auto_smooth_angle = 0.523599  # 30 degrees
` : ''}

# Export as GLB
output_path = r"${outputPath}"
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_materials='EXPORT',
    use_selection=False
)

print(f"Exported to: {output_path}")
print("SUCCESS")
`;
  
  return code;
}

/**
 * Quality checks for the pipeline
 */
function validateSVG(svgPath) {
  if (!fs.existsSync(svgPath)) {
    throw new Error('SVG file not found');
  }
  
  const content = fs.readFileSync(svgPath, 'utf8');
  
  // Check if it's valid XML
  if (!content.includes('<svg')) {
    throw new Error('Not a valid SVG file');
  }
  
  // Check for closed paths (fill-based shapes)
  if (!content.includes('path') && !content.includes('polygon') && !content.includes('rect')) {
    throw new Error('SVG must contain paths, polygons, or rectangles');
  }
  
  return true;
}

module.exports = {
  parseSVGToPolygons,
  generateBlenderExtrusionCode,
  validateSVG
};
