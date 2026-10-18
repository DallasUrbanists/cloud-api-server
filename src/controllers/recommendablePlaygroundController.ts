import { recommendableMockDescriptions } from '../data/recommendableMockDescriptions.js';
import type { Request, Response } from 'express';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Public, ephemeral interface for testing approved civic actions. */
export class RecommendablePlaygroundController {
  static markedScript(_req: Request, res: Response): void {
    res.sendFile(path.join(path.dirname(require.resolve('marked')), 'marked.umd.js'));
  }

  static purifyScript(_req: Request, res: Response): void {
    res.sendFile(path.join(path.dirname(require.resolve('dompurify')), 'purify.min.js'));
  }

  static render(_req: Request, res: Response): void {
    res.type('html').send(playgroundHtml);
  }
}

export const playgroundHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Search Actions &amp; Representatives | Dallas Urbanists</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#07172b;color:#f5f3ee;line-height:1.6}
*{box-sizing:border-box}body{margin:0}header{border-bottom:1px solid #193860;background:#0c2340;padding:1rem 1.5rem}a{color:#85b8ff}
main{max-width:850px;margin:2.5rem auto;padding:0 1.25rem}h1{font-family:Georgia,serif;font-weight:normal;color:#ffa800;line-height:1.2}p{color:#a9bed4}
form{margin:1rem 0}.card{padding:1.5rem;border:1px solid #193860;border-radius:10px;background:#0c2340;margin:1rem 0}
label{display:block;font-weight:600;margin-bottom:.4rem}textarea,input{width:100%;font:inherit;padding:.7rem;background:#05101f;color:#f5f3ee;border:1px solid #748da9;border-radius:5px}
textarea{display:block;min-height:110px;resize:none;overflow-y:hidden;border-radius:5px 5px 0 0}.coordinates{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem}button{font:inherit;font-weight:700;padding:.7rem 1.2rem;background:#ffa800;color:#0c2340;border:0;border-radius:5px;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}
:focus-visible{outline:3px solid #85b8ff;outline-offset:3px}.card h3{margin-top:0}.card p{white-space:pre-wrap;overflow-wrap:anywhere}.probability{color:#ffa800;font-weight:700}#status{min-height:1.6em}#status.error{color:#ffb3ac}small{color:#a9bed4}footer{margin-top:2rem;color:#a9bed4}
.probability{white-space:nowrap}
.card[hidden]{display:none}
.empty-contact{color:#8195aa;font-size:.85rem}
.boundaries table{table-layout:fixed}.boundaries th,.boundaries td{width:50%;min-width:50%}
.location-picker #address-fields,.location-picker #coordinate-fields{margin-top:.75rem}.location-picker #address,.location-picker .coordinates input{display:block;height:3.125rem}.testing-options>summary{display:flex;align-items:center;gap:.4rem;list-style:none}.testing-options>summary::-webkit-details-marker{display:none}
.description-tools .testing-options,.location-actions .set-location{margin-inline-start:auto}.description-tools .testing-options-panel,.location-actions .set-location-options{left:auto;right:0}.toolbar-icon{width:1rem;height:1rem;flex:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;fill:none}#choose-sample,#set-location-button{display:inline-flex;align-items:center;gap:.4rem}
.set-location{position:relative}.set-location-options{position:absolute;z-index:5;top:calc(100% + .35rem);left:0;width:max-content;max-width:calc(100vw - 4.5rem);padding:.3rem;border:1px solid #426c96;border-radius:5px;background:#102c49;box-shadow:0 8px 24px #0006}.set-location-options button{display:block;width:100%;text-align:left;white-space:normal}.set-location-options button:hover,.set-location-options button:focus-visible{background:#193860}
.location-picker .coordinates{grid-template-columns:repeat(2,minmax(0,1fr));gap:0}.location-picker .coordinates input{min-width:0}.location-picker .coordinates>div:first-child input{border-top-right-radius:0}.location-picker .coordinates>div:last-child input{border-top-left-radius:0;border-left:0}.location-picker .location-actions select{appearance:none;padding-left:1.65rem;background-image:linear-gradient(45deg,transparent 50%,#a5ccff 50%),linear-gradient(135deg,#a5ccff 50%,transparent 50%);background-position:.65rem 50%,calc(.65rem + 4px) 50%;background-size:4px 4px;background-repeat:no-repeat}
.location-picker .location-actions{margin-top:0;gap:.3rem}.location-picker #address,.location-picker .coordinates input{border-radius:5px 5px 0 0}.location-actions select{max-width:100%;background:#102c49;color:#a5ccff;border:1px solid transparent;border-radius:5px;padding:.4rem .75rem;font:700 .875rem Inter,system-ui,sans-serif;cursor:pointer}.location-actions select:disabled{opacity:.6;cursor:not-allowed}
.address-heading{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.4rem}.address-heading label,.address-heading .maps-attribution{margin:0}.location-status:empty{display:none}
.representative .breadcrumb{display:flex;flex-wrap:wrap;gap:0 .3em}.breadcrumb-level{white-space:nowrap}.representative>strong{display:block;text-wrap:pretty}.contact-group small{text-wrap:pretty}
#submit{transition:background-color .18s ease,opacity .18s ease,box-shadow .18s ease}dialog[open]::backdrop{animation:sample-backdrop-in .18s ease-out}@keyframes sample-backdrop-in{from{background:#0000}to{background:#0009}}@media(prefers-reduced-motion:reduce){#submit{transition:none}dialog[open]::backdrop,.spinner{animation:none}}
.card.match-primary{border-color:#b98014;border-left:4px solid #ffa800;background:#172b3e}.card.match-secondary{border-color:#426c96;border-left:4px solid #85b8ff;background:#0c2340}.card.match-secondary .probability{color:#a5ccff}.card.match-tertiary{border-color:#34465c;background:#0a1c30}.card.match-tertiary h3,.card.match-tertiary .probability{color:#a9bed4}
.result-toggle[hidden]{display:none}.representative+.representative{margin-top:1rem}.representative strong{color:#f5f3ee}.contact{margin-top:.5rem}.contact small{display:block}.boundaries th:first-child{width:50%}
.result-toggle{display:flex;align-items:center;gap:.6rem;font-weight:400}.result-toggle input{width:auto;accent-color:#ffa800}.testing-options{position:relative;font-size:.8rem;color:#a9bed4}.testing-options summary{cursor:pointer;padding:.4rem .75rem;color:#a5ccff;font-size:.875rem;font-weight:700}.testing-options label{margin:.5rem 0}.testing-options-panel{position:absolute;z-index:5;left:0;top:calc(100% + .35rem);width:max-content;max-width:calc(100vw - 4.5rem);padding:.4rem .75rem;border:1px solid #426c96;border-radius:5px;background:#102c49;box-shadow:0 8px 24px #0006}
#status:empty{display:none}.boundaries{margin-top:2rem;overflow-x:auto}.boundaries table{width:100%;border-collapse:collapse;text-align:left;color:#a9bed4}.boundaries caption{text-align:left;font-size:1.5rem;font-weight:700;color:#f5f3ee;margin-bottom:.75rem}.boundaries th,.boundaries td{padding:.65rem .8rem;border:1px solid #193860;vertical-align:top}.boundaries th{background:#0c2340;color:#f5f3ee}.boundaries td{overflow-wrap:anywhere}.boundaries tbody tr:nth-child(even){background:#0a1c33}.breadcrumb{display:block;margin-top:.35rem;font-size:.85rem;color:#a9bed4}.contact-group+.contact-group{margin-top:1rem}.contact-group small{display:block}
.description-tools{display:flex;flex-wrap:wrap;width:100%;border:1px solid #748da9;border-top:0;border-radius:0 0 5px 5px;background:#102c49;padding:.35rem;gap:.3rem}.description-tools button,.secondary-button{background:transparent;color:#a5ccff;border:1px solid #426c96;padding:.4rem .75rem;font-size:.875rem}.description-tools button{border-color:transparent}
fieldset{border:0;padding:0;margin:0;min-width:0}legend{font-weight:600;padding:0;margin-bottom:.4rem}.location-picker{margin:1.25rem 0}.location-mode{display:flex;gap:1rem;flex-wrap:wrap}.location-mode label{font-weight:400;display:flex;align-items:center;gap:.4rem}.location-mode input{width:auto;accent-color:#ffa800}.location-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem}.address-search{position:relative;margin-top:.75rem}.address-options{padding:0;margin:.4rem 0;list-style:none;border:1px solid #426c96;border-radius:5px;background:#05101f}.address-options:empty{display:none}.address-options button{display:block;text-align:left;width:100%;background:transparent;color:#f5f3ee;border-radius:0;font-weight:400}.address-options button:hover,.address-options button:focus{background:#193860}.maps-attribution{font:400 .75rem system-ui,sans-serif;color:white;text-align:right;white-space:nowrap;margin:.25rem 0}.location-status{margin:.5rem 0 0;font-size:.875rem}#submit{width:100%;min-height:49px;margin-top:.5rem}.spinner{display:inline-block;width:1.25rem;height:1.25rem;vertical-align:middle;border:3px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation-duration:2s}}
dialog{width:min(700px,calc(100% - 2rem));max-height:85vh;padding:1.25rem;border:1px solid #426c96;border-radius:10px;background:#0c2340;color:#f5f3ee}dialog::backdrop{background:#0009}.dialog-header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.dialog-header h2{margin:0}.sample-list{list-style:none;padding:0;margin:.75rem 0;max-height:50vh;overflow:auto}.sample-list button{display:block;width:100%;text-align:left;background:#05101f;color:#a9bed4;font-weight:400;border:1px solid #193860;margin:.35rem 0}.sample-list button:hover{border-color:#85b8ff}#sample-count{display:block;margin-top:.5rem}[hidden]{display:none!important}
.card{display:flow-root}.match-photos{float:right;display:flex;flex-direction:column;max-width:100%;gap:.75rem;padding-left:1rem;margin:1rem 0}.match-photos a{display:block;min-width:0}.match-photos img{display:block;max-width:100%;width:auto;height:auto;max-height:220px;object-fit:contain;background:#05101f;border:1px solid #193860;border-radius:6px}.match-photos[hidden],.match-photos a[hidden]{display:none}
.instructions{margin:1rem 0;color:#a9bed4;overflow-wrap:anywhere}.instructions p{white-space:normal}.instructions ol,.instructions ul{padding-left:1.5rem}.instructions li+li{margin-top:.4rem}.instructions pre{overflow-x:auto;padding:.75rem;background:#05101f;border-radius:5px}.instructions code{font-family:monospace}
@media(width < 580px){.match-photos{float:none;width:100%;padding-left:0}.match-photos img{width:100%;max-height:none}}
@media(max-width:520px){.coordinates{grid-template-columns:1fr}main{margin-top:1.5rem}.card{padding:1rem}}
@media(max-width:520px){.description-tools,.location-picker .location-actions{flex-wrap:nowrap;gap:.15rem}.toolbar-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}#random-description,#choose-sample,#set-location-button,.testing-options>summary{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:.5rem}.location-actions select{min-width:0;min-height:44px;font-size:.8rem}#random-description>span[aria-hidden]{font-size:1.25rem;line-height:1}.testing-options-panel,.set-location-options{text-align:left}}
</style></head><body>
<main><h1>Search Actions &amp; Representatives</h1>
<form id="match-form"><fieldset id="form-controls">
<label for="text">Describe your idea, observation, request, or concern.</label><textarea id="text" name="text" maxlength="10000" required></textarea>
<div class="description-tools" role="toolbar" aria-label="Description samples"><button id="random-description" type="button"><span aria-hidden="true">↻</span><span class="toolbar-label"> Randomize</span></button><button id="choose-sample" type="button" aria-haspopup="dialog"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><span class="toolbar-label">Choose sample...</span></button><details id="testing-options" class="testing-options"><summary id="testing-options-button" aria-controls="testing-options-panel" aria-expanded="false"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 3 1-2h4l1 2 2 1 2.3-.1 2 3.4-1.2 2 .1 2.4 1.2 2-2 3.4-2.4-.1-2 1-1 2h-4l-1-2-2-1-2.3.1-2-3.4 1.2-2V9.3l-1.2-2 2-3.4L7 4Z"/><circle cx="12" cy="10.5" r="3"/></svg><span class="toolbar-label">Testing options</span></summary><div id="testing-options-panel" class="testing-options-panel"><label class="result-toggle"><input id="bypass-jev-cache" type="checkbox"> Run without JEV cache</label><label id="low-toggle" class="result-toggle"><input id="show-all" type="checkbox" disabled> Show low matches (20% to 50% probability)</label></div></details></div>
<fieldset class="location-picker" aria-label="Location">
<div id="coordinate-fields" class="coordinates" hidden><div><label for="latitude">Latitude</label><input id="latitude" name="latitude" type="number" min="-90" max="90" step="any" value="32.781162" disabled></div>
<div><label for="longitude">Longitude</label><input id="longitude" name="longitude" type="number" min="-180" max="180" step="any" value="-96.794861" disabled></div></div>
<div id="address-fields" class="address-search"><div class="address-heading"><label for="address">Address</label><div id="maps-attribution" class="maps-attribution" translate="no" hidden>Google Maps</div></div><input id="address" type="text" maxlength="200" autocomplete="off" value="1902 Main St, Dallas, TX 75201" placeholder="Start typing an address…" aria-describedby="location-status" aria-controls="address-options" aria-expanded="false" aria-autocomplete="list" role="combobox"><ul id="address-options" class="address-options" aria-label="Address suggestions"></ul></div>
<div class="description-tools location-actions" role="toolbar" aria-label="Location tools"><select id="location-mode" aria-label="Location type"><option value="address" selected>Address</option><option value="coordinates">Latitude/longitude</option></select><div id="set-location" class="set-location"><button id="set-location-button" type="button" aria-expanded="false" aria-controls="set-location-options"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span class="toolbar-label">Set location...</span></button><div id="set-location-options" class="set-location-options" role="group" aria-label="Set location options" hidden><button id="current-location" type="button">Use current location</button><button id="default-location" type="button">Use default (downtown)</button><button id="clear-location" type="button">Clear location</button></div></div></div><p id="location-status" class="location-status" role="status" aria-live="polite"></p></fieldset>
<button id="submit" type="submit" disabled>Search</button>
</fieldset>
</form>
<dialog id="sample-dialog" aria-labelledby="sample-heading"><div class="dialog-header"><h2 id="sample-heading">Choose a sample</h2><button id="close-samples" class="secondary-button" type="button" aria-label="Close sample browser">Close</button></div><label for="sample-filter">Filter scenarios</label><input id="sample-filter" type="search" placeholder="Search samples…"><small id="sample-count" role="status"></small><ul id="sample-list" class="sample-list"></ul></dialog>
<section aria-labelledby="results-heading" id="results" aria-busy="false"><h2 id="results-heading" hidden>Recommended actions</h2><p id="status" role="status" aria-live="polite"></p><div id="output"></div></section>
</main>
<script src="/playground/recommendables/marked.js"></script>
<script src="/playground/recommendables/purify.js"></script>
<script>
const form = document.getElementById('match-form');
const button = document.getElementById('submit');
const status = document.getElementById('status');
const output = document.getElementById('output');
const results = document.getElementById('results');
const showAll = document.getElementById('show-all');
showAll.disabled = true;
showAll.checked = false;
const heading = document.getElementById('results-heading');
const controls = document.getElementById('form-controls');
const textarea = document.getElementById('text');
const latitudeInput = document.getElementById('latitude');
const longitudeInput = document.getElementById('longitude');
const addressInput = document.getElementById('address');
const addressOptions = document.getElementById('address-options');
const locationStatus = document.getElementById('location-status');
const attribution = document.getElementById('maps-attribution');
const sampleDialog = document.getElementById('sample-dialog');
const locationMenu = document.getElementById('set-location');
const locationMenuButton = document.getElementById('set-location-button');
const locationMenuOptions = document.getElementById('set-location-options');
const testingMenu = document.getElementById('testing-options');
const testingMenuButton = document.getElementById('testing-options-button');
const testingMenuOptions = document.getElementById('testing-options-panel');
const dropdownStates = new WeakMap();
function dropdownOpen(panel, details) { return dropdownStates.get(panel)?.open ?? (details ? details.open : !panel.hidden); }
function setDropdownOpen(panel, trigger, open, details) {
  const wasOpen = dropdownOpen(panel, details);
  const previous = dropdownStates.get(panel);
  if (wasOpen === open) return;
  previous?.animation?.cancel();
  const state = { open, animation: undefined }; dropdownStates.set(panel, state);
  trigger.setAttribute('aria-expanded', String(open)); panel.inert = !open;
  const finish = () => {
    if (dropdownStates.get(panel) !== state) return;
    panel.hidden = !open;
    if (details) details.open = open;
    state.animation?.cancel(); state.animation = undefined;
  };
  if (open) { if (details) details.open = true; panel.hidden = false; }
  if (!motionEnabled(panel)) { finish(); return; }
  const hidden = { opacity: 0, transform: 'translateY(-6px) scale(.98)' };
  const visible = { opacity: 1, transform: 'translateY(0) scale(1)' };
  const animation = panel.animate(open ? [hidden, visible] : [visible, hidden], {
    duration: open ? 180 : 140, easing: open ? 'ease-out' : 'ease-in', fill: 'forwards',
  });
  state.animation = animation;
  animation.finished.then(finish, () => {});
}
function closeLocationMenu(restoreFocus = false) {
  setDropdownOpen(locationMenuOptions, locationMenuButton, false);
  if (restoreFocus) locationMenuButton.focus();
}
locationMenuButton.addEventListener('click', () => {
  setDropdownOpen(locationMenuOptions, locationMenuButton, !dropdownOpen(locationMenuOptions));
});
locationMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeLocationMenu(true); }
});
window.addEventListener('pointerdown', event => { if (!locationMenu.contains(event.target)) closeLocationMenu(); });
locationMenu.addEventListener('focusout', event => { if (!locationMenu.contains(event.relatedTarget)) closeLocationMenu(); });
function closeTestingMenu(restoreFocus = false) {
  setDropdownOpen(testingMenuOptions, testingMenuButton, false, testingMenu);
  if (restoreFocus) testingMenuButton.focus();
}
testingMenuButton.addEventListener('click', event => {
  event.preventDefault();
  setDropdownOpen(testingMenuOptions, testingMenuButton, !dropdownOpen(testingMenuOptions, testingMenu), testingMenu);
});
testingMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeTestingMenu(true); } });
testingMenu.addEventListener('focusout', event => { if (!testingMenu.contains(event.relatedTarget)) closeTestingMenu(); });
window.addEventListener('pointerdown', event => { if (!testingMenu.contains(event.target)) closeTestingMenu(); });
let loading = false;
let locating = false;
let resolving = false;
let addressMode = true;
let addressSelected = true;
const defaultLocation = { address: '1902 Main St, Dallas, TX 75201', latitude: '32.781162', longitude: '-96.794861' };
latitudeInput.value = defaultLocation.latitude; longitudeInput.value = defaultLocation.longitude;
addressInput.value = defaultLocation.address;
let locationVersion = 0;
let addressTimer;
let addressRequest;
let sessionToken;
let lastResult = null;
const mockDescriptions = ${JSON.stringify(recommendableMockDescriptions).replace(/</g, '\u003c')};
function resizeDescription() {
  textarea.style.height = 'auto';
  textarea.style.height = Math.max(110, textarea.scrollHeight + 2) + 'px';
}
function updateSubmit() { button.disabled = loading || locating || resolving || !textarea.value.trim(); }
let descriptionTransition;
function stopDescriptionTransition() { descriptionTransition?.cancel(); descriptionTransition = undefined; }
function setDescription(text) { stopDescriptionTransition(); textarea.value = text; resizeDescription(); updateSubmit(); }
textarea.addEventListener('input', () => { stopDescriptionTransition(); resizeDescription(); updateSubmit(); });
window.addEventListener('resize', resizeDescription);
resizeDescription(); updateSubmit();
document.getElementById('random-description').addEventListener('click', () => {
  stopDescriptionTransition();
  const oldHeight = textarea.getBoundingClientRect().height;
  setDescription(mockDescriptions[Math.floor(Math.random() * mockDescriptions.length)]);
  if (!motionEnabled(textarea)) return;
  const height = textarea.getBoundingClientRect().height + 'px';
  const color = getComputedStyle(textarea).color || '#f5f3ee';
  descriptionTransition = textarea.animate([
    { color: 'transparent', textShadow: '0 0 12px #85b8ff', height: oldHeight + 'px' },
    { color: '#85b8ff', textShadow: '0 0 3px #85b8ff', height, offset: .45 },
    { color, textShadow: '0 0 0 transparent', height },
  ], { duration: 360, easing: 'cubic-bezier(.22,.76,.18,1)' });
  descriptionTransition.finished.catch(() => {});
});
function renderSamples() {
  const query = document.getElementById('sample-filter').value.trim().toLowerCase();
  const list = document.getElementById('sample-list'); list.replaceChildren();
  const samples = mockDescriptions.filter(text => text.toLowerCase().includes(query));
  document.getElementById('sample-count').textContent = samples.length + (samples.length === 1 ? ' scenario' : ' scenarios');
  for (const text of samples) {
    const choice = element('button', text, element('li', '', list)); choice.type = 'button';
    choice.addEventListener('click', () => { setDescription(text); closeSamples(true); });
  }
  if (!samples.length) element('li', 'No scenarios match your filter.', list);
}
let dialogTransition;
function openSamples() {
  dialogTransition?.cancel(); renderSamples();
  if (!sampleDialog.open) sampleDialog.showModal();
  if (motionEnabled(sampleDialog)) {
    dialogTransition = sampleDialog.animate([{ opacity: 0, transform: 'translateY(12px) scale(.98)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 200, easing: 'ease-out' });
    dialogTransition.finished.catch(() => {});
  }
  document.getElementById('sample-filter').focus();
}
function closeSamples(focusDescription = false) {
  if (!sampleDialog.open) return;
  dialogTransition?.cancel();
  const finish = () => { sampleDialog.close(); if (focusDescription) textarea.focus(); };
  if (!motionEnabled(sampleDialog)) { finish(); return; }
  const animation = sampleDialog.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(8px) scale(.98)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
  dialogTransition = animation;
  animation.finished.then(() => { if (dialogTransition === animation) { finish(); animation.cancel(); dialogTransition = undefined; } }, () => {});
}
document.getElementById('choose-sample').addEventListener('click', openSamples);
document.getElementById('sample-filter').addEventListener('input', renderSamples);
document.getElementById('close-samples').addEventListener('click', () => closeSamples());
sampleDialog.addEventListener('cancel', event => { event.preventDefault(); closeSamples(); });
function stopAddressSearch() {
  clearTimeout(addressTimer); if (addressRequest) addressRequest.abort();
  addressOptions.replaceChildren(); addressInput.setAttribute('aria-expanded', 'false');
  resolving = false;
}
function setMode(useAddress) {
  closeLocationMenu();
  stopAddressSearch(); locationVersion++; locating = false;
  document.getElementById('current-location').disabled = false;
  addressMode = useAddress;
  document.getElementById('coordinate-fields').hidden = useAddress;
  document.getElementById('address-fields').hidden = !useAddress;
  // Hidden numeric fields must not participate in browser constraint validation.
  latitudeInput.disabled = longitudeInput.disabled = useAddress;
  document.getElementById('location-mode').value = useAddress ? 'address' : 'coordinates';
  locationStatus.textContent = useAddress && !addressSelected && latitudeInput.value !== '' ? 'Choose an address, use current location, or clear location.' : '';
  updateSubmit();
}
document.getElementById('location-mode').addEventListener('change', event => setMode(event.target.value === 'address'));
setMode(true);
for (const input of [latitudeInput, longitudeInput]) input.addEventListener('input', () => {
  addressSelected = false; addressInput.value = ''; attribution.hidden = true; locationStatus.textContent = '';
});
function clearLocation() {
  closeLocationMenu(true);
  stopAddressSearch(); locationVersion++; locating = false; sessionToken = undefined;
  document.getElementById('current-location').disabled = false;
  latitudeInput.value = longitudeInput.value = addressInput.value = '';
  addressSelected = false; attribution.hidden = true;
  locationStatus.textContent = 'Location cleared. Searching unrestricted actions only.'; updateSubmit();
}
document.getElementById('clear-location').addEventListener('click', clearLocation);
document.getElementById('default-location').addEventListener('click', () => {
  clearLocation();
  latitudeInput.value = defaultLocation.latitude; longitudeInput.value = defaultLocation.longitude;
  addressInput.value = defaultLocation.address; addressSelected = true;
  locationStatus.textContent = ''; updateSubmit();
});
document.getElementById('current-location').addEventListener('click', () => {
  closeLocationMenu(true);
  stopAddressSearch(); const version = ++locationVersion;
  if (!navigator.geolocation) { locationStatus.textContent = 'Current location is unavailable in this browser. Enter an address or coordinates.'; return; }
  locating = true; document.getElementById('current-location').disabled = true; updateSubmit();
  locationStatus.textContent = 'Requesting your location…';
  navigator.geolocation.getCurrentPosition(position => {
    if (version !== locationVersion) return;
    const { latitude, longitude } = position.coords;
    latitudeInput.value = String(latitude); longitudeInput.value = String(longitude);
    addressInput.value = 'Current location (' + latitude.toFixed(5) + ', ' + longitude.toFixed(5) + ')';
    addressSelected = true; attribution.hidden = true;
    locationStatus.textContent = 'Current location selected.';
    locating = false; document.getElementById('current-location').disabled = false; updateSubmit();
  }, error => {
    if (version !== locationVersion) return;
    locating = false; document.getElementById('current-location').disabled = false;
    locationStatus.textContent = error.code === 1 ? 'Location permission was denied. Enter an address or coordinates, or clear location.' : 'Could not get your location. Try again, enter an address or coordinates, or clear location.';
    updateSubmit();
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
});
async function locationFetch(params, signal) {
  const response = await fetch('/api/recommendables/locations?' + new URLSearchParams(params), { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Address search failed. Retry or use coordinates.');
  return result;
}
async function selectAddress(suggestion) {
  stopAddressSearch(); const version = ++locationVersion;
  const controller = new AbortController(); addressRequest = controller;
  resolving = true; updateSubmit(); locationStatus.textContent = 'Resolving address…';
  try {
    const result = await locationFetch({ placeId: suggestion.placeId, sessionToken }, controller.signal);
    if (version !== locationVersion || controller.signal.aborted) return;
    latitudeInput.value = String(result.latitude); longitudeInput.value = String(result.longitude);
    addressInput.value = result.address; addressSelected = true; attribution.hidden = false;
    sessionToken = undefined; locationStatus.textContent = '';
  } catch (error) {
    if (!controller.signal.aborted && version === locationVersion) locationStatus.textContent = error.message;
  } finally { if (version === locationVersion) { resolving = false; updateSubmit(); } }
}
addressInput.addEventListener('input', () => {
  stopAddressSearch(); const version = ++locationVersion;
  locating = false; document.getElementById('current-location').disabled = false;
  latitudeInput.value = longitudeInput.value = ''; addressSelected = false; attribution.hidden = true;
  const query = addressInput.value.trim();
  locationStatus.textContent = query.length < 3 ? (query ? 'Type at least three characters.' : 'No location selected. Searching unrestricted actions only.') : 'Looking for addresses…';
  updateSubmit();
  if (query.length < 3) return;
  sessionToken ||= crypto.randomUUID();
  addressTimer = setTimeout(async () => {
    const controller = new AbortController(); addressRequest = controller;
    try {
      const result = await locationFetch({ input: query, sessionToken }, controller.signal);
      if (version !== locationVersion || controller.signal.aborted || loading) return;
      addressOptions.replaceChildren();
      for (const suggestion of result.suggestions) {
        const choice = element('button', suggestion.text, element('li', '', addressOptions)); choice.type = 'button';
        choice.addEventListener('click', () => selectAddress(suggestion));
      }
      attribution.hidden = !result.suggestions.length;
      addressInput.setAttribute('aria-expanded', String(!!result.suggestions.length));
      locationStatus.textContent = result.suggestions.length ? 'Select an address from the suggestions.' : 'No addresses found. Refine your search or use coordinates.';
    } catch (error) { if (!controller.signal.aborted && version === locationVersion) locationStatus.textContent = error.message; }
  }, 250);
});
addressInput.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' && addressOptions.children.length) { event.preventDefault(); addressOptions.children[0].firstChild.focus(); }
  if (event.key === 'Escape') stopAddressSearch();
});
addressOptions.addEventListener('keydown', event => {
  if (event.key === 'Escape') { stopAddressSearch(); addressInput.focus(); return; }
  const choices = Array.from(addressOptions.querySelectorAll('button'));
  const index = choices.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus(); }
});
function element(tag, text, parent, className) {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  parent.append(node); return node;
}
const resultAnimations = new WeakMap();
function motionEnabled(node) {
  return typeof node.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
let searchTransition;
function animateSearchState() {
  searchTransition?.cancel();
  if (!motionEnabled(button)) return;
  searchTransition = button.animate([{ opacity: .55, transform: 'scale(.985)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
  searchTransition.finished.catch(() => {});
}
function setCardExpanded(card, expanded) {
  const previous = resultAnimations.get(card);
  if (previous) {
    previous.animation.cancel(); card.style.overflow = previous.overflow;
    resultAnimations.delete(card);
  }
  card.inert = !expanded;
  if (!motionEnabled(card)) { card.hidden = !expanded; return; }
  if (card.hidden && !expanded) return;
  card.hidden = false;
  const style = getComputedStyle(card);
  const full = { height: card.getBoundingClientRect().height + 'px', paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
    marginTop: style.marginTop, marginBottom: style.marginBottom, borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth, opacity: 1, transform: 'translateY(0)' };
  const collapsed = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px',
    borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0, transform: 'translateY(-6px)' };
  const overflow = card.style.overflow;
  card.style.overflow = 'hidden';
  const animation = card.animate(expanded ? [collapsed, full] : [full, collapsed], { duration: 220, easing: 'ease-out' });
  resultAnimations.set(card, { animation, overflow });
  const finish = () => {
    if (resultAnimations.get(card)?.animation !== animation) return;
    card.hidden = !expanded; card.style.overflow = overflow;
    resultAnimations.delete(card);
  };
  animation.finished.then(finish, finish);
}
function renderResult(result) {
    output.replaceChildren();
    const d = result.diagnostics;
    const hasLowMatches = result.eligibleActions.some(action => action.matchProbability >= 0.2 && action.matchProbability < 0.5);
    showAll.disabled = !hasLowMatches;
    if (!hasLowMatches) showAll.checked = false;
    const actions = result.eligibleActions.filter(action => action.matchProbability >= (showAll.checked ? 0.2 : 0.5));
    const is311Action = action => /\\b311\\b/.test([action.summary, action.instructions].join(' '));
    const count311 = actions.filter(is311Action).length;
    let seen311 = 0;
    const extra311Cards = [];
    heading.hidden = !actions.length;
    status.textContent = !d.catalogCount ? 'The approved catalog is empty.' : !d.eligibleCount ? 'No actions are geographically eligible for this test.' : !actions.length ? (showAll.checked ? 'No actions reached 20%.' : (hasLowMatches ? 'No actions reached 50%. Open Testing options to show low matches.' : 'No actions reached 20%.')) : '';
    for (const action of actions) {
      const related311 = is311Action(action);
      if (related311) seen311++;
      const tier = action.matchProbability >= 0.8 ? 'primary' : action.matchProbability >= 0.5 ? 'secondary' : 'tertiary';
      const card = element('article', '', output, 'card match-' + tier);
      card.hidden = related311 && seen311 > 2;
      if (card.hidden) extra311Cards.push(card);
      const summary = element('h3', action.summary + ' ', card);
      element('span', Number((action.matchProbability * 100).toFixed(1)) + '% match', summary, 'probability');
      const photos = (Array.isArray(action.photos) ? action.photos : []).flatMap(photo => {
        try {
          if (typeof photo !== 'string') return [];
          const url = new URL(photo);
          return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
        } catch { return []; }
      });
      if (photos.length) {
        const gallery = element('div', '', card, 'match-photos');
        for (const [index, url] of [...new Set(photos)].entries()) {
          const link = element('a', '', gallery);
          link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          const photo = element('img', '', link);
          photo.alt = action.summary + ' — photo ' + (index + 1);
          photo.loading = 'lazy'; photo.decoding = 'async'; photo.referrerPolicy = 'no-referrer';
          photo.addEventListener('error', () => {
            link.hidden = true;
            gallery.hidden = Array.from(gallery.children).every(child => child.hidden);
          });
          photo.src = url;
        }
      }
      const instructions = element('div', '', card, 'instructions');
      instructions.innerHTML = DOMPurify.sanitize(marked.parse(action.instructions), {
        ALLOWED_TAGS: ['p', 'br', 'ol', 'ul', 'li', 'a', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
        ALLOWED_ATTR: ['href', 'title', 'start'],
        ALLOW_DATA_ATTR: false,
      });
      const hasWhyNot = typeof action.whyNot === 'string' && action.whyNot.trim().length > 0;
      const why = element('p', '', card);
      if (hasWhyNot) element('strong', 'Why: ', why);
      element('span', action.why, why);
      if (hasWhyNot) {
        const whyNot = element('p', '', card);
        element('strong', 'Why not: ', whyNot); element('span', action.whyNot, whyNot);
      }
      try {
        const url = new URL(action.sourceUrl);
        const source = new URL(url.href); source.hash = '';
        const alreadyLinked = Array.from(instructions.querySelectorAll('a[href]')).some(link => {
          try { const target = new URL(link.getAttribute('href')); target.hash = ''; return target.href === source.href; } catch { return false; }
        });
        if (!alreadyLinked && (url.protocol === 'https:' || url.protocol === 'http:')) {
          const link = element('a', 'View source', card); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        }
      } catch {}
      if (related311 && seen311 === 2 && count311 > 2) {
        const toggle = element('button', 'Show more', output, 'secondary-button more-311');
        toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Show more 311 actions');
        let expanded = false;
        toggle.addEventListener('click', () => {
          expanded = !expanded;
          for (const extra of extra311Cards) setCardExpanded(extra, expanded);
          toggle.textContent = expanded ? 'Show less' : 'Show more';
          toggle.setAttribute('aria-label', expanded ? 'Show less 311 actions' : 'Show more 311 actions');
          toggle.setAttribute('aria-expanded', String(expanded));
        });
      }
    }
    const boundaryContainer = element('div', '', output, 'boundaries');
    const table = element('table', '', boundaryContainer);
    element('caption', 'Boundary matches', table);
    const header = element('tr', '', element('thead', '', table));
    element('th', 'Representative', header).setAttribute('scope', 'col');
    element('th', 'Contact', header).setAttribute('scope', 'col');
    const body = element('tbody', '', table);
    const grouped = new Map();
    for (const boundary of d.boundaries) {
      for (const representative of boundary.representatives?.length ? boundary.representatives : [null]) {
        const key = representative ? JSON.stringify([representative.name?.trim().toLowerCase(), representative.title?.trim().toLowerCase()]) : 'boundary-' + boundary.id;
        if (!grouped.has(key)) grouped.set(key, { representative, boundaries: new Set(), records: [] });
        const group = grouped.get(key); group.boundaries.add(boundary.name);
        if (representative) group.records.push(representative);
      }
    }
    const contactRank = group => !group.representative ? 2 : group.records.some(record =>
      ['phones', 'emails'].some(field => Array.isArray(record[field]) && record[field].some(contact => {
        const value = contact?.[field === 'phones' ? 'phone' : 'email'];
        return typeof value === 'string' && value.trim().length > 0;
      }))
    ) ? 0 : 1;
    for (const group of [...grouped.values()].sort((a, b) => contactRank(a) - contactRank(b))) {
      const row = element('tr', '', body);
      const identity = element('td', '', row, 'representative');
      const representative = group.representative;
      if (representative) element('strong', [representative.name, representative.title].filter(Boolean).join(' — ') || 'Representative', identity);
      for (const name of group.boundaries) {
        const breadcrumb = element('span', '', identity, 'breadcrumb');
        name.split(' / ').forEach((level, index) => element('span', (index ? ' › ' : '') + level, breadcrumb, 'breadcrumb-level'));
      }
      const cell = element('td', '', row);
      if (!representative) { element('span', 'No current representative on file.', cell, 'empty-contact'); continue; }
      const identityTokens = text => text.normalize('NFKC').toLowerCase().split(/[^\\p{L}\\p{N}]+/u).filter(Boolean).sort().join(' ');
      const representativeIdentity = identityTokens([representative.name, representative.title].filter(Boolean).join(' '));
      const contactGroups = new Map();
      for (const record of group.records) {
        for (const [field, scheme, fallback] of [['phones', 'tel:', 'Phone'], ['emails', 'mailto:', 'Email']]) {
          const contacts = Array.isArray(record[field]) ? record[field] : [];
          for (const contact of contacts) {
            const value = contact && contact[field === 'phones' ? 'phone' : 'email'];
            if (typeof value !== 'string' || !value.trim()) continue;
            const label = typeof contact.label === 'string' && contact.label.trim() ? contact.label.trim() : 'Contact';
            const isDirect = !!representative.name?.trim() && !!representativeIdentity && identityTokens(label) === representativeIdentity;
            const key = isDirect ? 'direct-representative' : 'label:' + label.toLowerCase().replaceAll('–', '—').split(' ').filter(Boolean).join(' ');
            if (!contactGroups.has(key)) contactGroups.set(key, { label, isDirect, reason: '', contacts: new Map() });
            const contactGroup = contactGroups.get(key);
            contactGroup.contacts.set(scheme + value.trim().toLowerCase(), { value: value.trim(), scheme, fallback });
            if (typeof contact.when_to_use === 'string' && contact.when_to_use.trim().length > contactGroup.reason.length) contactGroup.reason = contact.when_to_use.trim();
          }
        }
      }
      if (!contactGroups.size) element('span', 'No contact details on file.', cell, 'empty-contact');
      for (const contactGroup of [...contactGroups.values()].sort((a, b) => Number(b.isDirect) - Number(a.isDirect))) {
        const contactCard = element('div', '', cell, 'contact-group');
        if (contactGroups.size > 1 && !contactGroup.isDirect) element('strong', contactGroup.label, contactCard);
        for (const { value, scheme, fallback } of contactGroup.contacts.values()) {
          const line = element('div', '', contactCard, 'contact');
          element('span', fallback + ': ', line);
          const link = element('a', value, line); link.href = scheme + encodeURIComponent(value);
        }
        if (contactGroup.reason) element('small', contactGroup.reason, contactCard);
      }
    }
    if (!d.boundaries.length) element('td', 'None', element('tr', '', body)).setAttribute('colspan', '2');
    let entranceIndex = 0;
    for (const node of output.children) {
      if (!node.hidden && motionEnabled(node)) node.animate(
        [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 260, delay: Math.min(entranceIndex++ * 35, 140), easing: 'ease-out', fill: 'backwards' }
      );
    }
}
showAll.addEventListener('change', () => { if (lastResult) renderResult(lastResult); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (loading || locating || resolving) return;
  closeLocationMenu();
  closeTestingMenu();
  const text = document.getElementById('text').value;
  const latitude = document.getElementById('latitude').value;
  const longitude = document.getElementById('longitude').value;
  lastResult = null; showAll.disabled = true; showAll.checked = false; heading.hidden = true; status.className = ''; output.replaceChildren();
  if (!text.trim()) { status.textContent = 'Please enter a civic issue or idea.'; return; }
  if ((latitude === '') !== (longitude === '')) { status.textContent = 'Enter both coordinates, or clear both.'; return; }
  if (addressMode && !addressSelected && (addressInput.value.trim() || latitude !== '')) { status.textContent = 'Select an address suggestion, use current location, or clear location.'; return; }
  const body = { text, bypassJevCache: document.getElementById('bypass-jev-cache').checked };
  if (latitude !== '') { body.latitude = Number(latitude); body.longitude = Number(longitude); }
  stopAddressSearch(); locationVersion++;
  loading = true; controls.disabled = true; button.disabled = true;
  button.replaceChildren(); const spinner = element('span', '', button, 'spinner'); spinner.setAttribute('aria-hidden', 'true');
  button.setAttribute('aria-label', 'Searching');
  animateSearchState();
  results.setAttribute('aria-busy', 'true'); status.textContent = 'Checking boundaries and matching actions…';
  try {
    const response = await fetch('/api/recommendables/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Matching could not complete. Please retry.');
    lastResult = result;
    renderResult(result);
  } catch (error) {
    output.replaceChildren(); heading.hidden = true; status.className = 'error'; status.textContent = error.message || 'Matching failed. Please retry.';
  } finally { loading = false; controls.disabled = false; button.textContent = 'Search'; button.setAttribute('aria-label', 'Search'); updateSubmit(); results.setAttribute('aria-busy', 'false'); animateSearchState(); }
});
</script></body></html>`;
