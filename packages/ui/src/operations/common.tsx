import { useEffect, useState } from 'react';
import { PAY_METHODS, type MemberProfile } from '@kunlun/shared';
import { useApi } from '../auth';
import { Dialog } from '../feedback';

export type Done = () => void | Promise<void>;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PayOptions() {
  return <>{PAY_METHODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</>;
}

/** Shown instead of a form when a precondition (permission, configuration, data) is not met. */
export function UnavailableDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return <Dialog title={title} onClose={onClose}><p className="account-error" role="alert">{message}</p></Dialog>;
}

/** What a member picker needs to show a choice; search results carry the full profile. */
export type PickerMember = Pick<MemberProfile, 'id' | 'name' | 'memberNo'> & { phone?: string };

const PICKER_RESULTS = 20;
const memberLabel = (m: PickerMember) => [m.name, m.memberNo, m.phone].filter(Boolean).join(' · ');

/**
 * The member a staff dialog acts on. A preselected `memberId` is loaded from the server, so it need not be in any
 * list the caller holds; the picker can then change it.
 */
export function usePickedMember(memberId?: string) {
  const api = useApi();
  const [member, setMember] = useState<MemberProfile | null>(null);
  useEffect(() => {
    let alive = true;
    // A member the staff already picked meanwhile wins; if loading fails they can still search.
    if (memberId) api.memberProfile(memberId).then(m => alive && setMember(current => current ?? m)).catch(() => undefined);
    return () => { alive = false; };
  }, [api, memberId]);
  return [member, setMember] as const;
}

/**
 * Server-searched member choice: matches on name, phone or member number, newest first. The chosen member stays
 * selected while later searches show other members; a search with a single match selects it.
 */
export function MemberPicker({ id, value, onChange, disabled }: { id: string; value: PickerMember | null; onChange: (member: MemberProfile) => void; disabled?: boolean }) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ q: string; rows: MemberProfile[]; total: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    const timer = window.setTimeout(() => {
      api.membersPage({ q, pageSize: PICKER_RESULTS })
        .then(page => {
          if (!alive) return;
          setResult({ q, rows: page.rows, total: page.total }); setError('');
          if (q && page.total === 1) onChange(page.rows[0]);
        })
        .catch(e => alive && setError(errorText(e)));
    }, q ? 250 : 0);
    return () => { alive = false; window.clearTimeout(timer); };
    // onChange is a fresh closure on every render; searching again because of it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, query]);

  const rows = result?.rows ?? [];
  const options: PickerMember[] = value && !rows.some(m => m.id === value.id) ? [value, ...rows] : rows;
  const hint = error || (!result ? '正在加载会员…'
    : result.total === 0 ? (result.q ? `没有找到「${result.q}」，请换个关键字` : '暂无会员，请先建立会员档案')
    : result.total > rows.length ? `共 ${result.total} 位${result.q ? '匹配' : '会员'}，显示最近 ${rows.length} 位；输入姓名、手机号或会员编号缩小范围`
    : result.q ? `找到 ${result.total} 位会员` : '');
  return (
    <div className="member-picker">
      <input className="input" type="search" aria-label="搜索会员" placeholder="搜索姓名、手机号或会员编号" value={query} disabled={disabled}
        onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} />
      <select id={id} className="select" required disabled={disabled} value={value?.id ?? ''}
        onChange={e => { const m = rows.find(r => r.id === e.target.value); if (m) onChange(m); }}>
        {!value && <option value="">请选择会员</option>}
        {options.map(m => <option key={m.id} value={m.id}>{memberLabel(m)}</option>)}
      </select>
      {hint && <small className="membership-note">{hint}</small>}
    </div>
  );
}

/** Common reasons as chips: picking one fills the reason field, which staff can still edit. */
export function ReasonChips({ options, value, onPick, label = '常用原因' }: { options: readonly string[]; value: string; onPick: (reason: string) => void; label?: string }) {
  return (
    <div className="slot-chips reason-chips" role="group" aria-label={label}>
      {options.map(option => (
        <button key={option} type="button" className={value.trim() === option ? 'active' : ''} aria-pressed={value.trim() === option} onClick={() => onPick(option)}>{option}</button>
      ))}
    </div>
  );
}
