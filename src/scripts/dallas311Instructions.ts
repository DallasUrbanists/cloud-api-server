/** Formats captured directions as prose without adding destinations or eligibility rules. */
export interface Dallas311Directions { who: string; what: string; how_formatted: string }

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function recipient(value: string): string {
  const name = value.trim().replace(/\/311$/, ' (311)');
  if (/^(?:911\s+)?emergency dispatch$/i.test(name)) return 'emergency dispatch';
  if (/^(?:the\s+|a\s+|an\s+)/i.test(name)) return name;
  if (/^Office of\b/i.test(name) || /Department$/i.test(name) || /^(?:City Attorney|Library|Coyote Hotline|Property manager)$/i.test(name)) return `the ${name}`;
  return name;
}

export function formatDallas311Instructions(action: Dallas311Directions): string {
  let text = action.how_formatted.trim();
  const who = recipient(action.who);
  const plainWho = who.replace(/^the /i, '');
  const parts = text.split(/\s+>\s+/);
  if (/^\[Go to Dallas 311\]\(/.test(parts[0])) {
    const link = parts[0].replace('[Go to Dallas 311]', '[Dallas 311]');
    const purpose = action.what === 'Submit 311 request' ? 'submit a request to' : 'read guidance from';
    return [`Open ${link} to ${purpose} ${who}`, ...parts.slice(1)]
      .map((step, index) => `${index + 1}. ${sentence(step)}`).join('\n');
  }

  if (/^Bring the animal to the shelter\b/.test(text)) {
    return sentence(text.replace('to the shelter', `to the ${plainWho} shelter`));
  }
  if (/^Visit DallasCityHall\.com\/Sanitation and choose Contact Us online or by phone$/i.test(text)) {
    return `Contact ${who} online or by phone using the "Contact Us" option at DallasCityHall.com/Sanitation.`;
  }
  if (/^Take brush or bulk items to McCommas Bluff Landfill\b/.test(text)) {
    return sentence(`To use ${who}’s self-transport service, ${text[0].toLowerCase()}${text.slice(1)}`);
  }
  if (/^Pick up a sign\b/.test(text) && action.who === 'City of Dallas') {
    return sentence(text.replace('Pick up a sign', 'Pick up a City of Dallas sign'));
  }
  if (/^Contact the relevant company$/i.test(text)) return sentence(`Contact ${who}`);
  if (/^Submit the \[Sanitation Alley to Curb form\]\([^)]+\) or email /i.test(text)) {
    return sentence(text.replace(/(\]\([^)]+\)) or email /, `$1 to ${who}, or email `));
  }
  if (/^Use the "Click Here" link for additional information in the Interagency Projects service description$/i.test(text)) {
    return `For more information from ${who}, use the "Click Here" link in the Interagency Projects service description.`;
  }
  if (/^Visit \[Article X\]\([^)]+\) for more information$/i.test(text) && action.who === 'Dallas City Code') {
    return sentence(text.replace(/^Visit /, 'Read ').replace(' for more information', ' of the Dallas City Code for more information'));
  }

  // A recipient already named in the captured sentence needs only punctuation.
  if (text.toLowerCase().includes(plainWho.toLowerCase()) || /^(?:Resident|Requestor|Requester)$/i.test(action.who)) return sentence(text);
  if (/^Call \[/.test(text)) {
    if (/^(?:311|811|911)$/.test(action.who)) return sentence(text);
    if (/^Call \[311\]\(tel:311\)/.test(text) && action.who !== 'Dallas 311') {
      return sentence(text.replace(/^(Call \[311\]\(tel:311\))/, `$1 to contact ${who}`));
    }
    return sentence(text.replace(/^Call /, `Call ${who} at `));
  }
  if (/^Email \[/.test(text)) return sentence(text.replace(/^Email /, `Email ${who} at `));
  if (/^Visit \[[^\]]+\]\([^)]+\)$/.test(text)) return sentence(`${text}, the ${plainWho} website`);
  if (/^(?:Visit|Use|Read|Review|View)\b/i.test(text)) return sentence(`For information from ${who}, ${text[0].toLowerCase()}${text.slice(1)}`);
  if (/^(?:Call|Contact|Email|Connect)\b/i.test(text)) return sentence(`To contact ${who}, ${text[0].toLowerCase()}${text.slice(1)}`);
  return sentence(text);
}
