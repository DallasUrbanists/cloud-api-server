export type SuggestionStatus = 'new' | 'inprogress' | 'stalled' | 'withdrawn' | 'completed';

export const VALID_SUGGESTION_STATUSES: readonly SuggestionStatus[] = [
  'new',
  'inprogress',
  'stalled',
  'withdrawn',
  'completed',
] as const;

export interface SuggestionAuthor {
  email: string;
  name: string;
}

export interface SuggestionPhoto {
  url: string;
  caption: string;
  timestamp: string; // ISO 8601 string representation
}

export interface SuggestionContent {
  summary: string;
  details: string;
  photos?: SuggestionPhoto[];
}

export interface SuggestionLocation {
  latitude?: number;
  longitude?: number;
  description: string;
  address: string;
}

export interface Suggestion {
  id: number;
  creationDate: string; // ISO 8601 string representation for API responses & JSON
  modificationDate: string;
  status: SuggestionStatus;
  author: SuggestionAuthor;
  content: SuggestionContent;
  location: SuggestionLocation;
}

export interface CreateSuggestionDTO {
  id?: number;
  status?: SuggestionStatus;
  author: {
    email: string;
    name: string;
  };
  content: {
    summary: string;
    details?: string;
    photos?: SuggestionPhoto[];
  };
  location?: {
    latitude?: number;
    longitude?: number;
    description?: string;
    address?: string;
  };
}

export interface UpdateSuggestionDTO {
  status?: SuggestionStatus;
  author?: {
    email?: string;
    name?: string;
  };
  content?: {
    summary?: string;
    details?: string;
    photos?: SuggestionPhoto[];
  };
  location?: {
    latitude?: number;
    longitude?: number;
    description?: string;
    address?: string;
  };
}

/**
 * Validates an array of suggestion photos. Maximum 10 photos allowed.
 */
export function validatePhotos(photos: any): { error?: string; data?: SuggestionPhoto[] } {
  if (!Array.isArray(photos)) {
    return { error: 'content.photos must be an array.' };
  }

  if (photos.length > 10) {
    return { error: 'content.photos cannot contain more than 10 photos.' };
  }

  const validatedPhotos: SuggestionPhoto[] = [];

  for (let i = 0; i < photos.length; i++) {
    const item = photos[i];
    if (!item || typeof item !== 'object') {
      return { error: `content.photos[${i}] must be an object.` };
    }

    if (!item.url || typeof item.url !== 'string' || item.url.trim() === '') {
      return { error: `content.photos[${i}].url is required and must be a non-empty string.` };
    }

    if (item.caption !== undefined && typeof item.caption !== 'string') {
      return { error: `content.photos[${i}].caption must be a string.` };
    }

    let timestamp = new Date().toISOString();
    if (item.timestamp !== undefined) {
      if (typeof item.timestamp !== 'string' || isNaN(Date.parse(item.timestamp))) {
        return { error: `content.photos[${i}].timestamp must be a valid ISO 8601 date string.` };
      }
      timestamp = new Date(item.timestamp).toISOString();
    }

    validatedPhotos.push({
      url: item.url.trim(),
      caption: typeof item.caption === 'string' ? item.caption.trim() : '',
      timestamp,
    });
  }

  return { data: validatedPhotos };
}

/**
 * Validates input for creating a Suggestion.
 */
