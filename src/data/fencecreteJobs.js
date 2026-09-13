import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  fencecreteJobOverlayCopy,
  normalizeFencecreteJobsSnapshot,
  openFencecreteJobUrl,
  sanitizeFencecreteJobUrl,
} from './fencecreteJobsGeojson.js';

export {
  convertMapCsvToFencecreteGeojson,
  fencecreteJobOverlayCopy,
  fencecreteJobUrlFromId,
  FENCECRETE_JOBS_PROJECT_URL_PREFIX,
  normalizeFencecreteJobsSnapshot,
  openFencecreteJobUrl,
  parseCsvRows,
  sanitizeFencecreteJobUrl,
} from './fencecreteJobsGeojson.js';

/**
 * Fencecrete jobs — static GeoJSON pins from a committed Command Center
 * `/map` export. Additive fork layer: no live Fencecrete API, no secrets.
 */

export const FENCECRETE_JOBS_LAYER_ID = 'fencecrete-jobs';
export const FENCECRETE_JOBS_OVERLAY_SOURCE_ID = 'fencecrete-jobs';
export const FENCECRETE_JOBS_GEOJSON_URL = '/data/fencecrete-jobs.geojson';
export const FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT = 96;
export const FENCECRETE_JOBS_OVERLAY_COLLISION_CAPACITY = 48;

/** Maroon / poured-concrete pin fill. */
export const FENCECRETE_PIN_FILL = '#6b2d3c';
/** Warm concrete outline. */
export const FENCECRETE_PIN_OUTLINE = '#c4b8a8';

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: null,
});

const PIN_FILL_COLOR = Cesium.Color.fromCssColorString(FENCECRETE_PIN_FILL);
const PIN_OUTLINE_COLOR = Cesium.Color.fromCssColorString(FENCECRETE_PIN_OUTLINE);

/**
 * Shared-host presentation for one job pin.
 * @param {object} input
 * @returns {object}
 */
