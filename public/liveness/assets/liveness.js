// The hosted liveness check. Guides the person through the steps the server chose, takes one frame per
// step, and sends them to the server, which runs the same measurements again and gives the verdict.
// Nothing decided here is trusted: this side only makes sure the frames are worth sending.
import {Human} from '/liveness/vendor/human.esm.js';

const sessionId = location.pathname.split('/').filter(Boolean)[1] || '';
const $ = (id) => document.getElementById(id);

// ----- Where we're running -----

const ua = navigator.userAgent;
const platform = (() => {
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  return {
    ios,
    android,
    mobile: ios || android || /Mobi/.test(ua),
    // Apps that open links in their own browser, which often has no camera access.
    inApp: /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Line\/|Snapchat|musical_ly|TikTok|Twitter|MicroMessenger|Pinterest|GSA\//.test(ua),
    firefox: /Firefox|FxiOS/.test(ua),
    edge: /Edg(e|iOS|A)?\//.test(ua),
    samsung: /SamsungBrowser/.test(ua),
    safari: /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|Android/.test(ua),
  };
})();

const INSTRUCTIONS = {
  center: 'Look straight at the camera',
  turn_left: 'Slowly turn your head to your left',
  turn_right: 'Slowly turn your head to your right',
  open_mouth: 'Open your mouth wide',
};

// What to say if a step is taking a while.
const STEP_HELP = {
  center: 'Hold the phone at eye level and look straight into the camera.',
  turn_left: 'Keep turning to your left, about a quarter turn.',
  turn_right: 'Keep turning to your right, about a quarter turn.',
  open_mouth: 'Open your mouth as wide as you can, like saying “ah”.',
};

// Why an attempt failed, in words for the person taking it.
const REASONS = {
  no_face: 'We couldn’t see your face clearly. Try somewhere with more light, and don’t turn all the way to the side.',
  multiple_faces: 'More than one face was in view. Make sure only you are in the picture.',
  face_too_small: 'Your face was too far away. Hold the phone a little closer.',
  not_facing_camera: 'Look straight at the camera at the start.',
  did_not_turn_left: 'Turn your head further to your left when asked.',
  did_not_turn_right: 'Turn your head further to your right when asked.',
  mouth_not_open: 'Open your mouth wider when asked.',
  different_person: 'The pictures didn’t all show the same person.',
  spoof_suspected: 'We couldn’t confirm a live person. Use your own face, not a photo or screen, in good light.',
  duplicate_frames: 'Something went wrong with the camera. Please try again.',
  too_fast: 'That was too quick. Please try again.',
  too_slow: 'That took too long. Please try again.',
  wrong_frame_count: 'Something went wrong. Please try again.',
  invalid_frame: 'Something went wrong with the camera. Please try again.',
  step_timeout: 'We couldn’t see that step. Follow the instruction under the picture.',
};

// The page waits for a little more than the server asks, so a frame it takes isn't a borderline one.
const MARGIN = {center: 0.02, turn: 0.03, mouth: 0.02, width: 0.02};
const HOLD_MS = 450;
const STEP_HELP_MS = 9000;
const STEP_TIMEOUT_MS = 30000;
const FRAME_WIDTH = 640;
const POLL_MS = 4000;

const human = new Human({
  modelBasePath: '/liveness/models/',
  wasmPath: '/liveness/wasm/',
  backend: 'webgl',
  debug: false,
  face: {
    enabled: true,
    detector: {rotation: true, maxDetected: 2, minConfidence: 0.5},
    mesh: {enabled: true},
    iris: {enabled: false},
    description: {enabled: false},
    emotion: {enabled: false},
    antispoof: {enabled: false},
    liveness: {enabled: false},
  },
  body: {enabled: false},
  hand: {enabled: false},
  object: {enabled: false},
  gesture: {enabled: false},
  segmentation: {enabled: false},
});
let modelsReady = null;

let info = null;
let run = null; // {steps, thresholds, index, frames, centerMouth, holdSince, stepStarted, helped}
let stream = null;
let looping = false;
let paused = false;
let wakeLock = null;
let pollTimer = null;
let frameCount = 0;
let lightHint = '';
// Set once this page has started a try, so its own unfinished try isn't taken for another device's.
let startedHere = false;

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2500);
}

