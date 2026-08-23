/**
 * Batch process GoPro videos:
 * 1. Copy all files to input folder
 * 2. Extract telemetry and create SRT files
 * 3. Add soft subtitles to MP4 files
 * 4. Merge all into one file for YouTube
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_DIR = 'N:\\20250712_SZChina';
const OUTPUT_DIR = 'N:\\20250712_SZChina\\processed';
const INPUT_DIR = __dirname + '\\input';

// Find all MP4 files
const mp4Files = fs.readdirSync(SOURCE_DIR)
  .filter(f => f.startsWith('GX') && f.endsWith('.MP4'))
  .sort();

console.log(`Found ${mp4Files.length} GoPro files:`);
mp4Files.forEach((f, i) => console.log(`  ${i+1}. ${f}`));

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(INPUT_DIR)) {
  fs.mkdirSync(INPUT_DIR, { recursive: true });
}

// Step 1: Copy all files to input folder
console.log('\n=== Step 1: Copying files to input folder ===');
for (const mp4File of mp4Files) {
  const lrvFile = mp4File.replace('GX', 'GL').replace('.MP4', '.LRV');
  
  const srcMp4 = path.join(SOURCE_DIR, mp4File);
  const srcLrv = path.join(SOURCE_DIR, lrvFile);
  const dstMp4 = path.join(INPUT_DIR, mp4File);
  const dstLrv = path.join(INPUT_DIR, lrvFile);
  
  if (!fs.existsSync(dstMp4)) {
    console.log(`  Copying ${mp4File}...`);
    fs.copyFileSync(srcMp4, dstMp4);
  } else {
    console.log(`  ${mp4File} already exists, skipping`);
  }
  
  if (fs.existsSync(srcLrv) && !fs.existsSync(dstLrv)) {
    console.log(`  Copying ${lrvFile}...`);
    fs.copyFileSync(srcLrv, dstLrv);
  }
}

// Step 2: Extract SRT for each video
console.log('\n=== Step 2: Extracting telemetry ===');
try {
  execSync('node extract.js', {
    cwd: __dirname,
    stdio: 'inherit'
  });
} catch (err) {
  console.error(`Extraction failed: ${err.message}`);
}

// Find generated SRT files
const generatedSrtDir = path.join(__dirname, 'output');
const srtFiles = mp4Files.map(mp4File => {
  const baseName = mp4File.replace('.MP4', '');
  const srcSrt = path.join(generatedSrtDir, `${baseName}.srt`);
  const dstSrt = path.join(OUTPUT_DIR, `${baseName}.srt`);
  
  if (fs.existsSync(srcSrt)) {
    fs.copyFileSync(srcSrt, dstSrt);
    console.log(`  ✓ Copied: ${baseName}.srt`);
    return { mp4: mp4File, srt: dstSrt };
  }
  return null;
}).filter(f => f !== null);

console.log(`\nGenerated ${srtFiles.length} SRT files`);

// Step 2: Add soft subtitles to each MP4
console.log('\n=== Step 2: Adding soft subtitles ===');
const subbedFiles = [];

for (const { mp4, srt } of srtFiles) {
  const baseName = mp4.replace('.MP4', '');
  const outputMp4 = path.join(OUTPUT_DIR, `${baseName}_subs.mp4`);
  
  console.log(`Adding subtitle to ${mp4}...`);
  
  try {
    // Use FFmpeg to add SRT as soft subtitle (mov_text)
    execSync(`ffmpeg -y -i "${path.join(SOURCE_DIR, mp4)}" -i "${srt}" -c copy -c:s mov_text -disposition:s:0 default "${outputMp4}"`, {
      stdio: 'inherit'
    });
    
    subbedFiles.push(outputMp4);
    console.log(`  ✓ Created: ${baseName}_subs.mp4`);
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
  }
}

// Step 3: Merge all files
console.log('\n=== Step 3: Merging all files ===');

// Create filelist
const mergeList = path.join(OUTPUT_DIR, 'filelist.txt');
let listContent = '';
for (const f of subbedFiles) {
  listContent += `file ${f.replace(/\\/g, '/')}\n`;
}
fs.writeFileSync(mergeList, listContent);
console.log(`Created filelist with ${subbedFiles.length} files`);

// Merge using FFmpeg concat
const finalOutput = path.join(OUTPUT_DIR, 'final_merged.mp4');
console.log('Merging...');

try {
  execSync(`ffmpeg -y -f concat -safe 0 -i "${mergeList}" -c copy "${finalOutput}"`, {
    stdio: 'inherit'
  });
  console.log(`\n✓ Final video saved: ${finalOutput}`);
} catch (err) {
  console.error(`Merge failed: ${err.message}`);
}

console.log('\n=== Done! ===');
console.log(`Output directory: ${OUTPUT_DIR}`);
