import { useRef, useState } from 'react';
import { PHONE_PATTERN } from '@kunlun/shared';
import { useApi } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import type { Done } from './common';

type CreatedMember = { id: string; memberNo: string; name: string; phone: string };

/** 新建会员档案；填写收货地址时同时建立首个默认地址，联系人默认为会员本人。 */
export function NewMemberDialog({ onClose, onDone }: { onClose: (created?: CreatedMember) => void; onDone?: Done }) {
  const api = useApi();
  const toast = useToast();
  const created = useRef<CreatedMember>();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [doorNo, setDoorNo] = useState('');
  const [remark, setRemark] = useState('');
  const submit = async () => {
    const member = await api.createMember({ name: name.trim(), phone: phone.trim(), defaultAddress: location.trim() || undefined, doorNo: doorNo.trim() || undefined, remark: remark.trim() || undefined });
    created.current = member;
    await onDone?.();
    toast(`建档成功：${member.name}（${member.memberNo}）`);
  };
  return (
    <FormDialog title="新建会员" submitLabel="保存并建档" onClose={() => onClose(created.current)} onSubmit={submit}>
      <Field label="会员姓名" htmlFor="newMemberName"><input id="newMemberName" className="input" required maxLength={64} placeholder="请输入真实姓名" value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="联系电话" htmlFor="newMemberPhone"><input id="newMemberPhone" className="input" type="tel" required pattern={PHONE_PATTERN} maxLength={11} inputMode="numeric" placeholder="11 位手机号" value={phone} onChange={e => setPhone(e.target.value)} /></Field>
      <Field label="收货地址（选填）" htmlFor="newMemberLocation"><input id="newMemberLocation" className="input" maxLength={200} placeholder="小区 / 街道 / 楼栋" value={location} onChange={e => setLocation(e.target.value)} /></Field>
      <Field label={location.trim() ? '门牌号' : '门牌号（选填）'} htmlFor="newMemberDoorNo"><input id="newMemberDoorNo" className="input" required={!!location.trim()} maxLength={64} placeholder="单元、楼层及房号" value={doorNo} onChange={e => setDoorNo(e.target.value)} /></Field>
      <Field label="备注" htmlFor="newMemberRemark"><textarea id="newMemberRemark" className="textarea" maxLength={500} placeholder="选填" value={remark} onChange={e => setRemark(e.target.value)} /></Field>
      <p className="membership-note">填写地址后将建立首个默认收货地址，联系人和手机号默认为会员本人，之后可在收货地址中增改。</p>
    </FormDialog>
  );
}
