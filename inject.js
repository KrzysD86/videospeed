var regStrip = /^[\r\t\f\v ]+|[\r\t\f\v ]+$/gm;

var tc = {
  settings: {
    lastSpeed: 1.0, // default 1x
    enabled: true, // default enabled
    speeds: {}, // empty object to hold speed for each source

    displayKeyCode: 86, // default: V
    rememberSpeed: false, // default: false
    forceLastSavedSpeed: false, //default: false
    audioBoolean: false, // default: false
    startHidden: false, // default: false
    controllerOpacity: 0.3, // default: 0.3
    keyBindings: [],
    blacklist: `\
      www.instagram.com
      twitter.com
      vine.co
      imgur.com
      teams.microsoft.com
    `.replace(regStrip, ""),
    defaultLogLevel: 4,
    logLevel: 3
  },

  // Holds a reference to all of the AUDIO/VIDEO DOM elements we've attached to
  mediaElements: [],

  // Remembers which speed each AUDIO/VIDEO element should play at, so that it
  // survives the controller being torn down and rebuilt for the same element.
  savedTargets: new WeakMap()
};

// Browsers reject playback rates outside of 0.0625 - 16.
var MIN_SPEED = 0.07;
var MAX_SPEED = 16;

// Websites often reset playbackRate (usually back to 1.0) when a video loads,
// plays, pauses or seeks. A speed change that this extension didn't make and
// that lands shortly after one of these events is treated as such a reset and
// is undone, so the user's speed sticks.
var RESET_PRONE_EVENTS = [
  "loadstart",
  "emptied",
  "loadedmetadata",
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked"
];
var RESET_WINDOW_MS = 1000;

// A speed change that this extension didn't make and that is NOT near one of
// the events above is probably deliberate (e.g. the website's own speed menu).
// It is kept for that video only, unless a reset-prone event follows within
// this delay. It is never saved as the remembered speed.
var ADOPT_DELAY_MS = 300;

// Safety valve so we never end up in an endless tug of war with a website or
// another extension that keeps setting its own speed.
var MAX_REVERTS_PER_SECOND = 50;

// chrome.storage.sync has write quotas, so rapid key presses are batched into
// a single save.
var SAVE_DELAY_MS = 500;

/* Log levels (depends on caller specifying the correct level)
  1 - none
  2 - error
  3 - warning
  4 - info
  5 - debug
  6 - debug high verbosity + stack trace on each message
*/
function log(message, level) {
  verbosity = tc.settings.logLevel;
  if (typeof level === "undefined") {
    level = tc.settings.defaultLogLevel;
  }
  if (verbosity >= level) {
    if (level === 2) {
      console.log("ERROR:" + message);
    } else if (level === 3) {
      console.log("WARNING:" + message);
    } else if (level === 4) {
      console.log("INFO:" + message);
    } else if (level === 5) {
      console.log("DEBUG:" + message);
    } else if (level === 6) {
      console.log("DEBUG (VERBOSE):" + message);
      console.trace();
    }
  }
}

