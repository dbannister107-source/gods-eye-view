import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as convertMapCsvMain } from '../../scripts/map-csv-to-fencecrete-geojson.mjs';
import * as Cesium from 'cesium';
import {
  FENCECRETE_JOBS_LAYER_ID,
  FENCECRETE_JOBS_OVERLAY_SOURCE_ID,
  FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT,
  FENCECRETE_JOBS_OVERLAY_COLLISION_CAPACITY,
  convertMapCsvToFencecreteGeojson,
  createFencecreteJobOverlayEntry,
  createFencecreteJobsLayer,
  fencecreteJobOverlayCopy,
  fencecreteJobUrlFromId,
  normalizeFencecreteJobsSnapshot,
  openFencecreteJobUrl,
  parseCsvRows,
  sanitizeFencecreteJobUrl,
  selectFencecreteJobOverlayCohort,
} from './fencecreteJobs.js';

const SNAPSHOT_PATH = fileURLToPath(new URL('../../public/data/fencecrete-jobs.geojson', import.meta.url));
const SNAPSHOT = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

// A fixed two-job payload for the lifecycle test below. That test is about
// layer BEHAVIOUR -- entities, overlay cards, click-to-open -- not about how
// many jobs ship today, so it must not be wired to the committed export: a
// routine `/map` refresh would otherwise turn a behaviour test red for a
// reason that has nothing to do with behaviour.
const LIFECYCLE_SNAPSHOT = Object.freeze({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-95.44112, 29.58401] },
      properties: {
        id: '268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
        job_number: '26H055',
        job_name: 'Houston Plant',
        status: 'contract_review',
        market: 'HOU',
        coords_source: 'manual',
        url: 'https://ops.fencecrete.com/projects/268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-98.583365, 29.58667] },
      properties: {
        id: 'e044e2df-9661-4c61-af41-87e16a01b6d0',
        job_number: '26S034',
        job_name: 'San Antonio Plant',
        status: 'contract_review',
        market: 'SA',
        coords_source: 'manual',
        url: 'https://ops.fencecrete.com/projects/e044e2df-9661-4c61-af41-87e16a01b6d0',
      },
    },
  ],
});

test('main.js registers the additive Fencecrete layer without replacing stock layers', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /import fencecreteJobsLayer from '\.\/data\/fencecreteJobs\.js'/);
  assert.match(main, /dataManager\.register\(fencecreteJobsLayer\)/);
  assert.match(main, /dataManager\.register\(earthquakesLayer\)/);
  assert.match(main, /dataManager\.register\(flightsLayer\)/);
});

test('committed GeoJSON is the full Command Center export, not the two-plant starter', () => {
  assert.equal(SNAPSHOT.type, 'FeatureCollection');
  // The starter file was two hand-placed plant pins. Guard a floor rather than
  // an exact count, so a routine `/map` refresh does not break the suite — but
  // keep the floor far enough above 2 that a revert to the starter goes red.
  assert.ok(
    SNAPSHOT.features.length >= 200,
    `expected the full export (>=200 pins), found ${SNAPSHOT.features.length}`,
  );

  const rows = normalizeFencecreteJobsSnapshot(SNAPSHOT);
  // Every committed feature must survive normalization. A drop here means a
  // non-finite coordinate or a duplicate id shipped inside the export.
  assert.equal(rows.length, SNAPSHOT.features.length);
  assert.ok(rows.every((row) => row.url), 'every job needs a deep-link URL');
  assert.match(rows[0].url, /^https:\/\/ops\.fencecrete\.com\/projects\//);

  // `_sample` marked the hand-placed starter pins. The real export carries none.
  assert.equal(
    SNAPSHOT.features.filter((feature) => '_sample' in (feature.properties ?? {})).length,
    0,
    '_sample belongs to the retired starter file',
  );

  // Both plants must sit on the coordinates Command Center Setup holds, not the
  // retired hand-placed ones. These are the two rows a reader checks by eye.
  const plants = new Map(
    rows.filter((row) => row.jobNumber === '26H055' || row.jobNumber === '26S034')
      .map((row) => [row.jobNumber, row]),
  );
  assert.equal(plants.size, 2, 'both plant jobs must be on the globe');
  assert.deepEqual([plants.get('26H055').lon, plants.get('26H055').lat], [-95.44112, 29.58401]);
  assert.deepEqual([plants.get('26S034').lon, plants.get('26S034').lat], [-98.583365, 29.58667]);
});

test('normalizeFencecreteJobsSnapshot skips features missing finite coordinates and never invents them', () => {
  const rows = normalizeFencecreteJobsSnapshot({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-95.4807, 29.5994] },
        properties: { job_number: 'KEEP', job_name: 'Kept' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [null, 29.5] },
        properties: { job_number: 'BAD-NULL', job_name: 'Houston HQ' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: ['', ''] },
        properties: { job_number: 'BAD-BLANK' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [NaN, 30] },
        properties: { job_number: 'BAD-NAN' },
      },
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-95.4, 29.5], [-95.5, 29.6]] },
        properties: { job_number: 'BAD-LINE' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [200, 29.5] },
        properties: { job_number: 'BAD-RANGE' },
      },
      { type: 'Feature', geometry: null, properties: { job_number: 'NO-GEOM' } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobNumber, 'KEEP');
  assert.equal(rows[0].lon, -95.4807);
  assert.equal(rows[0].lat, 29.5994);
});

