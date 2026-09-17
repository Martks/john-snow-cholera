(function () {
  "use strict";

  const FALLBACK_CENTER = [51.51345, -0.13655];
  const FALLBACK_ZOOM = 16;
  const BUFFER_RADIUS = 120;
  let dataBounds = null;

  if (typeof L === "undefined") {
    showStatus("Leaflet не загрузился. Проверьте подключение к интернету и обновите страницу.");
    return;
  }

  const map = L.map("map", {
    center: FALLBACK_CENTER,
    zoom: FALLBACK_ZOOM,
    zoomControl: false,
    preferCanvas: true
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);
  const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  const modernMap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: osmAttribution
  });

  const historicalContext = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    opacity: 0.16,
    attribution: osmAttribution
  });
  const historicalTiles = L.tileLayer(
    "https://tiles.arcgis.com/tiles/j80Jz20at6Bi0thr/arcgis/rest/services/Snow_cholera_map_detailed/MapServer/tile/{z}/{y}/{x}",
    {
      minZoom: 14,
      maxZoom: 21,
      maxNativeZoom: 19,
      opacity: 0.88,
      bounds: [[51.5090, -0.1442], [51.5171, -0.1307]],
      attribution: 'Историческая карта: John Snow / C. F. Cheffins, 1855 · <a href="https://www.arcgis.com/home/item.html?id=830cebdbe3fa4e1da5627fbbb6e97fdd" target="_blank" rel="noopener">Esri</a> · источник изображения: Wikimedia Commons'
    }
  );
  const historicalBase = L.layerGroup([
    historicalContext,
    historicalTiles
  ]);
  modernMap.addTo(map);

  const buffersLayer = L.layerGroup().addTo(map);
  const deathsLayer = L.layerGroup().addTo(map);
  const pumpsLayer = L.layerGroup().addTo(map);
  const pumpMarkers = new Map();
  let ranking = [];
  let pumpAnalysis = [];

  L.control.layers(
    { "Современная карта": modernMap, "Историческая карта": historicalBase },
    { "Deaths — смерти": deathsLayer, "Pumps — колонки": pumpsLayer, "Buffers — 120 м": buffersLayer },
    { position: "topright", collapsed: false }
  ).addTo(map);

  const opacityControl = L.control({ position: "topright" });
  opacityControl.onAdd = function () {
    const div = L.DomUtil.create("div", "history-opacity is-hidden");
    div.innerHTML = '<label for="history-opacity-range"><span>Прозрачность истории</span><strong>88%</strong></label><input id="history-opacity-range" type="range" min="10" max="100" value="88" step="1" aria-label="Прозрачность исторической карты">';
    const range = div.querySelector("input");
    const value = div.querySelector("strong");
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    range.addEventListener("input", function () {
      const opacity = Number(range.value) / 100;
      historicalTiles.setOpacity(opacity);
      value.textContent = `${range.value}%`;
    });
    return div;
  };
  opacityControl.addTo(map);

  map.on("baselayerchange", function (event) {
    const control = document.querySelector(".history-opacity");
    if (control) control.classList.toggle("is-hidden", event.layer !== historicalBase);
  });

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend");
    div.innerHTML = `
      <h3>Легенда</h3>
      <div class="legend-item"><i class="legend-circle"></i><span>Смерти от холеры</span></div>
      <div class="legend-item"><i class="legend-pump"></i><span>Водяная колонка</span></div>
      <div class="legend-item"><i class="legend-buffer"></i><span>Буфер 120 м</span></div>
      <div class="legend-scale"><span>count</span><i class="scale-dot small"></i><i class="scale-dot medium"></i><i class="scale-dot large"></i></div>`;
    return div;
  };
  legend.addTo(map);

  document.getElementById("reset-view").addEventListener("click", function () {
    if (dataBounds && dataBounds.isValid()) {
      map.fitBounds(dataBounds, { padding: [45, 45], maxZoom: 17, animate: true });
    } else {
      map.setView(FALLBACK_CENTER, FALLBACK_ZOOM, { animate: true });
    }
  });

  Promise.all([
    loadGeoJSON("data/pumps.geojson"),
    loadGeoJSON("data/deaths.geojson"),
    loadGeoJSON("data/buffers.geojson")
  ]).then(([pumps, deaths, buffers]) => {
    console.log(`[GeoJSON] Загружено: pumps=${pumps.features.length}, deaths=${deaths.features.length}, buffers=${buffers.features.length}`);
    pumpAnalysis = buildPumpAnalysis(pumps, deaths, buffers);
    console.table(pumpAnalysis.map((item) => ({
      pump_id: item.id,
      buffer_fid: item.bufferFid,
      death_sum: item.deathSum,
      death_points: item.deathPointCount,
      source: item.source
    })));
    renderBuffers(buffers, pumpAnalysis);
    renderDeaths(deaths);
    renderPumps(pumps, pumpAnalysis);
    buildRanking(pumpAnalysis);

    const renderedLayers = [
      ...buffersLayer.getLayers(),
      ...deathsLayer.getLayers(),
      ...pumpsLayer.getLayers()
    ];
    dataBounds = L.featureGroup(renderedLayers).getBounds();
    if (dataBounds.isValid()) {
      map.fitBounds(dataBounds, { padding: [45, 45], maxZoom: 17 });
    }
    hideStatus();
  }).catch((error) => {
    console.error("[GeoJSON] Ошибка загрузки или обработки данных:", error);
    const localHint = location.protocol === "file:"
      ? " Откройте проект через локальный сервер: python -m http.server 8000"
      : " Проверьте наличие и формат файлов в папке data.";
    showStatus("Не удалось загрузить GeoJSON." + localHint);
  });

  function loadGeoJSON(url) {
    const absoluteUrl = new URL(url, document.baseURI);
    return fetch(absoluteUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      let data;
      try {
        data = await response.json();
      } catch (error) {
        throw new Error(`${url}: файл не является корректным JSON (${error.message})`);
      }
      validateFeatureCollection(data, url);
      return data;
    });
  }

  function validateFeatureCollection(data, url) {
    if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      throw new Error(`${url}: ожидается GeoJSON FeatureCollection с массивом features`);
    }
    data.features.forEach((feature, index) => {
      if (!feature || feature.type !== "Feature" || !feature.geometry || !feature.geometry.type) {
        throw new Error(`${url}: некорректный объект features[${index}]`);
      }
      if (feature.geometry.type === "Point") {
        const coordinates = feature.geometry.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(Number.isFinite)) {
          throw new Error(`${url}: некорректные координаты Point в features[${index}]`);
        }
        const [lng, lat] = coordinates;
        if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
          throw new Error(`${url}: координаты должны быть в WGS 84 и порядке [долгота, широта]`);
        }
      }
    });
  }

  function renderDeaths(data) {
    L.geoJSON(data, {
      pointToLayer: (feature, latlng) => {
        const count = deathCount(feature);
        return L.circleMarker(latlng, {
          radius: Math.min(18, 4 + Math.sqrt(count) * 2.15),
          color: "#8e302d",
          weight: 1.5,
          fillColor: "#d9534f",
          fillOpacity: 0.72
        });
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        layer.bindPopup(popup("Случай смерти", p.address || "Точка наблюдения", [
          ["Количество смертей", deathCount(feature)],
          p.address ? ["Адрес", p.address] : null,
          p.date ? ["Дата", p.date] : null
        ]));
      }
    }).addTo(deathsLayer);
  }

  function renderPumps(data, analysis) {
    L.geoJSON(data, {
      pointToLayer: (feature, latlng) => {
        const icon = L.divIcon({
          className: "pump-marker",
          html: '<span class="pump-pin" aria-hidden="true"></span>',
          iconSize: [28, 34],
          iconAnchor: [14, 31],
          popupAnchor: [0, -30]
        });
        return L.marker(latlng, { icon, riseOnHover: true });
      },
      onEachFeature: (feature, layer) => {
        const item = analysis.find((candidate) => candidate.pumpFeature === feature);
        if (!item) return;
        layer.bindPopup(popup("Водяная колонка", item.name, [
          ["ID", item.id],
          ["Смертей в 120 м", item.deathSum],
          ["Точек/адресов", item.deathPointCount],
          ["Источник", item.source]
        ]));
        layer.on("click", () => selectPump(item.id));
        pumpMarkers.set(item.id, { layer, ...item });
      }
    }).addTo(pumpsLayer);
  }

  function renderBuffers(data, analysis) {
    (data.features || []).forEach((feature) => {
      const p = feature.properties || {};
      const item = analysis.find((candidate) => candidate.bufferFeature === feature);
      let layer;
      if (feature.geometry && feature.geometry.type === "Point") {
        const coords = feature.geometry.coordinates;
        layer = L.circle([coords[1], coords[0]], {
          radius: positiveNumber(p.radius_m, BUFFER_RADIUS),
          color: "#2e86de",
          weight: 2,
          opacity: 0.82,
          fillColor: "#2e86de",
          fillOpacity: 0.11
        });
      } else {
        layer = L.geoJSON(feature, { style: { color: "#2e86de", weight: 2, opacity: 0.82, fillColor: "#2e86de", fillOpacity: 0.11 } });
      }
      layer.bindPopup(popup("Буферная зона", item ? item.name : "Буфер 120 м", [
        item ? ["ID", item.id] : null,
        ["Радиус", `${safe(p.radius_m, BUFFER_RADIUS)} м`],
        item ? ["Точек/адресов", item.deathPointCount] : null,
        item ? ["Сумма смертей", item.deathSum] : null,
        item ? ["Источник", item.source] : null
      ])).addTo(buffersLayer);
    });
  }

  function buildRanking(analysis) {
    ranking = analysis.map(({ id, name, deathSum }) => ({ id, name, deathSum }))
      .sort((a, b) => b.deathSum - a.deathSum || a.id.localeCompare(b.id, "ru", { numeric: true }));

    const list = document.getElementById("pump-ranking");
    list.innerHTML = "";
    ranking.forEach((pump, index) => {
      const item = document.createElement("li");
      item.innerHTML = `<span class="rank-number">${String(index + 1).padStart(2, "0")}</span><button type="button" data-pump-id="${escapeAttribute(pump.id)}">${escapeHTML(pump.name)}</button><span class="rank-value">${pump.deathSum}</span>`;
      list.appendChild(item);
    });
    list.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-pump-id]");
      if (button) selectPump(button.dataset.pumpId, true);
    });
  }

  function selectPump(id, moveToMarker) {
    const selected = pumpMarkers.get(String(id));
    if (!selected) return;
    pumpMarkers.forEach(({ layer }) => layer.getElement() && layer.getElement().classList.remove("is-selected"));
    const element = selected.layer.getElement();
    if (element) element.classList.add("is-selected");
    const rankIndex = ranking.findIndex((item) => item.id === String(id));
    document.getElementById("selection-empty").hidden = true;
    document.getElementById("selection-content").hidden = false;
    document.getElementById("selected-name").textContent = selected.name;
    document.getElementById("selected-rank").textContent = rankIndex >= 0 ? `№ ${rankIndex + 1}` : "—";
    document.getElementById("selected-deaths").textContent = selected.deathSum ?? "—";
    document.getElementById("selected-points").textContent = selected.deathPointCount;
    document.getElementById("selected-source").textContent = selected.source;
    if (moveToMarker) {
      map.flyTo(selected.layer.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.7 });
      selected.layer.openPopup();
    }
  }

  function buildPumpAnalysis(pumps, deaths, buffers) {
    const pumpFeatures = pumps.features || [];
    const bufferFeatures = buffers.features || [];
    const deathFeatures = deaths.features || [];
    const assignments = assignBuffersToPumps(pumpFeatures, bufferFeatures);
    const rawPumpIds = pumpFeatures.map((feature) => propertyValue(feature.properties, ["pump_id", "id"]));
    const usablePumpIds = rawPumpIds.every((value) => value !== undefined && value !== null && value !== "")
      && new Set(rawPumpIds.map(String)).size === pumpFeatures.length;

    return pumpFeatures.map((pumpFeature, index) => {
      const bufferFeature = assignments.get(pumpFeature) || null;
      const bufferFid = bufferFeature ? propertyValue(bufferFeature.properties, ["fid", "buffer_id", "id"]) : null;
      const sourceId = usablePumpIds ? rawPumpIds[index] : bufferFid;
      const id = formatPumpId(sourceId, index);
      const nameValue = propertyValue(pumpFeature.properties, ["name"]);
      const name = nameValue ? String(nameValue) : `Колонка ${id}`;
      const qgisSum = bufferFeature ? numericProperty(bufferFeature.properties, ["Count_sum", "sum_Count", "death_sum"]) : { found: false, value: null, field: null };
      const deathsInside = deathFeatures.filter((death) => deathInsideAnalysisArea(death, pumpFeature, bufferFeature));
      const calculatedSum = deathsInside.reduce((sum, death) => sum + deathCount(death), 0);
      const deathSum = qgisSum.found ? (qgisSum.value ?? 0) : calculatedSum;
      const source = qgisSum.found ? `QGIS: ${qgisSum.field}` : "расчёт по Count";
      return {
        id,
        name,
        pumpFeature,
        bufferFeature,
        bufferFid: bufferFid ?? "—",
        deathSum,
        deathPointCount: deathsInside.length,
        source
      };
    });
  }

  function assignBuffersToPumps(pumpFeatures, bufferFeatures) {
    const candidates = [];
    bufferFeatures.forEach((bufferFeature) => {
      const center = geometryCenter(bufferFeature.geometry);
      if (!center) return;
      pumpFeatures.forEach((pumpFeature) => {
        if (!pumpFeature.geometry || pumpFeature.geometry.type !== "Point") return;
        const [pumpLng, pumpLat] = pumpFeature.geometry.coordinates;
        candidates.push({
          bufferFeature,
          pumpFeature,
          distance: distanceMeters(center[1], center[0], pumpLat, pumpLng)
        });
      });
    });
    candidates.sort((a, b) => a.distance - b.distance);
    const assignedBuffers = new Set();
    const assignedPumps = new Set();
    const result = new Map();
    candidates.forEach(({ bufferFeature, pumpFeature }) => {
      if (assignedBuffers.has(bufferFeature) || assignedPumps.has(pumpFeature)) return;
      assignedBuffers.add(bufferFeature);
      assignedPumps.add(pumpFeature);
      result.set(pumpFeature, bufferFeature);
    });
    return result;
  }

  function geometryCenter(geometry) {
    if (!geometry) return null;
    if (geometry.type === "Point") return geometry.coordinates;
    const points = [];
    collectCoordinates(geometry.coordinates, points);
    if (!points.length) return null;
    const lngs = points.map((point) => point[0]);
    const lats = points.map((point) => point[1]);
    return [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  }

  function collectCoordinates(value, points) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      points.push(value);
      return;
    }
    value.forEach((child) => collectCoordinates(child, points));
  }

  function deathInsideAnalysisArea(deathFeature, pumpFeature, bufferFeature) {
    if (!deathFeature.geometry || deathFeature.geometry.type !== "Point") return false;
    const point = deathFeature.geometry.coordinates;
    if (bufferFeature && ["Polygon", "MultiPolygon"].includes(bufferFeature.geometry && bufferFeature.geometry.type)) {
      return pointInGeometry(point, bufferFeature.geometry);
    }
    if (!pumpFeature.geometry || pumpFeature.geometry.type !== "Point") return false;
    const [lng, lat] = pumpFeature.geometry.coordinates;
    return distanceMeters(lat, lng, point[1], point[0]) <= BUFFER_RADIUS;
  }

  function pointInGeometry(point, geometry) {
    if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
    if (geometry.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
    return false;
  }

  function pointInPolygon(point, rings) {
    if (!rings.length || !pointInRing(point, rings[0])) return false;
    return !rings.slice(1).some((ring) => pointInRing(point, ring));
  }

  function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      if (pointOnSegment(point, a, b)) return true;
      const crosses = ((b[1] > point[1]) !== (a[1] > point[1]))
        && point[0] < (a[0] - b[0]) * (point[1] - b[1]) / (a[1] - b[1]) + b[0];
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function pointOnSegment(point, a, b) {
    const epsilon = 1e-10;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= epsilon * epsilon) {
      return Math.hypot(point[0] - a[0], point[1] - a[1]) <= epsilon;
    }
    const cross = (point[1] - a[1]) * dx - (point[0] - a[0]) * dy;
    if (Math.abs(cross) > epsilon) return false;
    const dot = (point[0] - a[0]) * dx + (point[1] - a[1]) * dy;
    return dot >= -epsilon && dot <= lengthSquared + epsilon;
  }

  function deathCount(feature) {
    const value = propertyValue(feature.properties, ["Count", "count", "COUNT"]);
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  }

  function propertyValue(properties, names) {
    if (!properties) return undefined;
    const keys = Object.keys(properties);
    for (const name of names) {
      const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (key) return properties[key];
    }
    return undefined;
  }

  function numericProperty(properties, names) {
    if (!properties) return { found: false, value: null, field: null };
    const keys = Object.keys(properties);
    for (const name of names) {
      const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (!key) continue;
      const raw = properties[key];
      if (raw === null || raw === "") return { found: true, value: 0, field: key };
      const value = Number(raw);
      return { found: true, value: Number.isFinite(value) ? value : 0, field: key };
    }
    return { found: false, value: null, field: null };
  }

  function formatPumpId(value, index) {
    if (value !== undefined && value !== null && value !== "") {
      const text = String(value).trim();
      return /^p/i.test(text) ? text.toLowerCase() : `p${text}`;
    }
    return `p${index + 1}`;
  }

  function distanceMeters(lat1, lng1, lat2, lng2) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const earthRadius = 6371000;
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function popup(kicker, title, rows) {
    const rowHTML = rows.filter(Boolean).map(([label, value]) => `<div class="popup-row"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join("");
    return `<div class="popup-kicker">${escapeHTML(kicker)}</div><div class="popup-title">${escapeHTML(title)}</div>${rowHTML}`;
  }

  function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function safe(value, fallback) {
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function escapeAttribute(value) { return escapeHTML(value); }

  function showStatus(message) {
    const status = document.getElementById("map-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function hideStatus() {
    const status = document.getElementById("map-status");
    if (!status) return;
    status.textContent = "";
    status.hidden = true;
  }
})();