chrome.storage.sync.get(tc.settings, function (storage) {
  tc.settings.keyBindings = storage.keyBindings; // Array
  if (storage.keyBindings.length == 0) {
    // if first initialization of 0.5.3
    // UPDATE
    tc.settings.keyBindings.push({
      action: "slower",
      key: Number(storage.slowerKeyCode) || 83,
      value: Number(storage.speedStep) || 0.1,
      force: false,
      predefined: true
    }); // default S
    tc.settings.keyBindings.push({
      action: "faster",
      key: Number(storage.fasterKeyCode) || 68,
      value: Number(storage.speedStep) || 0.1,
      force: false,
      predefined: true
    }); // default: D
    tc.settings.keyBindings.push({
      action: "rewind",
      key: Number(storage.rewindKeyCode) || 90,
      value: Number(storage.rewindTime) || 10,
      force: false,
      predefined: true
    }); // default: Z
    tc.settings.keyBindings.push({
      action: "advance",
      key: Number(storage.advanceKeyCode) || 88,
      value: Number(storage.advanceTime) || 10,
      force: false,
      predefined: true
    }); // default: X
    tc.settings.keyBindings.push({
      action: "reset",
      key: Number(storage.resetKeyCode) || 82,
      value: 1.0,
      force: false,
      predefined: true
    }); // default: R
    tc.settings.keyBindings.push({
      action: "fast",
      key: Number(storage.fastKeyCode) || 71,
      value: Number(storage.fastSpeed) || 1.8,
      force: false,
      predefined: true
    }); // default: G
    tc.settings.version = "0.5.3";

    chrome.storage.sync.set({
      keyBindings: tc.settings.keyBindings,
      version: tc.settings.version,
      displayKeyCode: tc.settings.displayKeyCode,
      rememberSpeed: tc.settings.rememberSpeed,
      forceLastSavedSpeed: tc.settings.forceLastSavedSpeed,
      audioBoolean: tc.settings.audioBoolean,
      startHidden: tc.settings.startHidden,
      enabled: tc.settings.enabled,
      controllerOpacity: tc.settings.controllerOpacity,
      blacklist: tc.settings.blacklist.replace(regStrip, "")
    });
  }
  tc.settings.lastSpeed = normalizeSpeed(storage.lastSpeed);
  tc.settings.displayKeyCode = Number(storage.displayKeyCode);
  tc.settings.rememberSpeed = Boolean(storage.rememberSpeed);
  tc.settings.forceLastSavedSpeed = Boolean(storage.forceLastSavedSpeed);
  tc.settings.audioBoolean = Boolean(storage.audioBoolean);
  tc.settings.enabled = Boolean(storage.enabled);
  tc.settings.startHidden = Boolean(storage.startHidden);
  tc.settings.controllerOpacity = Number(storage.controllerOpacity);
  tc.settings.blacklist = String(storage.blacklist);

  // ensure that there is a "display" binding (for upgrades from versions that had it as a separate binding)
  if (
    tc.settings.keyBindings.filter((x) => x.action == "display").length == 0
  ) {
    tc.settings.keyBindings.push({
      action: "display",
      key: Number(storage.displayKeyCode) || 86,
      value: 0,
      force: false,
      predefined: true
    }); // default V
  }

  initializeWhenReady(document);
});

function getKeyBindings(action, what = "value") {
  try {
    return tc.settings.keyBindings.find((item) => item.action === action)[what];
  } catch (e) {
    return false;
  }
}