test('normalizeFencecreteJobsSnapshot rejects a malformed collection rather than inventing pins', () => {
  assert.equal(normalizeFencecreteJobsSnapshot(null), null);
  assert.equal(normalizeFencecreteJobsSnapshot({ type: 'FeatureCollection' }), null);
  assert.equal(normalizeFencecreteJobsSnapshot({ type: 'Feature', features: [] }), null);
});

test('overlay copy shows job_number, job_name, status, and market when present', () => {
  assert.deepEqual(fencecreteJobOverlayCopy({
    jobNumber: '26H055',
    jobName: 'Houston Plant',
    status: 'production_queue',
    market: 'Houston',
  }), {
    title: '26H055 · Houston Plant',
    details: ['production_queue', 'Houston'],
  });
  assert.deepEqual(fencecreteJobOverlayCopy({ jobNumber: '26H055' }), {
    title: '26H055',
    details: [],
  });
  assert.equal(fencecreteJobOverlayCopy({}).title, 'Fencecrete job');
});

test('overlay entry is an interactive card that opens a sanitized URL', () => {
  const opened = [];
  const position = Cesium.Cartesian3.fromDegrees(-95.4807, 29.5994);
  const entry = createFencecreteJobOverlayEntry({
    id: '268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
    position,
    jobNumber: '26H055',
    jobName: 'Houston Plant',
    status: 'production_queue',
    market: 'Houston',
    url: 'https://ops.fencecrete.com/projects/268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
  });
  assert.equal(entry.variant, 'card');
  assert.equal(entry.title, '26H055 · Houston Plant');
  assert.deepEqual(entry.details, ['production_queue', 'Houston']);
  assert.equal(entry.interactive, true);
  assert.equal(entry.activate(), true);
  assert.deepEqual(opened, [
    'https://ops.fencecrete.com/projects/268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
  ]);
});

test('sanitizeFencecreteJobUrl refuses non-http(s) and openFencecreteJobUrl no-ops without a URL', () => {
  assert.equal(sanitizeFencecreteJobUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeFencecreteJobUrl('/projects/abc'), null);
  assert.equal(sanitizeFencecreteJobUrl(''), null);
  assert.equal(sanitizeFencecreteJobUrl('https://ops.fencecrete.com/projects/abc'), 'https://ops.fencecrete.com/projects/abc');
  const opened = [];
  assert.equal(openFencecreteJobUrl(null, (url) => opened.push(url)), false);
  assert.equal(openFencecreteJobUrl('javascript:alert(1)', (url) => opened.push(url)), false);
  assert.equal(openFencecreteJobUrl('https://ops.fencecrete.com/projects/abc', (url, target, features) => {
    opened.push({ url, target, features });
  }), true);
  assert.deepEqual(opened, [{
    url: 'https://ops.fencecrete.com/projects/abc',
    target: '_blank',
    features: 'noopener,noreferrer',
  }]);
  assert.equal(fencecreteJobUrlFromId(''), null);
  assert.equal(
    fencecreteJobUrlFromId('268ebe83-e7a5-4f30-8ef4-d2c473fb302c'),
    'https://ops.fencecrete.com/projects/268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
  );
});

