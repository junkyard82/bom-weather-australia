// Pure functions for the BOM Weather widget. No QML types in here so the whole
// file runs under `node --test test/` as well as inside the shell.
//
// Input is the JSON printed by bin/bom-api; output is plain objects the QML
// binds to directly.

var BAR_GLYPH = "󰖕"     // md-weather_partly_cloudy — identity glyph, also the no-data badge
var WARNING_GLYPH = "󰀦" // md-alert

// BOM icon_descriptor → nerd-font glyph, with day/night variants where BOM's
// own iconography has them. Descriptors are the Bureau's fixed vocabulary; an
// unknown one falls back to plain cloud rather than guessing.
var ICONS = {
  sunny:            { day: "󰖙", night: "󰖔" },
  clear:            { day: "󰖙", night: "󰖔" },
  mostly_sunny:     { day: "󰖕", night: "󰼱" },
  partly_cloudy:    { day: "󰖕", night: "󰼱" },
  cloudy:           { day: "󰖐", night: "󰖐" },
  fog:              { day: "󰖑", night: "󰖑" },
  haze:             { day: "󰼰", night: "󰼰" },
  hazy:             { day: "󰼰", night: "󰼰" },
  light_rain:       { day: "󰖗", night: "󰖗" },
  light_shower:     { day: "󰖗", night: "󰖗" },
  shower:           { day: "󰖗", night: "󰖗" },
  rain:             { day: "󰖖", night: "󰖖" },
  heavy_shower:     { day: "󰖖", night: "󰖖" },
  storm:            { day: "󰖓", night: "󰖓" },
  snow:             { day: "󰖘", night: "󰖘" },
  frost:            { day: "󰜗", night: "󰜗" },
  windy:            { day: "󰖝", night: "󰖝" },
  dust:             { day: "󰖝", night: "󰖝" },
  dusty:            { day: "󰖝", night: "󰖝" },
  cyclone:          { day: "󰠜", night: "󰠜" },
  tropical_cyclone: { day: "󰠜", night: "󰠜" }
}

function glyphFor(descriptor, isNight) {
  var entry = ICONS[String(descriptor || "")]
  if (!entry) return "󰖐"
  return isNight === true ? entry.night : entry.day
}

// Everything below that touches `raw` treats the BOM response as untrusted
// input: it lands in QML Text items, tooltips and notification arguments.
// Same defence pair as the sibling plugins — trim() here, Text.PlainText in
// Panel.qml, byte caps in bin/bom-api.
var MAX_TEXT = 200
var MAX_LONG_TEXT = 600 // extended_text is a paragraph by design
var MAX_DAYS = 8
var MAX_HOURS = 12
var MAX_WARNINGS = 10

var CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
var LINE_BREAKS = /[\r\n\t\u2028\u2029]+/g

// One-line, plain, bounded. Angle brackets become single angle quotes so
// nothing tag-shaped survives into Qt components whose text format we do not
// own (tooltips, notification bodies).
function trim(s, limit) {
  var out = String(s === undefined || s === null ? "" : s)
    .replace(CONTROL_CHARS, "")
    .replace(LINE_BREAKS, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/^\s+|\s+$/g, "")
  var max = limit || MAX_TEXT
  if (out.length > max) out = out.slice(0, max - 1) + "…"
  return out
}

// BOM timestamps are ISO 8601 with an explicit zone ("2026-09-01T06:40:00Z").
// Only that shape is accepted; Date renders it in the machine's local zone,
// which for a desktop widget is the zone the user is standing in.
function parseIso(text) {
  var s = trim(text, 40)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null
  var d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function pad2(n) { return (n < 10 ? "0" : "") + n }
function clock(date) { return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) }

var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()) }
function dayDiff(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / 86400000) }
function shortDate(date) { return DAY_NAMES[date.getDay()] + " " + date.getDate() + " " + MONTH_NAMES[date.getMonth()] }

// "3pm", "12am" — compact labels for the hourly strip.
function formatHour(date) {
  var h = date.getHours()
  var suffix = h < 12 ? "am" : "pm"
  var display = h % 12
  if (display === 0) display = 12
  return display + suffix
}

// A temperature that may legitimately be null (BOM omits temp_min on today
// once the minimum has passed). Rounded for display; "" when absent.
function tempText(value) {
  if (value === undefined || value === null || value === "") return ""
  var n = parseFloat(String(value))
  return isNaN(n) ? "" : String(Math.round(n)) + "°"
}