function defineVideoController() {
  // Data structures
  // ---------------
  // videoController (JS object) instances:
  //   video = AUDIO/VIDEO DOM element
  //   parent = A/V DOM element's parentElement OR
  //            (A/V elements discovered from the Mutation Observer)
  //            A/V element's parentNode OR the node whose children changed.
  //   div = Controller's DOM element (which happens to be a DIV)
  //   speedIndicator = DOM element in the Controller of the speed indicator

  // added to AUDIO / VIDEO DOM elements
  //    vsc = reference to the videoController
  tc.videoController = function (target, parent) {
    if (target.vsc) {
      return target.vsc;
    }

    tc.mediaElements.push(target);

    this.video = target;
    this.parent = target.parentElement || parent;
    this.currentSrc = target.currentSrc;
    this.lastMediaEventTime = 0;
    this.revertTimes = [];
    this.adoptTimer = null;

    // resetSpeed isn't really a reset, it's a toggle. This is the speed the
    // R / G keys toggle back to, kept per video so that other videos on the
    // page (previews, ads) can't overwrite it.
    this.toggleSpeed = tc.settings.rememberSpeed
      ? getKeyBindings("reset")
      : getKeyBindings("fast"); // resetSpeed = fastSpeed
    setTargetSpeed(this, initialSpeedFor(target));

    log("Explicitly setting playbackRate to: " + this.targetSpeed, 5);
    if (!sameSpeed(target.playbackRate, this.targetSpeed)) {
      try {
        target.playbackRate = this.targetSpeed;
      } catch (e) {
        log("Unable to set playbackRate: " + e, 2);
      }
    }

    this.div = this.initializeControls();

    // Put the user's speed back whenever the media does something that
    // websites like to reset the speed on (load, play, pause, seek).
    this.handleMediaEvent = onMediaEvent.bind(this);
    RESET_PRONE_EVENTS.forEach((type) =>
      target.addEventListener(type, this.handleMediaEvent)
    );

    var observer = (this.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === "attributes" &&
          (mutation.attributeName === "src" ||
            mutation.attributeName === "currentSrc")
        ) {
          log("mutation of A/V element", 5);
          var controller = this.div;
          if (!mutation.target.src && !mutation.target.currentSrc) {
            controller.classList.add("vsc-nosource");
          } else {
            controller.classList.remove("vsc-nosource");
          }
        }
      });
    }));
    observer.observe(target, {
      attributeFilter: ["src", "currentSrc"]
    });
  };

  tc.videoController.prototype.remove = function () {
    this.div.remove();
    RESET_PRONE_EVENTS.forEach((type) =>
      this.video.removeEventListener(type, this.handleMediaEvent)
    );
    this.observer.disconnect();
    cancelAdopt(this);
    delete this.video.vsc;
    let idx = tc.mediaElements.indexOf(this.video);
    if (idx != -1) {
      tc.mediaElements.splice(idx, 1);
    }
  };

  tc.videoController.prototype.initializeControls = function () {
    log("initializeControls Begin", 5);
    const document = this.video.ownerDocument;
    const speed = this.video.playbackRate.toFixed(2);
    var top = Math.max(this.video.offsetTop, 0) + "px",
      left = Math.max(this.video.offsetLeft, 0) + "px";

    log("Speed variable set to: " + speed, 5);

    var wrapper = document.createElement("div");
    wrapper.classList.add("vsc-controller");

    if (!this.video.src && !this.video.currentSrc) {
      wrapper.classList.add("vsc-nosource");
    }

    if (tc.settings.startHidden) {
      wrapper.classList.add("vsc-hidden");
    }

    var shadow = wrapper.attachShadow({ mode: "open" });
    var shadowTemplate = `
        <style>
          @import "${chrome.runtime.getURL("shadow.css")}";
        </style>

        <div id="controller" style="top:${top}; left:${left}; opacity:${
      tc.settings.controllerOpacity
    }">
          <span data-action="drag" class="draggable">${speed}</span>
          <span id="controls">
            <button data-action="rewind" class="rw">«</button>
            <button data-action="slower">&minus;</button>
            <button data-action="faster">&plus;</button>
            <button data-action="advance" class="rw">»</button>
            <button data-action="display" class="hideButton">&times;</button>
          </span>
        </div>
      `;
    shadow.innerHTML = shadowTemplate;
    shadow.querySelector(".draggable").addEventListener(
      "mousedown",
      (e) => {
        runAction(e.target.dataset["action"], false, e);
        e.stopPropagation();
      },
      true
    );

    shadow.querySelectorAll("button").forEach(function (button) {
      button.addEventListener(
        "click",
        (e) => {
          runAction(
            e.target.dataset["action"],
            getKeyBindings(e.target.dataset["action"]),
            e
          );
          e.stopPropagation();
        },
        true
      );
    });

    shadow
      .querySelector("#controller")
      .addEventListener("click", (e) => e.stopPropagation(), false);
    shadow
      .querySelector("#controller")
      .addEventListener("mousedown", (e) => e.stopPropagation(), false);

    this.speedIndicator = shadow.querySelector("span");
    var fragment = document.createDocumentFragment();
    fragment.appendChild(wrapper);

    switch (true) {
      case location.hostname == "www.amazon.com":
      case location.hostname == "www.reddit.com":
      case /hbogo\./.test(location.hostname):
        // insert before parent to bypass overlay
        this.parent.parentElement.insertBefore(fragment, this.parent);
        break;
      case location.hostname == "www.facebook.com":
        // this is a monstrosity but new FB design does not have *any*
        // semantic handles for us to traverse the tree, and deep nesting
        // that we need to bubble up from to get controller to stack correctly
        let p = this.parent.parentElement.parentElement.parentElement
          .parentElement.parentElement.parentElement.parentElement;
        p.insertBefore(fragment, p.firstChild);
        break;
      case location.hostname == "tv.apple.com":
        // insert after parent for correct stacking context
        this.parent.getRootNode().querySelector(".scrim").prepend(fragment);
      default:
        // Note: when triggered via a MutationRecord, it's possible that the
        // target is not the immediate parent. This appends the controller as
        // the first element of the target, which may not be the parent.
        this.parent.insertBefore(fragment, this.parent.firstChild);
    }
    return wrapper;
  };
}

