/**
 * Pure Fencecrete jobs GeoJSON / CSV helpers.
 * No Cesium — the refresh script and unit tests import this directly.
 */

export const FENCECRETE_JOBS_PROJECT_URL_PREFIX = 'https://ops.fencecrete.com/projects/';

export function cleanFencecreteText(value) {
  const text = String(value ?? '').trim();
  return text && text !== 'undefined' && text !== 'null' ? text : '';
}

export function clampFencecreteLine(value, max = 48) {
  const text = cleanFencecreteText(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Accept only http(s) project URLs. Never invent a URL or open javascript:.
 * @param {unknown} url
 * @returns {string|null}
 */
export function sanitizeFencecreteJobUrl(url) {
  const text = cleanFencecreteText(url);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Build the Command Center project URL when a stable id is present.
 * @param {unknown} id
 * @returns {string|null}
 */
export function fencecreteJobUrlFromId(id) {
  const text = cleanFencecreteText(id);
  if (!text) return null;
  return `${FENCECRETE_JOBS_PROJECT_URL_PREFIX}${encodeURIComponent(text)}`;
}

/**
 * Open a sanitized job URL in a new tab. Returns false when the URL is absent
 * or not http(s).
 * @param {unknown} url
 * @param {typeof window.open} [open]
 * @returns {boolean}
 */
export function openFencecreteJobUrl(url, open = globalThis.open) {
  const safe = sanitizeFencecreteJobUrl(url);
  if (!safe || typeof open !== 'function') return false;
  open(safe, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Popup / overlay copy. Only fields that are present are shown.
 * @param {object} job
 * @returns {{title: string, details: string[]}}
 */
export function fencecreteJobOverlayCopy(job) {
  const jobNumber = clampFencecreteLine(job?.jobNumber, 24);
  const jobName = clampFencecreteLine(job?.jobName, 40);
  const title = [jobNumber, jobName].filter(Boolean).join(' · ') || 'Fencecrete job';
  const details = [];
  const status = clampFencecreteLine(job?.status, 40);
  const market = clampFencecreteLine(job?.market, 40);
  if (status) details.push(status);
  if (market) details.push(market);
  return { title, details };
}

function readFiniteCoordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function readCoordinatePair(feature) {
  const geometry = feature?.geometry;
  if (!geometry || (geometry.type != null && geometry.type !== 'Point')) return null;
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = readFiniteCoordinate(coordinates[0]);
  const lat = readFiniteCoordinate(coordinates[1]);
  if (lon == null || lat == null) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}

/**
 * Normalize a FeatureCollection into job rows. Features missing a finite
 * [lng, lat] pair are skipped — coordinates are never invented. A missing
 * `features` array yields null (malformed file).
 * @param {object|null|undefined} geojson
 * @returns {object[]|null}
 */
export function normalizeFencecreteJobsSnapshot(geojson) {
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    return null;
  }
  const rows = [];
  const ids = new Set();
  for (const [index, feature] of geojson.features.entries()) {
    const pair = readCoordinatePair(feature);
    if (!pair) continue;
    const properties = feature?.properties && typeof feature.properties === 'object'
      && !Array.isArray(feature.properties)
      ? feature.properties
      : {};
    const jobNumber = cleanFencecreteText(properties.job_number);
    const jobName = cleanFencecreteText(properties.job_name);
    const status = cleanFencecreteText(properties.status);
    const market = cleanFencecreteText(properties.market);
    const rawId = cleanFencecreteText(properties.id) || cleanFencecreteText(feature.id);
    const stableId = rawId || jobNumber || `job-${index + 1}`;
    if (ids.has(stableId)) continue;
    ids.add(stableId);
    rows.push({
      stableId,
      lon: pair.lon,
      lat: pair.lat,
      jobNumber: jobNumber || null,
      jobName: jobName || null,
      status: status || null,
      market: market || null,
      url: sanitizeFencecreteJobUrl(properties.url),
      coordsSource: cleanFencecreteText(properties.coords_source) || null,
    });
  }
  return rows;
}

const CSV_HEADER_ALIASES = Object.freeze({
  'job #': 'job_number',
  'job#': 'job_number',
  job_number: 'job_number',
  'job number': 'job_number',
  name: 'job_name',
  job_name: 'job_name',
  'job name': 'job_name',
  status: 'status',
  market: 'market',
  lat: 'lat',
  latitude: 'lat',
  lng: 'lng',
  lon: 'lng',
  long: 'lng',
  longitude: 'lng',
  id: 'id',
});

/**
 * Parse a RFC4180-ish CSV (quoted fields, commas, CRLF) into row objects.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsvRows(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushRow();
      continue;
    }
    if (ch === '\r') {
      if (source[i + 1] === '\n') i += 1;
      pushRow();
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) pushRow();
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => {
    const key = String(header || '').trim().toLowerCase();
    return CSV_HEADER_ALIASES[key] || null;
  });
  return rows.slice(1).map((values) => {
    const record = {};
    headers.forEach((key, index) => {
      if (!key) return;
      record[key] = String(values[index] ?? '').trim();
    });
    return record;
  });
}

function parseOptionalNumber(value) {
  const text = cleanFencecreteText(value);
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Convert a Command Center `/map` CSV into the Fencecrete jobs GeoJSON schema.
 * Blank or non-finite Lat/Lng rows are excluded. `url` is written only when
 * `id` is present. Coordinates are never invented.
 * @param {string} csvText
 * @returns {{type: 'FeatureCollection', features: object[]}}
 */
export function convertMapCsvToFencecreteGeojson(csvText) {
  const features = [];
  for (const record of parseCsvRows(csvText)) {
    const lat = parseOptionalNumber(record.lat);
    const lng = parseOptionalNumber(record.lng);
    if (lat == null || lng == null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const id = cleanFencecreteText(record.id);
    const properties = {
      job_number: cleanFencecreteText(record.job_number) || undefined,
      job_name: cleanFencecreteText(record.job_name) || undefined,
      status: cleanFencecreteText(record.status) || undefined,
      market: cleanFencecreteText(record.market) || undefined,
      coords_source: 'command-center-map-csv',
    };
    if (id) {
      properties.id = id;
      properties.url = fencecreteJobUrlFromId(id);
    }
    for (const key of Object.keys(properties)) {
      if (properties[key] === undefined) delete properties[key];
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties,
    });
  }
  return { type: 'FeatureCollection', features };
}
