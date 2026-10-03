import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import { Checkin, CreateCheckinDTO, UpdateCheckinDTO } from '../models/checkin.js';
import { hasRole } from '../middleware/auth.js';

function redactContact(contact: any, mode: 'false' | 'partial' | 'full' | 'redacted'): any {
  if (!contact || mode === 'false') return undefined;
  if (mode === 'full') return contact;
  if (mode === 'partial') return { ...contact, name: contact.name.split(/\s+/).map((word: string, index: number) => index === 0 ? word : `${word.charAt(0)}.`).join(' '), emails: null, phones: null, zip_other: null, roles: null, firebase_uid: null };
  return { name: contact.name.split(/\s+/).map((word: string) => word.charAt(0)).join(''), zip_home: contact.zip_home, emails: null, phones: null, zip_other: null, roles: null, firebase_uid: null };
}

function attachContact(row: any, mode: 'false' | 'partial' | 'full' | 'redacted'): any {
  const { contact, firebase_uid, ...checkin } = row;
  const redacted = redactContact(contact, mode);
  return redacted === undefined ? checkin : { ...checkin, contact: redacted };
}

async function canModifyCheckin(id: number, req: Request): Promise<boolean> {
  if (hasRole(req, 'staff')) return true;
  if (!req.user) return false;
  const result = await pool.query<{ firebase_uid: string | null }>('SELECT contacts.firebase_uid FROM checkins LEFT JOIN contacts ON contacts.id = checkins.contact_id WHERE checkins.id = $1', [id]);
  return result.rows[0]?.firebase_uid === req.user.uid;
}

export class CheckinController {
  // -----------------------------------------------------------------
  // 1. CREATE (POST /api/checkins)
  // -----------------------------------------------------------------
  static async createCheckin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { contact_id, event_id, submitted_on } = (req.body || {}) as CreateCheckinDTO;

