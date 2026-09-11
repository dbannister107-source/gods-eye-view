#!/usr/bin/env node
/**
 * Convert a Command Center `/map` CSV export into the Fencecrete jobs
 * GeoJSON schema used by the GEV overlay.
 *
 * Expected columns: Job #, Name, Status, Market, Lat, Lng
 * Optional: id  — when present, writes
 *   https://ops.fencecrete.com/projects/{id}
 *
 * Rows with blank or non-finite Lat/Lng are excluded. Coordinates are
 * never invented or geocoded.
 *
 * Usage:
 *   node scripts/map-csv-to-fencecrete-geojson.mjs <export.csv> [outfile]
 *
 * Default outfile: public/data/fencecrete-jobs.geojson
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertMapCsvToFencecreteGeojson } from '../src/data/fencecreteJobsGeojson.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, '..', 'public', 'data', 'fencecrete-jobs.geojson');

function usage() {
  console.error('Usage: node scripts/map-csv-to-fencecrete-geojson.mjs <export.csv> [outfile]');
}

export { convertMapCsvToFencecreteGeojson };

function main(argv = process.argv.slice(2)) {
  const [inputPath, outputPath = DEFAULT_OUT] = argv;
  if (!inputPath || inputPath === '-h' || inputPath === '--help') {
    usage();
    return inputPath ? 0 : 1;
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`CSV not found: ${inputPath}`);
    return 1;
  }
  const csvText = fs.readFileSync(inputPath, 'utf8');
  const geojson = convertMapCsvToFencecreteGeojson(csvText);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(geojson, null, 2)}\n`);
  console.log(`Wrote ${geojson.features.length} job pin(s) to ${outputPath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

export { main, DEFAULT_OUT };