function escapeStringRegExp(str) {
  matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g;
  return str.replace(matchOperatorsRe, "\\$&");
}

function isBlacklisted() {
  blacklisted = false;
  tc.settings.blacklist.split("\n").forEach((match) => {
    match = match.replace(regStrip, "");
    if (match.length == 0) {
      return;
    }

    if (match.startsWith("/")) {
      try {
        var regexp = new RegExp(match);
      } catch (err) {
        return;
      }
    } else {
      var regexp = new RegExp(escapeStringRegExp(match));
    }

    if (regexp.test(location.href)) {
      blacklisted = true;
      return;
    }
  });
  return blacklisted;
}

var coolDown = false;
function refreshCoolDown() {
  log("Begin refreshCoolDown", 5);
  if (coolDown) {
    clearTimeout(coolDown);
  }
  coolDown = setTimeout(function () {
    coolDown = false;
  }, 1000);
  log("End refreshCoolDown", 5);
}

function normalizeSpeed(value) {
  var speed = Number(value);
  if (!isFinite(speed) || speed <= 0) {
    return 1.0;
  }
  speed = Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED);
  return Number(speed.toFixed(2));
}

function sameSpeed(a, b) {
  return Math.abs(a - b) < 0.005;
}

// The speed a media element should play at when we first see it, or when it
// switches to a new source (e.g. the next video in the same player).
function initialSpeedFor(video) {
  var src = video.currentSrc;
  var saved = tc.savedTargets.get(video);
  if (saved && saved.src === src) {
    // Same element, same media: the controller was just rebuilt. Carry on at
    // the speed it was already playing at.
    return saved.speed;
  }
  if (tc.settings.rememberSpeed) {
    return tc.settings.lastSpeed;
  }
  return (src && tc.settings.speeds[src]) || 1.0;
}

// Records the speed a video *should* be playing at. Does not touch the video.
function setTargetSpeed(vsc, speed) {
  vsc.targetSpeed = speed;
  tc.savedTargets.set(vsc.video, { src: vsc.video.currentSrc, speed: speed });
}

// Detects a new source on a reused element and picks the right speed for it.
function syncSource(vsc) {
  var src = vsc.video.currentSrc;
  if (src === vsc.currentSrc) {
    return;
  }
  vsc.currentSrc = src;
  if (!src) {
    return; // element emptied, wait for the next source
  }
  setTargetSpeed(vsc, initialSpeedFor(vsc.video));
  log("New source, speed will be " + vsc.targetSpeed, 4);
}

function isNearMediaEvent(vsc) {
  var video = vsc.video;
  return (
    video.seeking ||
    video.readyState === 0 ||
    Date.now() - vsc.lastMediaEventTime < RESET_WINDOW_MS
  );
}

function mayRevert(vsc) {
  var now = Date.now();
  vsc.revertTimes = vsc.revertTimes.filter((t) => now - t < 1000);
  if (vsc.revertTimes.length >= MAX_REVERTS_PER_SECOND) {
    log("Something keeps overriding the speed, backing off", 3);
    return false;
  }
  vsc.revertTimes.push(now);
  return true;
}

function cancelAdopt(vsc) {
  if (vsc.adoptTimer) {
    clearTimeout(vsc.adoptTimer);
    vsc.adoptTimer = null;
  }
}

// Keep a speed the website set on purpose, for this video only, unless a
// load/play/pause/seek event shows up right after it (then it was a reset).
function scheduleAdopt(vsc) {
  cancelAdopt(vsc);
  vsc.adoptTimer = setTimeout(function () {
    vsc.adoptTimer = null;
    var rate = vsc.video.playbackRate;
    if (vsc.video.vsc === vsc && !sameSpeed(rate, vsc.targetSpeed)) {
      log("Keeping speed " + rate + " set by the website for this video", 4);
      setTargetSpeed(vsc, rate);
    }
  }, ADOPT_DELAY_MS);
}

