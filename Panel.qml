import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Detail popup for the BOM Weather bar widget. Owns the data lifecycle (fetch,
// cache-aware refresh, warning notifications) and the keyboard-driven forecast
// list. All network access goes through bin/bom-api.
Panel {
  id: root
  moduleName: "io.github.zuccs.bom-weather"
  ipcTarget: "io.github.zuccs.bom-weather"
  manageIpc: false

  property var anchorItem: null
  property bool openedFromHotkey: false

  // The bar tracks the widget mounted in its slot (BarWidget.qml), not this
  // nested panel, so everything the bar identifies a panel by has to be that
  // widget. Same arrangement as the first-party Weather panel.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
    root.refresh(false)
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    root.refresh(false)
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  // ---- Settings (inline on this widget's shell.json entry) -----------------

  // BOM observations update roughly every 10 minutes; 300 s is the floor so
  // the widget stays polite with an API that publishes no rate limit.
  readonly property int refreshIntervalSec: Math.max(300, parseInt(setting("refreshIntervalSec", 600), 10) || 600)
  readonly property string locationQuery: String(setting("location", ""))
  readonly property string badgeShows: String(setting("badgeShows", "temp")) === "feels-like" ? "feels-like" : "temp"
  readonly property bool notificationsEnabled: String(setting("notifications", "On")) !== "Off"

  onLocationQueryChanged: refresh(false)

  // ---- State ----------------------------------------------------------------

  // Absolute path of the bridge script, wherever this plugin was installed.
  readonly property string scriptPath: String(Qt.resolvedUrl("bin/bom-api")).replace(/^file:\/\//, "")

  property string lastRaw: ""
  property var location: null
  property var current: null
  property var today: null
  property var hours: []
  property var days: []
  property var warnings: []
  property string errorCode: ""
  property string errorMessage: ""
  property bool stale: false
  property double fetchedAt: 0
  property bool refreshing: false
  property bool everLoaded: false
  property int cursor: 0
  property int expandedIndex: -1
  property var now: new Date()

  readonly property string badgeText: {
    root.now
    return Model.badgeText(root.viewModel(), root.badgeShows)
  }
  readonly property bool badgeUrgent: Model.badgeUrgent(root.viewModel())
  readonly property bool needsSetup: errorCode === "no-location"
  readonly property bool showingError: !needsSetup && errorCode !== "" && !stale
  readonly property string headline: needsSetup ? "Location needed"
    : (showingError && !everLoaded ? "Unavailable"
    : (!everLoaded ? "Fetching forecast…" : Model.summaryLine(root.viewModel())))
  readonly property string tooltip: needsSetup ? "BOM Weather · location not set"
    : (showingError && !everLoaded ? "BOM Weather · " + errorMessage : Model.tooltip(root.viewModel()))
  readonly property string updatedText: {
    root.now // reactive dependency so relative times tick
    if (!root.fetchedAt) return ""
    var rel = Model.formatRelative(new Date(root.fetchedAt), root.now)
    if (root.stale) return (root.errorMessage || "Last refresh failed") + " — showing data from " + rel
    return "Updated " + rel + " · Data © Bureau of Meteorology"
  }

  // The pieces above are stored flat so QML bindings stay cheap; this bundles
  // them back into the shape Model's summary helpers take.
  function viewModel() {
    return { ok: everLoaded, location: location, current: current, today: today,
             hours: hours, days: days, warnings: warnings }
  }

  // Popup text sits on the popup background, so use the theme foreground (as
  // Weather does), not barForeground, which swaps to a contrast colour when the
  // bar itself is transparent.
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property color urgent: bar && bar.urgent !== undefined ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // ---- Data lifecycle -------------------------------------------------------

  // force=false honours the on-disk cache (a panel open or shell restart costs
  // no API request); force=true always hits the API.
  property bool pendingRefresh: false
  property bool pendingForce: false

  function refresh(force) {
    if (fetchProc.running) {
      // Settings can change (or a hotkey fire) mid-fetch; run again when done.
      pendingRefresh = true
      pendingForce = pendingForce || force === true
      return
    }
    refreshing = true
    var maxAge = force ? "0" : String(Math.max(60, refreshIntervalSec - 30))
    fetchProc.command = [root.scriptPath, "weather", root.locationQuery, "--max-age", maxAge]
    fetchProc.running = true
  }

  onRefreshingChanged: if (!refreshing) refreshButton.rotation = 0

  function applyRaw(raw) {
    var parsed = Model.parseResponse(raw, new Date())
    // A response for the previous location (settings changed mid-fetch) must
    // not be shown under the new one; fetch the right one instead. Stale
    // responses are exempt — a cache served during an outage may carry an
    // older query for the same place, and chasing it would loop.
    if (parsed.ok && !parsed.stale && parsed.query !== Model.normalizeQuery(root.locationQuery)) {
      root.pendingRefresh = true // onExited runs the queued refresh once
      return
    }
    root.lastRaw = raw
    if (parsed.ok) {
      if (parsed.warningsKnown) {
        if (root.everLoaded && root.notificationsEnabled && !parsed.cached)
          root.notify(Model.diffWarnings(root.warnings, parsed.warnings))
        root.warnings = parsed.warnings
      } // warnings:null → the warnings fetch failed; keep showing what we had
      root.location = parsed.location
      root.current = parsed.current
      root.today = parsed.today
      root.hours = parsed.hours
      root.days = parsed.days
      root.fetchedAt = parsed.fetchedAt
      root.stale = parsed.stale
      root.errorCode = parsed.stale ? parsed.error : ""
      root.errorMessage = parsed.stale ? parsed.message : ""
      root.everLoaded = true
    } else {
      root.errorCode = parsed.error || "unknown"
      root.errorMessage = parsed.message || "Something went wrong."
      // Keep whatever we last showed, but say so: a failed poll must not
      // present old data as current.
      root.stale = root.everLoaded
    }
    if (root.cursor >= root.days.length) root.cursor = Math.max(0, root.days.length - 1)
    if (root.expandedIndex >= root.days.length) root.expandedIndex = -1
    root.now = new Date()
  }

  // One bar surface exists per monitor, each with its own panel instance.
  // Route explicit refreshes through the host widget so every instance
  // updates; the bridge's lock makes that a single round of requests.
  function refreshAll() {
    if (root.hostWidget && typeof root.hostWidget.broadcast === "function") root.hostWidget.broadcast("refresh")
    else root.refresh(true)
  }

  function notify(fresh) {
    for (var i = 0; i < fresh.length; i++) {
      var n = Model.notificationFor(fresh[i])
      Quickshell.execDetached(["omarchy-notification-send", "--app-name", "BOM Weather", "-g", n.glyph, "-u", n.urgency, n.headline, n.body])
    }
  }

  function moveCursor(delta) {
    if (!root.days.length) return
    root.cursor = Math.max(0, Math.min(root.days.length - 1, root.cursor + delta))
    ensureCursorVisible()
  }

  function activateCursor() {
    if (!root.days.length) return
    root.expandedIndex = root.expandedIndex === root.cursor ? -1 : root.cursor
    Qt.callLater(ensureCursorVisible)
  }

  function ensureCursorVisible() {
    var item = rowRepeater.itemAt(root.cursor)
    if (!item) return
    if (item.y < listFlick.contentY) listFlick.contentY = item.y
    else if (item.y + item.height > listFlick.contentY + listFlick.height)
      listFlick.contentY = Math.max(0, item.y + item.height - listFlick.height)
  }

  function copySetupCommand() {
    Quickshell.execDetached(["wl-copy", Model.SETUP_COMMAND])
    Quickshell.execDetached(["omarchy-notification-send", "--app-name", "BOM Weather", "-g", "󰆏", "Command copied", "Paste it in a terminal with your suburb, then press r in the panel"])
  }

  function openWeb() {
    Quickshell.execDetached(["omarchy-launch-webapp", Model.webUrl(root.location)])
  }

  Process {
    id: fetchProc
    running: false
    command: []
    stdout: StdioCollector { id: fetchStdout; waitForEnd: true; onStreamFinished: root._fetchOutput = text }
    onExited: function(exitCode) {
      root.refreshing = false
      var raw = String(fetchStdout.text || root._fetchOutput || "").trim()
      root._fetchOutput = ""
      if (!raw) {
        root.errorCode = "bridge"
        root.errorMessage = "bom-api produced no output (exit " + exitCode + "). Is it executable?"
        root.stale = root.everLoaded
      } else {
        root.applyRaw(raw)
      }
      if (root.pendingRefresh) {
        var force = root.pendingForce
        root.pendingRefresh = false
        root.pendingForce = false
        Qt.callLater(function() { root.refresh(force) })
      }
    }
  }
  property string _fetchOutput: ""

  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh(false)
  }

  // Relative timestamps tick while the panel is open.
  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.now = new Date()
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refreshAll() }
  }

  // ---- UI -------------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight, Style.space(700))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r") root.refreshAll()
        else if (t === "o") root.openWeb()
      }

      Column {
        id: contentColumn
        width: parent.width
        spacing: Style.space(10)

        // ---- Header: condition glyph, title, one-line summary, refresh.
        Item {
          width: parent.width
          height: Math.max(headerLeft.implicitHeight, refreshButton.height)

          Row {
            id: headerLeft
            anchors.left: parent.left
            anchors.right: refreshButton.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(12)

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: root.hours.length ? root.hours[0].glyph : (root.today ? root.today.glyph : Model.BAR_GLYPH)
              color: root.badgeUrgent ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }

            Column {
              anchors.verticalCenter: parent.verticalCenter
              width: headerLeft.width - Style.font.display - headerLeft.spacing
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: "BOM WEATHER" + (root.location ? " · " + (root.location.name + " " + root.location.state).toUpperCase() : "")
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
                elide: Text.ElideRight
              }
              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.headline
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                elide: Text.ElideRight
              }
            }
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰑐"
            tooltipText: "Refresh (r)"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: !root.refreshing && !root.needsSetup
            onClicked: root.refreshAll()

            RotationAnimator on rotation {
              running: root.refreshing
              from: 0; to: 360
              duration: 900
              loops: Animation.Infinite
            }
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        // ---- Setup: no location configured yet.
        Column {
          visible: root.needsSetup
          width: parent.width
          spacing: Style.space(8)

          Text {
            textFormat: Text.PlainText
            width: parent.width
            wrapMode: Text.WordWrap
            text: "This widget shows Bureau of Meteorology weather for an Australian location — the same data as the BOM app. Tell it where you are (suburb, town or postcode):"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          Rectangle {
            width: parent.width
            height: setupCommand.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            color: Style.normalFillFor(root.foreground, Color.accent)

            Text {
              id: setupCommand
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.margins: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: Model.SETUP_COMMAND
              wrapMode: Text.WrapAnywhere
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }

          Button {
            text: "Copy command"
            iconText: "󰆏"
            foreground: root.foreground
            fontFamily: root.fontFamily
            bordered: true
            onClicked: root.copySetupCommand()
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            wrapMode: Text.WordWrap
            text: "Ambiguous name? Add the state (\"Brighton VIC\") or use the postcode. Press r here once it is set."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        // ---- Error with nothing loaded to show.
        Text {
          textFormat: Text.PlainText
          visible: root.showingError && !root.everLoaded
          width: parent.width
          wrapMode: Text.WordWrap
          text: root.errorMessage
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        // ---- Active BOM warnings.
        Column {
          visible: root.warnings.length > 0
          width: parent.width
          spacing: Style.space(4)

          Repeater {
            model: root.warnings

            delegate: Rectangle {
              id: warningRow
              required property var modelData
              width: parent.width
              height: warningContent.implicitHeight + Style.space(12)
              radius: Style.cornerRadius
              color: Style.normalFillFor(root.foreground, Color.accent)

              Row {
                id: warningContent
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(10)

                Text {
                  id: warningGlyph
                  textFormat: Text.PlainText
                  anchors.verticalCenter: parent.verticalCenter
                  text: Model.WARNING_GLYPH
                  color: root.urgent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.iconLarge
                }

                Column {
                  width: warningContent.width - warningGlyph.width - warningContent.spacing
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(2)

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    text: warningRow.modelData.shortTitle
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }
                  Text {
                    textFormat: Text.PlainText
                    width: parent.width
                    text: {
                      root.now
                      var when = Model.formatExpiry(warningRow.modelData, root.now)
                      return warningRow.modelData.title + (when ? " · " + when : "")
                    }
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }
              }
            }
          }
        }

        // ---- Current conditions from the nearest BOM station.
        Row {
          visible: root.current !== null
          width: parent.width
          spacing: Style.space(14)

          Text {
            id: bigTemp
            textFormat: Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            text: root.current && root.current.temp !== null ? root.current.temp + "°" : "–"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
          }

          Column {
            width: parent.width - bigTemp.width - parent.spacing
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: {
                if (!root.current) return ""
                var bits = []
                if (root.current.feelsLike !== null) bits.push("Feels like " + root.current.feelsLike + "°")
                if (root.current.humidity !== null) bits.push("󰖎 " + root.current.humidity + "%")
                if (root.current.windKmh !== null)
                  bits.push("󰖝 " + root.current.windDir + " " + root.current.windKmh
                    + (root.current.gustKmh !== null ? "–" + root.current.gustKmh : "") + " km/h")
                return bits.join("   ")
              }
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: {
                if (!root.current) return ""
                var bits = []
                if (root.current.minTemp !== null && root.current.maxTemp !== null)
                  bits.push(root.current.minTemp + "° to " + root.current.maxTemp + "° so far")
                if (root.current.rainSince9am !== null) bits.push(root.current.rainSince9am + " mm since 9am")
                return bits.join("  ·  ")
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: {
                if (!root.current || !root.current.stationName) return ""
                return root.current.stationName
                  + (root.current.stationKm !== null ? " station · " + root.current.stationKm + " km away" : " station")
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }
        }

        // ---- Today's forecast detail.
        Column {
          visible: root.today !== null
          width: parent.width
          spacing: Style.space(2)

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: {
              if (!root.today) return ""
              var bits = []
              if (root.today.nowLabel && root.today.tempNow !== null) bits.push(root.today.nowLabel + " " + root.today.tempNow + "°")
              if (root.today.laterLabel && root.today.tempLater !== null) bits.push(root.today.laterLabel.toLowerCase() + " " + root.today.tempLater + "°")
              if (root.today.rainChance !== null)
                bits.push("rain " + root.today.rainChance + "%" + (root.today.rainAmount ? " (" + root.today.rainAmount + ")" : ""))
              return bits.join("  ·  ")
            }
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }
          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: {
              if (!root.today) return ""
              var bits = []
              if (root.today.uvIndex !== null)
                bits.push("UV " + root.today.uvIndex + (root.today.uvCategory ? " " + root.today.uvCategory : ""))
              if (root.today.sunrise) bits.push("󰖜 " + Qt.formatTime(root.today.sunrise, "HH:mm"))
              if (root.today.sunset) bits.push("󰖛 " + Qt.formatTime(root.today.sunset, "HH:mm"))
              if (root.today.fireDanger) bits.push("fire danger " + root.today.fireDanger)
              return bits.join("  ·  ")
            }
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }
        }

        // ---- Next hours.
        Row {
          visible: root.hours.length > 0
          width: parent.width
          spacing: 0

          Repeater {
            model: root.hours.slice(0, 6)

            delegate: Column {
              id: hourCell
              required property var modelData
              width: parent.width / Math.min(6, Math.max(1, root.hours.length))
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                text: hourCell.modelData.label
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                textFormat: Text.PlainText
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                text: hourCell.modelData.glyph
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.iconLarge
              }
              Text {
                textFormat: Text.PlainText
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                text: hourCell.modelData.temp !== null ? hourCell.modelData.temp + "°" : ""
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
              Text {
                textFormat: Text.PlainText
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                text: hourCell.modelData.rainChance !== null && hourCell.modelData.rainChance >= 20
                  ? hourCell.modelData.rainChance + "%" : " "
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }

        PanelSeparator {
          visible: root.days.length > 0
          width: parent.width
          foreground: root.foreground
        }

        // ---- The week ahead.
        Flickable {
          id: listFlick
          visible: root.days.length > 0
          width: parent.width
          height: Math.min(rowsColumn.implicitHeight, Style.space(330))
          contentWidth: width
          contentHeight: rowsColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height

          Column {
            id: rowsColumn
            width: listFlick.width
            spacing: Style.space(2)

            Repeater {
              id: rowRepeater
              model: root.days

            delegate: Rectangle {
              id: dayRow
              required property var modelData
              required property int index

              readonly property bool hasCursor: index === root.cursor
              readonly property bool expanded: index === root.expandedIndex

              width: rowsColumn.width
              height: dayContent.implicitHeight + Style.space(12)
              radius: Style.cornerRadius
              color: hasCursor ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

              Column {
                id: dayContent
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(6)

                Row {
                  id: dayMain
                  width: parent.width
                  spacing: Style.space(10)

                  Text {
                    id: dayGlyph
                    textFormat: Text.PlainText
                    width: Style.space(22)
                    anchors.verticalCenter: parent.verticalCenter
                    text: dayRow.modelData.glyph
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.iconLarge
                    horizontalAlignment: Text.AlignHCenter
                  }

                  Column {
                    width: dayMain.width - dayGlyph.width - tempColumn.width - dayMain.spacing * 2
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(2)

                    Text {
                      textFormat: Text.PlainText
                      width: parent.width
                      text: dayRow.modelData.label
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      elide: Text.ElideRight
                    }
                    Text {
                      textFormat: Text.PlainText
                      width: parent.width
                      text: dayRow.modelData.shortText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      elide: Text.ElideRight
                    }
                  }

                  Column {
                    id: tempColumn
                    width: Math.max(tempsText.implicitWidth, rainText.implicitWidth)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(2)

                    Text {
                      id: tempsText
                      textFormat: Text.PlainText
                      width: parent.width
                      text: (dayRow.modelData.min !== null ? dayRow.modelData.min + "°" : "–")
                        + " / " + (dayRow.modelData.max !== null ? dayRow.modelData.max + "°" : "–")
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      horizontalAlignment: Text.AlignRight
                    }
                    Text {
                      id: rainText
                      textFormat: Text.PlainText
                      width: parent.width
                      text: dayRow.modelData.rainChance !== null ? "󰖗 " + dayRow.modelData.rainChance + "%" : ""
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      horizontalAlignment: Text.AlignRight
                    }
                  }
                }

                // ---- Expanded: the Bureau's full text for the day.
                Text {
                  textFormat: Text.PlainText
                  visible: dayRow.expanded
                  width: parent.width
                  wrapMode: Text.WordWrap
                  text: (dayRow.modelData.extendedText || dayRow.modelData.shortText || "No detail for this day.")
                    + (dayRow.modelData.rainAmount ? "  (" + dayRow.modelData.rainAmount + ")" : "")
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onPositionChanged: root.cursor = dayRow.index
                onClicked: {
                  root.cursor = dayRow.index
                  root.activateCursor()
                }
              }
            }
            }
          }
        }

        // ---- Footer: freshness + key hints.
        Column {
          width: parent.width
          spacing: Style.space(2)
          visible: root.everLoaded || root.stale

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: root.updatedText
            color: root.stale ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: "↑↓ select day · ⏎ full forecast · r refresh · o open bom.gov.au"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
      }
    }
  }
}
