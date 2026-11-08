// scripts/bundle-extension.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT_DIR, 'apps', 'chrome-extension');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const CHROMIUM_MANIFEST_PATH = path.join(EXTENSION_DIR, 'manifest.json');
const FIREFOX_MANIFEST_PATH = path.join(EXTENSION_DIR, 'manifest.firefox.json');

async function bundle() {
  console.log('====================================================');
  console.log('  MeetMonitor Multi-Browser Extension Packager');
  console.log('  Supports: Brave, Google Chrome, Firefox, Edge');
  console.log('====================================================\n');

  if (!fs.existsSync(CHROMIUM_MANIFEST_PATH)) {
    console.error(`[Error] manifest.json not found at: ${CHROMIUM_MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(CHROMIUM_MANIFEST_PATH, 'utf-8'));
  const version = manifest.version || '1.0.0';

  // Ensure dist directory exists
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  // 1. Build Chromium Package (Brave, Chrome, Edge, Opera)
  console.log('▶ Packaging Chromium Target (Brave / Chrome / Edge)...');
  const chromiumZipPath = path.join(DIST_DIR, `meetmonitor-chromium-v${version}.zip`);
  await buildZipTarget(chromiumZipPath, (fileName) => {
    // Exclude firefox-specific manifest from chromium bundle
    return fileName !== 'manifest.firefox.json';
  });

  const chromStats = fs.statSync(chromiumZipPath);
  console.log(`  ✓ Created: ${chromiumZipPath} (${(chromStats.size / 1024).toFixed(2)} KB)`);

  // 2. Build Firefox Package (Gecko / Mozilla Add-ons)
  console.log('\n▶ Packaging Firefox Target (Gecko / Mozilla Add-ons)...');
  const firefoxZipPath = path.join(DIST_DIR, `meetmonitor-firefox-v${version}.zip`);
  
  if (!fs.existsSync(FIREFOX_MANIFEST_PATH)) {
    console.error(`[Error] manifest.firefox.json not found at: ${FIREFOX_MANIFEST_PATH}`);
    process.exit(1);
  }

  const firefoxManifestData = fs.readFileSync(FIREFOX_MANIFEST_PATH);

  await buildZipTarget(firefoxZipPath, (fileName) => {
    // Exclude default manifest.json and manifest.firefox.json because we inject manifest.firefox.json as manifest.json
    return fileName !== 'manifest.json' && fileName !== 'manifest.firefox.json';
  }, [
    { name: 'manifest.json', data: firefoxManifestData }
  ]);

  const ffStats = fs.statSync(firefoxZipPath);
  console.log(`  ✓ Created: ${firefoxZipPath} (${(ffStats.size / 1024).toFixed(2)} KB)`);

  console.log('\n====================================================');
  console.log('  ALL BROWSER PACKAGES BUNDLED SUCCESSFULLY!');
  console.log('====================================================');
  console.log('Distribution Targets:');
  console.log(`1. Brave / Chrome / Edge : dist/meetmonitor-chromium-v${version}.zip`);
  console.log(`2. Mozilla Firefox       : dist/meetmonitor-firefox-v${version}.zip`);
  console.log('\nInstallation Instructions:');
  console.log('• Brave & Chrome : Load unpacked folder or upload chromium .zip to Web Store.');
  console.log('• Firefox        : Load temporary add-on via about:debugging or upload to AMO.');
  console.log('====================================================\n');
}

async function buildZipTarget(outputPath, filterFn, extraFiles = []) {
  const zlib = await import('node:zlib');

  function collectFiles(dir, base = '') {
    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results = results.concat(collectFiles(full, rel));
      } else {
        if (filterFn(rel)) {
          results.push({ name: rel.replace(/\\/g, '/'), data: fs.readFileSync(full) });
        }
      }
    }
    return results;
  }

  const files = [...collectFiles(EXTENSION_DIR), ...extraFiles];
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const fileNameBuf = Buffer.from(file.name, 'utf8');
    const content = file.data;
    const crc = zlib.crc32(content);
    const compressed = zlib.deflateRawSync(content);

    // Local Header
    const lh = Buffer.alloc(30 + fileNameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6);  // bit flag
    lh.writeUInt16LE(8, 8);  // compression method (deflate)
    lh.writeUInt32LE(0, 10); // time/date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(fileNameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    fileNameBuf.copy(lh, 30);

    localHeaders.push(lh, compressed);

    // Central Directory Header
    const ch = Buffer.alloc(46 + fileNameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8);  // bit flag
    ch.writeUInt16LE(8, 10); // method
    ch.writeUInt32LE(0, 12); // time/date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(fileNameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk num
    ch.writeUInt16LE(0, 36); // internal attr
    ch.writeUInt32LE(0, 38); // external attr
    ch.writeUInt32LE(offset, 42); // offset
    fileNameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + compressed.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const ch of centralHeaders) cdSize += ch.length;

  // End of Central Directory Record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  const fullZip = Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  fs.writeFileSync(outputPath, fullZip);
}

bundle().catch((err) => {
  console.error('[Error] Bundle failed:', err);
  process.exit(1);
});
