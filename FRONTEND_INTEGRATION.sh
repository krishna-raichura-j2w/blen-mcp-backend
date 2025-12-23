#!/bin/bash

echo "🎯 AI-Powered Multi-View SVG to 3D - cURL Examples for Frontend Integration"
echo "=========================================================================="
echo ""

BASE_URL="http://localhost:5000"

# Example 1: Single View (simplest)
echo "Example 1: Single SVG View"
echo "-----------------------------------------------------------"
echo "curl -X POST \"$BASE_URL/api/svg-to-3d-intelligent\" \\"
echo "  -F \"files=@your-file.svg\" \\"
echo "  -F \"views=front\""
echo ""
echo "Response:"
cat << 'EOF'
{
  "success": true,
  "glbUrl": "http://localhost:5000/exports/intelligent-multiview-123.glb",
  "stats": {
    "views": ["front"],
    "totalPolygons": 7,
    "aiAnalysis": {
      "finalShape": "cylinder",
      "dimensions": { "width": 2, "height": 0.48, "depth": 0.48 },
      "confidence": 0.95
    }
  }
}
EOF
echo ""
echo ""

# Example 2: Two Views (front + side)
echo "Example 2: Two Views (Better Accuracy)"
echo "-----------------------------------------------------------"
echo "curl -X POST \"$BASE_URL/api/svg-to-3d-intelligent\" \\"
echo "  -F \"files=@front-view.svg\" \\"
echo "  -F \"files=@side-view.svg\" \\"
echo "  -F \"views=front,side\""
echo ""
echo ""

# Example 3: Three Views (Best - front, side, top)
echo "Example 3: Three Views (Highest Accuracy)"
echo "-----------------------------------------------------------"
echo "curl -X POST \"$BASE_URL/api/svg-to-3d-intelligent\" \\"
echo "  -F \"files=@front-view.svg\" \\"
echo "  -F \"files=@side-view.svg\" \\"
echo "  -F \"files=@top-view.svg\" \\"
echo "  -F \"views=front,side,top\""
echo ""
echo ""

# Example 4: With custom depth override
echo "Example 4: With Custom Depth Override"
echo "-----------------------------------------------------------"
echo "curl -X POST \"$BASE_URL/api/svg-to-3d-intelligent\" \\"
echo "  -F \"files=@front-view.svg\" \\"
echo "  -F \"views=front\" \\"
echo "  -F \"depth=0.5\""
echo ""
echo ""

echo "=========================================================================="
echo ""
echo "📋 Frontend Integration Guide"
echo "=========================================================================="
echo ""
echo "JavaScript (Fetch API):"
echo "-----------------------------------------------------------"
cat << 'EOF'
const formData = new FormData();
formData.append('files', frontViewFile);  // File object from input
formData.append('files', sideViewFile);   // Optional
formData.append('files', topViewFile);    // Optional
formData.append('views', 'front,side,top');

fetch('http://localhost:5000/api/svg-to-3d-intelligent', {
  method: 'POST',
  body: formData
})
.then(response => response.json())
.then(data => {
  console.log('GLB URL:', data.glbUrl);
  console.log('AI Analysis:', data.stats.aiAnalysis);
  // Download or display the GLB file
  window.open(data.glbUrl, '_blank');
});
EOF
echo ""
echo ""

echo "React Example:"
echo "-----------------------------------------------------------"
cat << 'EOF'
const handleUpload = async (files) => {
  const formData = new FormData();
  
  files.forEach(file => {
    formData.append('files', file);
  });
  
  formData.append('views', 'front,side,top');
  
  const response = await fetch('http://localhost:5000/api/svg-to-3d-intelligent', {
    method: 'POST',
    body: formData
  });
  
  const result = await response.json();
  
  if (result.success) {
    setGlbUrl(result.glbUrl);
    setAiAnalysis(result.stats.aiAnalysis);
  }
};
EOF
echo ""
echo ""

echo "Axios Example:"
echo "-----------------------------------------------------------"
cat << 'EOF'
import axios from 'axios';

const formData = new FormData();
formData.append('files', frontViewFile);
formData.append('files', sideViewFile);
formData.append('views', 'front,side');

const response = await axios.post(
  'http://localhost:5000/api/svg-to-3d-intelligent',
  formData,
  {
    headers: { 'Content-Type': 'multipart/form-data' }
  }
);

console.log('GLB URL:', response.data.glbUrl);
console.log('Shape:', response.data.stats.aiAnalysis.finalShape);
console.log('Confidence:', response.data.stats.aiAnalysis.confidence);
EOF
echo ""
echo ""

echo "=========================================================================="
echo ""
echo "📝 API Specification"
echo "=========================================================================="
echo ""
echo "Endpoint: POST /api/svg-to-3d-intelligent"
echo ""
echo "Request Parameters (multipart/form-data):"
echo "  • files (required): Array of 1-3 SVG files"
echo "  • views (required): Comma-separated view names (e.g., 'front,side,top')"
echo "  • depth (optional): Manual depth override (float, e.g., 0.5)"
echo ""
echo "Supported Views:"
echo "  • front - Front face of object"
echo "  • side  - Side profile"
echo "  • top   - Top-down view"
echo ""
echo "Response Format:"
echo "  • success (boolean): Operation status"
echo "  • glbUrl (string): URL to download GLB file"
echo "  • glbPath (string): Server file path"
echo "  • stats.views (array): Processed view names"
echo "  • stats.totalPolygons (number): Number of shapes"
echo "  • stats.aiAnalysis (object): AI analysis results"
echo "    - finalShape: 'cylinder' | 'box' | 'sphere' | 'custom'"
echo "    - dimensions: { width, height, depth }"
echo "    - crossSection: 'circular' | 'rectangular' | 'elliptical'"
echo "    - confidence: 0-1 (e.g., 0.95 = 95%)"
echo "    - reasoning: AI explanation"
echo ""
echo "Error Response:"
echo "  • success: false"
echo "  • error: Error message"
echo ""
echo "=========================================================================="
echo ""
echo "🧪 Test the API now:"
echo "-----------------------------------------------------------"
echo "cd uploads && ls -1 *.svg | head -3"
