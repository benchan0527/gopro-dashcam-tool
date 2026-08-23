const fs = require('fs');
const path = require('path');
const http = require('http');
const gpmfExtract = require('gpmf-extract');
const goproTelemetry = require('gopro-telemetry');
const NodeGeocoder = require('node-geocoder');

const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');

const geoCache = new Map();

async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  
  if (geoCache.has(key)) {
    return geoCache.get(key);
  }
  
  console.log(`[Geocoding] Requesting: http://localhost:8080/reverse?format=json&lat=${lat}&lon=${lon}`);
  
  try {
    const url = `http://localhost:8080/reverse?format=json&lat=${lat}&lon=${lon}`;
    
    const result = await new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`[Geocoding] Response status: ${res.statusCode}`);
          console.log(`[Geocoding] Response data: ${data.substring(0, 200)}`);
          
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch(e) {
            reject(new Error(data || 'Invalid JSON response'));
          }
        });
      });
      
      req.on('error', (err) => {
        console.error(`[Geocoding] Request error: ${err.message}`);
        if (err.message.includes('ECONNREFUSED')) {
          reject(new Error('Nominatim server not running. Please start it first.'));
        } else if (err.message.includes('socket hang up')) {
          reject(new Error('Connection closed by server. Is Nominatim still initializing?'));
        } else {
          reject(err);
        }
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
    
    if (result && result.address) {
      const addr = result.address;
      const parts = [];
      
      if (addr.road) parts.push(addr.road);
      if (addr.suburb) parts.push(addr.suburb);
      if (addr.town) parts.push(addr.town);
      else if (addr.city) parts.push(addr.city);
      else if (addr.village) parts.push(addr.village);
      if (addr.country) parts.push(addr.country);
      
      const locationStr = parts.length > 0 ? parts.join(', ') : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      geoCache.set(key, locationStr);
      return locationStr;
    }
  } catch (err) {
    console.warn('Geocoding failed:', err.message);
  }
  
  const result = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  geoCache.set(key, result);
  return result;
}

function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function formatTimeRange(startSeconds, duration = 1) {
  const endSeconds = startSeconds + duration;
  return `${formatSRTTime(startSeconds)} --> ${formatSRTTime(endSeconds)}`;
}

async function findPairedFiles(inputDir) {
  const files = fs.readdirSync(inputDir);
  const pairs = [];
  
  const gxFiles = files.filter(f => /^GX\d+\.MP4$/i.test(f));
  
  for (const gxFile of gxFiles) {
    const match = gxFile.match(/^GX(\d+)\.MP4$/i);
    if (match) {
      const number = match[1];
      const lrvFile = `GL${number}.LRV`;
      const mp4File = gxFile;
      
      const hasLRV = files.some(f => f.toUpperCase() === lrvFile.toUpperCase());
      const hasMP4 = files.some(f => f.toUpperCase() === mp4File.toUpperCase());
      
      if (hasMP4) {
        pairs.push({
          baseName: `GX${number}`,
          mp4: path.join(inputDir, mp4File),
          lrv: hasLRV ? path.join(inputDir, lrvFile) : null
        });
      }
    }
  }
  
  return pairs;
}

async function extractTelemetry(filePath, options = {}) {
  console.log(`Extracting telemetry from: ${path.basename(filePath)}`);
  
  const fileBuffer = fs.readFileSync(filePath);
  console.log(`File buffer size: ${fileBuffer.length} bytes`);
  
  const rawData = await gpmfExtract(fileBuffer);
  
  if (!rawData || !rawData.rawData || rawData.rawData.length === 0) {
    throw new Error('No GPMF data found in file');
  }
  
  console.log(`Raw data length: ${rawData.rawData.length} bytes`);
  console.log(`Timing:`, rawData.timing);
  
  const streams = options.streams || ['ACCL', 'GPS5', 'GPS'];
  
  const telemetry = await goproTelemetry(rawData, {
    stream: streams,
    repeatSticky: true
  });
  
  return telemetry;
}

function getStreamData(telemetry, streamName) {
  for (const device in telemetry) {
    const deviceData = telemetry[device];
    if (deviceData && deviceData.streams && deviceData.streams[streamName]) {
      return deviceData.streams[streamName];
    }
  }
  return null;
}

function downsampleTo1Hz(samples, timeSamples) {
  if (!samples || samples.length === 0) return { samples: [], times: [] };
  
  const result = [];
  const resultTimes = [];
  
  let currentSecond = 0;
  let currentGroup = [];
  let currentTimes = [];
  
  for (let i = 0; i < samples.length; i++) {
    const sampleTime = timeSamples ? timeSamples[i] : i;
    const sampleSecond = Math.floor(sampleTime);
    
    if (sampleSecond !== currentSecond) {
      if (currentGroup.length > 0) {
        result.push(currentGroup);
        resultTimes.push(currentTimes);
      }
      currentSecond = sampleSecond;
      currentGroup = [];
      currentTimes = [];
    }
    
    currentGroup.push(samples[i]);
    currentTimes.push(sampleTime);
  }
  
  if (currentGroup.length > 0) {
    result.push(currentGroup);
    resultTimes.push(currentTimes);
  }
  
  return { samples: result, times: resultTimes };
}