function intOrNull(value) {
  var n = parseFloat(String(value === undefined || value === null ? "" : value))
  return isNaN(n) ? null : Math.round(n)
}

// The bridge echoes the location query it resolved, normalised this same way,
// so the panel can tell a response for a stale setting from a current one.
function normalizeQuery(s) {
  return String(s === undefined || s === null ? "" : s)
    .toLowerCase().replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(0, 80)
}

// "1–2 mm", "up to 2 mm", "" when the Bureau expects nothing.
function rainAmountText(amount) {
  if (!amount || typeof amount !== "object") return ""
  var min = intOrNull(amount.min)
  var max = intOrNull(amount.max)
  if (max === null || max === 0) return ""
  if (min === null || min === 0) return "up to " + max + " mm"
  if (min === max) return min + " mm"
  return min + "–" + max + " mm"
}

function normalizeLocation(raw) {
  if (!raw || typeof raw !== "object") return null
  var name = trim(raw.name, 60)
  if (!name) return null
  return {
    name: name,
    state: trim(raw.state, 3).toUpperCase(),
    postcode: trim(raw.postcode, 4),
    geohash: trim(raw.geohash, 7).toLowerCase().replace(/[^0-9a-z]/g, ""),
    timezone: trim(raw.timezone, 40)
  }
}

function normalizeObservations(raw) {
  if (!raw || typeof raw !== "object") return null
  var wind = raw.wind && typeof raw.wind === "object" ? raw.wind : {}
  var gust = raw.gust && typeof raw.gust === "object" ? raw.gust : {}
  var maxT = raw.max_temp && typeof raw.max_temp === "object" ? raw.max_temp.value : null
  var minT = raw.min_temp && typeof raw.min_temp === "object" ? raw.min_temp.value : null
  var station = raw.station && typeof raw.station === "object" ? raw.station : {}
  var stationMetres = intOrNull(station.distance)
  return {
    temp: intOrNull(raw.temp),
    tempExact: typeof raw.temp === "number" ? raw.temp : null,
    feelsLike: intOrNull(raw.temp_feels_like),
    humidity: intOrNull(raw.humidity),
    windDir: trim(wind.direction, 3),
    windKmh: intOrNull(wind.speed_kilometre),
    gustKmh: intOrNull(gust.speed_kilometre),
    rainSince9am: typeof raw.rain_since_9am === "number" ? raw.rain_since_9am : null,
    maxTemp: intOrNull(maxT),
    minTemp: intOrNull(minT),
    stationName: trim(station.name, 60),
    stationKm: stationMetres === null ? null : Math.round(stationMetres / 100) / 10
  }
}

function normalizeDay(raw, now) {
  if (!raw || typeof raw !== "object") return null
  var date = parseIso(raw.date)
  var rain = raw.rain && typeof raw.rain === "object" ? raw.rain : {}
  var uv = raw.uv && typeof raw.uv === "object" ? raw.uv : {}
  var astro = raw.astronomical && typeof raw.astronomical === "object" ? raw.astronomical : {}
  var nowBlock = raw.now && typeof raw.now === "object" ? raw.now : null
  var label = ""
  if (date) {
    // BOM stamps each day at local midnight expressed in UTC; half a day of
    // slack keeps the label right on either side of a DST edge.
    var diff = dayDiff(new Date(date.getTime() + 43200000), now)
    label = diff === 0 ? "Today" : (diff === 1 ? "Tomorrow" : shortDate(new Date(date.getTime() + 43200000)))
  }
  return {
    date: date,
    label: label,
    min: intOrNull(raw.temp_min),
    max: intOrNull(raw.temp_max),
    rainChance: intOrNull(rain.chance),
    rainAmount: rainAmountText(rain.amount),
    shortText: trim(raw.short_text, 80).replace(/\.$/, ""),
    extendedText: trim(raw.extended_text, MAX_LONG_TEXT),
    glyph: glyphFor(raw.icon_descriptor, false),
    uvIndex: intOrNull(uv.max_index),
    uvCategory: trim(uv.category, 20),
    sunrise: parseIso(astro.sunrise_time),
    sunset: parseIso(astro.sunset_time),
    fireDanger: typeof raw.fire_danger === "string" ? trim(raw.fire_danger, 40) : "",
    nowLabel: nowBlock ? trim(nowBlock.now_label, 20) : "",
    tempNow: nowBlock ? intOrNull(nowBlock.temp_now) : null,
    laterLabel: nowBlock ? trim(nowBlock.later_label, 20) : "",
    tempLater: nowBlock ? intOrNull(nowBlock.temp_later) : null
  }
}

