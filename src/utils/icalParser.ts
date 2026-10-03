import { CreateEventDTO } from '../models/event.js';

/**
 * Unescapes RFC 5545 text value special characters.
 */
export function unescapeICalText(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Parses iCalendar date / datetime strings into ISO Date objects, recognizing UTC, local, and all-day formats.
 */
export function parseICalDateTime(
  value: string,
  params: Record<string, string> = {}
): { date: Date | null; allDay: boolean; timezone?: string } {
  const trimmed = value.trim();
  const isDateValue = params.VALUE === 'DATE' || /^\d{8}$/.test(trimmed);
  const tzid = params.TZID;

  // Format 1: All-day date YYYYMMDD
  if (isDateValue || /^\d{8}$/.test(trimmed)) {
    const match = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const day = parseInt(match[3], 10);
      return {
        date: new Date(Date.UTC(year, month, day, 0, 0, 0)),
        allDay: true,
        timezone: tzid,
      };
    }
  }

  // Format 2: Datetime YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  const dtMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i);
  if (dtMatch) {
    const year = parseInt(dtMatch[1], 10);
    const month = parseInt(dtMatch[2], 10) - 1;
    const day = parseInt(dtMatch[3], 10);
    const hours = parseInt(dtMatch[4], 10);
    const minutes = parseInt(dtMatch[5], 10);
    const seconds = parseInt(dtMatch[6], 10);
    const isUtc = Boolean(dtMatch[7]);

    if (isUtc) {
      return {
        date: new Date(Date.UTC(year, month, day, hours, minutes, seconds)),
        allDay: false,
        timezone: 'UTC',
      };
    }

    // Floating or TZID specified
    return {
      date: new Date(Date.UTC(year, month, day, hours, minutes, seconds)),
      allDay: false,
      timezone: tzid,
    };
  }

  // Fallback to standard JS Date parsing
  const fallbackDate = new Date(trimmed);
  if (!isNaN(fallbackDate.getTime())) {
    return {
      date: fallbackDate,
      allDay: false,
      timezone: tzid,
    };
  }

  return { date: null, allDay: false, timezone: tzid };
}

/**
 * Parses raw iCalendar text into an array of CreateEventDTO objects.
 */