async function api(path, options = {}) {
  const res = await fetch(`/api/liveness/${encodeURIComponent(sessionId)}${path}`, {
    method: options.method || 'GET',
    headers: {'Content-Type': 'application/json'},
    body: options.body && JSON.stringify(options.body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  return {status: res.status, data};
}

function loadModels() {
  if (!modelsReady) {
    modelsReady = (async () => {
      try {
        await human.load();
        await human.warmup();
      } catch {
        // No WebGL (some older phones and locked-down browsers): fall back to WebAssembly.
        human.config.backend = 'wasm';
        await human.load();
        await human.warmup();
      }
    })();
    modelsReady.catch(() => (modelsReady = null));
  }
  return modelsReady;
}

async function copyLink() {
  const url = (info && info.page_url) || location.href;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Older browsers: copy through a hidden text box.
    const box = document.createElement('textarea');
    box.value = url;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    try {
      document.execCommand('copy');
    } catch {
      return toast(url);
    } finally {
      box.remove();
    }
  }
  toast('Link copied');
}

// Same measurements as the server (helpers/liveness/faceHelper.js), on the frame as the camera takes it.
function turnOf(mesh) {
  const [left, right] = [mesh[234][0], mesh[454][0]].sort((a, b) => a - b);
  return right > left ? (mesh[1][0] - left) / (right - left) : 0.5;
}
function mouthOf(mesh) {
  const gap = Math.hypot(mesh[13][0] - mesh[14][0], mesh[13][1] - mesh[14][1]);
  const height = Math.hypot(mesh[10][0] - mesh[152][0], mesh[10][1] - mesh[152][1]);
  return height > 0 ? gap / height : 0;
}

// ----- Results -----

/** Tells a page that opened this one in a popup how it went. Only the status: the result itself comes from the API. */
function tellOpener(status) {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({type: 'smatid.liveness', session_id: sessionId, status}, '*');
    }
  } catch {
    // The opener has gone, or won't take messages.
  }
}

function showResult({kind, title, text, retry = false, redirect = null}) {
  stopCamera();
  stopPolling();
  $('result-icon').className = `result-icon ${kind}`;
  $('result-title').textContent = title;
  $('result-text').textContent = text;
  $('retry').hidden = !retry;
  const cont = $('continue');
  cont.hidden = !redirect;
  if (redirect) {
    cont.href = redirect;
    setTimeout(() => location.assign(redirect), 3000);
  } else if (!retry && window.opener && !window.opener.closed) {
    // Opened as a popup with nowhere to go back to: close once the person has seen the result.
    $('result-text').textContent = `${text} This window will close.`;
    setTimeout(() => window.close(), 3000);
  }
  show('screen-result');
}

/** Shows the screen for a finished or expired session. Returns true if it did, false if the check can go on. */
function showState(view) {
  if (['passed', 'failed', 'expired'].includes(view.status)) tellOpener(view.status);
  if (view.status === 'passed') {
    showResult({kind: 'ok', title: 'You’re done', text: view.redirect_url ? 'Taking you back…' : 'Thank you. You can close this page now.', redirect: view.redirect_url});
    return true;
  }
  if (view.status === 'expired') {
    showResult({kind: 'bad', title: 'This link has expired', text: 'Ask the company that sent it for a new one.', redirect: view.redirect_url});
    return true;
  }
  if (view.status === 'failed' || view.attempts_left === 0) {
    showResult({kind: 'bad', title: 'We couldn’t confirm it’s you', text: 'You’ve used all your tries. Contact the company that sent you this link.', redirect: view.redirect_url});
    return true;
  }
  return false;
}

function showUnavailable(status) {
  const text = status === 404
    ? 'This link isn’t valid. Check that you opened the whole link.'
    : status === 403
      ? 'This check isn’t available right now. Please try again later.'
      : status === 0
        ? 'We couldn’t reach Smatid. Check your internet connection and try again.'
        : 'Something went wrong on our side. Please try again in a moment.';
  showResult({kind: 'bad', title: 'Can’t start the check', text});
}

function attemptFailed(reason, attemptsLeft) {
  if (attemptsLeft === 0) {
    return showResult({kind: 'bad', title: 'We couldn’t confirm it’s you', text: 'You’ve used all your tries. Contact the company that sent you this link.'});
  }
  const left = typeof attemptsLeft === 'number' ? ` You have ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.` : '';
  showResult({kind: 'retry', title: 'Let’s try that again', text: (REASONS[reason] || 'That didn’t work.') + left, retry: true});
}

// ----- Following a check done on another device -----