// Sets the playback rate WITHOUT treating it as a new choice by the user.
function applySpeed(video, speed) {
  if (!sameSpeed(video.playbackRate, speed)) {
    try {
      video.playbackRate = speed;
    } catch (e) {
      log("Unable to set playbackRate to " + speed + ": " + e, 2);
      return;
    }
    refreshCoolDown();
  }
  video.vsc.speedIndicator.textContent = speed.toFixed(2);
}

function showSpeed(video, rate) {
  log("Playback rate changed to " + rate, 4);
  video.vsc.speedIndicator.textContent = rate.toFixed(2);
  // show the controller for 1000ms if it's hidden.
  runAction("blink", null, null);
}

// Bound to a videoController. Runs on its video's RESET_PRONE_EVENTS.
function onMediaEvent(event) {
  var vsc = this;
  var video = vsc.video;
  vsc.lastMediaEventTime = Date.now();
  syncSource(vsc);
  // A website speed change we were about to keep turned out to be part of
  // this load/play/pause/seek, i.e. a reset. Don't keep it.
  cancelAdopt(vsc);

  if (sameSpeed(video.playbackRate, vsc.targetSpeed)) {
    return;
  }
  if (mayRevert(vsc)) {
    log("Restoring speed " + vsc.targetSpeed + " after " + event.type, 4);
    applySpeed(video, vsc.targetSpeed);
  } else if (!tc.settings.forceLastSavedSpeed) {
    setTargetSpeed(vsc, video.playbackRate);
  }
}

/**
 * Runs whenever the playback rate of a controlled video changes, no matter
 * who changed it. Only changes made by the user through this extension
 * (setSpeed) are ever saved as the remembered speed. Everything else is
 * either undone (a reset by the website around load/play/pause/seek, or any
 * change at all when "Force last saved speed" is on) or kept for that one
 * video only (e.g. the website's own speed menu).
 */
function handleRateChange(video, event) {
  var vsc = video.vsc;
  syncSource(vsc);
  var rate = video.playbackRate;
  var forced = tc.settings.forceLastSavedSpeed;

  if (forced) {
    // Hide all rate changes from the website's own listeners.
    event.stopImmediatePropagation();
  }

  if (sameSpeed(rate, vsc.targetSpeed)) {
    // Our own change, or nothing that matters.
    showSpeed(video, rate);
    return;
  }

  // Something other than this extension changed the speed.
  var looksLikeReset = forced || isNearMediaEvent(vsc);
  if (looksLikeReset && mayRevert(vsc)) {
    log("Undoing speed change to " + rate + ", back to " + vsc.targetSpeed, 4);
    event.stopImmediatePropagation();
    cancelAdopt(vsc);
    applySpeed(video, vsc.targetSpeed);
    return;
  }

  showSpeed(video, rate);
  if (!looksLikeReset) {
    scheduleAdopt(vsc);
  } else if (!forced) {
    // We've been fighting this too often, give up and go along with it.
    setTargetSpeed(vsc, rate);
  }
}

function setupListener(doc) {
  doc.addEventListener(
    "ratechange",
    function (event) {
      if (coolDown) {
        log("Speed event propagation blocked", 4);
        event.stopImmediatePropagation();
      }
      var video = event.target;
      // It's possible to get a rate change on a VIDEO/AUDIO that doesn't have
      // a video controller attached to it.  If we do, ignore it.
      if (!video || !video.vsc) {
        return;
      }
      handleRateChange(video, event);
    },
    true
  );
}

function initializeWhenReady(document) {
  log("Begin initializeWhenReady", 5);
  if (isBlacklisted()) {
    return;
  }
  window.addEventListener('load', () => {
    initializeNow(window.document);
  });
  if (document) {
    if (document.readyState === "complete") {
      initializeNow(document);
    } else {
      document.onreadystatechange = () => {
        if (document.readyState === "complete") {
          initializeNow(document);
        }
      };
    }
  }
  log("End initializeWhenReady", 5);
}
function inIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}
function getShadow(parent) {
  let result = [];
  function getChild(parent) {
    if (parent.firstElementChild) {
      var child = parent.firstElementChild;
      do {
        result.push(child);
        getChild(child);
        if (child.shadowRoot) {
          result.push(getShadow(child.shadowRoot));
        }
        child = child.nextElementSibling;
      } while (child);
    }
  }
  getChild(parent);
  return result.flat(Infinity);
}

