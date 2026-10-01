/**
 * Model interfaces for Checkin database records and API transfer objects
 */

export interface Checkin {
  id: number | string;
  contact_id: number | string | null;
  event_id: string;
  submitted_on: Date | string;
}

export interface CreateCheckinDTO {
  contact_id?: number | string | null;
  event_id: string;
  submitted_on?: Date | string;
}

export interface UpdateCheckinDTO {
  contact_id?: number | string | null;
  event_id?: string;
  submitted_on?: Date | string;
}

export interface CheckinQueryParams {
  contact_id?: string;
  event_id?: string;
  limit?: string;
  offset?: string;
}