/** While this page waits (e.g. on a computer after showing the QR code), follow the session. */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (run || document.hidden) return;
    const {status, data} = await api('').catch(() => ({status: 0}));
    if (status !== 200 || run) return;
    info = {...info, ...data};
    if (showState(data)) return;
    if (data.status === 'started' && !startedHere) show('screen-elsewhere');
    else if (!$('screen-elsewhere').hidden) {
      // The other device stopped or failed a try: back to the start, with the reason.
      renderIntro();
      show('screen-intro');
    }
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ----- Camera -----

/** The steps to let this site use the camera, for this browser. */
function permissionSteps() {
  if (platform.ios) {
    return [
      'Tap <b>aA</b> (or the icon) on the left of the address bar, then <b>Website Settings</b>.',
      'Set <b>Camera</b> to <b>Allow</b>.',
      'If there’s no such option, open the <b>Settings</b> app → <b>Safari</b> → <b>Camera</b> → <b>Allow</b>.',
      'Come back and tap <b>Try again</b>.',
    ];
  }
  if (platform.android && platform.samsung) {
    return ['Tap the <b>lock</b> icon by the address, then <b>Permissions</b>.', 'Allow <b>Camera</b>.', 'Tap <b>Try again</b>.'];
  }
  if (platform.android) {
    return [
      'Tap the icon on the left of the address bar, then <b>Permissions</b> (or <b>Site settings</b>).',
      'Turn <b>Camera</b> on.',
      'If Chrome itself can’t use the camera: <b>Settings</b> app → <b>Apps</b> → <b>Chrome</b> → <b>Permissions</b> → <b>Camera</b> → <b>Allow</b>.',
      'Tap <b>Try again</b>.',
    ];
  }
  if (platform.firefox) {
    return ['Click the <b>camera</b> icon on the left of the address bar.', 'Remove the block, then click <b>Try again</b> and choose <b>Allow</b>.'];
  }
  if (platform.safari) {
    return ['In the menu bar, choose <b>Safari</b> → <b>Settings for This Website</b>.', 'Set <b>Camera</b> to <b>Allow</b>, then click <b>Try again</b>.'];
  }
  return [
    'Click the <b>camera</b> icon (or the icon on the left) in the address bar.',
    'Choose <b>Always allow</b> for the camera, then click <b>Try again</b>.',
    'On a Mac, also check <b>System Settings</b> → <b>Privacy &amp; Security</b> → <b>Camera</b> for your browser.',
  ];
}

function showCameraHelp(kind) {
  stopCamera();
  const blocked = kind === 'blocked';
  $('help-title').textContent = blocked ? 'Allow the camera' : kind === 'busy' ? 'Your camera is busy' : 'No camera found';
  $('help-text').textContent = blocked
    ? 'We need your camera for the check, but it was blocked.'
    : kind === 'busy'
      ? 'Another app or tab is using the camera. Close it, then try again.'
      : 'We couldn’t find a camera. Use a phone, or a computer with a webcam.';
  $('help-steps').innerHTML = blocked ? permissionSteps().map((s) => `<li>${s}</li>`).join('') : '';
  $('help-steps').hidden = !blocked;
  show('screen-camera-help');
}

async function startCamera() {
  const attempts = [
    {audio: false, video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}}},
    // Some cameras won't take those settings; anything will do.
    {audio: false, video: true},
  ];
  let lastError;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
    }
  }
  if (!stream) throw lastError || new Error('no camera');
  const video = $('video');
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // iOS sometimes needs a moment; autoplay + muted + playsinline gets it going.
  }
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, {once: true}));
  // Keep the screen on during the check.
  try {
    wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null;
  } catch {
    wakeLock = null;
  }
}

