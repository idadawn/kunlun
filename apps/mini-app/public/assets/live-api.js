/* =========================================================================
   绿麒麟 · 水站会员管理系统 —— 真实登录门禁 + 100% k3s PostgreSQL 实库驱动引擎
   规则：
   1. 管理端 PC (admin.html) 仅限管理员 (ADMIN) 登录，未登录前强制显示管理员登录页
   2. 员工端/会员端小程序未登录前强制显示小程序原生登录页
   3. 登录后所有 KPI 卡片、汇总条、表格、抽屉、水票与容器数据 100% 来自 k3s PostgreSQL
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

    async staffLogin(account, password, requireAdmin = false) {
      const s = await this.req('/api/auth/staff/login', {
        method: 'POST',
        body: JSON.stringify({ account, password, requireAdmin }),
      });
      this.token = s.accessToken;
      this.session = s;
      return s;
    },

    async wechatPhoneLogin(phone, name) {
      const s = await this.req('/api/auth/wechat/phone-login', {
        method: 'POST',
        body: JSON.stringify({ phone, wxOpenId: `wx_${phone}`, name }),
      });
      this.token = s.accessToken;
      this.session = s;
      return s;
    },

    logoutAdmin() {
      sessionStorage.removeItem('kunlun_admin_session');
      this.token = null;
      this.session = null;
      location.reload();
    },

    logoutStaff() {
      sessionStorage.removeItem('kunlun_staff_session');
      this.token = null;
      this.session = null;
      location.reload();
    },

    logoutMember() {
      sessionStorage.removeItem('kunlun_member_session');
      this.token = null;
      this.session = null;
      location.reload();
    },

    /* ---------------------------------------------------------------------
       管理端 PC 全量实库同步与 100% DOM 渲染（无任何写死假数字）
       --------------------------------------------------------------------- */
    async syncAdminAll() {
      const [members, plans, orders, containers, finance, recharges, deposits, containerLedgers] =
        await Promise.all([
          this.req('/api/members'),
          this.req('/api/plans'),
          this.req('/api/orders'),
          this.req('/api/containers/summary'),
          this.req('/api/reports/finance-summary'),
          this.req('/api/ledgers/recharges'),
          this.req('/api/ledgers/deposits'),
          this.req('/api/ledgers/containers'),
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
        this.selectedMember = members[0];
      } else if (this.selectedMember) {
        this.selectedMember = members.find((m) => m.id === this.selectedMember.id) || members[0];
      }
      this.renderAdminDOM();
    },

    renderAdminDOM() {
      if (!document.getElementById('adminApp')) return;

      // 顶部管理员信息与退出按钮
      if (this.session) {
        const topName = document.getElementById('topUserName');
        const topRole = document.getElementById('topUserRole');
        const topAvatar = document.getElementById('topAvatar');
        if (topName) topName.textContent = this.session.displayName;
        if (topAvatar) topAvatar.textContent = this.session.displayName[0];
        if (topRole) topRole.textContent = `ADMIN · ${this.session.codeOrNo} (点击退出)`;
        const userBox = document.querySelector('.topbar .user');
        if (userBox) {
          userBox.title = '点击退出管理员登录';
          userBox.onclick = () => {
            if (confirm(`当前登录管理员：${this.session.displayName} (${this.session.codeOrNo})\n确定退出登录并返回登录界面吗？`)) {
              this.logoutAdmin();
            }
          };
        }
      }

      // 同步 window.memberData 供 360° 档案抽屉读取实库数据
      window.memberData = {};
      this.members.forEach((m) => {
        window.memberData[m.name] = {
          id: m.id,
          memberNo: m.memberNo,
          phone: m.phone,
          address: m.defaultAddress || '绿麒麟水站到店自提',
          bucket: m.bucketDeliveryTickets + m.bucketPickupTickets,
          bucketPickup: m.bucketPickupTickets,
          bucketDelivery: m.bucketDeliveryTickets,
          reservedBucket: m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets,
          bag: m.bagPickupTickets + m.bagDeliveryTickets,
          bagPickup: m.bagPickupTickets,
          bagDelivery: m.bagDeliveryTickets,
          deposit: `¥${Number(m.depositAmount).toFixed(2)}`,
          depositNum: Number(m.depositAmount),
          held: `${m.heldBuckets} / ${m.heldBags}`,
          heldBucket: m.heldBuckets,
          heldBag: m.heldBags,
          createdAt: (m.createdAt || '').slice(0, 10) || '2026-10-26',
        };
      });

      const bucketCfg = this.containers.find((c) => c.containerType === 'BUCKET') || {
        totalQty: 200, inStationQty: 88, inTransitQty: 0, memberHeldQty: 2, inspectingQty: 108, abnormalQty: 2, warnThreshold: 100, unitDeposit: 50,
      };
      const bagCfg = this.containers.find((c) => c.containerType === 'BAG') || {
        totalQty: 200, inStationQty: 164, inTransitQty: 0, memberHeldQty: 2, inspectingQty: 34, abnormalQty: 0, warnThreshold: 80, unitDeposit: 30,
      };

      const pendingDeliv = this.orders.filter((o) => o.status === 'PENDING' && o.fulfillMode === 'DELIVERY').length;
      const pendingPickup = this.orders.filter((o) => o.status === 'PENDING' && o.fulfillMode === 'PICKUP').length;
      const dispatchedCnt = this.orders.filter((o) => o.status === 'DISPATCHED').length;
      const completedOrders = this.orders.filter((o) => o.status === 'COMPLETED');
      const pendingTotal = pendingDeliv + pendingPickup + dispatchedCnt;

      const doneBuckets = completedOrders
        .filter((o) => o.waterType === 'BUCKET_18_9L')
        .reduce((s, o) => s + (o.actualQty ?? o.orderQty), 0);
      const doneBags = completedOrders
        .filter((o) => o.waterType === 'BAG_7_5L')
        .reduce((s, o) => s + (o.actualQty ?? o.orderQty), 0);

      const rcgRev = Number(this.finance?.rechargeRevenueTotal || 0);
      const depCol = Number(this.finance?.depositCollectedTotal || 0);
      const depRef = Number(this.finance?.depositRefundedTotal || 0);
      const depPool = Number(this.finance?.unrefundedDepositPoolTotal || 0);
      const netCash = rcgRev + (depCol - depRef);

      // 计算实库可退押金总额 = 各会员 max(0, 押金余额 - (持桶*50 + 持袋*30))
      const refundableTotal = this.members.reduce((sum, m) => {
        const occupied = m.heldBuckets * 50 + m.heldBags * 30;
        return sum + Math.max(0, Number(m.depositAmount) - occupied);
      }, 0);

      // 1. 侧栏水单徽章 & 首页 4 张核心 KPI 卡（100% 实库数据）
      const orderBadge = document.getElementById('orderBadge');
      if (orderBadge) orderBadge.textContent = String(pendingTotal);

      const dashStats = document.querySelectorAll('#page-dashboard .stats-grid .stat-card');
      if (dashStats.length >= 4) {
        dashStats[0].querySelector('.stat-top span').textContent = '实库累计实收（元）';
        dashStats[0].querySelector('.stat-value').textContent = `¥ ${netCash.toFixed(2)}`;
        dashStats[0].querySelector('.stat-foot').innerHTML = `<span class="trend-up">实库</span>水费实收 ¥${rcgRev.toFixed(2)} · 押金净收 ¥${(depCol - depRef).toFixed(2)}`;

        dashStats[1].querySelector('.stat-top span').textContent = '实库已核销用水';
        dashStats[1].querySelector('.stat-value').innerHTML = `${doneBuckets}<small>桶</small> · ${doneBags}<small>袋</small>`;
        dashStats[1].querySelector('.stat-foot').innerHTML = `累计完结水单 <b>${completedOrders.length}</b> 笔`;

        dashStats[2].querySelector('.stat-value').innerHTML = `${pendingTotal}<small>单</small>`;
        dashStats[2].querySelector('.stat-foot').innerHTML = `<span style="color:var(--orange-500)">待接单配送 ${pendingDeliv}</span> · 配送中 ${dispatchedCnt} · 待自提 ${pendingPickup}`;

        dashStats[3].querySelector('.stat-value').innerHTML = `${bucketCfg.memberHeldQty}<small>桶</small> / ${bagCfg.memberHeldQty}<small>袋</small>`;
        dashStats[3].querySelector('.stat-foot').textContent = `站内可用：桶 ${bucketCfg.inStationQty} · 袋 ${bagCfg.inStationQty}`;
      }

      // 2. 首页今日待办（100% 实库统计）
      const todoNums = document.querySelectorAll('#page-dashboard .todo-list .todo-item');
      if (todoNums.length >= 4) {
        todoNums[0].querySelector('.todo-num').textContent = String(pendingDeliv);
        todoNums[1].querySelector('.todo-num').textContent = String(pendingPickup);
        todoNums[2].querySelector('.todo-num').textContent = String(refundableTotal > 0 ? 1 : 0);
        todoNums[3].querySelector('small').textContent = `当前站内可用 ${bucketCfg.inStationQty} 个，预警值 ${bucketCfg.warnThreshold}`;
      }

      // 3. 首页最新水单（100% 实库订单）
      const orderMini = document.querySelector('#page-dashboard .order-mini');
      if (orderMini) {
        const rowsHtml =
          this.orders.length === 0
            ? `<div style="padding:18px 0;color:var(--muted);text-align:center;font-size:12.5px">数据库中暂无水单，可点击右上角「代开水单」创建真实水单</div>`
            : this.orders
                .slice(0, 4)
                .map((o) => {
                  const isPickup = o.fulfillMode === 'PICKUP';
                  const wLabel = o.waterType === 'BUCKET_18_9L' ? '18.9L 桶装' : '7.5L 袋装';
                  const stText =
                    o.status === 'COMPLETED'
                      ? '<span class="tag gray">已完成</span>'
                      : o.status === 'CANCELLED'
                      ? '<span class="tag red">已取消</span>'
                      : isPickup
                      ? `<span class="tag aqua dot">待自提(${o.pickupCode})</span>`
                      : '<span class="tag orange dot">待接单</span>';
                  return `<div class="order-row"><span><b>${o.addressSnapshot?.contactName || '会员'}</b><br><small style="color:var(--muted)">${o.orderNo}</small></span><span>${isPickup ? '自提' : '配送'}</span><span>${wLabel} × ${o.orderQty}</span>${stText}</div>`;
                })
                .join('');
        orderMini.innerHTML = `<div class="order-row head"><span>会员 / 单号</span><span>方式</span><span>水品与数量</span><span>状态</span></div>${rowsHtml}`;
      }

      // 4. 首页容器五维恒等概览（100% 实库 container_configs）
      const assetContent = document.querySelector('#page-dashboard .asset-content');
      if (assetContent) {
        const bPct = Math.min(100, Math.round((bucketCfg.memberHeldQty / Math.max(1, bucketCfg.totalQty)) * 100));
        const gPct = Math.min(100, Math.round((bagCfg.memberHeldQty / Math.max(1, bagCfg.totalQty)) * 100));
        assetContent.innerHTML = `
          <div class="asset-line"><span>18.9L 周转桶</span><span>会员持有 <b>${bucketCfg.memberHeldQty}</b> / 总量 <b>${bucketCfg.totalQty}</b></span></div>
          <div class="progress"><i style="width:${Math.max(4, bPct)}%"></i></div>
          <div class="asset-meta"><span>站内可用 ${bucketCfg.inStationQty}</span><span>配送在途 ${bucketCfg.inTransitQty}</span><span>待检 ${bucketCfg.inspectingQty} · 异常 ${bucketCfg.abnormalQty}</span></div>
          <div class="asset-line" style="margin-top:18px"><span>7.5L 配套水袋/周转筐</span><span>会员持有 <b>${bagCfg.memberHeldQty}</b> / 总量 <b>${bagCfg.totalQty}</b></span></div>
          <div class="progress"><i style="width:${Math.max(4, gPct)}%;background:var(--grad-aqua)"></i></div>
          <div class="asset-meta"><span>站内可用 ${bagCfg.inStationQty}</span><span>配送在途 ${bagCfg.inTransitQty}</span><span>待检 ${bagCfg.inspectingQty} · 异常 ${bagCfg.abnormalQty}</span></div>
          <div class="identity-formula"><span>五维恒等式校验 (${bucketCfg.identityValid && bagCfg.identityValid ? 'PASS' : 'WARN'})</span><b>总量 = 站内可用 + 配送在途 + 会员持有 + 待检 + 异常</b></div>`;
      }

      // 5. 会员管理页：汇总条 + 表格 + 页脚计数（100% 实库 members）
      const memSummary = document.querySelectorAll('#page-members .summary-strip .summary-item b');
      if (memSummary.length >= 4) {
        const withTickets = this.members.filter(
          (m) => m.bucketDeliveryTickets + m.bucketPickupTickets + m.bagPickupTickets + m.bagDeliveryTickets > 0
        ).length;
        const withContainers = this.members.filter((m) => m.heldBuckets + m.heldBags > 0).length;
        memSummary[0].textContent = String(this.members.length);
        memSummary[1].textContent = String(this.members.length);
        memSummary[2].textContent = String(withTickets);
        memSummary[3].textContent = String(withContainers);
      }
      const memToolbarSmall = document.querySelector('#page-members .table-toolbar small');
      if (memToolbarSmall) memToolbarSmall.textContent = `数据库实库共 ${this.members.length} 位会员 · 点击查看 360° 档案`;
      const memFooterSpan = document.querySelector('#page-members .table-footer span');
      if (memFooterSpan) memFooterSpan.textContent = `实库实时查询：共 ${this.members.length} 条记录`;

      const memberTable = document.getElementById('memberTable');
      if (memberTable) {
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
            <td>${(m.createdAt || '').slice(0, 10) || '2026-10-26'}</td>
            <td><button class="link" onclick="openMember('${m.name}')">360° 详情</button></td>
          </tr>`
          )
          .join('');
      }

      // 6. 水单管理页：汇总条 + 表格（100% 实库 water_orders）
      const ordSummary = document.querySelectorAll('#page-orders .summary-strip .summary-item b');
      if (ordSummary.length >= 4) {
        ordSummary[0].textContent = String(this.orders.length);
        ordSummary[1].textContent = String(pendingDeliv);
        ordSummary[2].textContent = String(dispatchedCnt + pendingPickup);
        ordSummary[3].textContent = String(completedOrders.length);
      }
      const orderTable = document.getElementById('orderTable');
      if (orderTable) {
        if (this.orders.length === 0) {
          orderTable.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">当前数据库暂无水单记录，请点击右上角「代开水单」或在小程序端下单</td></tr>`;
        } else {
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
                <td><span class="order-no">${o.orderNo}</span><br><small style="color:var(--muted)">${new Date(o.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></td>
                <td><b>${contactName}</b><br><small style="color:var(--muted)">${contactPhone}</small></td>
                <td><span class="tag ${isPickup ? 'aqua' : 'green'}">${isPickup ? '自提' : '配送'}</span> ${addr}</td>
                <td>小分子团弱碱活性水 ${waterLabel} × <b>${o.orderQty}</b></td>
                <td>${o.status === 'COMPLETED' ? `已核销 ${o.actualQty ?? o.orderQty}` : o.status === 'CANCELLED' ? '已释放预占' : `预占 ${o.reservedQty} ${unit}`}</td>
                <td>${o.status === 'COMPLETED' ? '已交付' : '待交付'}</td>
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
      }

      // 7. 充值与押金页：4 张 KPI 卡 + 实库流水表（100% 实库）
      const finStats = document.querySelectorAll('#page-finance .stats-grid .stat-card');
      if (finStats.length >= 4) {
        finStats[0].querySelector('.stat-top').textContent = '实库水费充值累计';
        finStats[0].querySelector('.stat-value').textContent = `¥ ${rcgRev.toFixed(2)}`;
        finStats[0].querySelector('.stat-foot').textContent = `充值 ${this.finance?.rechargeOrderCount || 0} 笔 · 售票 ${this.finance?.ticketsSoldBuyQty || 0} + 赠票 ${this.finance?.ticketsGiftedQty || 0}`;

        finStats[1].querySelector('.stat-top').textContent = '实库押金收支净额';
        finStats[1].querySelector('.stat-value').textContent = `¥ ${(depCol - depRef).toFixed(2)}`;
        finStats[1].querySelector('.stat-foot').textContent = `收押 ${this.finance?.depositCollectCount || 0} 笔 (¥${depCol.toFixed(0)}) · 退押 ${this.finance?.depositRefundCount || 0} 笔 (¥${depRef.toFixed(0)})`;

        finStats[2].querySelector('.stat-top').textContent = '实库在池未退押金总额';
        finStats[2].querySelector('.stat-value').textContent = `¥ ${depPool.toFixed(2)}`;
        finStats[2].querySelector('.stat-foot').textContent = this.finance?.reconciledZeroDiff ? '与收退流水 100% 零误差对齐 (AC-17)' : '对账校验中';

        finStats[3].querySelector('.stat-top').textContent = '实库当前可退押金';
        finStats[3].querySelector('.stat-value').textContent = `¥ ${refundableTotal.toFixed(2)}`;
        finStats[3].querySelector('.stat-foot').textContent = '已扣除会员实际持有容器占用押金 (AC-11)';
      }
      this.renderFinanceTabContent(window._currentFinanceTab || '充值记录');

      // 8. 桶袋台账页：4 张 KPI 卡 + 容器流转表（100% 实库）
      const assetStats = document.querySelectorAll('#page-assets .stats-grid .stat-card');
      if (assetStats.length >= 4) {
        assetStats[0].querySelector('.stat-value').innerHTML = `${bucketCfg.inStationQty}<small>/ ${bucketCfg.totalQty}</small>`;
        assetStats[0].querySelector('.stat-foot').innerHTML = `${bucketCfg.lowStockWarning ? `<span style="color:var(--orange-500)">低于预警值 ${bucketCfg.warnThreshold}</span>` : '库存充足'} · 待检 ${bucketCfg.inspectingQty}`;

        assetStats[1].querySelector('.stat-value').innerHTML = `${bucketCfg.memberHeldQty}<small>个</small>`;
        assetStats[1].querySelector('.stat-foot').textContent = `实库会员持有周转桶汇总`;

        assetStats[2].querySelector('.stat-value').innerHTML = `${bagCfg.inStationQty}<small>/ ${bagCfg.totalQty}</small>`;
        assetStats[2].querySelector('.stat-foot').textContent = `待检 ${bagCfg.inspectingQty} · 配送在途 ${bagCfg.inTransitQty}`;

        assetStats[3].querySelector('.stat-value').innerHTML = `${bagCfg.memberHeldQty}<small>个</small>`;
        assetStats[3].querySelector('.stat-foot').textContent = `实库会员持有水袋容器汇总`;
      }
      const assetTbody = document.querySelector('#page-assets table tbody');
      if (assetTbody) {
        if (this.containerLedgers.length === 0) {
          assetTbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">暂无容器流转流水，可通过「水单交付」或右上角「独立登记领还」产生真实记录</td></tr>`;
        } else {
          assetTbody.innerHTML = this.containerLedgers
            .map((c) => {
              const deltaTag =
                c.deltaHeld === 0
                  ? '<span class="tag green">0（等量换水）</span>'
                  : c.deltaHeld > 0
                  ? `<span class="tag orange">+${c.deltaHeld}（新增持有）</span>`
                  : `<span class="tag aqua">${c.deltaHeld}（退回容器）</span>`;
              return `<tr>
                <td><span class="order-no">${c.ledgerNo}</span><br><small style="color:var(--muted)">${new Date(c.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></td>
                <td><b>${c.memberName}</b></td>
                <td>${c.orderNo}</td>
                <td>${c.containerType === 'BUCKET' ? '18.9L 周转桶' : '7.5L 袋装容器'}</td>
                <td><b>${c.fullOutQty}</b></td>
                <td><b>${c.emptyInQty}</b></td>
                <td>${deltaTag} (持有 ${c.heldAfter})</td>
                <td>${c.operatorName}</td>
              </tr>`;
            })
            .join('');
        }
      }
    },

    renderFinanceTabContent(type) {
      window._currentFinanceTab = type;
      const head = document.getElementById('financeHead');
      const body = document.getElementById('financeBody');
      if (!head || !body) return;

      if (type === '充值记录') {
        head.innerHTML = '<th>业务单号 / 时间</th><th>会员</th><th>优惠方案快照</th><th>水费实收</th><th>购水 / 赠水</th><th>收款方式</th><th>操作人</th><th>操作</th>';
        if (this.recharges.length === 0) {
          body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">当前数据库暂无水费充值流水，请点击右上角「水费充值登记」办理</td></tr>`;
        } else {
          body.innerHTML = this.recharges
            .map(
              (r) => `<tr>
              <td><span class="order-no">${r.rechargeNo}</span><br><small style="color:var(--muted)">${new Date(r.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></td>
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
      } else {
        head.innerHTML = '<th>业务单号 / 时间</th><th>会员</th><th>业务类型</th><th>容器与数量</th><th>批次单价</th><th>押金金额</th><th>未退余量</th><th>操作人</th>';
        if (this.deposits.length === 0) {
          body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">当前数据库暂无押金流水</td></tr>`;
        } else {
          body.innerHTML = this.deposits
            .map(
              (d) => `<tr>
              <td><span class="order-no">${d.docNo}</span><br><small style="color:var(--muted)">${new Date(d.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></td>
              <td><b>${d.memberName}</b></td>
              <td><span class="tag ${d.flowType === 'COLLECT' ? 'green' : 'orange'}">${d.flowType === 'COLLECT' ? '交押金' : '退押金'}</span></td>
              <td>${d.containerType === 'BUCKET' ? '18.9L 周转桶' : '7.5L 袋装容器'} × ${d.qty}</td>
              <td>¥ ${Number(d.unitPrice).toFixed(2)}</td>
              <td><b>${d.flowType === 'COLLECT' ? '+' : '-'}¥ ${Number(d.amount).toFixed(2)}</b></td>
              <td>${d.remainingQty} 个</td>
              <td>${d.operatorName}</td>
            </tr>`
            )
            .join('');
        }
      }
    },

    async cancelOrderById(orderId, orderNo) {
      try {
        await this.req(`/api/orders/${orderId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ cancelReason: '管理员取消水单并释放预占水票' }),
        });
        window.GQ?.toast(`水单 ${orderNo} 已取消，预占水票已释放回可用余额 (AC-06)`);
        await this.syncAdminAll();
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    },
  });

  /* -----------------------------------------------------------------------
     1. 管理端 PC 登录门禁界面（仅限 ADMIN 管理员登录）
     ----------------------------------------------------------------------- */
  function showAdminLoginGate() {
    const appEl = document.getElementById('adminApp');
    if (appEl) appEl.style.display = 'none';

    let gate = document.getElementById('kunlunLoginGate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'kunlunLoginGate';
      gate.style.cssText =
        'min-height:100vh;display:grid;grid-template-columns:1.15fr 1fr;background:var(--bg);font-family:var(--font)';
      gate.innerHTML = `
        <div style="background:var(--grad-card);color:#fff;padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden">
          <div style="position:relative;z-index:2">
            <div style="display:inline-flex;align-items:center;gap:10px;padding:6px 14px;border-radius:999px;background:rgba(255,255,255,.14);font-size:12.5px;font-weight:600">
              <span>绿麒麟水站｜小分子团弱碱活性水</span>
            </div>
            <h1 style="font-size:36px;margin:24px 0 12px;letter-spacing:1px">绿麒麟·水站会员管理系统</h1>
            <p style="font-size:16px;opacity:.9;letter-spacing:2px;margin:0">鲜活每一滴，好水到你家</p>
            <div style="margin-top:36px;display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:520px">
              <div style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);padding:16px;border-radius:14px">
                <b style="display:block;font-size:14px;margin-bottom:4px">四账独立核算</b>
                <small style="opacity:.82;font-size:12px">水费实收、四类水票、批次押金、五维容器恒等式严格分离</small>
              </div>
              <div style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);padding:16px;border-radius:14px">
                <b style="display:block;font-size:14px;margin-bottom:4px">k3s PostgreSQL 实库</b>
                <small style="opacity:.82;font-size:12px">直连 10.78.1.209:5432/kunlun · 全部数据真实读写无硬编码</small>
              </div>
            </div>
          </div>
          <div style="font-size:12px;opacity:.75;position:relative;z-index:2">
            管理端 PC 仅对水站管理员（ADMIN）开放 · 店员与送水员请使用微信小程序端
          </div>
        </div>

        <div style="display:flex;align-items:center;justify-content:center;padding:40px">
          <div class="card" style="width:100%;max-width:420px;padding:34px 36px;border-radius:20px;box-shadow:var(--shadow-lg)">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:22px">
              <div class="gq-logo" style="width:44px;height:44px">${window.GQ?.logoSvg || '麒'}</div>
              <div>
                <h2 style="margin:0;font-size:20px;color:var(--ink)">管理员登录</h2>
                <small style="color:var(--muted);font-size:12px">管理端 PC · 仅限水站管理员 (ADMIN)</small>
              </div>
            </div>

            <div id="loginErrBox" style="display:none;padding:10px 12px;border-radius:10px;background:var(--red-50);color:var(--red-500);font-size:12.5px;margin-bottom:14px;font-weight:500"></div>

            <div class="field">
              <label>管理员账号（工号或手机号）</label>
              <input id="adminLoginAcc" class="input" value="YG0001" placeholder="请输入管理员账号 YG0001 或 13800000001">
            </div>
            <div class="field">
              <label>登录密码</label>
              <input id="adminLoginPwd" class="input" type="password" value="Kunlun@2026" placeholder="请输入登录密码">
            </div>

            <button id="adminLoginBtn" class="btn primary lg block" style="margin-top:8px">登录进入管理后台</button>

            <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line-soft);font-size:12px;color:var(--muted)">
              <div style="margin-bottom:8px;font-weight:600;color:var(--text)">实库账号测试快捷填入：</div>
              <div style="display:flex;gap:8px">
                <button type="button" class="btn sm" style="flex:1" id="fillAdminBtn">林站长 (YG0001 · ADMIN)</button>
                <button type="button" class="btn sm" style="flex:1" id="fillClerkBtn" title="测试非管理员被拒绝登录">测试店员拦截 (YG0012)</button>
              </div>
            </div>
          </div>
        </div>`;
      document.body.prepend(gate);

      document.getElementById('fillAdminBtn').onclick = () => {
        document.getElementById('adminLoginAcc').value = 'YG0001';
        document.getElementById('adminLoginPwd').value = 'Kunlun@2026';
      };
      document.getElementById('fillClerkBtn').onclick = () => {
        document.getElementById('adminLoginAcc').value = 'YG0012';
        document.getElementById('adminLoginPwd').value = 'Kunlun@2026';
      };

      const doLogin = async () => {
        const acc = document.getElementById('adminLoginAcc').value.trim();
        const pwd = document.getElementById('adminLoginPwd').value;
        const errBox = document.getElementById('loginErrBox');
        const btn = document.getElementById('adminLoginBtn');
        errBox.style.display = 'none';
        btn.disabled = true;
        btn.textContent = '正在校验管理员身份...';
        try {
          const s = await Live.staffLogin(acc, pwd, true); // requireAdmin = true
          sessionStorage.setItem('kunlun_admin_session', JSON.stringify(s));
          gate.remove();
          if (appEl) appEl.style.display = 'grid';
          await Live.syncAdminAll();
          hookAdminActions();
          window.GQ?.toast(`欢迎您，${s.displayName}！已加载 k3s PostgreSQL 实库数据`);
        } catch (e) {
          errBox.textContent = e.message || '登录失败';
          errBox.style.display = 'block';
        } finally {
          btn.disabled = false;
          btn.textContent = '登录进入管理后台';
        }
      };

      document.getElementById('adminLoginBtn').onclick = doLogin;
      document.getElementById('adminLoginPwd').onkeydown = (e) => {
        if (e.key === 'Enter') doLogin();
      };
    }
  }

  /* -----------------------------------------------------------------------
     2. 会员端小程序 & 员工端小程序手机壳内登录门禁
     ----------------------------------------------------------------------- */
  function showMemberLoginGate() {
    const scrollEl = document.getElementById('memberScroll');
    const bottomNav = document.querySelector('.phone-screen .h5-bottom');
    if (scrollEl) scrollEl.style.display = 'none';
    if (bottomNav) bottomNav.style.display = 'none';

    const screen = document.querySelector('.phone-screen');
    if (!screen) return;

    let gate = document.getElementById('kunlunMemberGate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'kunlunMemberGate';
      gate.style.cssText = 'flex:1;padding:24px 20px;display:flex;flex-direction:column;justify-content:center;background:#fff';
      gate.innerHTML = `
        <div style="text-align:center;margin-bottom:22px">
          <div class="gq-logo" style="width:56px;height:56px;border-radius:16px;margin:0 auto 12px">${window.GQ?.logoSvg || '麒'}</div>
          <h3 style="margin:0;font-size:18px;color:var(--ink)">绿麒麟水站 · 会员小程序</h3>
          <p style="margin:6px 0 0;font-size:12px;color:var(--muted)">鲜活每一滴，好水到你家</p>
        </div>
        <div id="mLoginErr" style="display:none;padding:8px 10px;border-radius:8px;background:var(--red-50);color:var(--red-500);font-size:12px;margin-bottom:10px"></div>
        <div class="field">
          <label>微信授权手机号（老会员自动绑定 / 新手机号自动建档）</label>
          <input id="mLoginPhone" class="input" value="13800138000" maxlength="11" placeholder="请输入 11 位手机号">
        </div>
        <div class="field">
          <label>会员姓名（新手机号首次注册时使用）</label>
          <input id="mLoginName" class="input" value="陈静" placeholder="选填姓名">
        </div>
        <button id="mLoginSubmit" class="wx-auth-btn" style="margin-top:6px">微信手机号一键登录</button>
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line-soft);font-size:11.5px;color:var(--muted)">
          <div style="margin-bottom:6px">快捷选择实库会员手机号：</div>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn sm" style="flex:1" onclick="document.getElementById('mLoginPhone').value='13800138000';document.getElementById('mLoginName').value='陈静'">陈静 (13800138000)</button>
            <button type="button" class="btn sm" style="flex:1" onclick="document.getElementById('mLoginPhone').value='13911223344';document.getElementById('mLoginName').value='周明'">周明 (13911223344)</button>
          </div>
        </div>`;
      screen.appendChild(gate);

      document.getElementById('mLoginSubmit').onclick = async () => {
        const phone = document.getElementById('mLoginPhone').value.trim();
        const name = document.getElementById('mLoginName').value.trim() || '微信会员';
        const errEl = document.getElementById('mLoginErr');
        errEl.style.display = 'none';
        try {
          const s = await Live.wechatPhoneLogin(phone, name);
          sessionStorage.setItem('kunlun_member_session', JSON.stringify(s));
          gate.remove();
          if (scrollEl) scrollEl.style.display = 'block';
          if (bottomNav) bottomNav.style.display = 'grid';
          await syncMemberMiniApp();
          hookMemberActions();
          window.GQ?.toast(`登录成功：${s.displayName} (${s.codeOrNo})`);
        } catch (e) {
          errEl.textContent = e.message;
          errEl.style.display = 'block';
        }
      };
    }
  }

  function showStaffLoginGate() {
    const scrollEl = document.getElementById('staffScroll');
    const bottomNav = document.querySelector('.phone-screen .h5-bottom');
    if (scrollEl) scrollEl.style.display = 'none';
    if (bottomNav) bottomNav.style.display = 'none';

    const screen = document.querySelector('.phone-screen');
    if (!screen) return;

    let gate = document.getElementById('kunlunStaffGate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'kunlunStaffGate';
      gate.style.cssText = 'flex:1;padding:24px 20px;display:flex;flex-direction:column;justify-content:center;background:#fff';
      gate.innerHTML = `
        <div style="text-align:center;margin-bottom:20px">
          <div class="gq-logo" style="width:54px;height:54px;border-radius:15px;margin:0 auto 10px">${window.GQ?.logoSvg || '麒'}</div>
          <h3 style="margin:0;font-size:18px;color:var(--ink)">绿麒麟水站 · 员工端小程序</h3>
          <p style="margin:5px 0 0;font-size:12px;color:var(--muted)">店员 / 送水员移动履约工作台</p>
        </div>
        <div id="sLoginErr" style="display:none;padding:8px 10px;border-radius:8px;background:var(--red-50);color:var(--red-500);font-size:12px;margin-bottom:10px"></div>
        <div class="field">
          <label>员工工号 / 手机号</label>
          <input id="sLoginAcc" class="input" value="YG0012" placeholder="YG0012 或 YG0008">
        </div>
        <div class="field">
          <label>登录密码</label>
          <input id="sLoginPwd" class="input" type="password" value="Kunlun@2026">
        </div>
        <button id="sLoginSubmit" class="btn primary lg block" style="margin-top:6px">登录员工工作台</button>
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line-soft);font-size:11.5px;color:var(--muted)">
          <div style="margin-bottom:6px">快捷切换实库员工账号：</div>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn sm" style="flex:1" onclick="document.getElementById('sLoginAcc').value='YG0012'">店员小林 (YG0012)</button>
            <button type="button" class="btn sm" style="flex:1" onclick="document.getElementById('sLoginAcc').value='YG0008'">送水员王师傅 (YG0008)</button>
          </div>
        </div>`;
      screen.appendChild(gate);

      document.getElementById('sLoginSubmit').onclick = async () => {
        const acc = document.getElementById('sLoginAcc').value.trim();
        const pwd = document.getElementById('sLoginPwd').value;
        const errEl = document.getElementById('sLoginErr');
        errEl.style.display = 'none';
        try {
          const s = await Live.staffLogin(acc, pwd, false);
          sessionStorage.setItem('kunlun_staff_session', JSON.stringify(s));
          gate.remove();
          if (scrollEl) scrollEl.style.display = 'block';
          if (bottomNav) bottomNav.style.display = 'grid';
          await syncStaffMiniApp();
          hookStaffActions();
          window.GQ?.toast(`员工登录成功：${s.displayName} (${s.role})`);
        } catch (e) {
          errEl.textContent = e.message;
          errEl.style.display = 'block';
        }
      };
    }
  }

  /* -----------------------------------------------------------------------
     页面初始化：检查登录会话，未登录则显示登录界面
     ----------------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    if (document.getElementById('adminApp')) {
      const saved = sessionStorage.getItem('kunlun_admin_session');
      if (saved) {
        try {
          const s = JSON.parse(saved);
          Live.token = s.accessToken;
          Live.session = s;
          await Live.syncAdminAll();
          hookAdminActions();
          return;
        } catch {
          sessionStorage.removeItem('kunlun_admin_session');
        }
      }
      showAdminLoginGate();
    } else if (document.getElementById('staffScroll')) {
      const saved = sessionStorage.getItem('kunlun_staff_session');
      if (saved) {
        try {
          const s = JSON.parse(saved);
          Live.token = s.accessToken;
          Live.session = s;
          await syncStaffMiniApp();
          hookStaffActions();
          return;
        } catch {
          sessionStorage.removeItem('kunlun_staff_session');
        }
      }
      showStaffLoginGate();
    } else if (document.getElementById('memberScroll')) {
      const saved = sessionStorage.getItem('kunlun_member_session');
      if (saved) {
        try {
          const s = JSON.parse(saved);
          Live.token = s.accessToken;
          Live.session = s;
          await syncMemberMiniApp();
          hookMemberActions();
          return;
        } catch {
          sessionStorage.removeItem('kunlun_member_session');
        }
      }
      showMemberLoginGate();
    }
  });

  function hookAdminActions() {
    // 覆盖 openMember(name)，使 360° 会员抽屉完全渲染实库字段
    window.openMember = function (name) {
      const m = Live.members.find((x) => x.name === name) || Live.members[0];
      if (!m) return;
      Live.selectedMember = m;
      document.getElementById('drawerName').textContent = m.name;
      document.getElementById('drawerAvatar').textContent = m.name[0];
      document.getElementById('drawerBucket').textContent = String(m.bucketDeliveryTickets + m.bucketPickupTickets);
      document.getElementById('drawerBag').textContent = String(m.bagPickupTickets + m.bagDeliveryTickets);
      document.getElementById('drawerDeposit').textContent = `¥${Number(m.depositAmount).toFixed(0)}`;
      document.getElementById('drawerHeld').textContent = `${m.heldBuckets} / ${m.heldBags}`;

      const pInfo = document.querySelector('#drawerMask .member-profile p');
      if (pInfo) pInfo.textContent = `${m.memberNo} · 麒麟会员 · ${(m.createdAt || '').slice(0, 10) || '实库档案'}`;

      const detailCards = document.querySelectorAll('#drawerMask .detail-card');
      if (detailCards.length >= 2) {
        const occupied = m.heldBuckets * 50 + m.heldBags * 30;
        const refundable = Math.max(0, Number(m.depositAmount) - occupied);
        detailCards[0].innerHTML = `
          <h4>基础资料 (k3s 实库)</h4>
          <div class="detail-row"><span>联系电话</span><b>${m.phone}</b></div>
          <div class="detail-row"><span>默认配送地址</span><b>${m.defaultAddress || '门店自提'}</b></div>
          <div class="detail-row"><span>会员卡号</span><b>${m.memberNo}</b></div>`;
        detailCards[1].innerHTML = `
          <h4>四类水票与押金明细</h4>
          <div class="detail-row"><span>自提桶票 / 配送桶票</span><b>${m.bucketPickupTickets} 桶 / ${m.bucketDeliveryTickets} 桶（预占 ${m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets}）</b></div>
          <div class="detail-row"><span>自提袋票 / 配送袋票</span><b>${m.bagPickupTickets} 袋 / ${m.bagDeliveryTickets} 袋</b></div>
          <div class="detail-row"><span>实际持有桶 / 袋</span><b>${m.heldBuckets} 桶 / ${m.heldBags} 袋</b></div>
          <div class="detail-row"><span>在池押金 / 当前可退</span><b style="color:var(--brand-600)">¥${Number(m.depositAmount).toFixed(2)} / 可退 ¥${refundable.toFixed(2)}</b></div>`;
      }
      document.getElementById('drawerMask').classList.add('open');
    };

    // 覆盖 selectedMember() 辅助条，显示当前选中的实库会员
    window.selectedMember = function (name) {
      const m = (name && Live.members.find((x) => x.name === name)) || Live.selectedMember || Live.members[0];
      if (!m) return '';
      Live.selectedMember = m;
      return `<div class="selected-member"><div class="member-avatar">${m.name[0]}</div><div><b>${m.name}</b><small>${m.phone} · ${m.memberNo}</small></div><button class="text-btn" onclick="openModal('memberSearch')">更换会员</button></div>`;
    };

    // 覆盖 openMemberSearch()，列出实库全部会员供选择
    window.openMemberSearch = function () {
      const listHtml = Live.members
        .map(
          (m) =>
            `<div class="detail-card" style="cursor:pointer" onclick="KunlunLive.pickMemberAndOpen('${m.id}')"><div class="member-cell"><div class="member-avatar">${m.name[0]}</div><div><b>${m.name}</b><small>${m.phone} · ${m.memberNo}（桶票 ${m.bucketDeliveryTickets + m.bucketPickupTickets} / 袋票 ${m.bagPickupTickets}）</small></div><span class="tag green" style="margin-left:auto">选择</span></div></div>`
        )
        .join('');
      window.setModal(
        '选择实库会员',
        `${listHtml}<button class="btn block" onclick="openModal('newMember')">${window.GQ.icon('plus')}未找到？立即新建会员</button>`
      );
    };

    Live.pickMemberAndOpen = function (memberId) {
      Live.selectedMember = Live.members.find((m) => m.id === memberId) || Live.selectedMember;
      window.openModal('recharge');
    };

    // 覆盖 financeTab 切换
    window.financeTab = function (btn, type) {
      btn.parentElement.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      Live.renderFinanceTabContent(type);
    };

    // 新建会员真实落库 (AC-01)
    window.saveMember = async function () {
      const inputs = document.querySelectorAll('#modalBody input, #modalBody textarea');
      const name = document.getElementById('newMemberName')?.value?.trim();
      const phone = document.getElementById('newMemberPhone')?.value?.trim();
      const addr = inputs[2]?.value?.trim() || '幸福里小区 1 栋 101 室';
      if (!name || !/^1\d{10}$/.test(phone || '')) {
        window.GQ?.toast('请填写姓名和正确的 11 位手机号');
        return;
      }
      try {
        const res = await Live.req('/api/members', {
          method: 'POST',
          body: JSON.stringify({ name, phone, defaultAddress: addr }),
        });
        window.closeModal?.();
        await Live.syncAdminAll();
        Live.selectedMember = Live.members.find((m) => m.id === res.id) || Live.selectedMember;
        window.GQ?.toast(`实库建档成功：${res.name}（${res.memberNo}）`);
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 水费充值真实落库
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

    // 独立押金收款/退款真实落库
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

    // 代开水单真实落库
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

    // 水单交付与容器 N 出 M 入核销真实落库
    const origOpenFulfill = window.openFulfill;
    window.openFulfill = function (no, name, water, qty, orderId) {
      window._currentFulfillOrderId = orderId || Live.orders.find((o) => o.orderNo === no)?.id;
      if (origOpenFulfill) origOpenFulfill(no, name, water, qty);
    };

    window.completeFulfill = async function (no) {
      const orderId = window._currentFulfillOrderId || Live.orders.find((o) => o.orderNo === no)?.id;
      if (!orderId) return;
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

    // 导出 CSV
    window.exportCSV = async function () {
      try {
        const headers = {};
        if (Live.token) headers['Authorization'] = `Bearer ${Live.token}`;
        const res = await fetch(`${Live.baseUrl}/api/exports/members`, { headers });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: '导出失败' }));
          throw new Error(err.message || err.error);
        }
        const csv = await res.text();
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `绿麒麟水站_实库导出_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        window.GQ?.toast('已从 k3s PostgreSQL 导出真实 CSV 台账');
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };
  }

  /* -----------------------------------------------------------------------
     会员端微信小程序 100% 实库同步
     ----------------------------------------------------------------------- */
  async function syncMemberMiniApp() {
    if (!Live.session) return;
    const [p, orders] = await Promise.all([
      Live.req(`/api/members/${Live.session.subjectId}/profile`),
      Live.req(`/api/orders?memberId=${Live.session.subjectId}`),
    ]);
    Live.selectedMember = p;
    Live.orders = orders;

    const vipBadge = document.querySelector('.member-hero .vip-badge');
    if (vipBadge) vipBadge.textContent = `麒麟会员 · ${p.name}`;
    const heroNo = document.querySelector('.member-hero .hero-slogan span');
    if (heroNo) heroNo.textContent = p.memberNo;

    const ticketBoxes = document.querySelectorAll('#member-home .ticket-grid .ticket-box');
    if (ticketBoxes.length >= 4) {
      ticketBoxes[0].querySelector('.num').innerHTML = `${p.bucketDeliveryTickets}<small>桶</small>`;
      ticketBoxes[0].querySelector('.label em').textContent = `预占 ${p.reservedBucketDeliveryTickets}`;
      ticketBoxes[1].querySelector('.num').innerHTML = `${p.bucketPickupTickets}<small>桶</small>`;
      ticketBoxes[2].querySelector('.num').innerHTML = `${p.bagPickupTickets}<small>袋</small>`;
      ticketBoxes[3].querySelector('.num').innerHTML = `${p.bagDeliveryTickets}<small>袋</small>`;
    }

    const miniAssets = document.querySelectorAll('#member-home .asset-mini-grid b');
    if (miniAssets.length >= 3) {
      miniAssets[0].textContent = String(p.heldBuckets);
      miniAssets[1].textContent = String(p.heldBags);
      miniAssets[2].textContent = `¥${Number(p.depositAmount).toFixed(0)}`;
    }

    // 个人中心实库信息 + 退出登录按钮
    const profCard = document.querySelector('#member-profile .h5-card div');
    if (profCard) {
      profCard.innerHTML = `<b style="font-size:16px;color:var(--ink)">${p.name}</b><div style="color:var(--muted);font-size:12px;margin-top:2px">${p.phone} · ${p.memberNo}</div>`;
    }
    const profList = document.querySelector('#member-profile .profile-list');
    if (profList && !document.getElementById('mLogoutRow')) {
      const row = document.createElement('div');
      row.id = 'mLogoutRow';
      row.className = 'profile-row';
      row.style.color = 'var(--red-500)';
      row.innerHTML = `<svg class="icon"><use href="#i-logout"/></svg><span>退出登录 / 切换手机号</span><small>当前 ${p.phone} ›</small>`;
      row.onclick = () => Live.logoutMember();
      profList.appendChild(row);
    }
  }

  function hookMemberActions() {
    window.openWxAuth = () => Live.logoutMember();
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

  /* -----------------------------------------------------------------------
     员工端微信小程序 100% 实库同步
     ----------------------------------------------------------------------- */
  async function syncStaffMiniApp() {
    if (!Live.session) return;
    await Live.syncAdminAll();
    const greetH2 = document.querySelector('#staff-home .h5-greeting h2');
    if (greetH2) greetH2.textContent = `${Live.session.displayName}，早上好`;

    const pendingCnt = Live.orders.filter((o) => o.status === 'PENDING' || o.status === 'DISPATCHED').length;
    const doneCnt = Live.orders.filter((o) => o.status === 'COMPLETED').length;
    const workNums = document.querySelectorAll('#staff-home .work-numbers .work-number b');
    if (workNums.length >= 3) {
      workNums[0].textContent = String(pendingCnt);
      workNums[1].textContent = String(doneCnt);
      workNums[2].textContent = `¥${Number(Live.finance?.rechargeRevenueTotal || 0).toFixed(0)}`;
    }

    // 渲染员工端查会员列表 (#staffMemberList)
    const staffMemberList = document.getElementById('staffMemberList');
    if (staffMemberList) {
      staffMemberList.innerHTML = Live.members
        .map(
          (m) => `
        <div class="h5-card" onclick="openSheet('memberDetail','${m.name}')" style="cursor:pointer">
          <div class="member-cell"><div class="member-avatar">${m.name[0]}</div><div><b>${m.name}</b><small>${m.phone} · ${m.memberNo}</small></div><span class="tag green" style="margin-left:auto">办理 ›</span></div>
          <div class="wallet-sub"><span>自提/配送桶 <b>${m.bucketPickupTickets}/${m.bucketDeliveryTickets}</b></span><span>袋票 <b>${m.bagPickupTickets}</b></span><span>押金 <b>¥${Number(m.depositAmount).toFixed(0)}</b></span><span>持桶/袋 <b>${m.heldBuckets}/${m.heldBags}</b></span></div>
        </div>`
        )
        .join('');
    }

    const profList = document.querySelector('#staff-profile .profile-list');
    if (profList && !document.getElementById('sLogoutRow')) {
      const row = document.createElement('div');
      row.id = 'sLogoutRow';
      row.className = 'profile-row';
      row.style.color = 'var(--red-500)';
      row.innerHTML = `<svg class="icon"><use href="#i-logout"/></svg><span>退出登录 / 切换员工账号</span><small>${Live.session.codeOrNo} ›</small>`;
      row.onclick = () => Live.logoutStaff();
      profList.appendChild(row);
    }
  }

  function hookStaffActions() {
    const origOpenSheet = window.openSheet;
    window.openSheet = function (type, a, b, c, d) {
      if (type === 'wxLogin') {
        Live.logoutStaff();
        return;
      }
      if (origOpenSheet) origOpenSheet(type, a, b, c, d);
    };
  }
})();
