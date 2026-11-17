import { useState } from 'react';
import { money, type MemberProfile } from '@kunlun/shared';
import { ConfirmDialog, FormDialog, ReasonChips, useAuth, useDialogs, useRun, useToast } from '@kunlun/ui';
import { useAdminData } from './data';

/** What the dialogs need to know about a member: a list row and a full profile both have it. */
type Member = Pick<MemberProfile, 'id' | 'name' | 'memberNo' | 'tickets' | 'depositAmount' | 'heldBuckets' | 'heldBags'>;

/**
 * 停用、重新启用和删除会员（「停用和删除会员」权限，默认只给管理员）。会员列表「操作」列办理，停用会员档案顶部的横幅也能重新启用。
 * 办完刷新数据：列表、档案和角标都按新的状态重读。
 */
export function useMemberStatusActions() {
  const { api } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const toast = useToast();
  const { refresh } = useAdminData();
  return {
    disable: (m: Member) => run(() => dialogs.open(close => <DisableMemberDialog member={m} onClose={close} onDone={refresh} />))(),
    enable: (m: Member) => run(async () => {
      const enabled = await dialogs.open<boolean>(close => <ConfirmDialog title="重新启用会员" confirmLabel="重新启用" onClose={close}
        message={`重新启用后，${m.name}可以登录会员端，员工也能照常为这位会员办理业务。`}
        onConfirm={async () => { await api.setMemberStatus(m.id, 'ACTIVE'); }} />);
      if (!enabled) return;
      await refresh();
      toast(`已重新启用 ${m.name}`);
    })(),
    remove: (m: Member) => run(async () => {
      const deleted = await dialogs.open<boolean>(close => <ConfirmDialog title="删除会员" confirmLabel="确认删除" onClose={close}
        message={<>确定删除 <b>{m.name}</b>（{m.memberNo}）吗？<br />只有一条记录都没有的会员才能删除，比如建错了、重复的档案；地址会一起删掉，删了找不回来。<br />有充值、水单、押金等记录的会员不能删，请用「停用」。</>}
        onConfirm={async () => { await api.deleteMember(m.id); }} />);
      if (!deleted) return;
      toast(`已删除会员 ${m.name}（${m.memberNo}）`);
      await refresh();
    })(),
  };
}

const DISABLE_REASONS = ['不再来了', '搬走了', '重复建档', '会员要求注销'] as const;

/** 停用会员要写原因。还有的水票、押金和桶袋先列出来：停用后都还在，要退钱得先退再停用，或者重新启用后再退。 */
function DisableMemberDialog({ member: m, onClose, onDone }: { member: Member; onClose: () => void; onDone: () => unknown }) {
  const { api } = useAuth();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const tickets = m.tickets.reduce((sum, t) => sum + t.available + t.reserved, 0);
  const holds = [
    tickets > 0 && `${tickets} 张水票`,
    Number(m.depositAmount) > 0 && `押金 ¥${money(m.depositAmount)}`,
    m.heldBuckets + m.heldBags > 0 && `手里 ${m.heldBuckets} 个桶、${m.heldBags} 个袋`,
  ].filter((hold): hold is string => !!hold);
  const submit = async () => {
    const text = reason.trim();
    if (!text) throw new Error('请写明停用原因');
    await api.setMemberStatus(m.id, 'DISABLED', text);
    await onDone();
    toast(`已停用会员 ${m.name}`);
  };
  return (
    <FormDialog title="停用会员" description={`${m.name} · ${m.memberNo}`} submitLabel="确认停用" onClose={onClose} onSubmit={submit}
      extraActions={<button type="button" className="btn" onClick={onClose}>取消</button>}>
      <p className="membership-note">停用后会员端马上登录不了，员工也不能再为这位会员充值、点单、收退押金、退款、登记领还和补录。没完成的水单、待审核的赠送、收押金、退款和损坏不赔付要先办完。以后需要可以重新启用。</p>
      {holds.length > 0 && <p className="profile-warn">还有 {holds.join('、')}：停用后都还在，照样算在账上。要退钱请先退再停用，或者重新启用后再退。</p>}
      <label htmlFor="disableReason">停用原因</label>
      <input id="disableReason" className="input" required maxLength={100} placeholder="如：搬走了" value={reason} onChange={e => setReason(e.target.value)} />
      <ReasonChips options={DISABLE_REASONS} value={reason} onPick={setReason} />
    </FormDialog>
  );
}
