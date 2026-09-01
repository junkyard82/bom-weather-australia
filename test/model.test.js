// Run with: node --test test/*.test.js
//
// Labels like "Tomorrow" and "5pm" are rendered in the machine's local zone,
// exactly as the widget does on a desktop in Australia; pin the zone so the
// assertions hold on any dev box.
process.env.TZ = "Australia/Melbourne"

const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

const NOW = new Date("2026-09-01T17:00:00+10:00") // Tue 1 Sep 2026 5pm AEST

// Fixtures follow the real shapes: bin/bom-api wraps the Bureau's own field
// names, so these mirror api.weather.bom.gov.au responses.
const LOCATION = { name: "Brighton", state: "VIC", postcode: "3186", geohash: "r1r077n" }

const OBSERVATIONS = {
  temp: 20.7, temp_feels_like: 16.4, humidity: 41,
  wind: { speed_kilometre: 19, direction: "N" },
  gust: { speed_kilometre: 28 },
  rain_since_9am: 0,
  max_temp: { value: 21.8 }, min_temp: { value: 9.9 },
  station: { name: "Melbourne (Olympic Park)", distance: 2078 }
}

function day(date, extra) {
  return Object.assign({
    date: date,
    temp_min: 12, temp_max: 23,
    rain: { chance: 70, amount: { min: 1, max: 2, units: "mm" } },
    uv: { max_index: 5, category: "moderate" },
    astronomical: { sunrise_time: "2026-08-31T20:42:13Z", sunset_time: "2026-09-01T07:58:33Z" },
    short_text: "Shower or two.",
    extended_text: "Becoming cloudy. High chance of showers.",
    icon_descriptor: "shower",
    fire_danger: null
  }, extra || {})
}

const DAILY = [
  day("2026-08-31T14:00:00Z", { temp_min: null, now: { now_label: "Max", temp_now: 23, later_label: "Overnight min", temp_later: 12 } }),
  day("2026-09-01T14:00:00Z", { short_text: "Morning shower or two.", icon_descriptor: "light_shower" }),
  day("2026-09-02T14:00:00Z", { short_text: "Showers.", icon_descriptor: "rain" }),
  day("2026-09-03T14:00:00Z"), day("2026-09-04T14:00:00Z"), day("2026-09-05T14:00:00Z"),
  day("2026-09-06T14:00:00Z"), day("2026-09-07T14:00:00Z"), day("2026-09-08T14:00:00Z")
]

const HOURLY = [
  { time: "2026-09-01T05:00:00Z", temp: 22, rain: { chance: 20 }, icon_descriptor: "shower", is_night: false }, // 3pm — already past
  { time: "2026-09-01T07:00:00Z", temp: 21, rain: { chance: 20 }, icon_descriptor: "shower", is_night: false }, // 5pm
  { time: "2026-09-01T08:00:00Z", temp: 20, rain: { chance: 70 }, icon_descriptor: "shower", is_night: true }   // 6pm
]

const WARNING = {
  id: "VIC_RC031_IDV36503", type: "flood_watch", title: "Flood Watch for East Gippsland",
  short_title: "Flood Watch", state: "VIC", warning_group_type: "major",
  issue_time: "2026-09-01T03:00:00Z", expiry_time: "2026-09-02T03:00:00Z", phase: "new"
}
const CANCELLED = Object.assign({}, WARNING, { id: "VIC_MW005_IDV20600", phase: "cancelled" })
const EXPIRED = Object.assign({}, WARNING, { id: "VIC_OLD_IDV1", expiry_time: "2026-09-01T01:00:00Z" })

function response(extra) {
  return JSON.stringify(Object.assign({
    ok: true, query: "brighton vic", fetchedAt: 1788245844, cached: false, stale: false,
    location: LOCATION, observations: OBSERVATIONS, daily: DAILY, hourly: HOURLY, warnings: [WARNING, CANCELLED, EXPIRED]
  }, extra || {}))
}

test("parseIso accepts BOM timestamps and rejects junk", () => {
  const d = Model.parseIso("2026-09-01T06:40:00Z")
  assert.equal(d.getTime(), Date.UTC(2026, 8, 1, 6, 40))
  assert.equal(Model.parseIso("2026-09-01"), null, "date without a zone is refused")
  assert.equal(Model.parseIso("not a date"), null)
  assert.equal(Model.parseIso(undefined), null)
})