function normalizeHour(raw) {
  if (!raw || typeof raw !== "object") return null
  var time = parseIso(raw.time)
  if (!time) return null
  var rain = raw.rain && typeof raw.rain === "object" ? raw.rain : {}
  return {
    time: time,
    label: formatHour(time),
    temp: intOrNull(raw.temp),
    rainChance: intOrNull(rain.chance),
    glyph: glyphFor(raw.icon_descriptor, raw.is_night === true)
  }
}

function normalizeWarning(raw, now) {
  if (!raw || typeof raw !== "object") return null
  var id = trim(raw.id, 60)
  if (!id) return null
  var expiry = parseIso(raw.expiry_time)
  var phase = trim(raw.phase, 20).toLowerCase()
  var active = phase !== "cancelled" && (!expiry || expiry.getTime() > now.getTime())
  return {
    id: id,
    title: trim(raw.title, 120),
    shortTitle: trim(raw.short_title, 80) || trim(raw.title, 80),
    group: trim(raw.warning_group_type, 20).toLowerCase(),
    phase: phase,
    issued: parseIso(raw.issue_time),
    expiry: expiry,
    active: active
  }
}

// bin/bom-api output → view model. Never throws.
function parseResponse(raw, now) {
  now = now || new Date()
  var result = {
    ok: false, error: "", message: "", stale: false, cached: false,
    fetchedAt: 0, query: "", location: null, current: null, today: null,
    hours: [], days: [], warnings: [], warningsKnown: false
  }
  var data
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch (e) {
    result.error = "bad-response"
    result.message = "Unreadable response from bom-api."
    return result
  }
  if (!data || typeof data !== "object") {
    result.error = "bad-response"
    result.message = "Empty response from bom-api."
    return result
  }
  result.error = trim(data.error, 40)
  result.message = trim(data.message, 300)
  result.stale = data.stale === true
  result.cached = data.cached === true
  result.fetchedAt = typeof data.fetchedAt === "number" ? data.fetchedAt * 1000 : 0
  result.query = normalizeQuery(data.query)
  result.location = normalizeLocation(data.location)
  if (data.ok !== true) return result

  // A success object must carry a location and a daily forecast; anything
  // less must never read as "clear skies".
  if (!result.location || !Array.isArray(data.daily) || data.daily.length === 0) {
    result.error = "bad-response"
    result.message = "Response carried no forecast."
    return result
  }

  result.current = normalizeObservations(data.observations)
  var days = []
  var dayCount = Math.min(data.daily.length, MAX_DAYS + 1)
  for (var i = 0; i < dayCount; i++) {
    var day = normalizeDay(data.daily[i], now)
    if (day) days.push(day)
  }
  result.today = days.length ? days[0] : null
  result.days = days.slice(1, MAX_DAYS)

  if (Array.isArray(data.hourly)) {
    var hours = []
    for (var j = 0; j < data.hourly.length && hours.length < MAX_HOURS; j++) {
      var hour = normalizeHour(data.hourly[j])
      // Skip periods already behind us; BOM keeps serving the whole day.
      if (hour && hour.time.getTime() >= now.getTime() - 45 * 60000) hours.push(hour)
    }
    result.hours = hours
  }

  // warnings:null means that fetch failed — the panel keeps what it had
  // rather than reading a network blip as "all clear".
  if (Array.isArray(data.warnings)) {
    var warnings = []
    var warningCount = Math.min(data.warnings.length, MAX_WARNINGS * 3)
    for (var k = 0; k < warningCount && warnings.length < MAX_WARNINGS; k++) {
      var w = normalizeWarning(data.warnings[k], now)
      if (w && w.active) warnings.push(w)
    }
    result.warnings = warnings
    result.warningsKnown = true
  }

  result.ok = true
  return result
}

// Bar badge: condition glyph plus the temperature, e.g. "󰖗 21°".
function badgeText(vm, badgeShows) {
  if (!vm || !vm.ok) return BAR_GLYPH
  var glyph = vm.today ? vm.today.glyph : BAR_GLYPH
  if (vm.hours.length) glyph = vm.hours[0].glyph
  var temp = null
  if (vm.current) temp = badgeShows === "feels-like" ? vm.current.feelsLike : vm.current.temp
  if (temp === null && vm.today) temp = vm.today.tempNow
  return temp === null ? glyph : glyph + " " + temp + "°"
}