export function createFencecreteJobOverlayEntry({
  id,
  position,
  jobNumber,
  jobName,
  status,
  market,
  url,
  accent = FENCECRETE_PIN_FILL,
  openUrl = openFencecreteJobUrl,
}) {
  const copy = fencecreteJobOverlayCopy({ jobNumber, jobName, status, market });
  const safeUrl = sanitizeFencecreteJobUrl(url);
  return {
    id: String(id),
    position,
    variant: 'card',
    title: copy.title,
    details: copy.details,
    accent,
    priority: 500,
    collisionGroup: 'ambient-card',
    paintLane: 'ambient-card',
    interactive: Boolean(safeUrl),
    accessibilityLabel: safeUrl
      ? `Open Fencecrete job ${copy.title}`
      : copy.title,
    activate: safeUrl ? () => openUrl(safeUrl) : undefined,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 16,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Keep a bounded, identity-stable overlay cohort.
 * @param {object[]} entries
 * @param {number} [limit]
 * @returns {object[]}
 */
export function selectFencecreteJobOverlayCohort(
  entries,
  limit = FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.min(
    FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    (b.priority || 0) - (a.priority || 0)
    || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

function createPinImage() {
  try {
    return new Cesium.PinBuilder().fromColor(PIN_FILL_COLOR, 36);
  } catch {
    return null;
  }
}

export function createFencecreteJobsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  geojsonUrl = FENCECRETE_JOBS_GEOJSON_URL,
  openUrl = openFencecreteJobUrl,
  screenSpaceEventHandlerFactory = (viewer) => (
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  ),
} = {}) {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _jobsByEntityId = new Map();
  let _pinImage = null;

  function publishOverlay(entries) {
    if (!_enabled) return;
    overlayHost.setEntries(
      FENCECRETE_JOBS_OVERLAY_SOURCE_ID,
      selectFencecreteJobOverlayCohort(entries),
      {
        cohortLimit: FENCECRETE_JOBS_OVERLAY_COHORT_LIMIT,
        collisionCapacity: FENCECRETE_JOBS_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      },
    );
  }

  function openJob(job) {
    if (!job?.url) return false;
    return openUrl(job.url);
  }

  function installClickHandler(viewer) {
    if (_clickHandler || !viewer?.scene) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = viewer.scene.pick?.(click.position);
      const entity = picked?.id;
      if (entity && _jobsByEntityId.has(entity.id)) {
        openJob(_jobsByEntityId.get(entity.id));
        return;
      }
      const cardHit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: FENCECRETE_JOBS_OVERLAY_SOURCE_ID,
      });
      if (cardHit?.entryId) {
        const job = [..._jobsByEntityId.values()].find((row) => row.stableId === cardHit.entryId);
        if (job) openJob(job);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (!_clickHandler) return;
    _clickHandler.destroy?.();
    _clickHandler = null;
  }

  const layer = {
    id: FENCECRETE_JOBS_LAYER_ID,
    name: 'Fencecrete jobs',
    icon: '◼',
    source: 'Command Center /map',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource(FENCECRETE_JOBS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _jobsByEntityId = new Map();
      _pinImage = createPinImage();
      overlayHost.setVisible(FENCECRETE_JOBS_OVERLAY_SOURCE_ID, false);
      console.log('[Data:FencecreteJobs] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(FENCECRETE_JOBS_OVERLAY_SOURCE_ID, true);
      installClickHandler(viewer);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(FENCECRETE_JOBS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FENCECRETE_JOBS_OVERLAY_SOURCE_ID, false);
      removeClickHandler();
    },

    async update(viewer) {
      try {
        const response = await fetch(geojsonUrl);
        if (!response.ok) {
          _lastError = `GeoJSON HTTP ${response.status}`;
          console.warn(`[Data:FencecreteJobs] ${geojsonUrl} returned ${response.status}`);
          return false;
        }
        const geojson = await response.json();
        const rows = normalizeFencecreteJobsSnapshot(geojson);
        if (!rows) {
          _lastError = 'Malformed Fencecrete GeoJSON';
          return false;
        }

        const nextEntities = [];
        const overlayEntries = [];
        const nextJobs = new Map();

        for (const job of rows) {
          const position = Cesium.Cartesian3.fromDegrees(job.lon, job.lat);
          const entityId = `${FENCECRETE_JOBS_LAYER_ID}:${job.stableId}`;
          const entity = new Cesium.Entity({
            id: entityId,
            position,
            billboard: _pinImage
              ? {
                image: _pinImage,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                color: Cesium.Color.WHITE,
              }
              : undefined,
            point: _pinImage
              ? undefined
              : {
                pixelSize: 14,
                color: PIN_FILL_COLOR,
                outlineColor: PIN_OUTLINE_COLOR,
                outlineWidth: 3,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            properties: {
              jobNumber: job.jobNumber,
              jobName: job.jobName,
              status: job.status,
              market: job.market,
              url: job.url,
            },
          });
          nextEntities.push(entity);
          nextJobs.set(entityId, job);
          overlayEntries.push(createFencecreteJobOverlayEntry({
            id: job.stableId,
            position,
            jobNumber: job.jobNumber,
            jobName: job.jobName,
            status: job.status,
            market: job.market,
            url: job.url,
            accent: FENCECRETE_PIN_FILL,
            openUrl,
          }));
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _jobsByEntityId = nextJobs;
        publishOverlay(overlayEntries);

        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:FencecreteJobs] Updated: ${_count} jobs`);
        return true;
      } catch (error) {
        console.warn('[Data:FencecreteJobs] Fetch error:', error);
        _lastError = 'Fencecrete GeoJSON unavailable';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      removeClickHandler();
      overlayHost.clearSource(FENCECRETE_JOBS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FENCECRETE_JOBS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _jobsByEntityId = new Map();
      _pinImage = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}

const fencecreteJobsLayer = createFencecreteJobsLayer();

export default fencecreteJobsLayer;
