/**
 * Model interfaces for Event database records and API transfer objects
 */

export interface Event {
  id: number | string;
  uid: string;

  start_at: Date | string;
  end_at: Date | string | null;
  duration: string | null;
  all_day: boolean;
  timezone: string | null;

  title: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  status: string | null;
  img: string | null;
  classification: string | null;
  sequence: number;

  organizer_name: string | null;
  organizer_email: string | null;

  recurrence_rule: string | null;
  recurrence_id: Date | string | null;

  categories: string[] | null;
  resources: string[] | null;
  attachments: Record<string, unknown> | Array<unknown> | null;

  geo_latitude: number | string | null;
  geo_longitude: number | string | null;

  is_hosted_by_du: boolean;

  ical_raw: string | null;
  ical_dtstamp: Date | string;
  ical_created: Date | string | null;
  ical_last_modified: Date | string | null;

  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateEventDTO {
  uid: string;

  start_at: Date | string;
  end_at?: Date | string | null;
  duration?: string | null;
  all_day?: boolean;
  timezone?: string | null;

  title?: string | null;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  status?: string | null;
  img?: string | null;
  classification?: string | null;
  sequence?: number;

  organizer_name?: string | null;
  organizer_email?: string | null;

  recurrence_rule?: string | null;
  recurrence_id?: Date | string | null;

  categories?: string[] | null;
  resources?: string[] | null;
  attachments?: Record<string, unknown> | Array<unknown> | null;

  geo_latitude?: number | string | null;
  geo_longitude?: number | string | null;

  is_hosted_by_du?: boolean;

  ical_raw?: string | null;
  ical_dtstamp?: Date | string | null;
  ical_created?: Date | string | null;
  ical_last_modified?: Date | string | null;
}

export interface UpdateEventDTO {
  uid?: string;

  start_at?: Date | string;
  end_at?: Date | string | null;
  duration?: string | null;
  all_day?: boolean;
  timezone?: string | null;

  title?: string | null;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  status?: string | null;
  img?: string | null;
  classification?: string | null;
  sequence?: number;

  organizer_name?: string | null;
  organizer_email?: string | null;

  recurrence_rule?: string | null;
  recurrence_id?: Date | string | null;

  categories?: string[] | null;
  resources?: string[] | null;
  attachments?: Record<string, unknown> | Array<unknown> | null;

  geo_latitude?: number | string | null;
  geo_longitude?: number | string | null;

  is_hosted_by_du?: boolean;

  ical_raw?: string | null;
  ical_dtstamp?: Date | string | null;
  ical_created?: Date | string | null;
  ical_last_modified?: Date | string | null;
}

export interface EventQueryParams {
  status?: string;
  is_hosted_by_du?: string;
  start_after?: string;
  start_before?: string;
  category?: string;
  search?: string;
  limit?: string;
  offset?: string;
  order?: 'asc' | 'desc';
}

export interface ImportICalDTO {
  url?: string;
  is_hosted_by_du?: boolean;
  force?: boolean;
}

export interface ImportICalItemResult {
  uid: string;
  title: string | null;
  action: 'created' | 'updated' | 'skipped' | 'error';
  reason?: string;
  id?: number | string;
}

export interface ImportICalResult {
  sourceUrl: string;
  totalFound: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  items: ImportICalItemResult[];
}