function badgeUrgent(vm) {
  if (!vm || !Array.isArray(vm.warnings)) return false
  for (var i = 0; i < vm.warnings.length; i++) {
    if (vm.warnings[i].group === "major") return true
  }
  return false
}

// "21°, feels 16° · Shower or two"
function summaryLine(vm) {
  if (!vm || !vm.ok) return ""
  var parts = []
  if (vm.current && vm.current.temp !== null) {
    var t = vm.current.temp + "°"
    if (vm.current.feelsLike !== null && vm.current.feelsLike !== vm.current.temp)
      t += ", feels " + vm.current.feelsLike + "°"
    parts.push(t)
  }
  if (vm.today && vm.today.shortText) parts.push(vm.today.shortText)
  return parts.join(" · ") || "Forecast loaded"
}

function tooltip(vm) {
  if (!vm || !vm.ok || !vm.location) return "BOM Weather"
  var line = vm.location.name
  var rest = summaryLine(vm)
  if (rest) line += " · " + rest
  if (vm.warnings && vm.warnings.length)
    line += " · " + vm.warnings.length + (vm.warnings.length === 1 ? " warning" : " warnings")
  return line
}

// "until 13:15", "until Tue 2 Sep" — how long a warning stands.
function formatExpiry(warning, now) {
  if (!warning || !warning.expiry) return ""
  now = now || new Date()
  if (dayDiff(warning.expiry, now) === 0) return "until " + clock(warning.expiry)
  return "until " + shortDate(warning.expiry) + " " + clock(warning.expiry)
}

// Which warnings are new since the last fetch. Feeds desktop notifications;
// first fetch never notifies (the caller gates on everLoaded, as siblings do).
function diffWarnings(previous, next) {
  var seen = {}
  for (var i = 0; i < previous.length; i++) seen[previous[i].id] = true
  var fresh = []
  for (var j = 0; j < next.length; j++) {
    if (!seen[next[j].id]) fresh.push(next[j])
  }
  return fresh
}

function notificationFor(warning) {
  return {
    headline: warning.shortTitle || "BOM warning",
    body: warning.title + (warning.expiry ? " · " + formatExpiry(warning) : ""),
    glyph: WARNING_GLYPH,
    urgency: warning.group === "major" ? "critical" : "normal"
  }
}

// "just now", "4m ago", "3h ago", "yesterday 14:02", "Mon 24 Aug"
function formatRelative(date, now) {
  if (!date) return ""
  now = now || new Date()
  var seconds = Math.round((now - date) / 1000)
  if (seconds < 45) return "just now"
  if (seconds < 3600) return Math.max(1, Math.round(seconds / 60)) + "m ago"
  if (seconds < 21600) return Math.round(seconds / 3600) + "h ago"
  var days = dayDiff(now, date)
  if (days === 0) return "today " + clock(date)
  if (days === 1) return "yesterday " + clock(date)
  return shortDate(date)
}

// The same page the BOM app opens for a location.
function webUrl(location) {
  if (!location || !location.geohash || !location.name) return "https://weather.bom.gov.au"
  var slug = location.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (!slug) return "https://weather.bom.gov.au"
  return "https://weather.bom.gov.au/location/" + location.geohash + "-" + slug
}

var SETUP_COMMAND = "omarchy bar set io.github.zuccs.bom-weather location \"Brighton VIC\""

if (typeof module !== "undefined") {
  module.exports = {
    BAR_GLYPH: BAR_GLYPH,
    WARNING_GLYPH: WARNING_GLYPH,
    MAX_TEXT: MAX_TEXT,
    MAX_LONG_TEXT: MAX_LONG_TEXT,
    MAX_DAYS: MAX_DAYS,
    MAX_HOURS: MAX_HOURS,
    MAX_WARNINGS: MAX_WARNINGS,
    SETUP_COMMAND: SETUP_COMMAND,
    trim: trim,
    parseIso: parseIso,
    glyphFor: glyphFor,
    formatHour: formatHour,
    tempText: tempText,
    normalizeQuery: normalizeQuery,
    rainAmountText: rainAmountText,
    normalizeObservations: normalizeObservations,
    normalizeDay: normalizeDay,
    normalizeHour: normalizeHour,
    normalizeWarning: normalizeWarning,
    parseResponse: parseResponse,
    badgeText: badgeText,
    badgeUrgent: badgeUrgent,
    summaryLine: summaryLine,
    tooltip: tooltip,
    formatExpiry: formatExpiry,
    diffWarnings: diffWarnings,
    notificationFor: notificationFor,
    formatRelative: formatRelative,
    webUrl: webUrl
  }
}
