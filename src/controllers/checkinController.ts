import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import { Checkin, CreateCheckinDTO } from '../models/checkin.js';
import { hasRole } from '../middleware/auth.js';
import { abbreviateName } from '../utils/redaction.js';
import { recordMutationHandler, recordId } from '../services/operationService.js';

function normalizeEventId(value: unknown): string | null {
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : String(value ?? '').trim();
  return /^\d+$/.test(text) && BigInt(text) > 0n ? text : null;
}

function redactContact(contact: any, mode: 'false' | 'partial' | 'full' | 'redacted', selfName = false): any {
  if (!contact || mode === 'false') return undefined;
  if (mode === 'full') return contact;
  const name = selfName ? contact.name : mode === 'partial'
    ? contact.name.split(/\s+/).map((word: string, index: number) => index === 0 ? word : `${word.charAt(0)}.`).join(' ')
    : abbreviateName(contact.name);
  const restricted = { name, zip_home: contact.zip_home, emails: null, phones: null, zip_other: null, roles: null, firebase_uid: null };
  return mode === 'partial' ? { id: contact.id, created_on: contact.created_on, ...restricted } : restricted;
}

export function attachContact(row: any, mode: 'false' | 'partial' | 'full' | 'redacted', uid?: string, selfName = false): any {
  const { contact, firebase_uid, ...checkin } = row;
  const isSelf = Boolean(uid && firebase_uid === uid);
  const redacted = redactContact(contact, mode, selfName && isSelf);
  return { ...checkin, is_self: isSelf, ...(redacted === undefined ? {} : { contact: redacted }) };
}

export class CheckinController {
  // -----------------------------------------------------------------
  // 1. CREATE (POST /api/checkins)
  // -----------------------------------------------------------------
  static async createCheckin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { contact_id, event_id } = (req.body || {}) as CreateCheckinDTO;

    const normalizedEventId = normalizeEventId(event_id);
    if (!normalizedEventId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'event_id is required and must be a positive integer event ID.',
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

    try {
      const event = await pool.query('SELECT 1 FROM events WHERE id = $1 LIMIT 1', [normalizedEventId]);
      if (event.rows.length === 0) { res.status(400).json({ error: 'Bad Request', message: 'event_id must reference a valid event ID.' }); return; }
      if (parsedContactId !== null) {
        const contact = await pool.query('SELECT 1 FROM contacts WHERE id = $1', [parsedContactId]);
        if (contact.rows.length === 0) { res.status(400).json({ error: 'Bad Request', message: 'contact_id must reference a valid contact.' }); return; }
        const duplicate = await pool.query('SELECT 1 FROM checkins WHERE contact_id = $1 AND event_id = $2 LIMIT 1', [parsedContactId, normalizedEventId]);
        if (duplicate.rows.length > 0) { res.status(409).json({ error: 'Conflict', message: 'This contact is already checked in for this event.' }); return; }
      }
      const query = `
        INSERT INTO checkins (contact_id, event_id, submitted_on)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        RETURNING *;
      `;
      const values = [parsedContactId, normalizedEventId];
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
        const normalizedEventId = normalizeEventId(event_id);
        if (!normalizedEventId) {
          res.status(400).json({ error: 'Bad Request', message: 'event_id must be a positive integer event ID.' });
          return;
        }
        conditions.push(`event_id = $${paramIndex++}`);
        values.push(normalizedEventId);
      }

      let query = `SELECT checkins.*, contacts.firebase_uid,
              (SELECT incarnation::text || ':' || revision::text FROM resource_revisions WHERE resource='checkins' AND record_id=checkins.id) AS revision
              ${includeContact === 'false' ? '' : ', row_to_json(contacts) AS contact'}
              FROM checkins LEFT JOIN contacts ON contacts.id = checkins.contact_id`;
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }
      query += ' ORDER BY checkins.id DESC';

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
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(result.rows.map((row) => attachContact(row, contactMode as 'false' | 'partial' | 'full' | 'redacted', req.user?.uid, !isStaff)));
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
    let parsedId: string;
    try { parsedId = recordId(id); } catch {

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
      const result = await pool.query<any>(`SELECT checkins.*, contacts.firebase_uid,
              (SELECT incarnation::text || ':' || revision::text FROM resource_revisions WHERE resource='checkins' AND record_id=checkins.id) AS revision
              ${includeContact === 'false' ? '' : ', row_to_json(contacts) AS contact'}
              FROM checkins LEFT JOIN contacts ON contacts.id = checkins.contact_id WHERE checkins.id = $1`, [parsedId]);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Checkin with ID ${parsedId} not found.`,
        });
        return;
      }

      const row = result.rows[0];
      const authorized = hasRole(req, 'staff') || Boolean(req.user && row.firebase_uid === req.user.uid);
            if (row.revision) res.setHeader('ETag', `"${row.revision}"`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.status(200).json(attachContact(row,
              includeContact === 'false' ? 'false' : authorized ? (includeContact as 'partial' | 'full') : 'redacted',
              req.user?.uid, !hasRole(req, 'staff')));
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
  static updateCheckin = recordMutationHandler('checkins');

  static deleteCheckin = recordMutationHandler('checkins');
}
