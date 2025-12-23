#!/bin/bash

echo "🧪 Testing Complex SVG (IC Chip) with AI-Powered Multi-View"
echo "=============================================================="
echo ""

BASE_URL="http://localhost:5000"

echo "📦 Complex IC Chip with 28+ pins and multiple materials"
echo "-----------------------------------------------------------"
echo "Processing 3 views: front (face), side (thickness), top (pins)"
echo ""

curl -X POST "$BASE_URL/api/svg-to-3d-intelligent" \
  -F "files=@uploads/complex-ic-chip-front.svg" \
  -F "files=@uploads/complex-ic-chip-side.svg" \
  -F "files=@uploads/complex-ic-chip-top.svg" \
  -F "views=front,side,top" \
  -H "Content-Type: multipart/form-data" | jq '.'

echo ""
echo ""
echo "✅ Test complete!"
echo ""
echo "The AI should analyze:"
echo "  - Front view: IC body + 28 pins + text markings"
echo "  - Side view: Body thickness + bent pins"
echo "  - Top view: Square body + pin layout"
echo ""
echo "Expected output:"
echo "  - Shape: box or custom (IC chip)"
echo "  - Multiple materials (black body, silver pins, markings)"
echo "  - Accurate dimensions from 3 perspectives"
echo ""
echo "View result at: https://gltf-viewer.donmccurdy.com/"
