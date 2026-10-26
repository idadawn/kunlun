import { useNavigate } from 'react-router-dom';
import { KUNLUN_PERMISSIONS as P, pathFor, type MemberProfile, type WaterOrder } from '@kunlun/shared';
import {
  AddressBook, CredentialsDialog, DepositDialog, Dialog, FulfillDialog, MemberAssetsDialog, MovementDialog, NewMemberDialog,
  RechargeDialog, useAuth, useDialogs, useRun, useToast,
} from '@kunlun/ui';
import { useStaffData } from './data';

/** Opens the shared staff operation dialogs with the current member list and refreshes afterwards. */
export function useStaffOperations() {
  const { api, can } = useAuth();
  const data = useStaffData();
  const { members, containers, selectedMemberId, refresh } = data;
  const dialogs = useDialogs();
  const toast = useToast();
  const run = useRun();
  const guard = (allowed: boolean, message: string, open: () => unknown) => run(async () => {
    if (!allowed) throw new Error(message);
    await open();
  });

  async function createMember() {
    const created = await dialogs.open<{ id: string; memberNo: string; name: string; phone: string }>(close => <NewMemberDialog onClose={close} onDone={refresh} />);
    if (!created) return undefined;
    data.setSelectedMemberId(created.id);
    await dialogs.open(close => <CredentialsDialog subjectType="MEMBER" id={created.id} onClose={close} />);
    return created.id;
  }

  const ops = {
    recharge: guard(can(P.RechargeCreate), '当前账号没有充值权限', () =>
      dialogs.open(close => <RechargeDialog members={members} memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    deposit: guard(can(P.DepositCollect) || can(P.DepositRefundApply) || can(P.DepositRefundApprove), '当前账号没有押金办理权限', () =>
      dialogs.open(close => <DepositDialog members={members} containers={containers} memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    pickup: guard(can(P.PickupVerify) || can(P.OrderFulfill), '当前账号没有自提核销权限', () =>
      dialogs.open(close => <FulfillDialog onClose={close} onDone={refresh} />)),
    container: guard(can(P.ContainerRegister) || can(P.OrderFulfill), '当前账号没有容器登记权限', () =>
      dialogs.open(close => <MovementDialog members={members} memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    newMember: guard(can(P.MemberWrite), '当前账号没有新建会员权限', () => createMember()),
    createMember,
    /** Recharges one member from the counter and resolves once the dialog closes, so the order menu can re-read tickets. */
    rechargeFor: (member: MemberProfile) => dialogs.open(close => <RechargeDialog members={[member]} memberId={member.id} onClose={close} onDone={refresh} />),
    fulfill: (order: WaterOrder) => run(() => dialogs.open(close => <FulfillDialog order={order} onClose={close} onDone={refresh} />))(),
    accept: (order: WaterOrder) => run(async () => {
      await api.acceptOrder(order.id);
      await refresh();
      toast(`已接单：${order.orderNo}`);
    })(),
    assets: (member: MemberProfile) => run(() =>
      dialogs.open(close => <MemberAssetsDialog memberId={member.id} memberName={member.name} members={members} onClose={close} onDone={refresh} />))(),
    detail: (member: MemberProfile) => {
      data.setSelectedMemberId(member.id);
      void dialogs.open(close => <MemberDetailDialog member={member} onClose={close} />);
    },
  };
  return ops;
}

function MemberDetailDialog({ member, onClose }: { member: MemberProfile; onClose: () => void }) {
  const { refresh, setSelectedMemberId } = useStaffData();
  const { can } = useAuth();
  const ops = useStaffOperations();
  const navigate = useNavigate();
  const order = () => { setSelectedMemberId(member.id); onClose(); navigate(pathFor('staff', 'order')); };
  return (
    <Dialog title={`${member.name} · 会员办理`} description={`${member.phone} · ${member.memberNo}`} onClose={onClose}>
      <div className="membership-summary">
        自提/配送桶票 <b>{member.bucketPickupTickets}/{member.bucketDeliveryTickets}</b> · 自提/配送袋票 <b>{member.bagPickupTickets}/{member.bagDeliveryTickets}</b><br />
        押金 <b>¥{Number(member.depositAmount).toFixed(2)}</b> · 持桶/袋 <b>{member.heldBuckets}/{member.heldBags}</b>
      </div>
      <div className="membership-actions" style={{ margin: '14px 0' }}>
        <button type="button" className="btn primary sm" onClick={() => ops.assets(member)}>水票批次 / 优惠券</button>
        <button type="button" className="btn sm" onClick={ops.recharge}>水费充值</button>
        {can(P.OrderCreate) && <button type="button" className="btn sm" onClick={order}>点单</button>}
        <button type="button" className="btn sm" onClick={ops.deposit}>交/退押金</button>
      </div>
      <AddressBook owner={member} onChanged={refresh} compact />
    </Dialog>
  );
}
