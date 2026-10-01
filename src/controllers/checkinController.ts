import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import { Checkin, CreateCheckinDTO, UpdateCheckinDTO } from '../models/checkin.js';

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

      let query = 'SELECT * FROM checkins';
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

      const result = await pool.query<Checkin>(query, values);
      res.status(200).json(result.rows);
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

    try {
      const result = await pool.query<Checkin>('SELECT * FROM checkins WHERE id = $1;', [parsedId]);

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `Checkin with ID ${parsedId} not found.`,
        });
        return;
      }

      res.status(200).json(result.rows[0]);
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
