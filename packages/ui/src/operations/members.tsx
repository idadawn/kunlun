import { useRef, useState } from 'react';
import { PHONE_PATTERN } from '@kunlun/shared';
import { useApi } from '../auth';
import { Dialog, Field, FormDialog, useDialogs, useToast } from '../feedback';
import type { Done } from './common';

type CreatedMember = { id: string; memberNo: string; name: string; phone: string };

function TemporaryPasswordDialog({ name, phone, password, onClose }: { name: string; phone: string; password: string; onClose: () => void }) {
  return <Dialog title={`${name} · 临时密码`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>已记下</button>}>
    <p>登录手机号 <b>{phone}</b></p><p>临时密码 <strong className="temporary-password">{password}</strong></p>
    <p className="membership-note">请将临时密码告知会员，首次登录时须修改。关闭后可通过重置密码重新生成。</p>
  </Dialog>;
}

export function ResetMemberPasswordDialog({ member, onClose }: { member: { id: string; name: string; phone: string }; onClose: () => void }) {
  const api = useApi();
  const dialogs = useDialogs();
  return <FormDialog title="重置密码" description={`${member.name} · 登录手机号 ${member.phone}`} onClose={onClose} submitLabel="生成临时密码" onSubmit={async () => {
    const result = await api.resetMemberPassword(member.id);
    await dialogs.open(close => <TemporaryPasswordDialog name={member.name} phone={result.phone} password={result.temporaryPassword} onClose={close} />);
  }}><p>重置后，会员须用手机号和新的临时密码重新登录，再设置自己的密码。</p></FormDialog>;
}

/** 新建会员档案；填写收货地址时同时建立首个默认地址，联系人默认为会员本人。 */
export function NewMemberDialog({ onClose, onDone }: { onClose: (created?: CreatedMember) => void; onDone?: Done }) {
  const api = useApi();
  const toast = useToast();
  const dialogs = useDialogs();
  const [phoneCheck, setPhoneCheck] = useState<{ phone: string; message: string } | null>(null);
  const created = useRef<CreatedMember>();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [doorNo, setDoorNo] = useState('');
  const [remark, setRemark] = useState('');
  const submit = async () => {
    if (phoneCheck?.phone === phone) throw new Error(phoneCheck.message);
    const member = await api.createMember({ name: name.trim(), phone: phone.trim(), defaultAddress: location.trim() || undefined, doorNo: doorNo.trim() || undefined, remark: remark.trim() || undefined });
    created.current = { id: member.id, memberNo: member.memberNo, name: member.name, phone: member.phone };
    await dialogs.open(close => <TemporaryPasswordDialog name={member.name} phone={member.phone} password={member.temporaryPassword} onClose={close} />);
    await onDone?.();
    toast(`建档成功：${member.name}（${member.memberNo}）`);
  };
  return (
    <FormDialog title="新建会员" submitLabel="保存并建档" onClose={() => onClose(created.current)} onSubmit={submit}>
      <Field label="会员姓名" htmlFor="newMemberName"><input id="newMemberName" className="input" required maxLength={64} placeholder="请输入真实姓名" value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="联系电话" htmlFor="newMemberPhone"><input id="newMemberPhone" className="input" type="tel" required pattern={PHONE_PATTERN} maxLength={11} inputMode="numeric" placeholder="11 位手机号" value={phone} onChange={e => { setPhone(e.target.value); setPhoneCheck(null); }} onBlur={async () => {
        if (!new RegExp(`^${PHONE_PATTERN}$`).test(phone)) return;
        try {
          const check = await api.memberPhoneAvailability(phone);
          if (!check.available) setPhoneCheck({ phone, message: check.message ?? '该手机号已被使用' });
        } catch { /* Saving also enforces phone uniqueness. */ }
      }} /></Field>
      {phoneCheck?.phone === phone && <p className="account-error" role="alert">{phoneCheck.message}</p>}
      <Field label="收货地址（选填）" htmlFor="newMemberLocation"><input id="newMemberLocation" className="input" maxLength={200} placeholder="小区 / 街道 / 楼栋" value={location} onChange={e => setLocation(e.target.value)} /></Field>
      <Field label={location.trim() ? '门牌号' : '门牌号（选填）'} htmlFor="newMemberDoorNo"><input id="newMemberDoorNo" className="input" required={!!location.trim()} maxLength={64} placeholder="单元、楼层及房号" value={doorNo} onChange={e => setDoorNo(e.target.value)} /></Field>
      <Field label="备注" htmlFor="newMemberRemark"><textarea id="newMemberRemark" className="textarea" maxLength={500} placeholder="选填" value={remark} onChange={e => setRemark(e.target.value)} /></Field>
      <p className="membership-note">填写地址后将建立首个默认收货地址，联系人和手机号默认为会员本人，之后可在收货地址中增改。</p>
    </FormDialog>
  );
}