function stopCamera() {
  looping = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

/** The current video frame, as the camera took it (not mirrored), as a JPEG data URL. */
function captureFrame() {
  const video = $('video');
  const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
  const canvas = $('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88);
}

/** Average brightness of the picture, 0-255, from a tiny copy of it. */
function brightness() {
  const c = $('light');
  const ctx = c.getContext('2d', {willReadFrequently: true});
  ctx.drawImage($('video'), 0, 0, c.width, c.height);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  return sum / (px.length / 4);
}

const isSideways = () => platform.mobile && window.innerWidth > window.innerHeight;

// ----- The check -----

function renderStep() {
  const step = run.steps[run.index];
  $('instruction').textContent = INSTRUCTIONS[step];
  $('progress').innerHTML = run.steps
    .map((_, i) => `<li class="${i < run.index ? 'done' : i === run.index ? 'now' : ''}"></li>`)
    .join('');
  const arrow = $('arrow');
  // The preview is mirrored, so your left is on the left of the screen.
  arrow.hidden = !step.startsWith('turn_');
  arrow.className = `arrow ${step === 'turn_left' ? 'left' : 'right'}`;
}

function hint(text, state) {
  $('hint').textContent = text || ' ';
  $('oval').className = `oval ${state || ''}`;
}

/** Whether the face meets the step, with the page's extra margin. */
function meets(step, face, t) {
  const offset = face.turn - 0.5;
  if (step === 'center') return Math.abs(offset) <= t.center_max_offset - MARGIN.center;
  if (step === 'turn_left') return offset >= t.turn_min_offset + MARGIN.turn;
  if (step === 'turn_right') return offset <= -(t.turn_min_offset + MARGIN.turn);
  if (step === 'open_mouth') {
    return face.mouth >= t.mouth_min_open + MARGIN.mouth && face.mouth - run.centerMouth >= t.mouth_min_gain + MARGIN.mouth;
  }
  return false;
}

async function tick() {
  if (!looping || !run || paused) return;
  const video = $('video');
  const step = run.steps[run.index];
  const t = run.thresholds;
  const waited = Date.now() - run.stepStarted;

  if (waited > STEP_TIMEOUT_MS) {
    stopCamera();
    return attemptFailed('step_timeout');
  }

  $('rotate').hidden = !isSideways();
  if (isSideways()) {
    run.holdSince = 0;
    return requestAnimationFrame(tick);
  }

  // Every 15 frames or so, check the light.
  if (++frameCount % 15 === 0) {
    const b = brightness();
    lightHint = b < 55 ? 'It’s too dark. Move somewhere brighter.' : b > 230 ? 'Too much light. Avoid a bright light behind or in front of you.' : '';
  }

  let result;
  try {
    result = await human.detect(video);
  } catch {
    return requestAnimationFrame(tick);
  }
  if (!looping || paused) return;
  const faces = result.face;
  let ready = false;

  if (!faces.length) hint(lightHint || 'Fit your face inside the oval', 'bad');
  else if (faces.length > 1) hint('Make sure only you are in view', 'bad');
  else {
    const f = faces[0];
    const mesh = f.mesh || [];
    const width = f.box[2] / video.videoWidth;
    const centreX = (f.box[0] + f.box[2] / 2) / video.videoWidth;
    const centreY = (f.box[1] + f.box[3] / 2) / video.videoHeight;
    if (mesh.length <= 454) hint('Hold still', 'bad');
    else if (width < t.face_min_width_share + MARGIN.width) hint('Move a little closer', 'bad');
    else if (width > 0.8) hint('Move back a little', 'bad');
    else if (step === 'center' && (Math.abs(centreX - 0.5) > 0.2 || centreY < 0.2 || centreY > 0.75)) hint('Move your face to the middle of the oval', 'bad');
    else {
      const face = {turn: turnOf(mesh), mouth: mouthOf(mesh)};
      ready = meets(step, face, t);
      if (ready) hint('Hold it…', 'good');
      else hint(lightHint || (waited > STEP_HELP_MS ? STEP_HELP[step] : ''), '');
      if (ready) {
        run.holdSince = run.holdSince || Date.now();
        if (Date.now() - run.holdSince >= HOLD_MS) {
          run.frames.push(captureFrame());
          if (step === 'center') run.centerMouth = face.mouth;
          if (navigator.vibrate) navigator.vibrate(35);
          run.index++;
          run.holdSince = 0;
          run.stepStarted = Date.now();
          if (run.index >= run.steps.length) return submit();
          renderStep();
          hint('', '');
        }
      }
    }
  }
  if (!ready) run.holdSince = 0;
  requestAnimationFrame(tick);
}

function cameraErrorKind(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'blocked';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'missing';
}

async function begin() {
  const button = $('start');
  button.disabled = true;
  button.textContent = 'Starting…';
  stopPolling();
  try {
    // Ask for the camera before starting a try, so a blocked camera doesn't use one up.
    show('screen-camera');
    $('instruction').textContent = 'Allow the camera when your browser asks';
    hint('', '');
    try {
      await startCamera();
    } catch (err) {
      return showCameraHelp(cameraErrorKind(err));
    }
    $('instruction').textContent = 'Getting ready…';
    try {
      await loadModels();
    } catch {
      stopCamera();
      return showResult({kind: 'bad', title: 'This device can’t run the check', text: 'Please open this link on another phone or computer, using an up-to-date Chrome or Safari.'});
    }

    const started = await api('/start', {method: 'POST'});
    if (started.status !== 200) {
      stopCamera();
      if (started.data && started.data.status && showState(started.data)) return;
      return showUnavailable(started.status);
    }
    startedHere = true;
    run = {...started.data, index: 0, frames: [], centerMouth: 0, holdSince: 0, stepStarted: Date.now()};
    renderStep();
    looping = true;
    paused = false;
    requestAnimationFrame(tick);
  } catch {
    stopCamera();
    showUnavailable(0);
  } finally {
    button.disabled = false;
    button.textContent = 'Start';
  }
}

async function submit() {
  stopCamera();
  show('screen-checking');
  const {status, data} = await api('/submit', {method: 'POST', body: {frames: run.frames}}).catch(() => ({status: 0, data: {}}));
  run = null;
  if (status !== 200) {
    if (data && data.status) return showState(data) || attemptFailed(data.failure_reason, data.attempts_left);
    return showUnavailable(status);
  }
  info = {...info, ...data};
  if (showState(data)) return;
  attemptFailed(data.failure_reason, data.attempts_left);
}

// Switching apps or tabs mid-check: pause (phones stop the camera anyway), then carry on from the same step.
document.addEventListener('visibilitychange', async () => {
  if (!run) return;
  if (document.hidden) {
    paused = true;
    stopCamera();
    return;
  }
  if (!paused) return;
  try {
    show('screen-camera');
    $('instruction').textContent = 'Getting the camera back…';
    await startCamera();
    paused = false;
    looping = true;
    run.stepStarted = Date.now();
    run.holdSince = 0;
    renderStep();
    requestAnimationFrame(tick);
  } catch (err) {
    showCameraHelp(cameraErrorKind(err));
  }
});

// ----- Start up -----

function renderIntro() {
  $('client-name').textContent = info.client_name;
  const note = $('intro-note');
  note.hidden = !(info.failure_reason && info.attempts_left < 3);
  if (!note.hidden) {
    note.textContent = `${REASONS[info.failure_reason] || 'Your last try didn’t work.'} You have ${info.attempts_left} ${info.attempts_left === 1 ? 'try' : 'tries'} left.`;
  }
  // On a computer, offer the phone: better camera, and how most people will do it.
  if (!platform.mobile) {
    $('handoff').hidden = false;
    $('qr').src = `/api/liveness/${encodeURIComponent(sessionId)}/qr.svg`;
    $('start').textContent = 'Use this computer’s camera';
    startPolling();
  }
}

function showInApp() {
  const steps = platform.ios
    ? ['Tap <b>•••</b> or the share icon in this app.', 'Choose <b>Open in Safari</b> (or <b>Open in browser</b>).']
    : ['Tap <b>⋮</b> in this app.', 'Choose <b>Open in Chrome</b> (or <b>Open in browser</b>).'];
  $('inapp-steps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  if (platform.android) {
    const open = $('open-chrome');
    open.hidden = false;
    open.href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
  }
  show('screen-inapp');
}

$('start').addEventListener('click', begin);
$('retry').addEventListener('click', begin);
$('help-retry').addEventListener('click', begin);
$('cancel').addEventListener('click', () => {
  stopCamera();
  run = null;
  renderIntro();
  show('screen-intro');
});
for (const id of ['copy-link-desktop', 'copy-link-inapp', 'copy-link-help']) $(id).addEventListener('click', copyLink);
$('inapp-continue').addEventListener('click', () => {
  renderIntro();
  show('screen-intro');
});

(async () => {
  if (!/^lv_[A-Za-z0-9_-]{32}$/.test(sessionId)) return showUnavailable(404);
  const {status, data} = await api('').catch(() => ({status: 0, data: {}}));
  if (status !== 200) return showUnavailable(status);
  info = data;
  if (showState(info)) return;

  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (platform.inApp) return showInApp();
    return showResult({kind: 'bad', title: 'This browser can’t use the camera', text: 'Open this link in Chrome or Safari, or on your phone.'});
  }
  if (platform.inApp) return showInApp();
  if (info.status === 'started' && !platform.mobile) {
    // Already going on another device.
    renderIntro();
    show('screen-elsewhere');
    return;
  }
  renderIntro();
  show('screen-intro');
  // Fetch the face models while the person reads, so Start is quick.
  loadModels().catch(() => {});
})();