    if (!event_id || typeof event_id !== 'string' || event_id.trim() === '') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'event_id is required and must be a non-empty string.',
      });
      return;
    }

    let parsedContactId: number | null = null;
    if (contact_id !== undefined && contact_id !== null && contact_id !== '') {
      parsedContactId = parseInt(String(contact_id), 10);
      if (isNaN(parsedContactId) || parsedContactId < 1) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'contact_id must be a positive integer or null.',
        });
        return;
      }
    }

    let parsedSubmittedOn: Date | null = null;
    if (submitted_on) {
      const parsedDate = new Date(submitted_on);
      if (isNaN(parsedDate.getTime())) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'submitted_on must be a valid ISO 8601 timestamp string.',
        });
        return;
      }
      parsedSubmittedOn = parsedDate;
    }

    try {
      const event = await pool.query('SELECT 1 FROM events WHERE id::text = $1 OR uid = $1 LIMIT 1', [event_id.trim()]);
      if (event.rows.length === 0) { res.status(400).json({ error: 'Bad Request', message: 'event_id must reference a valid event.' }); return; }
      if (parsedContactId !== null) {
        const contact = await pool.query('SELECT 1 FROM contacts WHERE id = $1', [parsedContactId]);
        if (contact.rows.length === 0) { res.status(400).json({ error: 'Bad Request', message: 'contact_id must reference a valid contact.' }); return; }
        const duplicate = await pool.query('SELECT 1 FROM checkins WHERE contact_id = $1 AND event_id = $2 LIMIT 1', [parsedContactId, event_id.trim()]);
        if (duplicate.rows.length > 0) { res.status(409).json({ error: 'Conflict', message: 'This contact is already checked in for this event.' }); return; }
      }
      const query = `
        INSERT INTO checkins (contact_id, event_id, submitted_on)
        VALUES ($1, $2, COALESCE($3, CURRENT_TIMESTAMP)) 
        RETURNING *;
      `;
      const values = [parsedContactId, event_id.trim(), parsedSubmittedOn];
      const result = await pool.query<Checkin>(query, values);

      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Error inserting checkin:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while creating checkin record.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 2. READ (GET /api/checkins)
  // -----------------------------------------------------------------
  static async getAllCheckins(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { contact_id, event_id, limit, offset } = req.query;
    const includeContact = String(req.query.include_contact || 'false');
    const isStaff = hasRole(req, 'staff');
    if (!['false', 'partial', 'full'].includes(includeContact)) {
      res.status(400).json({ error: 'Bad Request', message: 'include_contact must be false, partial, or full.' });
      return;
    }
    if (!isStaff && (!event_id || String(event_id).trim() === '')) {
      res.status(400).json({ error: 'Bad Request', message: 'event_id is required unless the user has staff role.' });
      return;
    }
    if (includeContact === 'full' && !isStaff) {
      res.status(403).json({ error: 'Forbidden', message: 'Full contact details require staff authorization.' });
      return;
    }

    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (contact_id) {
        const parsedContactId = parseInt(contact_id as string, 10);
        if (isNaN(parsedContactId) || parsedContactId < 1) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'contact_id query parameter must be a positive integer.',
          });
          return;
        }
        conditions.push(`contact_id = $${paramIndex++}`);
        values.push(parsedContactId);
      }

      if (event_id) {
        const trimmedEventId = String(event_id).trim();
        if (trimmedEventId !== '') {
          conditions.push(`event_id = $${paramIndex++}`);
          values.push(trimmedEventId);
        }
      }

      let query = includeContact === 'false'
        ? 'SELECT checkins.* FROM checkins'
        : 'SELECT checkins.*, row_to_json(contacts) AS contact FROM checkins LEFT JOIN contacts ON contacts.id = checkins.contact_id';
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

      if (offset) {
        const parsedOffset = parseInt(offset as string, 10);
        if (isNaN(parsedOffset) || parsedOffset < 0) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'offset parameter must be a non-negative integer.',
          });
          return;
        }
        query += ` OFFSET $${paramIndex++}`;
        values.push(parsedOffset);
      }

      const result = await pool.query<any>(query, values);
      const contactMode = isStaff ? includeContact : (includeContact === 'false' ? 'false' : 'redacted');
      res.status(200).json(result.rows.map((row) => attachContact(row, contactMode as 'false' | 'partial' | 'full' | 'redacted')));
    } catch (error) {
      console.error('Error fetching checkins:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while fetching checkins.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 3. READ SINGLE (GET /api/checkins/:id)
  // -----------------------------------------------------------------
  static async getCheckinById(req: Request, res: Response, next: NextFunction): Promise<void> {
    const id = req.params.id as string;
    const parsedId = parseInt(id, 10);

    if (isNaN(parsedId) || parsedId < 1) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid checkin ID. Must be a positive integer.',
      });
      return;
    }

    const includeContact = String(req.query.include_contact || 'false');
    if (!['false', 'partial', 'full'].includes(includeContact)) {
      res.status(400).json({ error: 'Bad Request', message: 'include_contact must be false, partial, or full.' });
      return;
    }

    try {
      const result = await pool.query<any>(includeContact === 'false'
        ? 'SELECT checkins.*, contacts.firebase_uid FROM checkins LEFT JOIN contacts ON contacts.id = checkins.contact_id WHERE checkins.id = $1'
        : 'SELECT checkins.*, row_to_json(contacts) AS contact, contacts.firebase_uid FROM checkins LEFT JOIN contacts ON contacts.id = checkins.contact_id WHERE checkins.id = $1', [parsedId]);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Checkin with ID ${parsedId} not found.`,
        });
        return;
      }

      const row = result.rows[0];
      const authorized = hasRole(req, 'staff') || Boolean(req.user && row.firebase_uid === req.user.uid);
      if (includeContact === 'full' && authorized) {
        res.status(200).json(attachContact(row, 'full'));
        return;
      }
      if (includeContact === 'partial' && authorized) {
        res.status(200).json(attachContact(row, 'partial'));
        return;
      }
      res.status(200).json(attachContact(row, authorized ? (includeContact as 'false' | 'partial' | 'full') : 'redacted'));
    } catch (error) {
      console.error('Error retrieving checkin:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while retrieving checkin.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 4. UPDATE (PUT /api/checkins/:id)
  // -----------------------------------------------------------------
  static async updateCheckin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const id = req.params.id as string;
    const parsedId = parseInt(id, 10);

    if (isNaN(parsedId) || parsedId < 1) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid checkin ID. Must be a positive integer.',
      });
      return;
    }
    if (!(await canModifyCheckin(parsedId, req))) {
      res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to modify this checkin.' });
      return;
    }

    const { contact_id, event_id, submitted_on } = (req.body || {}) as UpdateCheckinDTO;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (contact_id !== undefined) {
      if (contact_id === null || contact_id === '') {
        updates.push(`contact_id = NULL`);
      } else {
        const parsedContactId = parseInt(String(contact_id), 10);
        if (isNaN(parsedContactId) || parsedContactId < 1) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'contact_id must be a positive integer or null.',
          });
          return;
        }
        updates.push(`contact_id = $${paramIndex++}`);
        values.push(parsedContactId);
      }
    }

    if (event_id !== undefined) {
      if (typeof event_id !== 'string' || event_id.trim() === '') {
        res.status(400).json({
          error: 'Bad Request',
          message: 'event_id must be a non-empty string.',
        });
        return;
      }
      updates.push(`event_id = $${paramIndex++}`);
      values.push(event_id.trim());
    }

    if (submitted_on !== undefined) {
      const parsedDate = new Date(submitted_on);
      if (isNaN(parsedDate.getTime())) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'submitted_on must be a valid ISO 8601 timestamp string.',
        });
        return;
      }
      updates.push(`submitted_on = $${paramIndex++}`);
      values.push(parsedDate);
    }

    if (updates.length === 0) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'At least one field (contact_id, event_id, submitted_on) must be provided for update.',
      });
      return;
    }

    values.push(parsedId);
    const query = `
      UPDATE checkins 
      SET ${updates.join(', ')} 
      WHERE id = $${paramIndex} 
      RETURNING *;
    `;

    try {
      const result = await pool.query<Checkin>(query, values);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Checkin with ID ${parsedId} not found.`,
        });
        return;
      }

      res.status(200).json(result.rows[0]);
    } catch (error) {
      console.error('Error updating checkin:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while updating checkin.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 5. DELETE (DELETE /api/checkins/:id)
  // -----------------------------------------------------------------
  static async deleteCheckin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const id = req.params.id as string;
    const parsedId = parseInt(id, 10);

    if (isNaN(parsedId) || parsedId < 1) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid checkin ID. Must be a positive integer.',
      });
      return;
    }
    if (!(await canModifyCheckin(parsedId, req))) {
      res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to delete this checkin.' });
      return;
    }

    try {
      const result = await pool.query<Checkin>('DELETE FROM checkins WHERE id = $1 RETURNING id;', [parsedId]);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Checkin with ID ${parsedId} not found.`,
        });
        return;
      }

      res.status(200).json({
        message: `Checkin with ID ${parsedId} has been deleted successfully.`,
      });
    } catch (error) {
      console.error('Error deleting checkin:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while deleting checkin.',
      });
    }
  }
}