function calculateGForce(accelSample) {
  if (!accelSample || accelSample.length < 3) return null;
  
  const x = accelSample[0];
  const y = accelSample[1];
  const z = accelSample[2];
  
  const magnitude = Math.sqrt(x * x + y * y + z * z);
  const gForce = magnitude / 9.81;
  
  return gForce;
}

function averageAccelSamples(samples) {
  if (!samples || samples.length === 0) return null;
  
  let sumX = 0, sumY = 0, sumZ = 0;
  let count = 0;
  
  for (const sample of samples) {
    if (sample && sample.length >= 3) {
      sumX += sample[0];
      sumY += sample[1];
      sumZ += sample[2];
      count++;
    }
  }
  
  if (count === 0) return null;
  
  return [sumX / count, sumY / count, sumZ / count];
}

function extractLastValidGPS(gpsData) {
  if (!gpsData || !gpsData.samples) return null;
  
  for (let i = gpsData.samples.length - 1; i >= 0; i--) {
    const sample = gpsData.samples[i];
    if (sample && sample.length >= 2 && sample[0] !== 0 && sample[1] !== 0) {
      return {
        lat: sample[0],
        lon: sample[1]
      };
    }
  }
  
  return null;
}

async function generateSRT(telemetry, outputPath, duration) {
  console.log('Processing telemetry data...');
  
  const accelData = getStreamData(telemetry, 'ACCL');
  const gps5Data = getStreamData(telemetry, 'GPS5');
  const gpsData = getStreamData(telemetry, 'GPS');
  
  console.log('ACCL samples:', accelData?.samples?.length || 0);
  console.log('GPS5 samples:', gps5Data?.samples?.length || 0);
  console.log('GPS samples:', gpsData?.samples?.length || 0);
  
  // Extract values from telemetry structure (samples have .value property)
  const accelSamples = accelData?.samples ? accelData.samples.map(s => s.value) : [];
  const accelTimes = accelData?.samples ? accelData.samples.map(s => s.cts) : [];
  
  const downsampled = downsampleTo1Hz(accelSamples, accelTimes);
  
  const totalSeconds = Math.ceil(duration);
  
  let lastGForce = null;
  let lastSpeed = null;
  let lastGPS = null;
  let lastLocation = 'N/A';
  
  const subtitleBlocks = [];
  
  for (let second = 0; second < totalSeconds; second++) {
    const dsIndex = second;
    
    if (dsIndex < downsampled.samples.length) {
      const avgAccel = averageAccelSamples(downsampled.samples[dsIndex]);
      if (avgAccel) {
        lastGForce = calculateGForce(avgAccel);
      }
    }
    
    // GPS5 has speed in value[4] and lat/lon in value[0], value[1]
    // cts is in milliseconds, so divide by 1000
    if (gps5Data?.samples) {
      const gps5Sample = gps5Data.samples.find((s) => {
        const timeInSeconds = s.cts / 1000;
        return Math.floor(timeInSeconds) === second;
      });
      
      if (gps5Sample && gps5Sample.value && gps5Sample.value.length >= 5) {
        const speedMps = gps5Sample.value[4];
        if (speedMps != null && speedMps > 0) {
          lastSpeed = speedMps * 3.6;
        }
        
        // Also get GPS from GPS5 since dedicated GPS stream is empty
        const lat = gps5Sample.value[0];
        const lon = gps5Sample.value[1];
        if (lat && lon && lat !== 0 && lon !== 0) {
          lastGPS = { lat, lon };
        }
      }
    }
    
    // Use GPS5 for location if GPS stream is empty
    if (lastGPS && (lastLocation === 'N/A' || second % 10 === 0)) {
      console.log(`[Geocoding] Calling for GPS: ${lastGPS.lat}, ${lastGPS.lon}`);
      lastLocation = await reverseGeocode(lastGPS.lat, lastGPS.lon);
      console.log(`[Geocoding] Result: ${lastLocation}`);
    }
    
    const speedStr = lastSpeed !== null ? lastSpeed.toFixed(1) : 'N/A';
    const gForceStr = lastGForce !== null ? lastGForce.toFixed(2) : 'N/A';
    const locationStr = lastLocation;
    
    const text = `Speed: ${speedStr} km/h\nG-Force: ${gForceStr} G\n${locationStr}`;
    
    subtitleBlocks.push({
      index: second + 1,
      startTime: second,
      duration: 1,
      text: text
    });
  }
  
  let srtContent = '';
  for (const block of subtitleBlocks) {
    srtContent += `${block.index}\n`;
    srtContent += `${formatTimeRange(block.startTime, block.duration)}\n`;
    srtContent += `${block.text}\n\n\n`;
  }
  
  fs.writeFileSync(outputPath, srtContent, 'utf8');
  console.log(`SRT file saved: ${outputPath}`);
  
  return srtContent;
}

