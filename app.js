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
  maxDeviation: null,
};

const $ = (id) => document.getElementById(id);
const elements = {
  sensorDot: $("