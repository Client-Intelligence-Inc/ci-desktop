const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const WIDTH = 660;
const HEIGHT = 400;

const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#0c0c0f';
ctx.fillRect(0, 0, WIDTH, HEIGHT);

const gradient = ctx.createLinearGradient(0, HEIGHT, WIDTH, 0);
gradient.addColorStop(0, 'rgba(184, 150, 46, 0.03)');
gradient.addColorStop(0.5, 'rgba(184, 150, 46, 0.06)');
gradient.addColorStop(1, 'rgba(184, 150, 46, 0.02)');
ctx.fillStyle = gradient;
ctx.fillRect(0, 0, WIDTH, HEIGHT);

ctx.strokeStyle = 'rgba(184, 150, 46, 0.08)';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(0, HEIGHT * 0.7);
ctx.bezierCurveTo(WIDTH * 0.3, HEIGHT * 0.5, WIDTH * 0.7, HEIGHT * 0.8, WIDTH, HEIGHT * 0.6);
ctx.stroke();

ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';
ctx.fillStyle = 'rgba(229, 231, 235, 0.5)';
ctx.textAlign = 'center';
ctx.fillText('Drag to Applications to install', WIDTH / 2, HEIGHT - 36);

const arrowY = 220;
const arrowStartX = 210;
const arrowEndX = 370;
ctx.strokeStyle = 'rgba(229, 231, 235, 0.2)';
ctx.lineWidth = 1.5;
ctx.setLineDash([6, 4]);
ctx.beginPath();
ctx.moveTo(arrowStartX, arrowY);
ctx.lineTo(arrowEndX, arrowY);
ctx.stroke();
ctx.setLineDash([]);

const arrowSize = 8;
ctx.fillStyle = 'rgba(229, 231, 235, 0.2)';
ctx.beginPath();
ctx.moveTo(arrowEndX, arrowY);
ctx.lineTo(arrowEndX - arrowSize, arrowY - arrowSize / 2);
ctx.lineTo(arrowEndX - arrowSize, arrowY + arrowSize / 2);
ctx.closePath();
ctx.fill();

const outputPath = path.join(__dirname, '..', 'build', 'dmg-background.png');
const buffer = canvas.toBuffer('image/png');
fs.writeFileSync(outputPath, buffer);
console.log(`DMG background generated: ${outputPath} (${buffer.length} bytes)`);
