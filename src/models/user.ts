export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  staff: boolean;
}
