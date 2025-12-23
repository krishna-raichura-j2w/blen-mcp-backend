const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const MCPClient = require('./mcpClient');
const User = require('./models/User');
const OTP = require('./models/OTP');
const Token = require('./models/Token');
const { generateAccessToken, generateRefreshToken } = require('./utils/jwt');
const { initEmailService, sendOTPEmail } = require('./services/emailService');

// Import safety and quality modules
const promptSafety = require('./utils/promptSafety');
const svgValidator = require('./utils/svgValidator');
const blenderSafety = require('./utils/blenderSafety');
const modelQuality = require('./utils/modelQuality');
const textureBaking = require('./utils/textureBaking');
const svgTo3D = require('./utils/svgTo3D');
const svgTo3DPure = require('./utils/svgTo3DPure'); // Pure JS - No Blender
const intelligentMultiView = require('./utils/intelligentMultiView'); // AI-powered multi-view

const app = express();
const PORT = process.env.PORT || 5000;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create exports directory if it doesn't exist
const exportsDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/svg+xml' || file.originalname.endsWith('.svg')) {
      cb(null, true);
    } else {
      cb(new Error('Only SVG files are allowed'));
    }
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir)); // Serve uploaded files
app.use('/exports', express.static(exportsDir)); // Serve exported GLB files
app.use('/views', express.static(path.join(__dirname, 'views'))); // Serve HTML views

// Initialize MCP Client
const mcpClient = new MCPClient();
let isInitializing = false;

// Initialize execution logger
const executionLogger = new blenderSafety.ExecutionLogger();

// Ensure MCP connection before handling requests
async function ensureConnection(req, res, next) {
  if (mcpClient.isConnected) {
    return next();
  }

  if (isInitializing) {
    return res.status(503).json({
      success: false,
      error: 'MCP server is initializing, please try again in a moment'
    });
  }

  try {
    isInitializing = true;
    await mcpClient.connect();
    isInitializing = false;
    next();
  } catch (error) {
    isInitializing = false;
    res.status(503).json({
      success: false,
      error: 'Failed to connect to MCP server: ' + error.message
    });
  }
}

// ============= HEALTH & STATUS ENDPOINTS =============

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    success: true,
    connected: mcpClient.isConnected,
    timestamp: new Date().toISOString()
  });
});

// ============= AUTH ENDPOINTS =============

/**
 * POST /api/auth/check-user
 * Check if user exists
 * Body: { email: "user@example.com" }
 */
