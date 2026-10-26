import { PAY_METHODS, type MemberProfile } from '@kunlun/shared';
import { Dialog } from '../feedback';

export type Done = () => void | Promise<void>;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function MemberOptions({ members }: { members: MemberProfile[] }) {
  return <>{members.map(m => <option key={m.id} value={m.id}>{m.name} · {m.memberNo}</option>)}</>;
}

export function PayOptions() {
  return <>{PAY_METHODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</>;
}

/** Shown instead of a form when a precondition (permission, configuration, data) is not met. */
export function UnavailableDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return <Dialog title={title} onClose={onClose}><p className="account-error" role="alert">{message}</p></Dialog>;
}

export const initialMember = (members: MemberProfile[], memberId?: string) =>
  (memberId && members.some(m => m.id === memberId) ? memberId : members[0]?.id) ?? '';
