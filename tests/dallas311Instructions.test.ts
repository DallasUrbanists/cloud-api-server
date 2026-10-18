import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDallas311Instructions as format } from '../src/scripts/dallas311Instructions.js';
import { buildManifest, readSeedSources } from '../src/scripts/dallas311Manifest.js';

const directions = (who: string, how_formatted: string, what = 'Call') => ({ who, how_formatted, what });

test('shelter instructions incorporate the recipient naturally', () => {
  assert.equal(format(directions('Dallas Animal Services', 'Bring the animal to the shelter at 1818 N Westmoreland Rd during normal business hours', 'Bring animal to shelter')),
    'Bring the animal to the Dallas Animal Services shelter at 1818 N Westmoreland Rd during normal business hours.');
});

test('website directions retain menu paths and name the responsible department in prose', () => {
  const text = format(directions('Transportation and Public Works Department', '[Go to Dallas 311](https://dallascrm.my.site.com/public/s/) > Choose "Streets" > Choose "Street Repair"', 'Submit 311 request'));
  assert.equal(text, '1. Open [Dallas 311](https://dallascrm.my.site.com/public/s/) to submit a request to the Transportation and Public Works Department.\n2. Choose "Streets".\n3. Choose "Street Repair".');
  assert.match(format(directions('Dallas Animal Services', '[Go to Dallas 311](https://dallascrm.my.site.com/public/s/) > Choose "Animal Owner Surrender"', 'View 311 guidance')), /read guidance from Dallas Animal Services/);
});

test('phone and email directions retain exact links and distinguish an indirect 311 contact', () => {
  assert.equal(format(directions('Dallas 311', 'Call [311](tel:311)')), 'Call Dallas 311 at [311](tel:311).');
  assert.equal(format(directions('911 emergency dispatch', 'Call [911](tel:911)')), 'Call emergency dispatch at [911](tel:911).');
  assert.equal(format(directions('Dallas Water Utilities', 'Call [311](tel:311)')), 'Call [311](tel:311) to contact Dallas Water Utilities.');
  assert.equal(format(directions('Dallas Fire-Rescue', 'Email [dfrshowandtell@dallasfire.gov](mailto:dfrshowandtell@dallasfire.gov)')), 'Email Dallas Fire-Rescue at [dfrshowandtell@dallasfire.gov](mailto:dfrshowandtell@dallasfire.gov).');
  assert.equal(format(directions('Dallas Water Utilities', 'Call [214-651-1441](tel:2146511441) Monday through Friday from 8:00 a.m. to 5:00 p.m.')), 'Call Dallas Water Utilities at [214-651-1441](tel:2146511441) Monday through Friday from 8:00 a.m. to 5:00 p.m.');
});

test('directions already naming the recipient avoid repetition; resident actions do not add an artificial recipient', () => {
  assert.equal(format(directions('Public Works', 'Call [311](tel:311) and report the tree to Public Works')), 'Call [311](tel:311) and report the tree to Public Works.');
  assert.equal(format(directions('Resident', 'Move the cart to the parkway, the grassy area between the street and sidewalk')), 'Move the cart to the parkway, the grassy area between the street and sidewalk.');
  assert.equal(format(directions('Dallas Public Library', 'Visit [www.dallaslibrary.org](https://www.dallaslibrary.org)')), 'Visit [www.dallaslibrary.org](https://www.dallaslibrary.org), the Dallas Public Library website.');
});

test('all generated directions have punctuation, no recipient suffix, and preserve captured destinations', async () => {
  const manifest = buildManifest(await readSeedSources());
  for (const entry of manifest.entries) {
    assert.doesNotMatch(entry.input.instructions, /Responsible recipient:/);
    assert.match(entry.input.instructions, /[.!?]$/);
    const source = entry.members.find(member => member.id === entry.primaryMemberId)!.originalAction.how_formatted;
    const links = [...source.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
    for (const link of links) assert.ok(entry.input.instructions.includes(`](${link})`), `${entry.key}: lost destination ${link}`);
    assert.ok(!entry.input.instructions.includes('..'), `${entry.key}: repeated punctuation`);
  }
});
