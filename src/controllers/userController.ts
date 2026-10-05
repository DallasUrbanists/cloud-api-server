import type { Request, Response } from 'express';
import { UserService } from '../services/userService.js';

export class UserController {
  constructor(private readonly service: UserService = new UserService()) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    try {
      res.status(200).json(await this.service.findAll());
    } catch {
      res.status(500).json({ error: 'InternalServerError', message: 'User listing failed.' });
    }
  };
}
