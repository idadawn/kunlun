import { KUNLUN_PERMISSIONS as P, type MemberProfile, type WaterOrder } from '@kunlun/shared';
import {
  AddressBook, CredentialsDialog, DepositDialog, Dialog, FulfillDialog, MemberAssetsDialog, MovementDialog, NewMemberDialog,
  RechargeDialog, StaffOrderDialog, useAuth, useDialogs, useRun, useToast,
} from '@kunlun/ui';
import { useStaffData } from './data';

/** Opens the shared staff operation dialogs with the current member list and refreshes afterwards. */
export function useStaffOperations() {
  const { api, can } = useAuth();
  const data = useStaffData();
  const { members, products, containers, selectedMemberId, refresh } = data;
  const dialogs = useDialogs();
  const toast = useToast();
  const run = useRun();
  const guard = (allowed: boolean, message: string, open: () => unknown) => run(async () => {
    if (!allowed) throw new Error(message);
    await open();
  });

  const ops = {
    recharge: guard(can(P.RechargeCreate), '当前账号没有充值权限', () =>
      dialogs.open(close => <RechargeDialog members={members} memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    deposit: guard(can(P.DepositCollect) || can(P.DepositRefundApply) || can(P.DepositRefundApprove), '当前账号没有押金办理权限', () =>
      dialogs.open(close => <DepositDialog members={members} containers={containers} memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    order: guard(can(P.OrderCreate), '当前账号没有代开水单权限', () =>
      dialogs.open(close => <StaffOrderDialog members={members} products={products} memberId={selectedMemberId} onClose={close} onDone={() => refresh()} />)),
    pickup: guard(can(P.PickupVerify) || can(P.OrderFulfill), '当前账号没有自提核销权限', () =>
      dialogs.open(close => <FulfillDialog onClose={close} onDone={refresh} />)),
    container: guard(can(P.ContainerRegister) || can(P.OrderFulfill), '当前账号没有容器登记权限', () =>
      dialogs.open(close => <MovementDialog members={members} memberId={selectedMemberId} onClose={close} onDone={refresh} />)),
    newMember: guard(can(P.MemberWrite), '当前账号没有新建会员权限', async () => {
      const created = await dialogs.open<{ id: string; memberNo: string; name: string; phone: string }>(close => <NewMemberDialog onClose={close} onDone={refresh} />);
      if (!created) return;
      data.setSelectedMemberId(created.id);
      await dialogs.open(close => <CredentialsDialog subjectType="MEMBER" id={created.id} onClose={close} />);
    }),
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
  const { refresh } = useStaffData();
  const ops = useStaffOperations();
  return (
    <Dialog title={`${member.name} · 会员办理`} description={`${member.phone} · ${member.memberNo}`} onClose={onClose}>
      <div className="membership-summary">
        自提/配送桶票 <b>{member.bucketPickupTickets}/{member.bucketDeliveryTickets}</b> · 自提/配送袋票 <b>{member.bagPickupTickets}/{member.bagDeliveryTickets}</b><br />
        押金 <b>¥{Number(member.depositAmount).toFixed(2)}</b> · 持桶/袋 <b>{member.heldBuckets}/{member.heldBags}</b>
      </div>
      <div className="membership-actions" style={{ margin: '14px 0' }}>
        <button type="button" className="btn primary sm" onClick={() => ops.assets(member)}>水票批次 / 优惠券</button>
        <button type="button" className="btn sm" onClick={ops.recharge}>水费充值</button>
        <button type="button" className="btn sm" onClick={ops.order}>代开水单</button>
        <button type="button" className="btn sm" onClick={ops.deposit}>交/退押金</button>
      </div>
      <AddressBook owner={member} onChanged={refresh} compact />
    </Dialog>
  );
}
