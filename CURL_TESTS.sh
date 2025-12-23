#!/bin/bash

# 🎯 Clean SVG to 3D Pipeline - Quick Test Commands
# 
# Make sure your server is running: node server.js

echo "🎯 Clean SVG to 3D Pipeline - Test Commands"
echo "==========================================="
echo ""

# Basic curl command - replace 'path/to/your/file.svg' with actual SVG file
echo "1️⃣ Basic conversion (default depth: 0.1):"
echo "-------------------------------------------"
echo 'curl -X POST http://localhost:5000/api/blender/svg-to-3d-clean \'
echo '  -F "file=@uploads/1766468979717-logo.svg"'
echo ""

echo "2️⃣ Custom depth (0.2 units):"
echo "-------------------------------------------"
echo 'curl -X POST http://localhost:5000/api/blender/svg-to-3d-clean \'
echo '  -F "file=@uploads/1766468979717-logo.svg" \'
echo '  -F "depth=0.2"'
echo ""

echo "3️⃣ With smooth shading:"
echo "-------------------------------------------"
echo 'curl -X POST http://localhost:5000/api/blender/svg-to-3d-clean \'
echo '  -F "file=@uploads/1766468979717-logo.svg" \'
echo '  -F "depth=0.15" \'
echo '  -F "smoothing=true"'
echo ""

echo "4️⃣ Pretty JSON output (with jq):"
echo "-------------------------------------------"
echo 'curl -X POST http://localhost:5000/api/blender/svg-to-3d-clean \'
echo '  -F "file=@uploads/1766468979717-logo.svg" | jq "."'
echo ""

echo "💡 Tips:"
echo "  - Replace file path with your actual SVG file"
echo "  - Check exports/ folder for output GLB files"
echo "  - View at: http://localhost:5000/exports/clean-3d-*.glb"
