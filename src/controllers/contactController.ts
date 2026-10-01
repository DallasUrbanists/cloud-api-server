import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';

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
}

// Interface for API Request Payloads
export interface ContactRequestBody {
  name?: string;
  emails?: string[];
  phones?: string[];
  zip_home?: string;
  zip_other?: string[];
  roles?: string[];
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
    const { name, email, phone, limit } = req.query;

    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (name && typeof name === 'string' && name.trim() !== '') {
        const normalizedName = normalizeName(name);
        conditions.push(`name ILIKE $${paramIndex++}`);
        values.push(`%${normalizedName}%`);
      }

      if (email && typeof email === 'string' && email.trim() !== '') {
        const normalizedEmail = normalizeEmail(email);
        conditions.push(`EXISTS (SELECT 1 FROM unnest(emails) AS e WHERE e ILIKE $${paramIndex++})`);
        values.push(`%${normalizedEmail}%`);
      }

      if (phone && typeof phone === 'string' && phone.trim() !== '') {
        const normalizedPhone = normalizePhone(phone);
        conditions.push(`EXISTS (SELECT 1 FROM unnest(phones) AS p WHERE p ILIKE $${paramIndex++})`);
        values.push(`%${normalizedPhone}%`);
      }

      let query = 'SELECT * FROM contacts';
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }
      query += ' ORDER BY id DESC';

      if (limit) {
        const parsedLimit = parseInt(limit as string, 10);
        if (isNaN(parsedLimit) || parsedLimit < 1) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'limit parameter must be a positive integer.',
          });
          return;
        }
        query += ` LIMIT $${paramIndex++}`;
        values.push(parsedLimit);
      }

      const result = await pool.query<Contact>(query, values);
      res.status(200).json(result.rows);
    } catch (error) {
      console.error('Error fetching contacts:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while fetching contacts.',
      });
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

      res.status(200).json(result.rows[0]);
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

    const { name, emails, phones, zip_home, zip_other, roles } = req.body || {};

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

    try {
      const query = `
        UPDATE contacts 
        SET name = $1, emails = $2, phones = $3, zip_home = $4, zip_other = $5, roles = $6 
        WHERE id = $7 
        RETURNING *;
      `;
      const values = [
        normalizedName,
        formattedEmails,
        formattedPhones,
        formattedZipHome,
        formattedZipOther,
        formattedRoles,
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
      const result = await pool.query<Contact>('DELETE FROM contacts WHERE id = $1 RETURNING id;', [parsedId]);

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

