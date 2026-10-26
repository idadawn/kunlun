/* =========================================================================
   绿麒麟 · 水站会员管理系统 —— 实库联调引擎 (k3s PostgreSQL + .NET 10 API)
   自动挂载于 admin.html / staff.html / member.html 及 Vite 应用
   ========================================================================= */
(function () {
  const API_BASE = window.KUNLUN_API_BASE || 'http://127.0.0.1:5180';

  const Live = (window.KunlunLive = {
    baseUrl: API_BASE,
    token: null,
    session: null,
    members: [],
    plans: [],
    orders: [],
    containers: [],
    finance: null,
    recharges: [],
    deposits: [],
    containerLedgers: [],
    selectedMember: null,

    async req(path, options = {}) {
      const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
      const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        throw new Error(err.message || err.error || `请求失败 (${res.status})`);
      }
      return res.json();
    },

    async staffLogin(account = 'YG0001', password = 'Kunlun@2026') {
      const s = await this.req('/api/auth/staff/login', {
        method: 'POST',
        body: JSON.stringify({ account, password }),
      });
      this.token = s.accessToken;
      this.session = s;
      return s;
    },

    async wechatPhoneLogin(phone = '13800138000', name = '陈静') {
      const s = await this.req('/api/auth/wechat/phone-login', {
        method: 'POST',
        body: JSON.stringify({ phone, wxOpenId: `wx_${phone}`, name }),
      });
      this.token = s.accessToken;
      this.session = s;
      return s;
    },

    async syncAdminAll() {
      const [members, plans, orders, containers, finance, recharges, deposits, containerLedgers] =
        await Promise.all([
          this.req('/api/members'),
          this.req('/api/plans'),
          this.req('/api/orders'),
          this.req('/api/containers/summary'),
          this.req('/api/reports/finance-summary').catch(() => null),
          this.req('/api/ledgers/recharges').catch(() => []),
          this.req('/api/ledgers/deposits').catch(() => []),
          this.req('/api/ledgers/containers').catch(() => []),
        ]);
      this.members = members;
      this.plans = plans;
      this.orders = orders;
      this.containers = containers;
      this.finance = finance;
      this.recharges = recharges;
      this.deposits = deposits;
      this.containerLedgers = containerLedgers;
      if (!this.selectedMember && members.length > 0) {
        this.selectedMember = members.find((m) => m.name === '陈静') || members[0];
      } else if (this.selectedMember) {
        this.selectedMember = members.find((m) => m.id === this.selectedMember.id) || members[0];
      }
      this.renderAdminDOM();
    },

    renderAdminDOM() {
      if (!document.getElementById('adminApp')) return;

      // 1. 注入全局 window.memberData 供原型的 openMember() 360° 抽屉使用
      if (window.memberData) {
        this.members.forEach((m) => {
          window.memberData[m.name] = {
            id: m.id,
            memberNo: m.memberNo,
            phone: m.phone,
            address: m.defaultAddress || '绿麒麟水站门店自提',
            bucket: m.bucketDeliveryTickets + m.bucketPickupTickets,
            bucketPickup: m.bucketPickupTickets,
            bucketDelivery: m.bucketDeliveryTickets,
            reservedBucket: m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets,
            bag: m.bagPickupTickets + m.bagDeliveryTickets,
            deposit: `¥${Number(m.depositAmount).toFixed(0)}`,
            held: `${m.heldBuckets} / ${m.heldBags}`,
            paidDeposit: Math.floor(Number(m.depositAmount) / 50),
            heldBucket: m.heldBuckets,
          };
        });
      }

      // 2. 更新待办水单徽章
      const pendingOrders = this.orders.filter((o) => o.status === 'PENDING' || o.status === 'DISPATCHED');
      const badge = document.getElementById('orderBadge');
      if (badge) badge.textContent = String(pendingOrders.length);
      const pendingStat = document.getElementById('pendingStat');
      if (pendingStat) pendingStat.innerHTML = `${pendingOrders.length}<small>单</small>`;

      // 3. 渲染会员管理表格 (#memberTable)
      const memberTable = document.getElementById('memberTable');
      if (memberTable && this.members.length > 0) {
        const palette = [
          '',
          'background:var(--aqua-50);color:var(--aqua-600)',
          'background:var(--gold-50);color:var(--gold-600)',
          'background:var(--violet-50);color:var(--violet-500)',
          'background:var(--orange-50);color:var(--orange-500)',
        ];
        memberTable.innerHTML = this.members
          .map(
            (m, i) => `
          <tr data-member="${m.name}">
            <td><div class="member-cell"><div class="member-avatar" style="${palette[i % palette.length]}">${m.name[0]}</div><div><b>${m.name}</b><small>${m.memberNo}</small></div></div></td>
            <td>${m.phone}</td>
            <td><b>${m.bucketPickupTickets}</b> / <b>${m.bucketDeliveryTickets}</b> 桶${m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets > 0 ? ` <span class="tag orange">预占 ${m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets}</span>` : ''}</td>
            <td><b>${m.bagPickupTickets}</b> / <b>${m.bagDeliveryTickets}</b> 袋</td>
            <td>¥ ${Number(m.depositAmount).toFixed(2)}</td>
            <td>${m.heldBuckets} 桶 / ${m.heldBags} 袋</td>
            <td>${(m.createdAt || '').slice(0, 10) || '今天'}</td>
            <td><button class="link" onclick="openMember('${m.name}')">360° 详情</button></td>
          </tr>`
          )
          .join('');
      }

      // 4. 渲染水单管理表格 (#orderTable)
      const orderTable = document.getElementById('orderTable');
      if (orderTable && this.orders.length > 0) {
        orderTable.innerHTML = this.orders
          .map((o) => {
            const isPickup = o.fulfillMode === 'PICKUP';
            const waterLabel = o.waterType === 'BUCKET_18_9L' ? '18.9L 桶装水' : '7.5L 袋装水';
            const unit = o.waterType === 'BUCKET_18_9L' ? '桶' : '袋';
            const statusMap = {
              PENDING: isPickup ? { text: '待自提', cls: 'aqua dot' } : { text: '待接单', cls: 'orange dot' },
              DISPATCHED: { text: '配送中', cls: 'green dot' },
              COMPLETED: { text: '已完成', cls: 'gray' },
              CANCELLED: { text: '已取消', cls: 'red' },
            };
            const st = statusMap[o.status] || { text: o.status, cls: 'gray' };
            const contactName = o.addressSnapshot?.contactName || '会员';
            const contactPhone = o.addressSnapshot?.contactPhone || '';
            const addr = isPickup
              ? `绿麒麟水站到店${o.pickupCode ? ` (取水码: <b>${o.pickupCode}</b>)` : ''}`
              : o.addressSnapshot?.address || '默认配送地址';
            return `
            <tr data-status="${st.text}">
              <td><span class="order-no">${o.orderNo}</span><br><small style="color:var(--muted)">${new Date(o.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 实库水单</small></td>
              <td><b>${contactName}</b><br><small style="color:var(--muted)">${contactPhone}</small></td>
              <td><span class="tag ${isPickup ? 'aqua' : 'green'}">${isPickup ? '自提' : '配送'}</span> ${addr}</td>
              <td>小分子团弱碱活性水 ${waterLabel} × <b>${o.orderQty}</b></td>
              <td>${o.status === 'COMPLETED' ? `已核销 ${o.actualQty ?? o.orderQty}` : `预占 ${o.reservedQty} ${unit}`}</td>
              <td>${o.status === 'COMPLETED' ? '已签收' : '王师傅/小林'}</td>
              <td><span class="tag ${st.cls}">${st.text}</span></td>
              <td>${
                o.status === 'PENDING' || o.status === 'DISPATCHED'
                  ? `<button class="link" onclick="openFulfill('${o.orderNo}','${contactName}','${waterLabel}',${o.orderQty},'${o.id}')">${isPickup ? '核验自提' : '接单并交付'}</button>
                     <button class="link" style="color:var(--red-500);margin-left:8px" onclick="KunlunLive.cancelOrderById('${o.id}','${o.orderNo}')">取消</button>`
                  : `<span style="color:var(--muted)">已完结</span>`
              }</td>
            </tr>`;
          })
          .join('');
      }

      // 5. 渲染充值与押金实时流水 (#financeBody)
      const financeBody = document.getElementById('financeBody');
      if (financeBody && this.recharges.length > 0) {
        financeBody.innerHTML = this.recharges
          .slice(0, 10)
          .map(
            (r) => `
          <tr>
            <td><span class="order-no">${r.rechargeNo}</span><br><small style="color:var(--muted)">${new Date(r.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></td>
            <td><b>${r.memberName}</b> <small style="color:var(--muted)">(${r.memberNo})</small></td>
            <td>${r.planName}</td>
            <td><b>¥ ${Number(r.paidAmount).toFixed(2)}</b></td>
            <td>购 ${r.buyQty} + 赠 ${r.giftQty}</td>
            <td>${r.payMethod}</td>
            <td>${r.operatorName}</td>
            <td><button class="link" onclick="toast('实库 JSONB 套餐快照已锁定 (AC-02/13)')">查看快照</button></td>
          </tr>`
          )
          .join('');
      }
    },

    async cancelOrderById(orderId, orderNo) {
      try {
        await this.req(`/api/orders/${orderId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ cancelReason: '管理端操作取消并原路释放预占水票' }),
        });
        window.GQ?.toast(`水单 ${orderNo} 已取消，预占水票已释放回可用余额 (AC-06)`);
        await this.syncAdminAll();
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    },
  });

  // 页面加载后自动连接实库并挂钩原型交互函数
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      if (document.getElementById('adminApp')) {
        await Live.staffLogin('YG0001', 'Kunlun@2026');
        await Live.syncAdminAll();
        hookAdminActions();
        window.GQ?.toast('已连接 k3s PostgreSQL 实库 (10.78.1.209:5432/kunlun)');
      } else if (document.getElementById('staffScroll')) {
        await Live.staffLogin('YG0012', 'Kunlun@2026');
        await Live.syncAdminAll();
        hookStaffActions();
        window.GQ?.toast('员工端小程序已连接 k3s PostgreSQL 实库');
      } else if (document.getElementById('memberScroll')) {
        await Live.wechatPhoneLogin('13800138000', '陈静');
        await syncMemberMiniApp();
        hookMemberActions();
        window.GQ?.toast('会员端小程序已连接 k3s PostgreSQL 实库 · 陈静 No.008621');
      }
    } catch (err) {
      console.warn('Live API 离线，当前使用静态演示数据:', err);
    }
  });

  function hookAdminActions() {
    // 1. 角色切换时调用真实后端登录
    const origApplyRole = window.applyAdminRole;
    window.applyAdminRole = async function (role, name, no) {
      try {
        await Live.staffLogin(no, 'Kunlun@2026');
        if (origApplyRole) origApplyRole(role, name, no);
        await Live.syncAdminAll();
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 2. 新建会员真实落库 (AC-01)
    window.saveMember = async function () {
      const name = document.getElementById('newMemberName')?.value?.trim();
      const phone = document.getElementById('newMemberPhone')?.value?.trim();
      if (!name || !/^1\d{10}$/.test(phone || '')) {
        window.GQ?.toast('请填写姓名和正确的 11 位手机号');
        return;
      }
      try {
        const res = await Live.req('/api/members', {
          method: 'POST',
          body: JSON.stringify({ name, phone, defaultAddress: '幸福里小区 1 栋 101 室' }),
        });
        window.closeModal?.();
        await Live.syncAdminAll();
        Live.selectedMember = Live.members.find((m) => m.id === res.id) || Live.selectedMember;
        window.GQ?.toast(`实库建档成功：${res.name}（${res.memberNo}）`);
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 3. 水费充值登记真实落库 (AC-02 / AC-03 / AC-05)
    window.completeRecharge = async function () {
      const m = Live.selectedMember || Live.members[0];
      if (!m) return;
      const activeChoice = document.querySelector('.choice[data-group="plan"].active');
      const getCnt = Number(activeChoice?.dataset?.get || 12);
      const planId =
        getCnt === 14
          ? '30000000-0000-0000-0000-000000000002'
          : getCnt === 11
          ? '30000000-0000-0000-0000-000000000003'
          : '30000000-0000-0000-0000-000000000001';
      try {
        const res = await Live.req('/api/recharges', {
          method: 'POST',
          body: JSON.stringify({
            memberId: m.id,
            planId,
            payMethod: 'WECHAT',
            idempotencyKey: `ui-rcg-${Date.now()}`,
          }),
        });
        await Live.syncAdminAll();
        window.setModal?.(
          '充值入账成功 (k3s 实库)',
          `<div class="success-state"><div class="success-icon">${window.GQ.icon('check')}</div><h3>水票已实时入账</h3><p>水费实收与优惠方案 JSONB 快照已写入 PostgreSQL</p><div class="success-detail"><div class="detail-row"><span>会员</span><b>${m.name} · ${m.phone} (${m.memberNo})</b></div><div class="detail-row"><span>实库充值单号</span><b>${res.rechargeNo}</b></div><div class="detail-row"><span>到账明细</span><b style="color:var(--brand-600)">购 ${res.buyQty} + 赠 ${res.giftQty} = 共 ${res.totalTickets} 张水票</b></div></div></div>`,
          `<button class="btn" onclick="closeModal()">返回</button><button class="btn primary" onclick="openModal('order')">继续代开水单</button>`
        );
        window.GQ?.toast(`实库充值成功：单号 ${res.rechargeNo}`);
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 4. 独立押金收款 / 原单价 FIFO 退押金真实落库 (AC-03 / AC-11 / AC-12)
    window.completeDeposit = async function () {
      const m = Live.selectedMember || Live.members[0];
      if (!m) return;
      const qty = Number(document.getElementById('depositQty')?.value || 1);
      const isBag = document.querySelector('.choice[data-group="depositType"].active')?.dataset?.value === '袋';
      const containerType = isBag ? 'BAG' : 'BUCKET';
      try {
        if (window.depositModeValue === 'refund') {
          const rf = await Live.req('/api/deposits/refund', {
            method: 'POST',
            body: JSON.stringify({
              memberId: m.id,
              containerType,
              refundQty: qty,
              idempotencyKey: `ui-ref-${Date.now()}`,
            }),
          });
          window.closeModal?.();
          await Live.syncAdminAll();
          window.GQ?.toast(`实库退押成功：单号 ${rf.refundNo}，按原批次单价退还 ¥${Number(rf.refundAmount).toFixed(2)}`);
        } else {
          const dep = await Live.req('/api/deposits/collect', {
            method: 'POST',
            body: JSON.stringify({
              memberId: m.id,
              containerType,
              quantity: qty,
              payMethod: 'WECHAT',
              idempotencyKey: `ui-dep-${Date.now()}`,
            }),
          });
          window.closeModal?.();
          await Live.syncAdminAll();
          window.GQ?.toast(`实库收押成功：单号 ${dep.depositNo}，金额 ¥${Number(dep.totalAmount).toFixed(2)}`);
        }
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 5. 代开水单真实落库 (AC-04 防透支 / 预占水票 / 生成 6 位取水码)
    window.completeOrder = async function () {
      const m = Live.selectedMember || Live.members[0];
      if (!m) return;
      const isPickup =
        document.querySelector('.choice[data-group="memberMethod"].active')?.dataset?.value === '自提';
      const isBag = document.querySelector('.choice[data-group="water"].active')?.textContent?.includes('7.5L');
      const qty = Number(document.getElementById('orderQty')?.value || 2);
      try {
        const res = await Live.req('/api/orders', {
          method: 'POST',
          body: JSON.stringify({
            memberId: m.id,
            waterType: isBag ? 'BAG_7_5L' : 'BUCKET_18_9L',
            fulfillMode: isPickup ? 'PICKUP' : 'DELIVERY',
            orderQty: qty,
            idempotencyKey: `ui-ord-${Date.now()}`,
          }),
        });
        window.closeModal?.();
        await Live.syncAdminAll();
        window.GQ?.toast(
          `实库水单 ${res.orderNo} 创建成功！${res.pickupCode ? `6位自提码：${res.pickupCode}` : `已预占 ${qty} 张水票`}`
        );
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 6. 水单交付与容器 N 出 M 入核销真实落库 (AC-07 / AC-08 / AC-09 / AC-14 / AC-20)
    const origOpenFulfill = window.openFulfill;
    window.openFulfill = function (no, name, water, qty, orderId) {
      window._currentFulfillOrderId = orderId || Live.orders.find((o) => o.orderNo === no)?.id;
      if (origOpenFulfill) origOpenFulfill(no, name, water, qty);
    };

    window.completeFulfill = async function (no) {
      const orderId = window._currentFulfillOrderId || Live.orders.find((o) => o.orderNo === no)?.id;
      if (!orderId) {
        window.closeModal?.();
        window.GQ?.toast(`水单 ${no} 已完成交付核销`);
        return;
      }
      const actualQty = Number(document.getElementById('fulfillQty')?.value || 1);
      const fullOutN = Number(document.getElementById('outQty')?.value || 1);
      const emptyInM = Number(document.getElementById('inQty')?.value || 1);
      const diffReason = document.getElementById('diffReason')?.value?.trim() || null;
      try {
        const res = await Live.req(`/api/orders/${orderId}/fulfill`, {
          method: 'POST',
          body: JSON.stringify({ actualQty, fullOutN, emptyInM, diffReason }),
        });
        window.closeModal?.();
        await Live.syncAdminAll();
        window.GQ?.toast(
          `实库核销完成：${res.orderNo}（发出 ${res.fullOutN} / 收回 ${res.emptyInM}，持有 ${res.heldAfter}）`
        );
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 7. 报表导出调用真实后端 CSV 接口 (AC-16 / AC-18)
    window.exportCSV = async function () {
      try {
        const headers = {};
        if (Live.token) headers['Authorization'] = `Bearer ${Live.token}`;
        const res = await fetch(`${Live.baseUrl}/api/exports/orders`, { headers });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: '无导出权限 (AC-16)' }));
          throw new Error(err.message || err.error || '无导出权限 (AC-16)');
        }
        const csv = await res.text();
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `绿麒麟水站_实库台账_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        window.GQ?.toast('已从 k3s PostgreSQL 导出真实 CSV 报表 (AC-18)');
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };
  }

  async function syncMemberMiniApp() {
    if (!Live.session) return;
    const [p, orders] = await Promise.all([
      Live.req(`/api/members/${Live.session.subjectId}/profile`),
      Live.req(`/api/orders?memberId=${Live.session.subjectId}`),
    ]);
    Live.selectedMember = p;
    Live.orders = orders;

    const delivEl = document.getElementById('mDelivBucket');
    if (delivEl) delivEl.innerHTML = `${p.bucketDeliveryTickets}<small>桶</small>`;
    const preHoldEl = document.getElementById('mPreHold');
    if (preHoldEl) preHoldEl.textContent = `预占 ${p.reservedBucketDeliveryTickets}`;
  }

  function hookMemberActions() {
    window.submitMemberOrder = async function () {
      const m = Live.selectedMember;
      if (!m) return;
      const isPickup = window.mMode === '自提';
      const isBag = document.getElementById('mWaterSel')?.value === '袋';
      const qty = Number(document.getElementById('mOrdQty')?.value || 2);
      try {
        const res = await Live.req('/api/orders', {
          method: 'POST',
          body: JSON.stringify({
            memberId: m.id,
            waterType: isBag ? 'BAG_7_5L' : 'BUCKET_18_9L',
            fulfillMode: isPickup ? 'PICKUP' : 'DELIVERY',
            orderQty: qty,
            idempotencyKey: `mp-ord-${Date.now()}`,
          }),
        });
        window.closeMSheet?.();
        await syncMemberMiniApp();
        if (isPickup && res.pickupCode) {
          window.showPickupQr?.(res.orderNo, res.pickupCode);
        } else {
          window.GQ?.toast(`实库预约成功！单号 ${res.orderNo}，剩余可用票 ${res.availableTicketsAfter}`);
          window.memberNav?.('orders');
        }
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };
  }

  function hookStaffActions() {
    const origSwitch = window.switchStaffRole;
    window.switchStaffRole = async function (role) {
      try {
        await Live.staffLogin(role === 'COURIER' ? 'YG0008' : 'YG0012', 'Kunlun@2026');
        if (origSwitch) origSwitch(role);
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };
  }
})();