function initializeNow(document) {
  log("Begin initializeNow", 5);
  if (!tc.settings.enabled) return;
  // enforce init-once due to redundant callers
  if (!document.body || document.body.classList.contains("vsc-initialized")) {
    return;
  }
  try {
    setupListener(document);
  } catch {
    // no operation
  }
  document.body.classList.add("vsc-initialized");
  log("initializeNow: vsc-initialized added to document body", 5);

  if (document === window.document) {
    defineVideoController();
  } else {
    var link = document.createElement("link");
    link.href = chrome.runtime.getURL("inject.css");
    link.type = "text/css";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  var docs = Array(document);
  try {
    if (inIframe()) docs.push(window.top.document);
  } catch (e) {}

  docs.forEach(function (doc) {
    doc.addEventListener(
      "keydown",
      function (event) {
        var keyCode = event.keyCode;
        log("Processing keydown event: " + keyCode, 6);

        // Ignore if following modifier is active.
        if (
          !event.getModifierState ||
          event.getModifierState("Alt") ||
          event.getModifierState("Control") ||
          event.getModifierState("Fn") ||
          event.getModifierState("Meta") ||
          event.getModifierState("Hyper") ||
          event.getModifierState("OS")
        ) {
          log("Keydown event ignored due to active modifier: " + keyCode, 5);
          return;
        }

        // Ignore keydown event if typing in an input box. composedPath()[0]
        // is the real target even when the box lives inside a shadow root,
        // where event.target only points at the shadow host.
        var target =
          (event.composedPath && event.composedPath()[0]) || event.target;
        if (
          target.nodeName === "INPUT" ||
          target.nodeName === "TEXTAREA" ||
          target.nodeName === "SELECT" ||
          target.isContentEditable
        ) {
          return false;
        }

        // Ignore keydown event if typing in a page without vsc
        if (!tc.mediaElements.length) {
          return false;
        }

        var item = tc.settings.keyBindings.find((item) => item.key === keyCode);
        if (item) {
          runAction(item.action, item.value);
          if (item.force === "true") {
            // disable websites key bindings
            event.preventDefault();
            event.stopPropagation();
          }
        }

        return false;
      },
      true
    );
  });

  function checkForVideo(node, parent, added) {
    // Only proceed with supposed removal if node is missing from DOM
    if (!added && document.body.contains(node)) {
      return;
    }
    if (
      node.nodeName === "VIDEO" ||
      (node.nodeName === "AUDIO" && tc.settings.audioBoolean)
    ) {
      if (added) {
        node.vsc = new tc.videoController(node, parent);
      } else {
        if (node.vsc) {
          node.vsc.remove();
        }
      }
    } else if (node.children != undefined) {
      for (var i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        checkForVideo(child, child.parentNode || parent, added);
      }
    }
  }

  var observer = new MutationObserver(function (mutations) {
    // Process the DOM nodes lazily
    requestIdleCallback(
      (_) => {
        mutations.forEach(function (mutation) {
          switch (mutation.type) {
            case "childList":
              mutation.addedNodes.forEach(function (node) {
                if (typeof node === "function") return;
                checkForVideo(node, node.parentNode || mutation.target, true);
              });
              mutation.removedNodes.forEach(function (node) {
                if (typeof node === "function") return;
                checkForVideo(node, node.parentNode || mutation.target, false);
              });
              break;
            case "attributes":
              if (
                mutation.target.attributes["aria-hidden"] &&
                mutation.target.attributes["aria-hidden"].value == "false"
              ) {
                var flattenedNodes = getShadow(document.body);
                var node = flattenedNodes.filter(
                  (x) => x.tagName == "VIDEO"
                )[0];
                if (node) {
                  if (node.vsc)
                    node.vsc.remove();
                  checkForVideo(node, node.parentNode || mutation.target, true);
                }
              }
              break;
          }
        });
      },
      { timeout: 1000 }
    );
  });
  observer.observe(document, {
    attributeFilter: ["aria-hidden"],
    childList: true,
    subtree: true
  });

  if (tc.settings.audioBoolean) {
    var mediaTags = document.querySelectorAll("video,audio");
  } else {
    var mediaTags = document.querySelectorAll("video");
  }

  mediaTags.forEach(function (video) {
    video.vsc = new tc.videoController(video);
  });

  var frameTags = document.getElementsByTagName("iframe");
  Array.prototype.forEach.call(frameTags, function (frame) {
    // Ignore frames we don't have permission to access (different origin).
    try {
      var childDocument = frame.contentDocument;
    } catch (e) {
      return;
    }
    initializeWhenReady(childDocument);
  });
  log("End initializeNow", 5);
}

// Sets the speed because the USER asked for it (shortcut key or controller
// button). This is the only place a video's wanted speed changes on purpose.
function setSpeed(video, speed) {
  log("setSpeed started: " + speed, 5);
  var vsc = video.vsc;
  speed = normalizeSpeed(speed);
  cancelAdopt(vsc);
  vsc.revertTimes = [];
  setTargetSpeed(vsc, speed);
  if (video.currentSrc) {
    tc.settings.speeds[video.currentSrc] = speed;
  }
  applySpeed(video, speed);
  log("setSpeed finished: " + speed, 5);
}

// Saves the speed the user picked, for the "Remember playback speed" option.
var pendingSavedSpeed = null;
var saveTimer = null;
function rememberUserSpeed(speed) {
  tc.settings.lastSpeed = speed;
  pendingSavedSpeed = speed;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSavedSpeed, SAVE_DELAY_MS);
}

