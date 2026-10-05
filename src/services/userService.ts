import { getAuth, type Auth } from 'firebase-admin/auth';
import { firebaseApp } from '../config/firebase.js';
import type { User } from '../models/user.js';

export class UserService {
  constructor(private readonly authProvider: () => Pick<Auth, 'listUsers'> = () => getAuth(firebaseApp())) {}

  async findAll(): Promise<User[]> {
    const auth = this.authProvider();
    const users: User[] = [];
    let pageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, pageToken);
      users.push(...page.users.map(user => ({
        uid: user.uid,
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        disabled: user.disabled,
        staff: user.customClaims?.staff === true,
      })));
      pageToken = page.pageToken;
    } while (pageToken);
    return users;
  }
}