test("parseResponse builds the full view model", () => {
  const vm = Model.parseResponse(response(), NOW)
  assert.equal(vm.ok, true)
  assert.equal(vm.query, "brighton vic")
  assert.equal(vm.location.name, "Brighton")
  assert.equal(vm.current.temp, 21)
  assert.equal(vm.current.feelsLike, 16)
  assert.equal(vm.current.windDir, "N")
  assert.equal(vm.current.gustKmh, 28)
  assert.equal(vm.current.stationKm, 2.1)
  assert.equal(vm.today.label, "Today")
  assert.equal(vm.today.nowLabel, "Max")
  assert.equal(vm.today.tempNow, 23)
  assert.equal(vm.today.min, null, "today's passed minimum stays null")
  assert.equal(vm.today.rainChance, 70)
  assert.equal(vm.today.rainAmount, "1–2 mm")
  assert.equal(vm.today.shortText, "Shower or two", "trailing full stop dropped")
  assert.equal(vm.days.length, 7, "a week ahead, today excluded")
  assert.equal(vm.days[0].label, "Tomorrow")
  assert.equal(vm.days[1].label, "Thu 3 Sep")
  assert.equal(vm.fetchedAt, 1788245844 * 1000)
})

test("hours drop periods already behind us and carry night glyphs", () => {
  const vm = Model.parseResponse(response(), NOW)
  assert.equal(vm.hours.length, 2, "3pm is in the past at 5pm")
  assert.equal(vm.hours[0].label, "5pm")
  assert.equal(vm.hours[1].glyph, Model.glyphFor("shower", true))
})

test("warnings: only active ones survive; cancelled and expired are dropped", () => {
  const vm = Model.parseResponse(response(), NOW)
  assert.equal(vm.warningsKnown, true)
  assert.equal(vm.warnings.length, 1)
  assert.equal(vm.warnings[0].shortTitle, "Flood Watch")
  assert.equal(vm.warnings[0].group, "major")
})

test("warnings:null means unknown, not all-clear", () => {
  const vm = Model.parseResponse(response({ warnings: null }), NOW)
  assert.equal(vm.ok, true)
  assert.equal(vm.warningsKnown, false)
  assert.deepEqual(vm.warnings, [])
})

test("diffWarnings reports only new warnings", () => {
  const before = Model.parseResponse(response(), NOW).warnings
  const another = Object.assign({}, WARNING, { id: "VIC_NEW_IDV2", short_title: "Severe Weather Warning", warning_group_type: "minor" })
  const after = Model.parseResponse(response({ warnings: [WARNING, another] }), NOW).warnings
  const fresh = Model.diffWarnings(before, after)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].id, "VIC_NEW_IDV2")
  const n = Model.notificationFor(fresh[0])
  assert.equal(n.headline, "Severe Weather Warning")
  assert.equal(n.urgency, "normal")
  assert.equal(Model.notificationFor(before[0]).urgency, "critical", "major warnings notify critically")
  assert.deepEqual(Model.diffWarnings(after, before), [], "a warning going away is not news")
})

test("badge, summary and tooltip", () => {
  const vm = Model.parseResponse(response(), NOW)
  assert.equal(Model.badgeText(vm, "temp"), Model.glyphFor("shower", false) + " 21°")
  assert.equal(Model.badgeText(vm, "feels-like"), Model.glyphFor("shower", false) + " 16°")
  assert.equal(Model.badgeUrgent(vm), true, "a major warning tints the badge")
  assert.equal(Model.summaryLine(vm), "21°, feels 16° · Shower or two")
  assert.equal(Model.tooltip(vm), "Brighton · 21°, feels 16° · Shower or two · 1 warning")
  assert.equal(Model.badgeText(null, "temp"), Model.BAR_GLYPH)
  const noObs = Model.parseResponse(response({ observations: null, warnings: [] }), NOW)
  assert.equal(noObs.current, null)
  assert.equal(Model.badgeText(noObs, "temp"), Model.glyphFor("shower", false) + " 23°", "falls back to today's now-temp")
  assert.equal(Model.badgeUrgent(noObs), false)
})

test("failure and stale responses", () => {
  assert.equal(Model.parseResponse("", NOW).error, "bad-response")
  assert.equal(Model.parseResponse("{not json", NOW).error, "bad-response")
  const noKey = Model.parseResponse('{"ok":false,"error":"no-location","message":"m"}', NOW)
  assert.equal(noKey.ok, false); assert.equal(noKey.error, "no-location")
  const noForecast = Model.parseResponse('{"ok":true,"query":"q","fetchedAt":1,"location":{"name":"X"},"daily":[]}', NOW)
  assert.equal(noForecast.ok, false); assert.equal(noForecast.error, "bad-response")
  const stale = Model.parseResponse(response({ stale: true, error: "network", message: "offline" }), NOW)
  assert.equal(stale.ok, true); assert.equal(stale.stale, true); assert.equal(stale.error, "network")
})

test("glyphs degrade gracefully on unknown descriptors", () => {
  assert.equal(Model.glyphFor("sunny", false), Model.glyphFor("clear", false))
  assert.notEqual(Model.glyphFor("sunny", true), Model.glyphFor("sunny", false))
  assert.equal(Model.glyphFor("mystery_weather", false), "󰖐")
  assert.equal(Model.glyphFor(undefined, false), "󰖐")
})

