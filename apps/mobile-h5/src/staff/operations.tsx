import { useNavigate } from 'react-router-dom';
import { KUNLUN_PERMISSIONS as P, money, pathFor, ticketGroups, type MemberProfile, type MobileFeatureKey, type WaterOrder } from '@kunlun/shared';
import {
  AddressBook, CredentialsDialog, DepositDialog, Dialog, FulfillDialog, MemberAssetsDialog, MovementDialog, NewMemberDialog,
  RechargeDialog, useAuth, useDialogs, useRun, useToast, type DepositAction,
} from '@kunlun/ui';
import { useMobileLayout, useStaffData } from './data';

/** Opens the shared staff operation dialogs, preselecting the member last opened from the list, and refreshes afterwards. */
export function useStaffOperations() {
  const { api, can } = useAuth();
  const data = useStaffData();
  const { containers, selectedMemberId, refresh } = data;
  const dialogs = useDialogs();
  const toast = useToast();
  const run = useRun();
  const guard = (allowed: boolean, message: string, open: () => unknown) => run(async () => {
    if (!allowed) throw new Error(message);
    await open();
  });
  const deposit = (action?: DepositAction) => guard(can(P.DepositCollect) || can(P.DepositRefundApply) || can(P.DepositRefundApprove), '当前账号没有押金办理权限', () =>
    dialogs.open(close => <DepositDialog containers={containers} memberId={selectedMemberId} action={action} onClose={close} onDone={refresh} />));

  async function createMember() {
    const created = await dialogs.open<{ id: string; memberNo: string; name: string; phone: string }>(close => <NewMemberDialog onClose={close} onDone={refresh} />);
    if (!created) return undefined;
    data.setSelectedMemberId(created.id);
    await dialogs.open(close => <CredentialsDialog subjectType="MEMBER" id={created.id} onClose={close} />);
    return created.id;
  }

  const ops = {
    recharge: guard(can(P.RechargeCreate), '当前账号没有充值权限', () =>
      dialogs.open(close => <RechargeDialog memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    deposit: deposit(),
    collectDeposit: deposit('collect'),
    refundDeposit: deposit('refund'),
    pickup: guard(can(P.PickupVerify) || can(P.OrderFulfill), '当前账号没有自提核销权限', () =>
      dialogs.open(close => <FulfillDialog onClose={close} onDone={refresh} />)),
    container: guard(can(P.ContainerRegister) || can(P.OrderFulfill), '当前账号没有容器登记权限', () =>
      dialogs.open(close => <MovementDialog memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    newMember: guard(can(P.MemberWrite), '当前账号没有新建会员权限', () => createMember()),
    createMember,
    /** Recharges one member from the counter and resolves once the dialog closes, so the order menu can re-read tickets. */
    rechargeFor: (member: MemberProfile) => dialogs.open(close => <RechargeDialog memberId={member.id} onClose={close} onDone={refresh} />),
    fulfill: (order: WaterOrder) => run(() => dialogs.open(close => <FulfillDialog order={order} onClose={close} onDone={refresh} />))(),
    accept: (order: WaterOrder) => run(async () => {
      await api.acceptOrder(order.id);
      await refresh();
      toast(`已接单：${order.orderNo}`);
    })(),
    assets: (member: MemberProfile) => run(() =>
      dialogs.open(close => <MemberAssetsDialog memberId={member.id} memberName={member.name} onClose={close} onDone={refresh} />))(),
    detail: (member: MemberProfile) => {
      data.setSelectedMemberId(member.id);
      void dialogs.open(close => <MemberDetailDialog member={member} onClose={close} />);
    },
  };
  /** Opens a workbench shortcut that works in a dialog; features with a page navigate instead. */
  const open = (key: MobileFeatureKey) => {
    const action: Partial<Record<MobileFeatureKey, () => void>> = {
      recharge: ops.recharge, depositCollect: ops.collectDeposit, depositRefund: ops.refundDeposit,
      pickup: ops.pickup, movement: ops.container, newMember: ops.newMember,
    };
    action[key]?.();
  };
  return { ...ops, open };
}

/** One member's tickets, deposit and addresses, with the businesses this role has on the phone. */
function MemberDetailDialog({ member: opened, onClose }: { member: MemberProfile; onClose: () => void }) {
  const { members, refresh, setSelectedMemberId } = useStaffData();
  // The list refreshes after a recharge, deposit or address change made from here; show that, not the row as it was when opened.
  const member = members.find(m => m.id === opened.id) ?? opened;
  const { can } = useAuth();
  const layout = useMobileLayout();
  const ops = useStaffOperations();
  const navigate = useNavigate();
  const order = () => { setSelectedMemberId(member.id); onClose(); navigate(pathFor('staff', 'order')); };
  // A disabled member cannot be served: the server refuses every business, so none is offered here.
  const disabled = member.status === 'DISABLED';
  const depositActions = !disabled && (layout.has('depositCollect') || layout.has('depositRefund'));
  return (
    <Dialog title={`${member.name} · 会员办理`} description={`${member.phone} · ${member.memberNo}`} onClose={onClose}>
      {disabled && (
        <p className="member-disabled-note"><b>这位会员已停用{member.disableReason ? `：${member.disableReason}` : ''}</b>停用的会员办不了充值、点单、押金和领还；水票、押金都还在。需要时请管理员在电脑上重新启用。</p>
      )}
      <div className="member-ledgers">
        <section>
          <header><b>水票</b><button type="button" className="link" onClick={() => ops.assets(member)}>批次{layout.has('recharge') && !disabled ? ' / 退款' : ''} ›</button></header>
          {member.tickets.length === 0 && <p>暂无水票</p>}
          {ticketGroups(member.tickets).map(g => (
            <p key={g.waterType}>{g.name}<br /><b>自提 {g.pickup} · 配送 {g.delivery}</b> {g.unit}{g.reserved > 0 ? `（预占 ${g.reserved}）` : ''}</p>
          ))}
          {layout.has('recharge') && !disabled && <div className="member-ledger-actions"><button type="button" className="btn primary sm" onClick={ops.recharge}>水费充值</button></div>}
        </section>
        <section className="deposit">
          <header><b>押金</b><small>独立记账</small></header>
          <p>在池押金 <b>¥{money(member.depositAmount)}</b></p>
          <p>持有桶/袋 <b>{member.heldBuckets}/{member.heldBags}</b></p>
          {depositActions && <div className="member-ledger-actions">
            {layout.has('depositCollect') && <button type="button" className="btn sm" onClick={ops.collectDeposit}>收押金</button>}
            {layout.has('depositRefund') && <button type="button" className="btn sm" onClick={ops.refundDeposit}>退押金</button>}
          </div>}
        </section>
      </div>
      {!disabled && (layout.has('order') || layout.has('movement')) && <div className="membership-actions" style={{ margin: '12px 0 14px' }}>
        {layout.has('order') && can(P.OrderCreate) && <button type="button" className="btn sm" onClick={order}>点单</button>}
        {layout.has('movement') && <button type="button" className="btn sm" onClick={ops.container}>登记领还</button>}
      </div>}
      <AddressBook owner={member} onChanged={refresh} compact />
    </Dialog>
  );
}
