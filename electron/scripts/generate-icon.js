/**
 * Generate ICO icon from SVG
 * Run with: node scripts/generate-icon.js
 */

const sharp = require('sharp');
const toIco = require('to-ico');
const fs = require('fs');
const path = require('path');

const sizes = [16, 32, 48, 256];
const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');
const pngPath = path.join(__dirname, '..', 'assets', 'icon.png');

async function generateIcon() {
  const svgBuffer = fs.readFileSync(svgPath);

  // Generate PNGs at different sizes
  const pngBuffers = await Promise.all(
    sizes.map(size =>
      sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toBuffer()
    )
  );

  // Also save a 256px PNG for other uses
  fs.writeFileSync(pngPath, pngBuffers[3]);
  console.log('Created icon.png (256x256)');

  // Convert to ICO
  const icoBuffer = await toIco(pngBuffers);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Created icon.ico');
}

generateIcon().catch(console.error);
