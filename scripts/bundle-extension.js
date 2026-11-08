// scripts/bundle-extension.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT_DIR, 'apps', 'chrome-extension');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const MANIFEST_PATH = path.join(EXTENSION_DIR, 'manifest.json');

async function bundle() {
  console.log('====================================================');
  console.log('  MeetMonitor Chrome Extension Packager');
  console.log('====================================================\n');

  // 1. Validate manifest.json
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[Error] manifest.json not found at: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (err) {
    console.error(`[Error] Failed to parse manifest.json: ${err.message}`);
    process.exit(1);
  }

  const version = manifest.version || '1.0.0';
  const name = (manifest.name || 'meetmonitor-extension')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const zipFileName = `${name}-v${version}.zip`;
  const zipFilePath = path.join(DIST_DIR, zipFileName);

  console.log(`Extension Name   : ${manifest.name}`);
  console.log(`Version          : ${version}`);
  console.log(`Manifest Version : MV${manifest.manifest_version}`);

  // 2. Validate critical files
  const requiredFiles = [
    'manifest.json',
    manifest.background?.service_worker,
    ...(manifest.content_scripts?.flatMap(cs => cs.js) || []),
    manifest.action?.default_popup,
    ...(manifest.icons ? Object.values(manifest.icons) : [])
  ].filter(Boolean);

  console.log('\nValidating package contents...');
  let hasMissing = false;
  for (const relPath of requiredFiles) {
    const fullPath = path.join(EXTENSION_DIR, relPath);
    if (fs.existsSync(fullPath)) {
      console.log(`  ✓ ${relPath}`);
    } else {
      console.error(`  ✗ MISSING: ${relPath} (expected at ${fullPath})`);
      hasMissing = true;
    }
  }

  if (hasMissing) {
    console.error('\n[Error] Missing required extension assets. Aborting bundle.');
    process.exit(1);
  }

  // 3. Ensure dist directory exists
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  // 4. Create ZIP Archive
  console.log(`\nCreating distribution zip: ${zipFilePath}`);

  await createWithNativeZip(zipFilePath);

  const stats = fs.statSync(zipFilePath);
  const sizeKb = (stats.size / 1024).toFixed(2);

  console.log('\n====================================================');
  console.log('  SUCCESSFULLY BUNDLED EXTENSION!');
  console.log('====================================================');
  console.log(`Output File : ${zipFilePath}`);
  console.log(`File Size   : ${sizeKb} KB`);
  console.log('\nNext steps:');
  console.log('1. For Chrome Web Store: Upload this .zip to the Chrome Developer Dashboard.');
  console.log('2. For Manual Sharing: Share this .zip with students/instructors to unzip and load via Developer Mode.');
  console.log('====================================================\n');
}

async function createWithNativeZip(outputPath) {
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
        results.push({ name: rel.replace(/\\/g, '/'), data: fs.readFileSync(full) });
      }
    }
    return results;
  }

  const files = collectFiles(EXTENSION_DIR);
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

  // End of Central Directory
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
