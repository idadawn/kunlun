import { useState } from 'react';
import { PHONE_PATTERN, type RoleCode } from '@kunlun/shared';
import { CredentialsDialog, Field, FormDialog, useApi, useDialogs, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow } from '../common';

const ROLES: Record<string, string> = { ADMIN: '管理员', CLERK: '店员', COURIER: '送水员' };

export function StaffAccounts() {
  const api = useApi();
  const dialogs = useDialogs();
  const run = useRun();
  const accounts = useLoader(() => api.listStaff(), [api]);
  return <>
    <div className="page-head"><div><h2>员工账号</h2><p>管理员工账号、角色及启用状态</p></div></div>
    <div className="table-card">
      <div className="table-toolbar"><b>员工账号与权限</b><button type="button" className="btn primary sm" onClick={() => dialogs.open(close => <NewStaffDialog onClose={close} onDone={accounts.reload} />)}>添加员工</button></div>
      <table>
        <thead><tr><th>员工</th><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {accounts.error ? <EmptyRow colSpan={5}>{accounts.error}</EmptyRow> : !accounts.data ? <EmptyRow colSpan={5}>正在加载…</EmptyRow> : accounts.data.map(s => (
            <tr key={s.id}>
              <td>{s.name}<br /><small>{s.phone}</small></td>
              <td>{s.username}</td>
              <td>{ROLES[s.role] ?? s.role}</td>
              <td>{s.status === 'ACTIVE' ? '启用' : '停用'}</td>
              <td>
                <button type="button" className="link" onClick={run(async () => { await api.setStaffStatus(s.id, s.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'); await accounts.reload(); })}>{s.status === 'ACTIVE' ? '停用' : '启用'}</button>{' '}
                <button type="button" className="link" onClick={() => dialogs.open(close => <CredentialsDialog subjectType="STAFF" id={s.id} initialUsername={s.username} onClose={close} onSaved={accounts.reload} />)}>设置账号 / 重置密码</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>;
}

function NewStaffDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Exclude<RoleCode, 'MEMBER'>>('CLERK');
  return (
    <FormDialog title="添加员工账号" onClose={onClose} onSubmit={async () => {
      await api.createStaff({ name, phone, username, password, role });
      await onDone();
      toast('员工账号已创建');
    }}>
      <Field label="姓名" htmlFor="staffName"><input id="staffName" className="input" required maxLength={64} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="手机号" htmlFor="staffPhone"><input id="staffPhone" className="input" type="tel" required pattern={PHONE_PATTERN} value={phone} onChange={e => setPhone(e.target.value)} /></Field>
      <Field label="用户名" htmlFor="staffUsername"><input id="staffUsername" className="input" required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} /></Field>
      <Field label="初始密码" htmlFor="staffPassword"><input id="staffPassword" className="input" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
      <Field label="角色" htmlFor="staffRole"><select id="staffRole" className="select" value={role} onChange={e => setRole(e.target.value as typeof role)}><option value="CLERK">店员</option><option value="COURIER">送水员</option><option value="ADMIN">管理员</option></select></Field>
    </FormDialog>
  );
}
