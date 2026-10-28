import { findAccountById } from '../../../core/index.ts';

export type UserRef = { id: string; name: string };

/** `UserRef` (Documents/21 §12.8) của một tài khoản; `core.accounts` không có RLS nên đọc được trong `withCompany`. */
export async function userRef(id: string): Promise<UserRef | null> {
  const account = await findAccountById(id);
  return account ? { id: account.id, name: account.fullName } : null;
}
