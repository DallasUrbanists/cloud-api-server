/** Shared sample-picker markup and browser behavior for the public playgrounds. @module */
import { recommendableMockDescriptions } from '../data/recommendableMockDescriptions.js';

/** Toolbar controls shared by the suggestion and action-search editors. */
export const descriptionSampleButtons = `<button id="random-description" type="button"><span aria-hidden="true">↻</span><span class="toolbar-label"> Randomize</span></button><button id="choose-sample" type="button" aria-haspopup="dialog"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><span class="toolbar-label">Choose sample...</span></button>`;

/** Searchable, text-only sample dialog used by both playgrounds. */
export const descriptionSampleDialog = `<dialog id="sample-dialog" aria-labelledby="sample-heading"><div class="dialog-header"><h2 id="sample-heading">Choose a sample</h2><button id="close-samples" class="secondary-button" type="button" aria-label="Close sample browser">Close</button></div><label for="sample-filter">Filter scenarios</label><input id="sample-filter" type="search" placeholder="Search samples…"><small id="sample-count" role="status"></small><ul id="sample-list" class="sample-list"></ul></dialog>`;

/** Inline browser helper; embeds the shared sample catalog with script-safe escaping. */
export const descriptionSamplesScript = String.raw`
function setupDescriptionSamples(textarea, onChange) {
  const mockDescriptions = ${JSON.stringify(recommendableMockDescriptions).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)};
  const sampleDialog = document.getElementById('sample-dialog');
  const sampleFilter = document.getElementById('sample-filter');
  const sampleList = document.getElementById('sample-list');
  const sampleCount = document.getElementById('sample-count');
  const canAnimate = node => typeof node.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let descriptionTransition, dialogTransition;
  function resize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.max(110, textarea.scrollHeight + 2) + 'px';
  }
  function stopTransition() { descriptionTransition?.cancel(); descriptionTransition = undefined; }
  function set(text) { stopTransition(); textarea.value = text; resize(); onChange(); }
  textarea.addEventListener('input', () => { stopTransition(); resize(); onChange(); });
  window.addEventListener('resize', resize);
  document.getElementById('random-description').addEventListener('click', () => {
    stopTransition();
    const oldHeight = textarea.getBoundingClientRect().height;
    set(mockDescriptions[Math.floor(Math.random() * mockDescriptions.length)]);
    if (!canAnimate(textarea)) return;
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
    const query = sampleFilter.value.trim().toLowerCase();
    sampleList.replaceChildren();
    const samples = mockDescriptions.filter(text => text.toLowerCase().includes(query));
    sampleCount.textContent = samples.length + (samples.length === 1 ? ' scenario' : ' scenarios');
    for (const text of samples) {
      const item = document.createElement('li');
      const choice = document.createElement('button');
      choice.type = 'button'; choice.textContent = text;
      choice.addEventListener('click', () => { set(text); close(true); });
      item.append(choice); sampleList.append(item);
    }
    if (!samples.length) {
      const empty = document.createElement('li'); empty.textContent = 'No scenarios match your filter.'; sampleList.append(empty);
    }
  }
  function open() {
    dialogTransition?.cancel(); renderSamples();
    if (!sampleDialog.open) sampleDialog.showModal();
    if (canAnimate(sampleDialog)) {
      dialogTransition = sampleDialog.animate([{ opacity: 0, transform: 'translateY(12px) scale(.98)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 200, easing: 'ease-out' });
      dialogTransition.finished.catch(() => {});
    }
    sampleFilter.focus();
  }
  function close(focusDescription = false) {
    if (!sampleDialog.open) return;
    dialogTransition?.cancel();
    const finish = () => { sampleDialog.close(); if (focusDescription) textarea.focus(); };
    if (!canAnimate(sampleDialog)) { finish(); return; }
    const animation = sampleDialog.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(8px) scale(.98)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
    dialogTransition = animation;
    animation.finished.then(() => { if (dialogTransition === animation) { finish(); animation.cancel(); dialogTransition = undefined; } }, () => {});
  }
  function dismiss() { dialogTransition?.cancel(); if (sampleDialog.open) sampleDialog.close(); }
  document.getElementById('choose-sample').addEventListener('click', open);
  sampleFilter.addEventListener('input', renderSamples);
  document.getElementById('close-samples').addEventListener('click', () => close());
  sampleDialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return { resize, set, dismiss };
}
`;