async function getVideoDuration(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const rawData = await gpmfExtract(fileBuffer);
  if (rawData.timing && rawData.timing.videoDuration) {
    return rawData.timing.videoDuration;
  }
  return 30;
}

async function processPair(pair) {
  console.log(`\n=== Processing ${pair.baseName} ===`);
  
  let sourceFile = null;
  let usedSource = null;
  
  if (pair.lrv) {
    console.log(`Trying LRV: ${path.basename(pair.lrv)}`);
    try {
      const fileStats = fs.statSync(pair.lrv);
      if (fileStats.size > 2 * 1024 * 1024 * 1024) {
        console.log('LRV file too large, skipping');
      } else {
        const fileBuffer = fs.readFileSync(pair.lrv);
        const testData = await gpmfExtract(fileBuffer);
        if (testData && testData.rawData && testData.rawData.length > 0) {
          sourceFile = pair.lrv;
          usedSource = 'LRV';
        }
      }
    } catch (e) {
      console.log(`LRV extraction failed: ${e.message}`);
    }
  }
  
  if (!sourceFile && pair.mp4) {
    console.log(`Trying MP4: ${path.basename(pair.mp4)}`);
    try {
      const fileStats = fs.statSync(pair.mp4);
      if (fileStats.size > 2 * 1024 * 1024 * 1024) {
        console.log('MP4 file too large, need to use streaming approach');
        console.log('For large files, please use the GUI or split the file');
      } else {
        const fileBuffer = fs.readFileSync(pair.mp4);
        const testData = await gpmfExtract(fileBuffer);
        if (testData && testData.rawData && testData.rawData.length > 0) {
          sourceFile = pair.mp4;
          usedSource = 'MP4';
        }
      }
    } catch (e) {
      console.log(`MP4 extraction failed: ${e.message}`);
    }
  }
  
  if (!sourceFile) {
    console.error(`Could not extract telemetry from any source file`);
    return { success: false, baseName: pair.baseName, error: 'Could not extract telemetry from MP4 or LRV' };
  }
  
  console.log(`Using source: ${usedSource} (${path.basename(sourceFile)})`);
  
  try {
    const duration = await getVideoDuration(sourceFile);
    
    const telemetry = await extractTelemetry(sourceFile);
    
    const outputFile = path.join(path.dirname(sourceFile), `${pair.baseName}.srt`);
    const srtContent = await generateSRT(telemetry, outputFile, duration);
    
    console.log(`Successfully processed ${pair.baseName}`);
    return { success: true, baseName: pair.baseName, outputFile, srtContent };
  } catch (error) {
    console.error(`Error processing ${pair.baseName}:`, error);
    return { success: false, baseName: pair.baseName, error: error.message };
  }
}

async function main() {
  console.log('GoPro Telemetry to SRT Extractor');
  console.log('================================\n');
  
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`Created output directory: ${OUTPUT_DIR}`);
  }
  
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`Input directory not found: ${INPUT_DIR}`);
    process.exit(1);
  }
  
  const pairs = await findPairedFiles(INPUT_DIR);
  
  if (pairs.length === 0) {
    console.log('No paired GX/GL files found in input directory.');
    console.log('Looking for MP4 files...');
    
    const files = fs.readdirSync(INPUT_DIR);
    const mp4Files = files.filter(f => /\.MP4$/i.test(f));
    
    for (const mp4File of mp4Files) {
      const match = mp4File.match(/^(GX\d+)\.MP4$/i);
      if (match) {
        pairs.push({
          baseName: match[1],
          mp4: path.join(INPUT_DIR, mp4File),
          lrv: null
        });
      }
    }
    
    if (pairs.length === 0) {
      console.log('No GoPro MP4 files found.');
      process.exit(0);
    }
  }
  
  console.log(`Found ${pairs.length} file pair(s) to process\n`);
  
  const results = [];
  for (const pair of pairs) {
    const result = await processPair(pair);
    results.push(result);
  }
  
  console.log('\n=== Summary ===');
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\nFailed files:');
    for (const r of results.filter(r => !r.success)) {
      console.log(`  - ${r.baseName}: ${r.error}`);
    }
  }
  
  console.log('\nDone!');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { processPair, extractTelemetry, generateSRT };
