const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SIZE = 1024;
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');

const DARK = '#121215';
const GOLD = '#B8962E';
const GOLD_LIGHT = '#d4b84a';

// Rounded rectangle background (macOS icon shape)
const radius = SIZE * 0.22;
ctx.beginPath();
ctx.moveTo(radius, 0);
ctx.lineTo(SIZE - radius, 0);
ctx.quadraticCurveTo(SIZE, 0, SIZE, radius);
ctx.lineTo(SIZE, SIZE - radius);
ctx.quadraticCurveTo(SIZE, SIZE, SIZE - radius, SIZE);
ctx.lineTo(radius, SIZE);
ctx.quadraticCurveTo(0, SIZE, 0, SIZE - radius);
ctx.lineTo(0, radius);
ctx.quadraticCurveTo(0, 0, radius, 0);
ctx.closePath();
ctx.fillStyle = DARK;
ctx.fill();

// Subtle border
ctx.strokeStyle = 'rgba(184, 150, 46, 0.15)';
ctx.lineWidth = 3;
ctx.stroke();

// Draw "CI" monogram
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';

// Gold gradient for text
const gradient = ctx.createLinearGradient(SIZE * 0.2, SIZE * 0.3, SIZE * 0.8, SIZE * 0.7);
gradient.addColorStop(0, GOLD_LIGHT);
gradient.addColorStop(0.5, GOLD);
gradient.addColorStop(1, '#9a7c24');

// "C" letter
ctx.font = `bold ${SIZE * 0.42}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
ctx.fillStyle = gradient;
ctx.letterSpacing = `${SIZE * 0.02}px`;
ctx.fillText('CI', SIZE * 0.5, SIZE * 0.48);

// Decorative line underneath
const lineY = SIZE * 0.68;
const lineWidth = SIZE * 0.32;
const lineGradient = ctx.createLinearGradient(
  SIZE * 0.5 - lineWidth / 2, lineY,
  SIZE * 0.5 + lineWidth / 2, lineY
);
lineGradient.addColorStop(0, 'rgba(184, 150, 46, 0)');
lineGradient.addColorStop(0.2, GOLD);
lineGradient.addColorStop(0.8, GOLD);
lineGradient.addColorStop(1, 'rgba(184, 150, 46, 0)');

ctx.beginPath();
ctx.moveTo(SIZE * 0.5 - lineWidth / 2, lineY);
ctx.lineTo(SIZE * 0.5 + lineWidth / 2, lineY);
ctx.strokeStyle = lineGradient;
ctx.lineWidth = 2.5;
ctx.stroke();

// Small tagline
ctx.font = `500 ${SIZE * 0.05}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
ctx.fillStyle = 'rgba(184, 150, 46, 0.6)';
ctx.fillText('CLIENT INTELLIGENCE', SIZE * 0.5, SIZE * 0.75);

// Save PNG
const buildDir = path.join(__dirname, '..', 'build');
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

const pngPath = path.join(buildDir, 'icon.png');
const buffer = canvas.toBuffer('image/png');
fs.writeFileSync(pngPath, buffer);
console.log(`Icon saved to ${pngPath}`);

// Generate .icns using sips + iconutil (macOS only)
if (process.platform === 'darwin') {
  const iconsetDir = path.join(buildDir, 'icon.iconset');
  if (fs.existsSync(iconsetDir)) {
    fs.rmSync(iconsetDir, { recursive: true });
  }
  fs.mkdirSync(iconsetDir, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    const outFile = path.join(iconsetDir, `icon_${size}x${size}.png`);
    execSync(`sips -z ${size} ${size} "${pngPath}" --out "${outFile}" 2>/dev/null`);
    if (size <= 512) {
      const outFile2x = path.join(iconsetDir, `icon_${size / 2}x${size / 2}@2x.png`);
      if (size / 2 >= 16) {
        execSync(`cp "${outFile}" "${outFile2x}"`);
      }
    }
  }

  // iconutil expects specific names
  const renames = {
    'icon_1024x1024.png': 'icon_512x512@2x.png',
  };
  for (const [from, to] of Object.entries(renames)) {
    const fromPath = path.join(iconsetDir, from);
    const toPath = path.join(iconsetDir, to);
    if (fs.existsSync(fromPath) && !fs.existsSync(toPath)) {
      fs.copyFileSync(fromPath, toPath);
    }
    if (fs.existsSync(fromPath) && from !== to) {
      fs.unlinkSync(fromPath);
    }
  }

  // Remove 64x64 (not a valid iconutil size)
  const icon64 = path.join(iconsetDir, 'icon_64x64.png');
  if (fs.existsSync(icon64)) fs.unlinkSync(icon64);

  try {
    const icnsPath = path.join(buildDir, 'icon.icns');
    execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
    console.log(`ICNS saved to ${icnsPath}`);
  } catch (err) {
    console.error('Failed to generate .icns:', err.message);
  }

  fs.rmSync(iconsetDir, { recursive: true });
}