export function validateCreateSuggestion(body: any): { error?: string; data?: CreateSuggestionDTO } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object.' };
  }

  // Validate author
  if (!body.author || typeof body.author !== 'object') {
    return { error: 'author object is required with email and name.' };
  }
  if (!body.author.email || typeof body.author.email !== 'string' || !body.author.email.includes('@')) {
    return { error: 'author.email is required and must be a valid email address.' };
  }
  if (!body.author.name || typeof body.author.name !== 'string' || body.author.name.trim() === '') {
    return { error: 'author.name is required and must be a non-empty string.' };
  }

  // Validate content
  if (!body.content || typeof body.content !== 'object') {
    return { error: 'content object is required with at least a summary.' };
  }
  if (!body.content.summary || typeof body.content.summary !== 'string' || body.content.summary.trim() === '') {
    return { error: 'content.summary is required and must be a non-empty string.' };
  }

  let validatedPhotos: SuggestionPhoto[] | undefined = undefined;
  if (body.content.photos !== undefined) {
    const photosValidation = validatePhotos(body.content.photos);
    if (photosValidation.error) {
      return { error: photosValidation.error };
    }
    validatedPhotos = photosValidation.data;
  }

  // Validate status if provided
  if (body.status !== undefined && !VALID_SUGGESTION_STATUSES.includes(body.status)) {
    return {
      error: `Invalid status "${body.status}". Allowed values: ${VALID_SUGGESTION_STATUSES.join(', ')}`,
    };
  }

  // Validate id if provided
  if (body.id !== undefined && (!Number.isInteger(body.id) || body.id < 1)) {
    return { error: 'id must be a positive integer if provided.' };
  }

  // Validate location if provided
  if (body.location !== undefined) {
    if (typeof body.location !== 'object' || body.location === null) {
      return { error: 'location must be an object if provided.' };
    }
    if (body.location.latitude !== undefined && typeof body.location.latitude !== 'number') {
      return { error: 'location.latitude must be a number.' };
    }
    if (body.location.longitude !== undefined && typeof body.location.longitude !== 'number') {
      return { error: 'location.longitude must be a number.' };
    }
  }

  return {
    data: {
      id: body.id,
      status: body.status || 'new',
      author: {
        email: body.author.email.trim(),
        name: body.author.name.trim(),
      },
      content: {
        summary: body.content.summary.trim(),
        details: typeof body.content.details === 'string' ? body.content.details.trim() : '',
        ...(validatedPhotos !== undefined ? { photos: validatedPhotos } : {}),
      },
      location: {
        latitude: body.location?.latitude,
        longitude: body.location?.longitude,
        description: typeof body.location?.description === 'string' ? body.location.description.trim() : '',
        address: typeof body.location?.address === 'string' ? body.location.address.trim() : '',
      },
    },
  };
}

/**
 * Validates input for updating a Suggestion.
 */
export function validateUpdateSuggestion(body: any): { error?: string; data?: UpdateSuggestionDTO } {
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    return { error: 'Request body must contain at least one field to update.' };
  }

  const updateData: UpdateSuggestionDTO = {};

  // Status
  if (body.status !== undefined) {
    if (!VALID_SUGGESTION_STATUSES.includes(body.status)) {
      return {
        error: `Invalid status "${body.status}". Allowed values: ${VALID_SUGGESTION_STATUSES.join(', ')}`,
      };
    }
    updateData.status = body.status;
  }

  // Author
  if (body.author !== undefined) {
    if (typeof body.author !== 'object' || body.author === null) {
      return { error: 'author must be an object.' };
    }
    updateData.author = {};
    if (body.author.email !== undefined) {
      if (typeof body.author.email !== 'string' || !body.author.email.includes('@')) {
        return { error: 'author.email must be a valid email string.' };
      }
      updateData.author.email = body.author.email.trim();
    }
    if (body.author.name !== undefined) {
      if (typeof body.author.name !== 'string' || body.author.name.trim() === '') {
        return { error: 'author.name must be a non-empty string.' };
      }
      updateData.author.name = body.author.name.trim();
    }
  }

  // Content
  if (body.content !== undefined) {
    if (typeof body.content !== 'object' || body.content === null) {
      return { error: 'content must be an object.' };
    }
    updateData.content = {};
    if (body.content.summary !== undefined) {
      if (typeof body.content.summary !== 'string' || body.content.summary.trim() === '') {
        return { error: 'content.summary must be a non-empty string.' };
      }
      updateData.content.summary = body.content.summary.trim();
    }
    if (body.content.details !== undefined) {
      if (typeof body.content.details !== 'string') {
        return { error: 'content.details must be a string.' };
      }
      updateData.content.details = body.content.details.trim();
    }
    if (body.content.photos !== undefined) {
      const photosValidation = validatePhotos(body.content.photos);
      if (photosValidation.error) {
        return { error: photosValidation.error };
      }
      updateData.content.photos = photosValidation.data;
    }
  }

  // Location
  if (body.location !== undefined) {
    if (typeof body.location !== 'object' || body.location === null) {
      return { error: 'location must be an object.' };
    }
    updateData.location = {};
    if (body.location.latitude !== undefined) {
      if (typeof body.location.latitude !== 'number') {
        return { error: 'location.latitude must be a number.' };
      }
      updateData.location.latitude = body.location.latitude;
    }
    if (body.location.longitude !== undefined) {
      if (typeof body.location.longitude !== 'number') {
        return { error: 'location.longitude must be a number.' };
      }
      updateData.location.longitude = body.location.longitude;
    }
    if (body.location.description !== undefined) {
      if (typeof body.location.description !== 'string') {
        return { error: 'location.description must be a string.' };
      }
      updateData.location.description = body.location.description.trim();
    }
    if (body.location.address !== undefined) {
      if (typeof body.location.address !== 'string') {
        return { error: 'location.address must be a string.' };
      }
      updateData.location.address = body.location.address.trim();
    }
  }

  return { data: updateData };
}