function flushSavedSpeed() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (pendingSavedSpeed === null) {
    return;
  }
  var speed = pendingSavedSpeed;
  pendingSavedSpeed = null;
  chrome.storage.sync.set({ lastSpeed: speed }, function () {
    log("Speed setting saved: " + speed, 5);
  });
}
window.addEventListener("pagehide", flushSavedSpeed);

// When one key press changes several videos at once (e.g. a hidden preview
// player next to the real one), remember the speed of the one being watched:
// prefer a playing video, then the biggest one.
function pickPrimaryVideo(videos) {
  function area(v) {
    var rect = v.getBoundingClientRect();
    return rect.width * rect.height;
  }
  return videos.reduce(function (best, v) {
    if (best.paused !== v.paused) {
      return v.paused ? best : v;
    }
    return area(v) > area(best) ? v : best;
  });
}

function runAction(action, value, e) {
  log("runAction Begin", 5);

  var mediaTags = tc.mediaElements;
  var changedVideos = [];

  // Get the controller that was used if called from a button press event e
  if (e) {
    var targetController = e.target.getRootNode().host;
  }

  mediaTags.forEach(function (v) {
    var controller = v.vsc.div;

    // Don't change video speed if the video has a different controller
    if (e && !(targetController == controller)) {
      return;
    }

    showController(controller);

    if (!v.classList.contains("vsc-cancelled")) {
      if (action === "rewind") {
        log("Rewind", 5);
        v.currentTime -= value;
      } else if (action === "advance") {
        log("Fast forward", 5);
        v.currentTime += value;
      } else if (action === "faster") {
        log("Increase speed", 5);
        // Maximum playback speed in Chrome is set to 16:
        // https://cs.chromium.org/chromium/src/third_party/blink/renderer/core/html/media/html_media_element.cc?gsn=kMinRate&l=166
        var s = Math.min(
          (v.playbackRate < 0.1 ? 0.0 : v.playbackRate) + value,
          16
        );
        setSpeed(v, s);
        changedVideos.push(v);
      } else if (action === "slower") {
        log("Decrease speed", 5);
        // Video min rate is 0.0625:
        // https://cs.chromium.org/chromium/src/third_party/blink/renderer/core/html/media/html_media_element.cc?gsn=kMinRate&l=165
        var s = Math.max(v.playbackRate - value, 0.07);
        setSpeed(v, s);
        changedVideos.push(v);
      } else if (action === "reset") {
        log("Reset speed", 5);
        resetSpeed(v, 1.0);
        changedVideos.push(v);
      } else if (action === "display") {
        log("Showing controller", 5);
        controller.classList.add("vsc-manual");
        controller.classList.toggle("vsc-hidden");
      } else if (action === "blink") {
        log("Showing controller momentarily", 5);
        // if vsc is hidden, show it briefly to give the use visual feedback that the action is excuted.
        if (
          controller.classList.contains("vsc-hidden") ||
          controller.blinkTimeOut !== undefined
        ) {
          clearTimeout(controller.blinkTimeOut);
          controller.classList.remove("vsc-hidden");
          controller.blinkTimeOut = setTimeout(
            () => {
              controller.classList.add("vsc-hidden");
              controller.blinkTimeOut = undefined;
            },
            value ? value : 1000
          );
        }
      } else if (action === "drag") {
        handleDrag(v, e);
      } else if (action === "fast") {
        resetSpeed(v, value);
        changedVideos.push(v);
      } else if (action === "pause") {
        pause(v);
      } else if (action === "muted") {
        muted(v);
      } else if (action === "mark") {
        setMark(v);
      } else if (action === "jump") {
        jumpToMark(v);
      }
    }
  });

  if (changedVideos.length) {
    rememberUserSpeed(pickPrimaryVideo(changedVideos).vsc.targetSpeed);
  }
  log("runAction End", 5);
}

