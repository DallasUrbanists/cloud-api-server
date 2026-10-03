export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '*'.repeat(Math.max(1, email.length));

  const handle = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedHandle = `${handle[0]}***`;
  const labels = domain.split('.');
  const maskedDomain = labels.map((label, index) => {
    if (index === labels.length - 1) return label;
    return label.length <= 1 ? label : `${label[0]}***`;
  }).join('.');

  return `${maskedHandle}@${maskedDomain}`;
}

export function redactPhone(phone: string): string {
  let digitIndex = 0;
  const digits = Array.from(phone).filter((character) => /\d/.test(character));
  return Array.from(phone).map((character) => {
    if (!/\d/.test(character)) return character;
    const replacement = digitIndex >= digits.length - 2 ? character : '*';
    digitIndex += 1;
    return replacement;
  }).join('');
}

export function redactZip(zip: string): string {
  const digits = zip.replace(/\D/g, '');
  if (digits.length <= 2) return zip;
  let digitIndex = 0;
  return Array.from(zip).map((character) => {
    if (!/\d/.test(character)) return character;
    const replacement = digitIndex >= digits.length - 2 ? character : '*';
    digitIndex += 1;
    return replacement;
  }).join('');
}

export function abbreviateName(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).map((word) => word[0]).join('');
}