export function parseICalToEvents(
  rawIcs: string,
  options: { is_hosted_by_du?: boolean } = {}
): CreateEventDTO[] {
  const events: CreateEventDTO[] = [];

  // Normalize line endings and unfold lines per RFC 5545 Section 3.1
  const normalized = rawIcs.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const unfolded = normalized.replace(/\n[ \t]/g, '');

  // Extract VEVENT sections
  const veventRegex = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let match: RegExpExecArray | null;

  while ((match = veventRegex.exec(unfolded)) !== null) {
    const eventBody = match[1];
    const rawVEvent = `BEGIN:VEVENT${eventBody}END:VEVENT`;
    const lines = eventBody.split('\n').map((l) => l.trim()).filter(Boolean);

    const props: Record<string, { value: string; params: Record<string, string> }[]> = {};

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const left = line.slice(0, colonIndex);
      const value = line.slice(colonIndex + 1);

      const semiIndex = left.indexOf(';');
      let propName = left;
      const params: Record<string, string> = {};

      if (semiIndex !== -1) {
        propName = left.slice(0, semiIndex).toUpperCase();
        const paramStr = left.slice(semiIndex + 1);
        const paramPairs = paramStr.split(';');
        for (const pair of paramPairs) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx !== -1) {
            const pKey = pair.slice(0, eqIdx).trim().toUpperCase();
            let pVal = pair.slice(eqIdx + 1).trim();
            if (pVal.startsWith('"') && pVal.endsWith('"')) {
              pVal = pVal.slice(1, -1);
            }
            params[pKey] = pVal;
          }
        }
      } else {
        propName = propName.toUpperCase();
      }

      if (!props[propName]) {
        props[propName] = [];
      }
      props[propName].push({ value, params });
    }

    const getFirst = (key: string) => props[key]?.[0];

    const uidProp = getFirst('UID');
    if (!uidProp || !uidProp.value.trim()) {
      // UID is mandatory in RFC 5545 and in our DB schema
      continue;
    }
    const uid = uidProp.value.trim();

    // Parse DTSTART
    const dtstartProp = getFirst('DTSTART');
    if (!dtstartProp) {
      continue;
    }
    const startParsed = parseICalDateTime(dtstartProp.value, dtstartProp.params);
    if (!startParsed.date) {
      continue;
    }
    const startAt = startParsed.date;
    const allDay = startParsed.allDay;
    const timezone = startParsed.timezone || null;

    // Parse DTEND or DURATION
    const dtendProp = getFirst('DTEND');
    const durationProp = getFirst('DURATION');

    let endAt: Date | null = null;
    let duration: string | null = null;

    if (dtendProp) {
      const endParsed = parseICalDateTime(dtendProp.value, dtendProp.params);
      if (endParsed.date) {
        endAt = endParsed.date;
      }
    }

    if (!endAt && durationProp && durationProp.value.trim()) {
      duration = durationProp.value.trim();
    }

    // Ensure CHECK constraint: (end_at IS NOT NULL OR duration IS NOT NULL) AND NOT both
    if (!endAt && !duration) {
      if (allDay) {
        // Default all-day event to 1 day duration
        duration = 'P1D';
      } else {
        // Default timed event to 1 hour duration
        duration = 'PT1H';
      }
    } else if (endAt && duration) {
      // If both present, prioritize end_at and clear duration to satisfy NOT (end_at IS NOT NULL AND duration IS NOT NULL)
      duration = null;
    }

    // Title / Summary
    const summaryProp = getFirst('SUMMARY');
    const title = summaryProp ? unescapeICalText(summaryProp.value) : null;

    // Description
    const descProp = getFirst('DESCRIPTION');
    const description = descProp ? unescapeICalText(descProp.value) : null;

    // Location
    const locProp = getFirst('LOCATION');
    const location = locProp ? unescapeICalText(locProp.value) : null;

    // URL
    const urlProp = getFirst('URL');
    const url = urlProp ? urlProp.value.trim() : null;

    // Status
    const statusProp = getFirst('STATUS');
    const status = statusProp ? statusProp.value.trim().toUpperCase() : null;

    // Classification
    const classProp = getFirst('CLASS');
    const classification = classProp ? classProp.value.trim().toUpperCase() : null;

    // Sequence
    const seqProp = getFirst('SEQUENCE');
    const sequence = seqProp ? parseInt(seqProp.value, 10) || 0 : 0;

    // Organizer
    const orgProp = getFirst('ORGANIZER');
    let organizerName: string | null = null;
    let organizerEmail: string | null = null;
    if (orgProp) {
      if (orgProp.params.CN) {
        organizerName = unescapeICalText(orgProp.params.CN);
      }
      const rawOrgVal = orgProp.value.trim();
      if (rawOrgVal.toLowerCase().startsWith('mailto:')) {
        organizerEmail = rawOrgVal.slice(7).trim();
      } else if (rawOrgVal) {
        organizerEmail = rawOrgVal;
      }
    }

    // Recurrence Rule & ID
    const rruleProp = getFirst('RRULE');
    const recurrenceRule = rruleProp ? rruleProp.value.trim() : null;

    const recurIdProp = getFirst('RECURRENCE-ID');
    let recurrenceId: Date | null = null;
    if (recurIdProp) {
      const recParsed = parseICalDateTime(recurIdProp.value, recurIdProp.params);
      recurrenceId = recParsed.date;
    }

    // Categories
    let categories: string[] | null = null;
    if (props.CATEGORIES && props.CATEGORIES.length > 0) {
      const allCats: string[] = [];
      for (const cat of props.CATEGORIES) {
        const parts = cat.value.split(',').map((p) => unescapeICalText(p.trim())).filter(Boolean);
        allCats.push(...parts);
      }
      if (allCats.length > 0) {
        categories = allCats;
      }
    }

    // Resources
    let resources: string[] | null = null;
    if (props.RESOURCES && props.RESOURCES.length > 0) {
      const allRes: string[] = [];
      for (const res of props.RESOURCES) {
        const parts = res.value.split(',').map((p) => unescapeICalText(p.trim())).filter(Boolean);
        allRes.push(...parts);
      }
      if (allRes.length > 0) {
        resources = allRes;
      }
    }

    // Attachments & Image
    let img: string | null = null;
    const attachmentsList: Array<{ url: string; mimeType?: string; title?: string }> = [];

    if (props.ATTACH) {
      for (const att of props.ATTACH) {
        const attUrl = att.value.trim();
        const mimeType = att.params.FMTTYPE;
        if (attUrl) {
          attachmentsList.push({ url: attUrl, mimeType });
          if (!img && (mimeType?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(attUrl))) {
            img = attUrl;
          }
        }
      }
    }

    const imageProp = getFirst('IMAGE') || getFirst('X-IMAGE-URL');
    if (imageProp && imageProp.value.trim()) {
      img = imageProp.value.trim();
    }

    // Geo coordinates (GEO:latitude;longitude)
    const geoProp = getFirst('GEO');
    let geoLatitude: number | null = null;
    let geoLongitude: number | null = null;
    if (geoProp) {
      const [latStr, lonStr] = geoProp.value.split(';');
      if (latStr && lonStr) {
        const parsedLat = parseFloat(latStr.trim());
        const parsedLon = parseFloat(lonStr.trim());
        if (!isNaN(parsedLat) && !isNaN(parsedLon)) {
          geoLatitude = parsedLat;
          geoLongitude = parsedLon;
        }
      }
    }

    // Timestamps
    const dtstampProp = getFirst('DTSTAMP');
    let icalDtstamp: Date | null = null;
    if (dtstampProp) {
      const dtParsed = parseICalDateTime(dtstampProp.value, dtstampProp.params);
      icalDtstamp = dtParsed.date;
    }

    const createdProp = getFirst('CREATED');
    let icalCreated: Date | null = null;
    if (createdProp) {
      const crParsed = parseICalDateTime(createdProp.value, createdProp.params);
      icalCreated = crParsed.date;
    }

    const lastModProp = getFirst('LAST-MODIFIED');
    let icalLastModified: Date | null = null;
    if (lastModProp) {
      const lmParsed = parseICalDateTime(lastModProp.value, lastModProp.params);
      icalLastModified = lmParsed.date;
    }

    const isHostedByDu =
      options.is_hosted_by_du !== undefined ? options.is_hosted_by_du : true;

    events.push({
      uid,
      start_at: startAt,
      end_at: endAt,
      duration,
      all_day: allDay,
      timezone,
      title,
      description,
      location,
      url,
      status,
      img,
      classification,
      sequence,
      organizer_name: organizerName,
      organizer_email: organizerEmail,
      recurrence_rule: recurrenceRule,
      recurrence_id: recurrenceId,
      categories,
      resources,
      attachments: attachmentsList.length > 0 ? attachmentsList : null,
      geo_latitude: geoLatitude,
      geo_longitude: geoLongitude,
      is_hosted_by_du: isHostedByDu,
      ical_raw: rawVEvent,
      ical_dtstamp: icalDtstamp || new Date(),
      ical_created: icalCreated,
      ical_last_modified: icalLastModified,
    });
  }

  return events;
}