test("rainAmountText covers the Bureau's shapes", () => {
  assert.equal(Model.rainAmountText({ min: 1, max: 2 }), "1–2 mm")
  assert.equal(Model.rainAmountText({ min: 0, max: 2 }), "up to 2 mm")
  assert.equal(Model.rainAmountText({ min: null, max: 5 }), "up to 5 mm")
  assert.equal(Model.rainAmountText({ min: 3, max: 3 }), "3 mm")
  assert.equal(Model.rainAmountText({ min: 0, max: null }), "")
  assert.equal(Model.rainAmountText(null), "")
})

test("formatHour and formatExpiry", () => {
  assert.equal(Model.formatHour(new Date(2026, 8, 1, 15)), "3pm")
  assert.equal(Model.formatHour(new Date(2026, 8, 1, 0)), "12am")
  assert.equal(Model.formatHour(new Date(2026, 8, 1, 12)), "12pm")
  const vm = Model.parseResponse(response(), NOW)
  assert.match(Model.formatExpiry(vm.warnings[0], NOW), /^until Wed 2 Sep /)
  assert.equal(Model.formatExpiry({ expiry: null }), "")
})

test("normalizeQuery matches the bridge's normalisation", () => {
  assert.equal(Model.normalizeQuery("  Brighton   VIC "), "brighton vic")
  assert.equal(Model.normalizeQuery("X".repeat(200)).length, 80)
  assert.equal(Model.normalizeQuery(null), "")
})

test("webUrl builds the BOM page for the location", () => {
  assert.equal(Model.webUrl(LOCATION), "https://weather.bom.gov.au/location/r1r077n-brighton")
  assert.equal(Model.webUrl({ name: "Airey's Inlet", geohash: "r1kg2mm" }), "https://weather.bom.gov.au/location/r1kg2mm-airey-s-inlet")
  assert.equal(Model.webUrl(null), "https://weather.bom.gov.au")
})

// ---- Hostile input -----------------------------------------------------------
// Everything the API returns is treated as untrusted. These cover the half of
// that defence that lives here; the other half is textFormat: Text.PlainText
// on every Text in Panel.qml and the byte caps in bin/bom-api.

test("markup in remote strings never survives into the view model", () => {
  const evil = '<img src="http://tracker.example/pixel.png">Cloudy'
  const vm = Model.parseResponse(response({
    location: { name: '<b>Brighton</b>', state: "VIC", postcode: "3186", geohash: "r1r077n" },
    daily: [day("2026-08-31T14:00:00Z", { short_text: evil, extended_text: evil }), day("2026-09-01T14:00:00Z")],
    warnings: [Object.assign({}, WARNING, { title: "<script>x</script>Flood Watch" })]
  }), NOW)
  for (const s of [vm.location.name, vm.today.shortText, vm.today.extendedText, vm.warnings[0].title]) {
    assert.ok(!/[<>]/.test(s), "angle brackets survived: " + s)
  }
  assert.equal(vm.location.name, "‹b›Brighton‹/b›")
})

test("remote strings are one line and bounded", () => {
  const vm = Model.parseResponse(response({
    daily: [day("2026-08-31T14:00:00Z", { extended_text: "A".repeat(5000), short_text: "line one\nline two" }),
            day("2026-09-01T14:00:00Z")]
  }), NOW)
  assert.equal(vm.today.extendedText.length, Model.MAX_LONG_TEXT)
  assert.ok(vm.today.extendedText.endsWith("…"))
  assert.ok(!/[\r\n]/.test(vm.today.shortText))
})

test("list lengths are capped so one response cannot flood the panel", () => {
  const manyDays = Array.from({ length: 400 }, () => day("2026-09-01T14:00:00Z"))
  const manyHours = Array.from({ length: 400 }, (_, i) => HOURLY[1])
  const manyWarnings = Array.from({ length: 400 }, (_, i) => Object.assign({}, WARNING, { id: "W" + i }))
  const vm = Model.parseResponse(response({ daily: manyDays, hourly: manyHours, warnings: manyWarnings }), NOW)
  assert.ok(vm.days.length <= Model.MAX_DAYS - 1)
  assert.ok(vm.hours.length <= Model.MAX_HOURS)
  assert.ok(vm.warnings.length <= Model.MAX_WARNINGS)
})

test("malformed nested objects degrade to nulls, never throw", () => {
  const vm = Model.parseResponse(response({
    observations: { temp: "warm", wind: "gusty", station: 7 },
    daily: [day("2026-08-31T14:00:00Z", { rain: "yes", uv: [], astronomical: false, now: "later" }),
            { date: "2026-09-01T14:00:00Z" }],
    hourly: [{ time: "junk" }, null, "x"],
    warnings: [null, "x", { title: "no id" }]
  }), NOW)
  assert.equal(vm.ok, true)
  assert.equal(vm.current.temp, null)
  assert.equal(vm.current.windKmh, null)
  assert.equal(vm.today.rainChance, null)
  assert.equal(vm.today.sunrise, null)
  assert.deepEqual(vm.hours, [])
  assert.deepEqual(vm.warnings, [])
})
