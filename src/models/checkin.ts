/**
 * Model interfaces for Checkin database records and API transfer objects
 */

export type EventId = number | string;

export interface Checkin {
  id: number | string;
  contact_id: number | string | null;
  event_id: EventId;
  submitted_on: Date | string;
}

export interface CreateCheckinDTO {
  contact_id?: number | string | null;
  event_id: EventId;
}

export interface UpdateCheckinDTO {
  contact_id?: number | string | null;
  event_id?: EventId;
  submitted_on?: string;
}

export interface CheckinQueryParams {
  contact_id?: string;
  event_id?: string;
  limit?: string;
  offset?: string;
}