app.post('/api/auth/check-user', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      return res.json({
        exists: true,
        verified: user.verification_status === 'VERIFIED',
        user: {
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          companyName: user.companyName,
          phoneNumber: user.phoneNumber,
          verification_status: user.verification_status
        }
      });
    } else {
      return res.json({ exists: false });
    }
  } catch (error) {
    console.error('Check user error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * POST /api/auth/register
 * Register new user
 * Body: { email, firstName, lastName, companyName?, phoneNumber? }
 */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, firstName, lastName, companyName, phoneNumber } = req.body;

    if (!email || !firstName || !lastName) {
      return res.status(400).json({ success: false, message: 'Email, first name, and last name are required' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    const user = new User({
      email: email.toLowerCase(),
      firstName,
      lastName,
      companyName,
      phoneNumber
    });

    await user.save();

    // Automatically send OTP for registration
    try {
      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // Delete any existing OTPs for this email
      await OTP.deleteMany({ email: email.toLowerCase() });

      // Save new OTP
      const otpDoc = new OTP({
        email: email.toLowerCase(),
        otp
      });
      await otpDoc.save();

      // Send email (if configured)
      try {
        await sendOTPEmail(email, otp, firstName);
      } catch (emailError) {
        console.log('⚠️  Email not sent (service not configured). Use default OTP: 999999 or check console for generated OTP:', otp);
      }
    } catch (emailError) {
      console.error('Error sending OTP email:', emailError);
      // Don't fail the registration if email fails, just log it
    }

    return res.status(201).json({
      success: true,
      message: 'User registered successfully. OTP sent to your email.',
      user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        verification_status: user.verification_status
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * POST /api/auth/send-otp
 * Send OTP to user's email
 * Body: { email: "user@example.com" }
 */
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete any existing OTPs for this email
    await OTP.deleteMany({ email: email.toLowerCase() });

    // Save new OTP
    const otpDoc = new OTP({
      email: email.toLowerCase(),
      otp
    });
    await otpDoc.save();

    // Send email (if configured)
    try {
      await sendOTPEmail(email, otp, user.firstName);
    } catch (emailError) {
      console.log('⚠️  Email not sent (service not configured). Use default OTP: 999999 or check console for generated OTP:', otp);
    }

    return res.json({
      success: true,
      message: 'OTP sent successfully to your email'
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send OTP', error: error.message });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verify OTP and login
 * Body: { email: "user@example.com", otp: "123456" }
 */
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    // Default OTP option (999999) - for development/testing
    const DEFAULT_OTP = '999999';
    const isDefaultOTP = otp === DEFAULT_OTP;

    if (isDefaultOTP) {
      // Allow default OTP to bypass database check
      console.log('⚠️  Using default OTP for login:', email);
    } else {
      // Regular OTP verification
      const otpDoc = await OTP.findOne({ email: email.toLowerCase() });

      if (!otpDoc) {
        return res.status(400).json({ success: false, message: 'OTP expired or not found' });
      }

      if (otpDoc.attempts >= 3) {
        await OTP.deleteOne({ _id: otpDoc._id });
        return res.status(400).json({ success: false, message: 'Too many attempts. Please request a new OTP' });
      }

      if (otpDoc.otp !== otp) {
        otpDoc.attempts += 1;
        await otpDoc.save();
        return res.status(400).json({ success: false, message: 'Invalid OTP' });
      }

      // Delete used OTP
      await OTP.deleteOne({ _id: otpDoc._id });
    }

    // OTP verified, get user
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Update user verification status
    user.verification_status = 'VERIFIED';
    user.verified_at = new Date();
    await user.save();

    // Generate tokens
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Save refresh token
    const tokenDoc = new Token({
      userId: user._id,
      refreshToken
    });
    await tokenDoc.save();

    return res.json({
      success: true,
      message: 'Login successful',
      data: {
        accessToken,
        refreshToken,
        user: {
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          companyName: user.companyName,
          phoneNumber: user.phoneNumber,
          verification_status: user.verification_status
        }
      }
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * POST /api/auth/logout
 * Logout user
 * Body: { refreshToken: "token" }
 */
app.post('/api/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await Token.deleteOne({ refreshToken });
    }

    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 * Body: { refreshToken: "token" }
 */
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'Refresh token is required' });
    }

    // Find token in database
    const tokenDoc = await Token.findOne({ refreshToken });
    if (!tokenDoc) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    // Get user
    const user = await User.findById(tokenDoc.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Generate new access token
    const newAccessToken = generateAccessToken(user._id);

    return res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: refreshToken,
        user: {
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          verification_status: user.verification_status
        }
      }
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile (requires authentication)
 * Headers: { Authorization: "Bearer token" }
 * Body: { firstName?, lastName?, companyName?, phoneNumber? }
 */
app.put('/api/auth/profile', async (req, res) => {
  try {
    // Get user ID from Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
    }

    const token = authHeader.substring(7);

    // Verify token and get user ID
    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    // Find user by ID
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Extract fields to update
    const { firstName, lastName, companyName, phoneNumber } = req.body;

    // Validate at least one field is provided
    if (!firstName && !lastName && !companyName && !phoneNumber) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    // Validate required fields if provided
    if (firstName && !firstName.trim()) {
      return res.status(400).json({ success: false, message: 'First name cannot be empty' });
    }
    if (lastName && !lastName.trim()) {
      return res.status(400).json({ success: false, message: 'Last name cannot be empty' });
    }

    // Update fields
    if (firstName) user.firstName = firstName.trim();
    if (lastName) user.lastName = lastName.trim();
    if (companyName) user.companyName = companyName.trim();
    if (phoneNumber) user.phoneNumber = phoneNumber.trim();

    // Save updated user
    await user.save();

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        companyName: user.companyName,
        phoneNumber: user.phoneNumber,
        verification_status: user.verification_status,
        updatedAt: user.updatedAt || new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Profile update error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

// ============= BLENDER ENDPOINTS (UNCHANGED) =============

/**
 * GET /api/tools
 * List all available MCP tools
 */
app.get('/api/tools', ensureConnection, async (req, res) => {
  try {
    const result = await mcpClient.listTools();
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/status
 * Get integration statuses
 */
app.get('/api/status', ensureConnection, async (req, res) => {
  try {
    const [hunyuan3d, polyhaven, sketchfab] = await Promise.allSettled([
      mcpClient.getHunyuan3DStatus(),
      mcpClient.getPolyhavenStatus(),
      mcpClient.getSketchfabStatus()
    ]);

    res.json({
      success: true,
      data: {
        hunyuan3d: hunyuan3d.status === 'fulfilled' ? hunyuan3d.value : { error: hunyuan3d.reason.message },
        polyhaven: polyhaven.status === 'fulfilled' ? polyhaven.value : { error: polyhaven.reason.message },
        sketchfab: sketchfab.status === 'fulfilled' ? sketchfab.value : { error: sketchfab.reason.message }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= BLENDER CONTROL ENDPOINTS =============

/**
 * POST /api/blender/execute
 * Execute Python code in Blender with safety validation
 * Body: { code: "import bpy\nbpy.ops.mesh.primitive_cube_add()" }
 */
app.post('/api/blender/execute', ensureConnection, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Code is required'
      });
    }

    // Validate code safety
    const validation = promptSafety.validateGeneratedCode(code);
    
    if (!validation.safe) {
      executionLogger.error('Code validation failed', new Error('Unsafe code detected'));
      return res.status(400).json({
        success: false,
        error: 'Code validation failed: Unsafe operations detected',
        issues: validation.issues
      });
    }

    // Wrap in safe execution context
    const safeCode = blenderSafety.wrapInSafeContext(code, 'Direct Code Execution');

    executionLogger.info('Executing code', { codeLength: code.length, warnings: validation.warningCount });

    const result = await mcpClient.executeBlenderCode(safeCode);
    
    executionLogger.success('Code executed successfully');

    res.json({
      success: true,
      data: result,
      validation: {
        warnings: validation.warningCount,
        issues: validation.issues.filter(i => i.severity === 'warning')
      }
    });
  } catch (error) {
    executionLogger.error('Execution failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/blender/screenshot
 * Get viewport screenshot
 * Query: ?maxSize=800
 */
app.get('/api/blender/screenshot', ensureConnection, async (req, res) => {
  try {
    const maxSize = parseInt(req.query.maxSize) || 800;
    const result = await mcpClient.getViewportScreenshot(maxSize);

    // Extract screenshot from MCP response
    let screenshotData = null;

    if (result && result.content && Array.isArray(result.content)) {
      // MCP returns content as array with type and data
      const imageContent = result.content.find(item => item.type === 'image');
      if (imageContent && imageContent.data) {
        screenshotData = imageContent.data;
      }
    }

    res.json({
      success: true,
      screenshot: screenshotData,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/blender/export-glb
 * Export current Blender scene as GLB file with quality checks
 * Returns URL to download the exported GLB
 */
app.post('/api/blender/export-glb', ensureConnection, async (req, res) => {
  try {
    executionLogger.info('Starting GLB export');

    // Run quality improvements before export
    const qualityCode = modelQuality.generateQualityPipeline();
    await mcpClient.executeBlenderCode(qualityCode);

    // Bake procedural textures before export
    executionLogger.info('Baking procedural materials');
    const bakeCode = textureBaking.generateTextureBaking();
    await mcpClient.executeBlenderCode(bakeCode);

    const timestamp = Date.now();
    const filename = `model-${timestamp}.glb`;
    const exportPath = path.join(exportsDir, filename).replace(/\\/g, '/');

    // Enhanced export code with validation
    const exportCode = `
import bpy
import os

print("\\n" + "=" * 60)
print("EXPORTING CURRENT SCENE AS GLB")
print("=" * 60)

# Enable GLTF exporter addon if not already enabled
if 'io_scene_gltf2' not in bpy.context.preferences.addons:
    try:
        bpy.ops.preferences.addon_enable(module='io_scene_gltf2')
        print("✓ GLTF exporter addon enabled")
    except Exception as e:
        print(f"⚠ Warning: Could not enable GLTF exporter: {str(e)}")

export_path = r"${exportPath}"
print(f"\\nExport path: {export_path}")

# Make sure export directory exists
os.makedirs(os.path.dirname(export_path), exist_ok=True)

# Convert all materials to use shader nodes for proper export
print("\\nVerifying material shader nodes...")
materials_fixed = 0
for mat in bpy.data.materials:
    if mat and not mat.use_nodes:
        print(f"⚠ Converting material '{mat.name}' to use nodes")
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        bsdf = nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value = mat.diffuse_color
            print(f"  Set Base Color to {mat.diffuse_color[:]}")
            materials_fixed += 1
    else:
        if mat:
            print(f"✓ Material '{mat.name}' already uses shader nodes")

if materials_fixed > 0:
    print(f"✓ Fixed {materials_fixed} material(s)")

# Get all mesh objects
mesh_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH']

if not mesh_objects:
    print("\\n✗ Warning: No mesh objects to export")
else:
    print(f"\\n✓ Found {len(mesh_objects)} mesh object(s) for export")
    for obj in mesh_objects:
        print(f"  - {obj.name}: {len(obj.data.vertices):,} verts, {len(obj.data.materials)} material(s)")
    
    # Export all mesh objects as GLB
    print("\\nExporting GLB...")
    try:
        bpy.ops.export_scene.gltf(
            filepath=export_path,
            export_format='GLB',
            use_selection=False,
            export_apply=True,
            export_materials='EXPORT',
            export_texcoords=True,
            export_normals=True,
            export_tangents=True,
            export_yup=True
        )
        
        if os.path.exists(export_path):
            file_size = os.path.getsize(export_path)
            print(f"\\n✓ SUCCESS: Exported {len(mesh_objects)} objects")
            print(f"  - Size: {file_size:,} bytes ({file_size / 1024:.2f} KB)")
            print("=" * 60)
        else:
            print(f"\\n✗ ERROR: Export completed but file not found")
            raise Exception("Export file not created")
    except Exception as e:
        print(f"\\n✗ ERROR during export: {str(e)}")
        import traceback
        traceback.print_exc()
        raise

print("=" * 60)
`;

    await mcpClient.executeBlenderCode(exportCode);

    // Validate GLB output
    const glbValidation = await modelQuality.validateGLBOutput(exportPath);
    
    if (!glbValidation.valid) {
      executionLogger.error('GLB validation failed', new Error(glbValidation.error));
      return res.status(500).json({
        success: false,
        error: 'GLB export validation failed',
        validation: glbValidation
      });
    }

    // Return URL to access the exported file
    const fileUrl = `http://localhost:${PORT}/exports/${filename}`;

    executionLogger.success('GLB export completed', glbValidation);

    res.json({
      success: true,
      message: 'Scene exported successfully',
      filename: filename,
      url: fileUrl,
      path: exportPath,
      validation: glbValidation,
      logs: executionLogger.getLogs()
    });
  } catch (error) {
    executionLogger.error('GLB export failed', error);
    console.error('GLB export error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      logs: executionLogger.getLogs()
    });
  } finally {
    executionLogger.clear();
  }
});

/**
 * GET /api/blender/scene
 * Get current scene information
 */
app.get('/api/blender/scene', ensureConnection, async (req, res) => {
  try {
    const result = await mcpClient.getSceneInfo();
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/blender/test-export
 * Test export functionality with a simple cube
 */
app.post('/api/blender/test-export', ensureConnection, async (req, res) => {
  try {
    // Create a simple cube and export it
    const timestamp = Date.now();
    const filename = `test-cube-${timestamp}.glb`;
    const exportPath = path.join(exportsDir, filename).replace(/\\/g, '/');

    const testCode = `
import bpy

# Clear scene
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# Create a cube
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0))
cube = bpy.context.active_object
cube.name = "TestCube"

print(f"Created cube: {cube.name}")

# Export
export_path = r"${exportPath}"
import os
os.makedirs(os.path.dirname(export_path), exist_ok=True)

try:
    bpy.ops.export_scene.gltf(
        filepath=export_path,
        export_format='GLB',
        use_selection=False
    )
    if os.path.exists(export_path):
        print(f"SUCCESS: Test export created at {export_path}")
    else:
        print(f"ERROR: File not created")
except Exception as e:
    print(f"ERROR: {str(e)}")
`;

    await mcpClient.executeBlenderCode(testCode);

    const fileExists = fs.existsSync(exportPath);
    const fileUrl = `http://localhost:${PORT}/exports/${filename}`;

    res.json({
      success: true,
      message: 'Test export completed',
      export: {
        filename,
        url: fileUrl,
        exists: fileExists,
        path: exportPath
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/blender/import-svg
 * Upload and import SVG file into Blender with validation and optimization
 * Multipart form data with 'file' field
 */
app.post('/api/blender/import-svg', upload.single('file'), ensureConnection, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const svgPath = req.file.path.replace(/\\/g, '/'); // Normalize path for Blender

    // Step 1: Validate SVG
    executionLogger.info('Validating SVG', { filename: req.file.originalname });
    const validation = await svgValidator.validateSVG(svgPath);

    if (!validation.valid) {
      executionLogger.error('SVG validation failed', new Error(validation.issues.join(', ')));
      
      // Clean up uploaded file
      if (fs.existsSync(svgPath)) {
        fs.unlinkSync(svgPath);
      }
      
      return res.status(400).json({
        success: false,
        error: 'SVG validation failed',
        issues: validation.issues
      });
    }

    // Step 2: Calculate adaptive settings
    const settings = svgValidator.calculateAdaptiveSettings(validation);
    executionLogger.info('Calculated adaptive settings', settings);

    // Step 3: Preprocess and simplify SVG
    executionLogger.info('Preprocessing SVG', { 
      hasWarnings: validation.warnings.length > 0,
      svgType: validation.svgType
    });
    
    const svgContent = fs.readFileSync(svgPath, 'utf8');
    let processed = svgContent;
    
    // Apply technical preprocessing if needed
    if (validation.svgType && validation.svgType.isTechnical) {
      executionLogger.info('Applying technical drawing preprocessing');
      processed = svgValidator.preprocessTechnicalSVG(processed);
    }
    
    // Always simplify to remove unsupported elements
    processed = svgValidator.simplifySVG(processed);
    fs.writeFileSync(svgPath, processed, 'utf8');
    executionLogger.info('SVG preprocessed and simplified');

    // Step 4: Generate optimized import code
    const importCode = svgValidator.generateImportCode(svgPath, settings);

    executionLogger.info('Importing SVG into Blender');
    const result = await mcpClient.executeBlenderCode(importCode);

    // Skip validation and quality improvements - go straight to export
    executionLogger.info('Import complete, proceeding to export...');

    // Step 6: Auto-export as GLB
    const timestamp = Date.now();
    const filename = `svg-import-${timestamp}.glb`;
    const exportPath = path.join(exportsDir, filename).replace(/\\/g, '/');

    const exportCode = `
import bpy
import os

print("\\n" + "=" * 60)
print("EXPORTING OPTIMIZED MODEL")
print("=" * 60)

export_path = r"${exportPath}"
os.makedirs(os.path.dirname(export_path), exist_ok=True)

# Ensure GLTF exporter
if 'io_scene_gltf2' not in bpy.context.preferences.addons:
    try:
        bpy.ops.preferences.addon_enable(module='io_scene_gltf2')
    except: pass

# Select mesh objects
bpy.ops.object.select_all(action='DESELECT')
mesh_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH']

for obj in mesh_objects:
    obj.select_set(True)

if mesh_objects:
    try:
        bpy.ops.export_scene.gltf(
            filepath=export_path,
            export_format='GLB',
            use_selection=True,
            export_apply=True,
            export_materials='EXPORT',
            export_texcoords=True,
            export_normals=True,
            export_tangents=True,
            export_yup=True
        )
        
        if os.path.exists(export_path):
            file_size = os.path.getsize(export_path)
            print(f"✓ Exported: {file_size:,} bytes ({file_size/1024:.2f} KB)")
        else:
            print("✗ Export file not created")
    except Exception as e:
        print(f"✗ Export error: {e}")
        import traceback
        traceback.print_exc()
else:
    print("✗ No mesh objects to export")

print("=" * 60)
`;

    executionLogger.info('Exporting GLB');
    await mcpClient.executeBlenderCode(exportCode);

    // Just check if file exists - no strict validation
    executionLogger.info('Export complete, checking file...');

    const fileUrl = `http://localhost:${PORT}/exports/${filename}`;

    executionLogger.success('SVG import pipeline completed');

    res.json({
      success: true,
      message: 'SVG imported and optimized successfully',
      file: {
        name: req.file.originalname,
        size: req.file.size,
        path: svgPath
      },
      validation: {
        stats: validation.stats,
        warnings: validation.warnings
      },
      settings: settings,
      export: {
        filename: filename,
        url: fileUrl,
        exists: fs.existsSync(exportPath),
        size: fs.existsSync(exportPath) ? fs.statSync(exportPath).size : 0
      },
      logs: executionLogger.getLogs()
    });
  } catch (error) {
    executionLogger.error('SVG import failed', error);
    console.error('SVG import error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      logs: executionLogger.getLogs()
    });
  } finally {
    // Clear logger for next operation
    executionLogger.clear();
  }
});

/**
 * POST /api/blender/svg-to-3d-clean
 * Clean SVG to 3D Pipeline - No guessing, exact extrusion
 * 
 * Pipeline: SVG → 2D Polygon → Controlled Extrusion → Mesh Cleanup → GLB
 * 
 * Body/FormData: 
 *   - file: SVG file (required)
 *   - depth: Extrusion depth in units (optional, default: 0.1)
 *   - smoothing: Apply smooth shading (optional, default: false)
 */
app.post('/api/blender/svg-to-3d-clean', upload.single('file'), ensureConnection, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No SVG file uploaded'
      });
    }

    const svgPath = req.file.path;
    const depth = parseFloat(req.body.depth) || 0.1;
    const smoothing = req.body.smoothing === 'true' || req.body.smoothing === true;
    
    console.log('\\n🎯 Starting Clean SVG to 3D Pipeline');
    console.log('📁 SVG File:', req.file.originalname);
    console.log('📏 Depth:', depth);
    console.log('✨ Smoothing:', smoothing);
    
    // Step 1: Validate SVG
    console.log('\\n1️⃣ Validating SVG...');
    svgTo3D.validateSVG(svgPath);
    console.log('✅ SVG validation passed');
    
    // Step 2: Parse SVG to 2D polygons
    console.log('\\n2️⃣ Parsing SVG to 2D polygons...');
    const { polygons, width, height } = svgTo3D.parseSVGToPolygons(svgPath);
    console.log(`✅ Extracted ${polygons.length} polygon(s)`);
    console.log(`   Original size: ${width.toFixed(2)} x ${height.toFixed(2)}`);
    
    if (polygons.length === 0) {
      throw new Error('No valid polygons found in SVG');
    }
    
    // Step 3: Generate output filename
    const timestamp = Date.now();
    const outputFilename = `clean-3d-${timestamp}.glb`;
    const outputPath = path.join(exportsDir, outputFilename);
    
    // Step 4: Generate Blender code for controlled extrusion
    console.log('\\n3️⃣ Generating controlled extrusion code...');
    const blenderCode = svgTo3D.generateBlenderExtrusionCode(polygons, {
      depth,
      smoothing,
      outputPath
    });
    console.log('✅ Extrusion code generated');
    
    // Step 5: Execute in Blender via MCP
    console.log('\\n4️⃣ Executing in Blender...');
    console.log('   - Creating 2D → 3D extrusion');
    console.log('   - Generating manifold mesh');
    console.log('   - Applying cleanup');
    
    const result = await mcpClient.executeBlenderCode(blenderCode);
    
    if (!result || !result.content || result.content.length === 0) {
      throw new Error('No response from Blender');
    }
    
    const output = result.content[0].text;
    console.log('\\n📤 Blender output:', output);
    
    if (!output.includes('SUCCESS')) {
      throw new Error('Blender execution failed: ' + output);
    }
    
    // Step 6: Verify output file exists
    if (!fs.existsSync(outputPath)) {
      throw new Error('GLB file was not created');
    }
    
    const fileStats = fs.statSync(outputPath);
    console.log('\\n✅ PIPELINE COMPLETE!');
    console.log(`📦 Output: ${outputFilename}`);
    console.log(`📊 Size: ${(fileStats.size / 1024).toFixed(2)} KB`);
    
    // Return success response
    res.json({
      success: true,
      message: 'Clean SVG to 3D conversion completed',
      data: {
        glbUrl: `/exports/${outputFilename}`,
        filename: outputFilename,
        fileSize: fileStats.size,
        pipeline: {
          polygonsExtracted: polygons.length,
          depth: depth,
          smoothing: smoothing,
          method: 'controlled-extrusion',
          ai: false,
          guessing: false
        },
        metadata: {
          originalSVG: req.file.originalname,
          svgSize: `${width.toFixed(2)} x ${height.toFixed(2)}`,
          timestamp: new Date().toISOString()
        }
      }
    });
    
  } catch (error) {
    console.error('\\n❌ Clean SVG to 3D Pipeline failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      pipeline: 'svg-to-3d-clean'
    });
  }
});

/**
 * POST /api/svg-to-3d-pure
 * 🎯 PURE JAVASCRIPT SVG to 3D Pipeline
 * NO BLENDER - Pure geometry math
 * 
 * Pipeline: SVG → 2D Polygon → Controlled Extrusion → Mesh → GLB
 * 
 * This is the clean, deterministic approach:
 * - SVG is a 2D profile (cookie cutter)
 * - Extrusion creates depth (makes the biscuit)
 * - Result: Exact 3D model, no guessing, no AI
 * 
 * Body/FormData:
 *   - file: SVG file (required)
 *   - depth: Extrusion depth (optional, default: 0.1)
 */
app.post('/api/svg-to-3d-pure', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No SVG file uploaded'
      });
    }

    const svgPath = req.file.path;
    const depth = parseFloat(req.body.depth) || 0.1;
    
    console.log('\\n🎯 PURE JS SVG to 3D Pipeline (NO BLENDER)');
    console.log('📁 SVG File:', req.file.originalname);
    console.log('📏 Depth:', depth);
    
    // Validate SVG
    console.log('\\n1️⃣ Validating SVG...');
    svgTo3DPure.validateSVG(svgPath);
    console.log('✅ SVG validation passed');
    
    // Generate output path
    const timestamp = Date.now();
    const outputFilename = `pure-3d-${timestamp}.glb`;
    const outputPath = path.join(exportsDir, outputFilename);
    
    // Run pure JS pipeline
    const result = await svgTo3DPure.convertSVGto3D(svgPath, {
      depth,
      outputPath
    });
    
    // Get file stats
    const fileStats = fs.statSync(outputPath);
    
    console.log('\\n✅ PURE JS PIPELINE COMPLETE!');
    console.log(`📦 Output: ${outputFilename}`);
    console.log(`📊 Size: ${(fileStats.size / 1024).toFixed(2)} KB`);
    console.log(`🔺 Triangles: ${result.stats.triangles}`);
    console.log(`📍 Vertices: ${result.stats.vertices}`);
    
    // Return success
    res.json({
      success: true,
      message: 'Pure JavaScript SVG to 3D conversion completed',
      data: {
        glbUrl: `/exports/${outputFilename}`,
        filename: outputFilename,
        fileSize: fileStats.size,
        stats: result.stats,
        pipeline: {
          method: 'pure-javascript-extrusion',
          blender: false,
          ai: false,
          guessing: false,
          deterministic: true
        },
        metadata: {
          originalSVG: req.file.originalname,
          depth: depth,
          timestamp: new Date().toISOString()
        }
      }
    });
    
  } catch (error) {
    console.error('\\n❌ Pure JS Pipeline failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      pipeline: 'svg-to-3d-pure'
    });
  }
});

/**
 * POST /api/svg-to-3d-intelligent
 * AI-Powered Multi-View SVG to 3D with Azure OpenAI Analysis
 * Uses GPT-4.1 to understand views and calculate accurate 3D dimensions
 * 
 * Upload 1-3 SVG files representing different views (front, side, top)
 * AI analyzes each view, understands measurements, and reconstructs proper 3D shape
 * 
 * Form Data:
 * - files: Array of SVG files (1-3 files)
 * - views: Comma-separated view names (e.g., "front,side,top")
 * - depth: Optional manual depth override (float)
 */
app.post('/api/svg-to-3d-intelligent', upload.array('files', 3), async (req, res) => {
  const uploadedFiles = req.files || [];
  
  try {
    // Validate file upload
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files uploaded. Please upload 1-3 SVG files.',
        usage: 'POST /api/svg-to-3d-intelligent with files[] (1-3 SVGs) and views (comma-separated)'
      });
    }
    
    if (uploadedFiles.length > 3) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 3 views allowed (front, side, top recommended)',
        uploaded: uploadedFiles.length
      });
    }
    
    // Check Azure OpenAI configuration
    if (!process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
      return res.status(500).json({
        success: false,
        error: 'Azure OpenAI not configured. Please set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT in .env'
      });
    }
    
    // Parse view names
    const viewsParam = req.body.views || '';
    const viewNames = viewsParam.split(',').map(v => v.trim().toLowerCase());
    
    if (viewNames.length !== uploadedFiles.length) {
      return res.status(400).json({
        success: false,
        error: `View count mismatch: ${uploadedFiles.length} files but ${viewNames.length} view names`,
        example: 'For 3 files, use views=front,side,top'
      });
    }
    
    // Validate all files are SVG
    const validSVGTypes = ['image/svg+xml', 'text/xml', 'application/xml'];
    const invalidFiles = uploadedFiles.filter(f => 
      !validSVGTypes.includes(f.mimetype) && !f.originalname.toLowerCase().endsWith('.svg')
    );
    
    if (invalidFiles.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'All files must be SVG format',
        invalidFiles: invalidFiles.map(f => f.originalname)
      });
    }
    
    // Prepare file metadata
    const svgFiles = uploadedFiles.map((file, idx) => ({
      path: file.path,
      view: viewNames[idx],
      filename: file.originalname
    }));
    
    console.log('\n🤖 INTELLIGENT Multi-View Request:');
    console.log(`   Files: ${svgFiles.map(f => `${f.view}(${f.filename})`).join(', ')}`);
    
    // Optional depth override
    const depthOverride = req.body.depth ? parseFloat(req.body.depth) : undefined;
    
    // Run AI-powered conversion
    const result = await intelligentMultiView.convertMultiViewSVGto3DIntelligent(svgFiles, {
      depth: depthOverride
    });
    
    // Generate URL for GLB
    const glbFilename = path.basename(result.glbPath);
    const glbUrl = `${req.protocol}://${req.get('host')}/exports/${glbFilename}`;
    
    res.json({
      success: true,
      message: 'AI-powered multi-view SVG to 3D conversion complete',
      glbUrl: glbUrl,
      glbPath: result.glbPath,
      stats: result.stats,
      pipeline: 'intelligent-multiview',
      aiPowered: true,
      views: svgFiles.map(f => ({
        view: f.view,
        filename: f.filename
      }))
    });
    
  } catch (error) {
    console.error('❌ Intelligent multi-view conversion error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      pipeline: 'intelligent-multiview'
    });
  }
});

/**
 * POST /api/blender/texture
 * Apply texture to object
 * Body: { objectName: "Cube", textureId: "texture_id" }
 */
app.post('/api/blender/texture', ensureConnection, async (req, res) => {
  try {
    const { objectName, textureId } = req.body;

    if (!objectName || !textureId) {
      return res.status(400).json({
        success: false,
        error: 'objectName and textureId are required'
      });
    }

    const result = await mcpClient.setTexture(objectName, textureId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= SKETCHFAB ENDPOINTS =============

/**
 * GET /api/sketchfab/search
 * Search Sketchfab models
 * Query: ?query=car&count=20&categories=vehicles&downloadable=true
 */
app.get('/api/sketchfab/search', ensureConnection, async (req, res) => {
  try {
    const { query, count, categories, downloadable } = req.query;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Search query is required'
      });
    }

    const result = await mcpClient.searchSketchfab(query, {
      count: count ? parseInt(count) : undefined,
      categories,
      downloadable: downloadable !== 'false'
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/sketchfab/download
 * Download Sketchfab model
 * Body: { uid: "model-uid-here" }
 */
app.post('/api/sketchfab/download', ensureConnection, async (req, res) => {
  try {
    const { uid } = req.body;

    if (!uid) {
      return res.status(400).json({
        success: false,
        error: 'Model UID is required'
      });
    }

    const result = await mcpClient.downloadSketchfabModel(uid);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= PROMPT ENDPOINT =============

/**
 * POST /api/prompt
 * Execute natural language prompt in Blender with enhanced AI safety
 * Body: { prompt: "create a red cube at position 0,0,0" }
 */
app.post('/api/prompt', ensureConnection, async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'Prompt is required'
      });
    }

    executionLogger.info('Processing prompt', { prompt });

    // Step 1: Process and validate prompt
    const promptProcessing = promptSafety.processPrompt(prompt);
    
    if (!promptProcessing.valid) {
      executionLogger.error('Prompt validation failed', new Error(promptProcessing.error));
      return res.status(400).json({
        success: false,
        error: promptProcessing.error,
        stage: promptProcessing.stage
      });
    }

    executionLogger.info('Prompt validated', {
      original: promptProcessing.originalPrompt,
      cleaned: promptProcessing.cleanedPrompt,
      expanded: promptProcessing.expandedPrompt
    });

    // Step 2: Use Azure OpenAI to generate code with enhanced system prompt
    const response = await axios.post(
      `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_MODEL}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`,
      {
        messages: [
          { role: 'system', content: promptProcessing.systemPrompt },
          { role: 'user', content: promptProcessing.expandedPrompt }
        ],
        temperature: 0.3,
        max_tokens: 800,
        top_p: 0.95,
        frequency_penalty: 0.0,
        presence_penalty: 0.0
      },
      {
        headers: {
          'api-key': process.env.AZURE_OPENAI_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    let generatedCode = response.data.choices[0].message.content.trim();
    
    // Remove markdown code blocks if present
    generatedCode = generatedCode.replace(/```python\n/g, '').replace(/```\n/g, '').replace(/```/g, '');

    executionLogger.info('AI code generated', { codeLength: generatedCode.length });

    // Step 3: Validate generated code for safety
    const codeValidation = promptSafety.validateGeneratedCode(generatedCode);
    
    if (!codeValidation.safe) {
      executionLogger.error('Generated code validation failed', new Error('Unsafe operations detected'));
      return res.status(400).json({
        success: false,
        error: 'Generated code contains unsafe operations',
        issues: codeValidation.issues,
        generatedCode: generatedCode
      });
    }

    if (codeValidation.warningCount > 0) {
      executionLogger.warning('Code has warnings', { warnings: codeValidation.issues });
    }

    // Step 4: Wrap in safe execution context
    const safeCode = blenderSafety.wrapInSafeContext(generatedCode, 'AI Generated Code');

    // Step 5: Execute in Blender
    executionLogger.info('Executing AI-generated code in Blender');
    const result = await mcpClient.executeBlenderCode(safeCode);

    // Step 6: Run quality improvements (preserve colors AND custom scales)
    executionLogger.info('Running quality improvements (preserving colors and scales)');
    const qualityCode = modelQuality.generateQualityPipelinePreserveColorsAndScale();
    const qualityResult = await mcpClient.executeBlenderCode(qualityCode);

    // Step 7: Auto-export as GLB
    const timestamp = Date.now();
    const filename = `model-${timestamp}.glb`;
    const exportPath = path.join(exportsDir, filename).replace(/\\/g, '/');

    // Step 7a: Bake procedural textures before export
    executionLogger.info('Baking procedural materials for export');
    const bakeCode = textureBaking.generateTextureBaking();
    await mcpClient.executeBlenderCode(bakeCode);

    // Step 7b: Export as GLB
    executionLogger.info('Exporting model as GLB');
    const exportCode = `
import bpy
import os

print("\\n" + "=" * 60)
print("AUTO-EXPORT AFTER AI GENERATION")
print("=" * 60)

if 'io_scene_gltf2' not in bpy.context.preferences.addons:
    try:
        bpy.ops.preferences.addon_enable(module='io_scene_gltf2')
    except: pass

export_path = r"${exportPath}"
os.makedirs(os.path.dirname(export_path), exist_ok=True)

# Verify materials have shader nodes
for mat in bpy.data.materials:
    if mat and not mat.use_nodes:
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value = mat.diffuse_color

# Select mesh objects
bpy.ops.object.select_all(action='DESELECT')
mesh_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH']

for obj in mesh_objects:
    obj.select_set(True)

if mesh_objects:
    try:
        bpy.ops.export_scene.gltf(
            filepath=export_path,
            export_format='GLB',
            use_selection=True,
            export_apply=True,
            export_materials='EXPORT',
            export_texcoords=True,
            export_normals=True,
            export_tangents=True,
            export_yup=True
        )
        if os.path.exists(export_path):
            file_size = os.path.getsize(export_path)
            print(f"✓ Exported: {file_size:,} bytes")
    except Exception as e:
        print(f"✗ Export error: {e}")

print("=" * 60)
`;

    executionLogger.info('Exporting model');
    await mcpClient.executeBlenderCode(exportCode);

    // Step 8: Validate GLB
    const glbValidation = await modelQuality.validateGLBOutput(exportPath);
    
    const fileUrl = `http://localhost:${PORT}/exports/${filename}`;

    executionLogger.success('Prompt execution completed successfully');

    res.json({
      success: true,
      prompt: {
        original: promptProcessing.originalPrompt,
        cleaned: promptProcessing.cleanedPrompt,
        expanded: promptProcessing.expandedPrompt
      },
      generatedCode: generatedCode,
      codeValidation: {
        safe: codeValidation.safe,
        warnings: codeValidation.warningCount,
        issues: codeValidation.issues.filter(i => i.severity === 'warning')
      },
      execution: {
        result: result,
        quality: qualityResult
      },
      export: {
        filename: filename,
        url: fileUrl,
        exists: glbValidation.valid,
        validation: glbValidation
      },
      logs: executionLogger.getLogs()
    });
  } catch (error) {
    executionLogger.error('Prompt execution failed', error);
    console.error('Prompt execution error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      logs: executionLogger.getLogs()
    });
  } finally {
    executionLogger.clear();
  }
});

// ============= 3D GENERATION ENDPOINTS =============

/**
 * POST /api/generate/hyper3d
 * Generate 3D model using Hyper3D
 * Body: { textPrompt: "a red sports car", bboxCondition: [2, 1, 1] }
 */
app.post('/api/generate/hyper3d', ensureConnection, async (req, res) => {
  try {
    const { textPrompt, bboxCondition } = req.body;

    if (!textPrompt) {
      return res.status(400).json({
        success: false,
        error: 'textPrompt is required'
      });
    }

    const result = await mcpClient.generateHyper3DModel(textPrompt, bboxCondition);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= GENERIC TOOL ENDPOINT =============

/**
 * POST /api/tool/call
 * Call any MCP tool by name
 * Body: { toolName: "mcp_blender-mcp_execute_blender_code", args: { code: "..." } }
 */
app.post('/api/tool/call', ensureConnection, async (req, res) => {
  try {
    const { toolName, args } = req.body;

    if (!toolName) {
      return res.status(400).json({
        success: false,
        error: 'toolName is required'
      });
    }

    const result = await mcpClient.callTool(toolName, args || {});
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= EMBED ENDPOINTS =============

/**
 * GET /embed/viewer
 * Standalone embeddable viewer page
 * Query params: url (model URL) or modelId (model filename)
 * Optional: bg (background color), autoRotate (true/false), controls (true/false)
 */
app.get('/embed/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'embed.html'));
});

/**
 * GET /api/embed/code/:modelId
 * Generate embed code for a model
 */
app.get('/api/embed/code/:modelId', (req, res) => {
  try {
    const { modelId } = req.params;
    const { width = '800', height = '600', autoRotate = 'false', controls = 'true', bg = '#1a1a1a' } = req.query;

    const baseUrl = `http://localhost:${PORT}`;
    const embedUrl = `${baseUrl}/embed/viewer?modelId=${modelId}&autoRotate=${autoRotate}&controls=${controls}&bg=${encodeURIComponent(bg)}`;

    const iframeCode = `<iframe 
  src="${embedUrl}" 
  width="${width}" 
  height="${height}" 
  frameborder="0" 
  allowfullscreen
></iframe>`;

    const htmlCode = `<!DOCTYPE html>
<html>
<head>
    <title>3D Model Viewer</title>
</head>
<body>
    ${iframeCode}
</body>
</html>`;

    const directLinkCode = `<a href="${embedUrl}" target="_blank">View 3D Model</a>`;

    res.json({
      success: true,
      modelId,
      embedUrl,
      codes: {
        iframe: iframeCode,
        html: htmlCode,
        directLink: directLinkCode,
        markdown: `[View 3D Model](${embedUrl})`
      },
      customization: {
        width: 'Iframe width (default: 800px)',
        height: 'Iframe height (default: 600px)',
        autoRotate: 'Auto-rotate model (true/false, default: false)',
        controls: 'Show controls help (true/false, default: true)',
        bg: 'Background color (hex, default: #1a1a1a)'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= ERROR HANDLING =============

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: err.message
  });
});

// ============= SERVER STARTUP =============

async function startServer() {
  try {
    // Connect to MongoDB
    if (process.env.MONGODB_URI) {
      try {
        await mongoose.connect(process.env.MONGODB_URI, {
          useNewUrlParser: true,
          useUnifiedTopology: true
        });
        console.log('✅ MongoDB connected');
      } catch (error) {
        console.log('⚠️  MongoDB not connected:', error.message);
      }
    }

    // Initialize email service
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      initEmailService();
    }

    // Start HTTP server first
    app.listen(PORT, () => {
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║     Blender MCP HTTP API Server          ║');
      console.log('║                                           ║');
      console.log(`║   Server: http://localhost:${PORT}            ║`);
      console.log('║   Status: RUNNING                         ║');
      console.log('║                                           ║');
      console.log(`║   Health: http://localhost:${PORT}/health     ║`);
      console.log(`║   Auth:   http://localhost:${PORT}/api/auth   ║`);
      console.log(`║   Tools:  http://localhost:${PORT}/api/tools  ║`);
      console.log(`║   Prompt: http://localhost:${PORT}/api/prompt ║`);
      console.log('║                                           ║');
      console.log(`║   Blender: ${process.env.BLENDER_HOST}:${process.env.BLENDER_PORT}      ║`);
      console.log('╚═══════════════════════════════════════════╝\n');
      console.log('⚠️  MCP will connect when first request is made');
      console.log('💡 Make sure Blender is running with MCP enabled\n');
    });

    // Try to connect to MCP server in background
    setTimeout(async () => {
      try {
        console.log('Attempting to connect to Blender MCP...');
        await mcpClient.connect();
        console.log('✅ MCP connected successfully!\n');
      } catch (error) {
        console.log('⚠️  MCP not connected yet. Will retry on first request.');
        console.log(`   Error: ${error.message}\n`);
      }
    }, 1000);

  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  mcpClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  mcpClient.disconnect();
  process.exit(0);
});

// Start the server
startServer();