test('CSV conversion uses Job # / Name / Status / Market / Lat / Lng and builds url only when id exists', () => {
  const geojson = convertMapCsvToFencecreteGeojson([
    'Job #,Name,Status,Market,Lat,Lng,id',
    '26H055,Houston Plant,production_queue,Houston,29.5994,-95.4807,268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
    '26S034,"San Antonio, Plant",production_queue,San Antonio,29.5849,-98.6122,',
    'SKIP-BLANK,No Coords,queued,Dallas,,,',
    'SKIP-TEXT,Bad Coords,queued,Austin,not-a-lat,not-a-lng,abc',
    'SKIP-RANGE,Out of range,queued,Orbit,91,-95.4,xyz',
  ].join('\n'));
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, 2);
  assert.deepEqual(geojson.features[0].geometry.coordinates, [-95.4807, 29.5994]);
  assert.equal(geojson.features[0].properties.job_number, '26H055');
  assert.equal(geojson.features[0].properties.job_name, 'Houston Plant');
  assert.equal(
    geojson.features[0].properties.url,
    'https://ops.fencecrete.com/projects/268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
  );
  assert.equal(geojson.features[1].properties.job_name, 'San Antonio, Plant');
  assert.equal(geojson.features[1].properties.url, undefined);
  assert.equal(geojson.features[1].properties.id, undefined);
  assert.equal(parseCsvRows('').length, 0);
});

test('map-csv-to-fencecrete-geojson.mjs writes the same schema to disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fencecrete-jobs-'));
  const csvPath = path.join(dir, 'map.csv');
  const outPath = path.join(dir, 'jobs.geojson');
  writeFileSync(csvPath, [
    'Job #,Name,Status,Market,Lat,Lng,id',
    '26H055,Houston Plant,production_queue,Houston,29.5994,-95.4807,268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
    'SKIP,Missing coords,queued,Dallas,,,',
  ].join('\n'));
  assert.equal(convertMapCsvMain([csvPath, outPath]), 0);
  const written = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(written.features.length, 1);
  assert.deepEqual(written.features[0].geometry.coordinates, [-95.4807, 29.5994]);
  assert.equal(
    written.features[0].properties.url,
    'https://ops.fencecrete.com/projects/268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
  );
});

test('overlay cohort is bounded and identity-stable', () => {
  const entries = Array.from({ length: FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT + 10 }, (_, index) => ({
    id: `job-${String(index).padStart(3, '0')}`,
    priority: index,
  }));
  const cohort = selectFencecreteJobOverlayCohort(entries);
  assert.equal(cohort.length, FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, `job-${String(FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT + 9).padStart(3, '0')}`);
});

test('layer lifecycle fetches static GeoJSON, publishes overlay cards, and opens URL on pin click', async () => {
  const originalFetch = globalThis.fetch;
  const hostCalls = [];
  const opened = [];
  const dataSources = [];
  const clickActions = [];
  const overlayHost = {
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
    hitTest: () => null,
  };
  const viewer = {
    scene: {
      canvas: {},
      pick: () => ({ id: { id: `${FENCECRETE_JOBS_LAYER_ID}:268ebe83-e7a5-4f30-8ef4-d2c473fb302c` } }),
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/data/fencecrete-jobs.geojson');
    return { ok: true, json: async () => LIFECYCLE_SNAPSHOT };
  };
  const layer = createFencecreteJobsLayer({
    overlayHost,
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (fn, type) => clickActions.push({ fn, type }),
      destroy() {},
    }),
  });
  try {
    assert.equal(layer.id, 'fencecrete-jobs');
    assert.equal(layer.name, 'Fencecrete jobs');
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);

    const entities = dataSources[0].entities.values;
    assert.equal(entities.length, 2);
    assert.ok(entities.every((entity) => entity.label === undefined));
    const hasPin = entities.every((entity) => entity.billboard || entity.point);
    assert.ok(hasPin, 'each job must render as a pin or fallback point, not an aircraft glyph');
    const publication = hostCalls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.deepEqual(publication[2].map(({ title }) => title), [
      '26H055 · Houston Plant',
      '26S034 · San Antonio Plant',
    ]);
    assert.deepEqual(publication[3], {
      cohortLimit: FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: FENCECRETE_JOBS_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
    assert.equal(clickActions.length, 1);
    clickActions[0].fn({ position: { x: 10, y: 10 } });
    assert.deepEqual(opened, [
      'https://ops.fencecrete.com/projects/268ebe83-e7a5-4f30-8ef4-d2c473fb302c',
    ]);
    assert.deepEqual(layer.getStats().count, 2);

    layer.disable(viewer);
    assert.equal(dataSources[0].show, false);
    assert.deepEqual(hostCalls.slice(-2), [
      ['clear', FENCECRETE_JOBS_OVERLAY_SOURCE_ID],
      ['visible', FENCECRETE_JOBS_OVERLAY_SOURCE_ID, false],
    ]);
    layer.destroy(viewer);
    assert.equal(dataSources.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