function pause(v) {
  if (v.paused) {
    log("Resuming video", 5);
    v.play();
  } else {
    log("Pausing video", 5);
    v.pause();
  }
}

function resetSpeed(v, target) {
  if (v.playbackRate === target) {
    if (v.playbackRate === v.vsc.toggleSpeed) {
      if (target !== 1.0) {
        log("Resetting playback speed to 1.0", 4);
        setSpeed(v, 1.0);
      } else {
        log('Toggling playback speed to "fast" speed', 4);
        setSpeed(v, getKeyBindings("fast"));
      }
    } else {
      log('Toggling playback speed to "reset" speed', 4);
      setSpeed(v, v.vsc.toggleSpeed);
    }
  } else {
    log('Toggling playback speed to "reset" speed', 4);
    v.vsc.toggleSpeed = v.playbackRate;
    setSpeed(v, target);
  }
}

function muted(v) {
  v.muted = v.muted !== true;
}

function setMark(v) {
  log("Adding marker", 5);
  v.vsc.mark = v.currentTime;
}

function jumpToMark(v) {
  log("Recalling marker", 5);
  if (v.vsc.mark && typeof v.vsc.mark === "number") {
    v.currentTime = v.vsc.mark;
  }
}

function handleDrag(video, e) {
  const controller = video.vsc.div;
  const shadowController = controller.shadowRoot.querySelector("#controller");

  // Find nearest parent of same size as video parent.
  var parentElement = controller.parentElement;
  while (
    parentElement.parentNode &&
    parentElement.parentNode.offsetHeight === parentElement.offsetHeight &&
    parentElement.parentNode.offsetWidth === parentElement.offsetWidth
  ) {
    parentElement = parentElement.parentNode;
  }

  video.classList.add("vcs-dragging");
  shadowController.classList.add("dragging");

  const initialMouseXY = [e.clientX, e.clientY];
  const initialControllerXY = [
    parseInt(shadowController.style.left),
    parseInt(shadowController.style.top)
  ];

  const startDragging = (e) => {
    let style = shadowController.style;
    let dx = e.clientX - initialMouseXY[0];
    let dy = e.clientY - initialMouseXY[1];
    style.left = initialControllerXY[0] + dx + "px";
    style.top = initialControllerXY[1] + dy + "px";
  };

  const stopDragging = () => {
    parentElement.removeEventListener("mousemove", startDragging);
    parentElement.removeEventListener("mouseup", stopDragging);
    parentElement.removeEventListener("mouseleave", stopDragging);

    shadowController.classList.remove("dragging");
    video.classList.remove("vcs-dragging");
  };

  parentElement.addEventListener("mouseup", stopDragging);
  parentElement.addEventListener("mouseleave", stopDragging);
  parentElement.addEventListener("mousemove", startDragging);
}

var timer = null;
function showController(controller) {
  log("Showing controller", 4);
  controller.classList.add("vcs-show");

  if (timer) clearTimeout(timer);

  timer = setTimeout(function () {
    controller.classList.remove("vcs-show");
    timer = false;
    log("Hiding controller", 5);
  }, 2000);
}
