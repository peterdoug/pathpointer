"use strict";

const EARTH_RADIUS = 6371008.8;
const SVG_NS = "http://www.w3.org/2000/svg";
const TRACK_CENTER = 146;
const TRACK_RADIUS = 122;

const state = {
  track: null,
  position: null,
  accuracy: null,
  heading: null,
  compassEnabled: false,
  locationPending: true,
};

const $ = (id) => document.getElementById(id);
const elements = {
  sensorDot: $("sensor-dot"), compass: $("compass"), needle: $("needle"),
  distance: $("distance"), readoutLabel: $("readout-label"), trackRow: $("track-row"),
  trackName: $("track-name"), trackDetail: $("track-detail"), fileInput: $("file-input"),
  fileButton: $("file-button"), fileButtonLabel: $("file-button-label"), compassButton: $("compass-button"),
  errorCard: $("error-card"), errorMessage: $("error-message"), accuracy: $("accuracy"),
  heading: $("heading"), installHint: $("install-hint"), trackView: $("track-view"),
  trackPaths: $("track-paths"), accuracyCircle: $("accuracy-circle"), nearestMarker: $("nearest-marker"),
};

const radians = (degrees) => degrees * Math.PI / 180;
const degrees = (value) => value * 180 / Math.PI;

function wrappedLongitudeDelta(value) {
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

function localVector(origin, point) {
  const originLatitude = radians(origin.latitude);
  const pointLatitude = radians(point.latitude);
  return {
    x: EARTH_RADIUS * wrappedLongitudeDelta(radians(point.longitude) - radians(origin.longitude)) * Math.cos((originLatitude + pointLatitude) / 2),
    y: EARTH_RADIUS * (pointLatitude - originLatitude),
  };
}

function bearing(east, north) {
  if (Math.abs(east) < 0.000001 && Math.abs(north) < 0.000001) return 0;
  return (degrees(Math.atan2(east, north)) + 360) % 360;
}

function interpolate(start, end, fraction) {
  const longitudeDelta = wrappedLongitudeDelta(radians(end.longitude) - radians(start.longitude));
  let longitude = radians(start.longitude) + fraction * longitudeDelta;
  if (longitude > Math.PI) longitude -= 2 * Math.PI;
  if (longitude < -Math.PI) longitude += 2 * Math.PI;
  return { latitude: start.latitude + fraction * (end.latitude - start.latitude), longitude: degrees(longitude) };
}

function nearestPointOnTrack(origin, segments) {
  let best = null;
  const consider = (coordinate, x, y) => {
    const candidate = { coordinate, distance: Math.hypot(x, y), bearing: bearing(x, y) };
    if (!best || candidate.distance < best.distance) best = candidate;
  };

  for (const segment of segments) {
    if (segment.length === 1) {
      const vector = localVector(origin, segment[0]);
      consider(segment[0], vector.x, vector.y);
      continue;
    }
    for (let index = 0; index < segment.length - 1; index += 1) {
      const start = localVector(origin, segment[index]);
      const end = localVector(origin, segment[index + 1]);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const rawFraction = lengthSquared > 0 ? -(start.x * dx + start.y * dy) / lengthSquared : 0;
      const fraction = Math.min(1, Math.max(0, rawFraction));
      consider(interpolate(segment[index], segment[index + 1], fraction), start.x + fraction * dx, start.y + fraction * dy);
    }
  }
  return best;
}

function normalizeRotation(value) {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function formatDistance(distance) {
  return distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(2)} km`;
}

function directChildText(element, childName) {
  const child = Array.from(element.children).find((item) => item.localName.toLowerCase() === childName);
  return child && child.textContent ? child.textContent.trim() : "";
}

function pointsWithin(element, pointName) {
  return Array.from(element.getElementsByTagNameNS("*", pointName)).flatMap((point) => {
    const latitude = Number(point.getAttribute("lat"));
    const longitude = Number(point.getAttribute("lon"));
    return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? [{ latitude, longitude }] : [];
  });
}

function parseGPX(source, fallbackName) {
  const xml = new DOMParser().parseFromString(source, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("This file is not valid GPX/XML.");
  const segments = [];
  const tracks = Array.from(xml.getElementsByTagNameNS("*", "trk"));
  const routes = Array.from(xml.getElementsByTagNameNS("*", "rte"));
  for (const track of tracks) {
    for (const segment of Array.from(track.getElementsByTagNameNS("*", "trkseg"))) {
      const points = pointsWithin(segment, "trkpt");
      if (points.length) segments.push(points);
    }
  }
  for (const route of routes) {
    const points = pointsWithin(route, "rtept");
    if (points.length) segments.push(points);
  }
  if (!segments.length) throw new Error("No track or route points were found in this GPX file.");
  const namedPath = [...tracks, ...routes].find((element) => directChildText(element, "name"));
  return {
    name: (namedPath && directChildText(namedPath, "name")) || fallbackName,
    segments,
    pointCount: segments.reduce((total, segment) => total + segment.length, 0),
  };
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorCard.hidden = !message;
}

function headingUpPoint(vector, heading, scale) {
  const angle = radians(heading || 0);
  const right = vector.x * Math.cos(angle) - vector.y * Math.sin(angle);
  const forward = vector.x * Math.sin(angle) + vector.y * Math.cos(angle);
  return {
    x: TRACK_CENTER + right * scale,
    y: TRACK_CENTER - forward * scale,
  };
}

function renderTrackView(nearest) {
  const ready = Boolean(state.track && state.position && nearest);
  elements.trackView.classList.toggle("visible", ready);
  elements.trackPaths.replaceChildren();
  elements.nearestMarker.hidden = true;
  elements.accuracyCircle.setAttribute("r", "0");
  if (!ready) return;

  const accuracy = Number.isFinite(state.accuracy) ? state.accuracy : 0;
  const viewRadiusMetres = Math.max(75, Math.min(20000, Math.max(nearest.distance * 1.35 + 40, accuracy * 2.5, 120)));
  const scale = TRACK_RADIUS / viewRadiusMetres;
  const heading = state.heading || 0;

  for (const segment of state.track.segments) {
    if (!segment.length) continue;
    const path = document.createElementNS(SVG_NS, "path");
    const commands = segment.map((point, index) => {
      const projected = headingUpPoint(localVector(state.position, point), heading, scale);
      return `${index === 0 ? "M" : "L"}${projected.x.toFixed(2)} ${projected.y.toFixed(2)}`;
    });
    path.setAttribute("d", commands.join(" "));
    path.setAttribute("class", "local-track-path");
    elements.trackPaths.appendChild(path);
  }

  const marker = headingUpPoint(localVector(state.position, nearest.coordinate), heading, scale);
  elements.nearestMarker.setAttribute("cx", marker.x.toFixed(2));
  elements.nearestMarker.setAttribute("cy", marker.y.toFixed(2));
  elements.nearestMarker.hidden = false;
  elements.accuracyCircle.setAttribute("r", Math.min(TRACK_RADIUS, accuracy * scale).toFixed(2));
}

function render() {
  elements.sensorDot.classList.toggle("ready", Boolean(state.position));
  elements.sensorDot.setAttribute("aria-label", state.position ? "GPS active" : "GPS waiting");
  elements.trackRow.hidden = !state.track;
  if (state.track) {
    elements.trackName.textContent = state.track.name;
    elements.trackDetail.textContent = `${state.track.pointCount} points · ${state.track.segments.length} ${state.track.segments.length === 1 ? "segment" : "segments"}`;
    elements.fileButtonLabel.textContent = "Change GPX file";
  } else {
    elements.fileButtonLabel.textContent = "Choose GPX file";
  }

  const nearest = state.track && state.position ? nearestPointOnTrack(state.position, state.track.segments) : null;
  const isOnPath = Boolean(nearest && nearest.distance < 3);
  renderTrackView(nearest);
  elements.needle.classList.toggle("visible", Boolean(nearest));
  elements.needle.style.transform = `rotate(${normalizeRotation((nearest ? nearest.bearing : 0) - (state.heading || 0))}deg)`;
  elements.compass.setAttribute("aria-label", isOnPath ? "You are on the path" : "Compass pointing toward the path");

  elements.distance.classList.toggle("empty", !state.track || !state.position);
  elements.readoutLabel.classList.toggle("success", isOnPath);
  if (!state.track) {
    elements.distance.textContent = "—";
    elements.readoutLabel.textContent = "IMPORT A GPX PATH TO BEGIN";
  } else if (!state.position) {
    elements.distance.textContent = "…";
    elements.readoutLabel.textContent = state.locationPending ? "WAITING FOR GPS" : "GPS NEEDED";
  } else {
    elements.distance.textContent = formatDistance(nearest ? nearest.distance : 0);
    elements.readoutLabel.textContent = isOnPath ? "YOU’RE ON THE PATH" : "TO THE CLOSEST POINT";
  }

  elements.accuracy.hidden = state.accuracy === null;
  if (state.accuracy !== null) elements.accuracy.textContent = `GPS ±${Math.round(state.accuracy)} m`;
  elements.heading.hidden = state.heading === null;
  if (state.heading !== null) elements.heading.textContent = `Heading ${Math.round(state.heading)}°`;
  elements.compassButton.hidden = state.compassEnabled;
}

function onOrientation(event) {
  if (typeof event.webkitCompassHeading === "number") state.heading = event.webkitCompassHeading;
  else if (event.absolute && typeof event.alpha === "number") state.heading = (360 - event.alpha + 360) % 360;
  render();
}

async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent === "undefined") throw new Error("This browser does not provide compass data.");
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") throw new Error("Compass access was not allowed.");
    }
    window.addEventListener("deviceorientation", onOrientation, true);
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    state.compassEnabled = true;
    showError("");
    render();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Compass access could not be enabled.");
  }
}

async function importFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    state.track = parseGPX(await file.text(), file.name.replace(/\.gpx$/i, "") || "Imported path");
    showError("");
  } catch (error) {
    state.track = null;
    showError(error instanceof Error ? error.message : "The GPX file could not be opened.");
  } finally {
    event.target.value = "";
    render();
  }
}

function startLocation() {
  if (!("geolocation" in navigator)) {
    state.locationPending = false;
    showError("This browser does not provide GPS location.");
    render();
    return;
  }
  navigator.geolocation.watchPosition((result) => {
    state.position = { latitude: result.coords.latitude, longitude: result.coords.longitude };
    state.accuracy = result.coords.accuracy;
    state.locationPending = false;
    render();
  }, (error) => {
    state.locationPending = false;
    showError(error.code === error.PERMISSION_DENIED
      ? "Location access is off. Allow it in Safari settings to use guidance."
      : "Your location is not available yet. Move outdoors and try again.");
    render();
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

elements.fileButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", importFile);
elements.compassButton.addEventListener("click", enableCompass);
const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
elements.installHint.hidden = standalone;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => undefined);
startLocation();
render();