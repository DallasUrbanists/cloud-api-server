import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { pool } from '../config/db.js';
import { hasRole } from '../middleware/auth.js';
import { getPublicImprovementsDb } from '../config/firestore.js';

// Interface for Contact in the PostgreSQL DB matching table schema
export interface Contact {
  id: number | string;
  name: string;
  created_on: Date | string;
  emails: string[] | null;
  phones: string[] | null;
  zip_home: string | null;
  zip_other: string[] | null;
  roles: string[] | null;
  firebase_uid: string | null;
}

// Interface for API Request Payloads
export interface ContactRequestBody {
  name?: string;
  emails?: string[];
  phones?: string[];
  zip_home?: string;
  zip_other?: string[];
  roles?: string[];
  firebase_uid?: string | null;
}

/**
 * Normalizes contact name to uppercase.
 */
export function normalizeName(name: string): string {
  return name.trim().toUpperCase();
}

/**
 * Normalizes email address to lowercase.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normalizes phone numbers into standardized format (+1-XXX-XXX-XXXX for 10/11-digit NANP).
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length > 11 && trimmed.startsWith('+')) {
    return `+${digits}`;
  }
  return trimmed;
}

function parseArrayField(field: unknown, normalizer?: (val: string) => string): string[] | null {
  if (Array.isArray(field)) {
    const cleaned = field
      .map((item) => String(item).trim())
      .filter(Boolean)
      .map((item) => (normalizer ? normalizer(item) : item));
    return cleaned.length > 0 ? cleaned : null;
  }
  if (typeof field === 'string' && field.trim() !== '') {
    const trimmed = field.trim();
    return normalizer ? [normalizer(trimmed)] : [trimmed];
  }
  return null;
}

function abbreviation(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).map((word) => word[0]).join('');
}

function redactContact(contact: Contact, query: { name?: string; email?: string; phone?: string; zip?: string }): Contact {
  const nameTerms = (query.name || '').trim().split(/\s+/).filter(Boolean).map(normalizeName);
  const visibleName = contact.name.split(/\s+/).map((word) => {
    const matched = nameTerms.some((term) => term.length >= 2 && word.startsWith(term));
    return matched ? word : `${word.charAt(0)}.`;
  }).join(' ');
  const exactEmail = query.email ? normalizeEmail(query.email) : undefined;
  const exactPhone = query.phone ? normalizePhone(query.phone) : undefined;
  const exactZip = query.zip?.trim();

  return {
    ...contact,
    name: visibleName,
    emails: exactEmail ? (contact.emails || []).filter((value) => value === exactEmail) : null,
    phones: exactPhone ? (contact.phones || []).filter((value) => value === exactPhone) : null,
    zip_home: exactZip && contact.zip_home === exactZip ? contact.zip_home : null,
    zip_other: exactZip ? (contact.zip_other || []).filter((value) => value === exactZip) : null,
    roles: null,
    firebase_uid: null,
  };
}

function redactContactById(contact: Contact): Contact {
  return {
    ...contact,
    name: abbreviation(contact.name),
    emails: null,
    phones: null,
    zip_home: null,
    zip_other: null,
    roles: null,
    firebase_uid: null,
  };
}

async function canAccessContact(id: number, req: Request): Promise<boolean> {
  if (hasRole(req, 'staff')) return true;
  if (!req.user) return false;
  const result = await pool.query<{ firebase_uid: string | null }>('SELECT firebase_uid FROM contacts WHERE id = $1', [id]);
  return result.rows[0]?.firebase_uid === req.user.uid;
}

interface ChallengeState { failures: number; banUntil: number; durationMinutes: number; }
function requestorCookie(req: Request, res: Response): string {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('contact_challenge='))?.split('=')[1];
  const value = cookie || crypto.randomUUID();
  if (!cookie) res.append('Set-Cookie', `contact_challenge=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return value;
}

export class ContactController {
  // -----------------------------------------------------------------
  // 1. CREATE (POST /api/contacts)
  // -----------------------------------------------------------------
  static async createContact(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { name, emails, phones, zip_home, zip_other, roles } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'name is required and must be a non-empty string.',
      });
      return;
    }

    const normalizedName = normalizeName(name);
    const formattedEmails = parseArrayField(emails, normalizeEmail);
    const formattedPhones = parseArrayField(phones, normalizePhone);
    const formattedZipOther = parseArrayField(zip_other);
    const formattedRoles = parseArrayField(roles);
    const formattedZipHome = typeof zip_home === 'string' && zip_home.trim() !== '' ? zip_home.trim() : null;

    try {
      const duplicateConditions: string[] = ['name ILIKE $1'];
      const duplicateValues: any[] = [`%${normalizedName}%`];
      let duplicateIndex = 2;
      if (formattedEmails?.[0]) { duplicateConditions.push(`EXISTS (SELECT 1 FROM unnest(emails) AS e WHERE e = $${duplicateIndex++})`); duplicateValues.push(formattedEmails[0]); }
      if (formattedPhones?.[0]) { duplicateConditions.push(`EXISTS (SELECT 1 FROM unnest(phones) AS p WHERE p = $${duplicateIndex++})`); duplicateValues.push(formattedPhones[0]); }
      if (formattedZipHome) { duplicateConditions.push(`(zip_home = $${duplicateIndex++} OR EXISTS (SELECT 1 FROM unnest(zip_other) AS z WHERE z = $${duplicateIndex - 1}))`); duplicateValues.push(formattedZipHome); }
      if (formattedZipOther?.[0]) { duplicateConditions.push(`EXISTS (SELECT 1 FROM unnest(zip_other) AS z WHERE z = $${duplicateIndex++})`); duplicateValues.push(formattedZipOther[0]); }
      const duplicateResult = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM contacts WHERE ${duplicateConditions.join(' AND ')}`, duplicateValues);
      const duplicateCount = Number(duplicateResult.rows[0]?.count || 0);
      if (duplicateCount > 0) {
        const requestor = requestorCookie(req, res);
        const challengeRef = getPublicImprovementsDb().collection('contact_challenges').doc(requestor);
        const challengeSnapshot = await challengeRef.get();
        const state: ChallengeState = (challengeSnapshot.data() as ChallengeState | undefined) || { failures: 0, banUntil: 0, durationMinutes: 5 };
        if (state.banUntil > Date.now()) { res.status(429).json({ error: 'Too Many Requests', message: 'Contact creation is temporarily blocked. Please try again later.' }); return; }
        const answer = Number(req.body?.challenge_answer);
        if (!Number.isInteger(answer)) { res.status(409).json({ error: 'Challenge Required', message: 'A challenge answer is required to continue.', challenge_question: 'How many existing contacts match this information?', match_count: duplicateCount }); return; }
        if (answer !== duplicateCount) {
          state.failures += 1;
          if (state.failures >= 3) { state.banUntil = Date.now() + state.durationMinutes * 60_000; state.durationMinutes += 5; state.failures = 0; }
          await challengeRef.set(state);
          const remaining = Math.max(0, 3 - state.failures);
          res.status(409).json({ error: 'Challenge Failed', message: `The challenge answer was incorrect. You have ${remaining} remaining attempts.` });
          return;
        }
        await challengeRef.set({ failures: 0, banUntil: 0, durationMinutes: 5 });
      }
      const query = `
        INSERT INTO contacts (name, emails, phones, zip_home, zip_other, roles)
        VALUES ($1, $2, $3, $4, $5, $6) 
        RETURNING *;
      `;
      const values = [
        normalizedName,
        formattedEmails,
        formattedPhones,
        formattedZipHome,
        formattedZipOther,
        formattedRoles,
      ];
      const result = await pool.query<Contact>(query, values);

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Error inserting contact:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while creating contact.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 2. READ (GET /api/contacts or GET /api/contacts/:id)
  // -----------------------------------------------------------------
  // Get all contacts
  static async getAllContacts(req: Request, res: Response, next: NextFunction): Promise<void> {
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : undefined;
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : undefined;
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : undefined;
    const zip = typeof req.query.zip === 'string' ? req.query.zip.trim() : undefined;
    const isStaff = hasRole(req, 'staff');

    if (!isStaff && !name && !email && !phone && !zip) {
      res.status(400).json({ error: 'Bad Request', message: 'At least one search term is required.' });
      return;
    }

    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      if (name) { conditions.push(`name ILIKE $${paramIndex++}`); values.push(`%${normalizeName(name)}%`); }
      if (email) { conditions.push(`EXISTS (SELECT 1 FROM unnest(emails) AS e WHERE e = $${paramIndex++})`); values.push(normalizeEmail(email)); }
      if (phone) { conditions.push(`EXISTS (SELECT 1 FROM unnest(phones) AS p WHERE p = $${paramIndex++})`); values.push(normalizePhone(phone)); }
      if (zip) { conditions.push(`(zip_home = $${paramIndex} OR EXISTS (SELECT 1 FROM unnest(zip_other) AS z WHERE z = $${paramIndex}))`); values.push(zip); paramIndex++; }

      let query = `SELECT * FROM contacts${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC`;
      if (isStaff && req.query.limit) {
        const limit = parseInt(String(req.query.limit), 10);
        if (!Number.isInteger(limit) || limit < 1) { res.status(400).json({ error: 'Bad Request', message: 'limit parameter must be a positive integer.' }); return; }
        query += ` LIMIT $${paramIndex++}`; values.push(limit);
      }
      const result = await pool.query<Contact>(query, values);
      if (!isStaff && result.rows.length > 3) {
        res.status(400).json({ error: 'Bad Request', message: 'Your search is too broad. Please try again with more details.' });
        return;
      }
      res.status(200).json(isStaff ? result.rows : result.rows.map((contact) => redactContact(contact, { name, email, phone, zip })));
    } catch (error) {
      console.error('Error fetching contacts:', error);
      res.status(500).json({ error: 'Internal Server Error', message: 'An unexpected error occurred while fetching contacts.' });
    }
  }

  // Get single contact by ID
  static async getContactById(req: Request, res: Response, next: NextFunction): Promise<void> {
    const id = req.params.id as string;
    const parsedId = parseInt(id, 10);

    if (isNaN(parsedId) || parsedId < 1) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid contact ID. Must be a positive integer.',
      });
      return;
    }

    try {
      const result = await pool.query<Contact>('SELECT * FROM contacts WHERE id = $1;', [parsedId]);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Contact with ID ${parsedId} not found.`,
        });
        return;
      }

      const authorized = await canAccessContact(parsedId, req);
      res.status(200).json(authorized ? result.rows[0] : redactContactById(result.rows[0]));
    } catch (error) {
      console.error('Error retrieving contact:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while retrieving contact.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 3. UPDATE (PUT /api/contacts/:id)
  // -----------------------------------------------------------------
  static async updateContact(req: Request, res: Response, next: NextFunction): Promise<void> {
    const id = req.params.id as string;
    const parsedId = parseInt(id, 10);

    if (isNaN(parsedId) || parsedId < 1) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid contact ID. Must be a positive integer.',
      });
      return;
    }

    const authorized = await canAccessContact(parsedId, req);
    const { name, emails, phones, zip_home, zip_other, roles, firebase_uid } = req.body || {};

    if (!authorized) {
      try {
        const existingResult = await pool.query<Contact>('SELECT * FROM contacts WHERE id = $1', [parsedId]);
        const existing = existingResult.rows[0];
        if (!existing) { res.status(404).json({ error: 'Not Found', message: `Contact with ID ${parsedId} not found.` }); return; }
        const add = (current: string[] | null, incoming: unknown, max: number, normalizer?: (value: string) => string) => Array.from(new Set([...(current || []), ...(parseArrayField(incoming, normalizer) || [])])).slice(0, max);
        const nextPhones = add(existing.phones, phones, 3, normalizePhone);
        const nextEmails = add(existing.emails, emails, 3, normalizeEmail);
        const nextZips = add(existing.zip_other, zip_other, 2);
        const nextHome = existing.zip_home || (typeof zip_home === 'string' && zip_home.trim() ? zip_home.trim() : null);
        const updated = await pool.query<Contact>('UPDATE contacts SET emails = $1, phones = $2, zip_home = $3, zip_other = $4 WHERE id = $5 RETURNING *', [nextEmails, nextPhones, nextHome, nextZips, parsedId]);
        res.status(200).json(redactContactById(updated.rows[0]));
        return;
      } catch (error) { next(error); return; }
    }

    if (!name || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'name is required for update and must be a non-empty string.',
      });
      return;
    }

    const normalizedName = normalizeName(name);
    const formattedEmails = parseArrayField(emails, normalizeEmail);
    const formattedPhones = parseArrayField(phones, normalizePhone);
    const formattedZipOther = parseArrayField(zip_other);
    const formattedRoles = parseArrayField(roles);
    const formattedZipHome = typeof zip_home === 'string' && zip_home.trim() !== '' ? zip_home.trim() : null;
    let protectedRoles = formattedRoles;
    let protectedFirebaseUid = typeof firebase_uid === 'string' && firebase_uid.trim() ? firebase_uid.trim() : null;
    if (!hasRole(req, 'staff')) {
      const existing = await pool.query<Contact>('SELECT roles, firebase_uid FROM contacts WHERE id = $1', [parsedId]);
      protectedRoles = existing.rows[0]?.roles || null;
      protectedFirebaseUid = existing.rows[0]?.firebase_uid || null;
    }

    try {
      const query = `
        UPDATE contacts 
        SET name = $1, emails = $2, phones = $3, zip_home = $4, zip_other = $5, roles = $6, firebase_uid = COALESCE($7, firebase_uid)
        WHERE id = $8 
        RETURNING *;
      `;
      const values = [
        normalizedName,
        formattedEmails,
        formattedPhones,
        formattedZipHome,
        formattedZipOther,
        protectedRoles,
        protectedFirebaseUid,
        parsedId,
      ];
      const result = await pool.query<Contact>(query, values);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Contact with ID ${parsedId} not found.`,
        });
        return;
      }

      res.status(200).json(result.rows[0]);
    } catch (error) {
      console.error('Error updating contact:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while updating contact.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 4. DELETE (DELETE /api/contacts/:id)
  // -----------------------------------------------------------------
  static async deleteContact(req: Request, res: Response, next: NextFunction): Promise<void> {
    const id = req.params.id as string;
    const parsedId = parseInt(id, 10);

    if (isNaN(parsedId) || parsedId < 1) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid contact ID. Must be a positive integer.',
      });
      return;
    }

    try {
      if (!(await canAccessContact(parsedId, req))) {
        res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to delete this contact.' });
        return;
      }
      const result = await pool.query<Contact>(`UPDATE contacts SET name = 'DELETED USER', emails = NULL, phones = NULL, zip_home = NULL, zip_other = NULL, roles = NULL, firebase_uid = NULL WHERE id = $1 RETURNING id;`, [parsedId]);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Contact with ID ${parsedId} not found.`,
        });
        return;
      }

      res.status(200).json({
        message: `Contact with ID ${parsedId} has been deleted successfully.`,
      });
    } catch (error) {
      console.error('Error deleting contact:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while deleting contact.',
      });
    }
  }
}

