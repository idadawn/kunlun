/* =========================================================================
   绿麒麟 · 水站会员管理系统 —— 真实登录门禁 + 登录与业务数据绑定
   规则：
   1. 管理端 PC (admin.html) 仅限管理员 (ADMIN) 登录，未登录前强制显示管理员登录页
   2. 员工端/会员端小程序未登录前强制显示小程序原生登录页
   3. 登录后所有 KPI 卡片、汇总条、表格、抽屉、水票与容器数据  来自 服务端
   ========================================================================= */
(function () {
  const API_BASE = window.KUNLUN_API_BASE || '';
  document.documentElement.classList.add('auth-pending');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const Live = (window.KunlunLive = {
    baseUrl: API_BASE,
    token: null,
    session: null,
    members: [],
    plans: [],
    products: [],
    orders: [],
    containers: [],
    finance: null,
    overview: null,
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
        if (res.status === 401 && this.token && !path.includes('/login')) {
          this.clearSession(); location.reload();
        }
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

    async memberLogin(account, password) {
      const s = await this.req('/api/auth/member/login', { method: 'POST', body: JSON.stringify({ account, password }) });
      this.token = s.accessToken; this.session = s; return s;
    },
    clearSession() {
      ['admin', 'staff', 'member'].forEach(x => sessionStorage.removeItem(`kunlun_${x}_session`));
      this.token = null; this.session = null;
    },
    async logout() {
      try { await this.req('/api/auth/logout', { method: 'POST' }); }
      catch (e) { if (this.token) { window.GQ?.toast('退出失败，请重试：' + e.message); return; } }
      this.clearSession(); location.reload();
    },
    logoutAdmin() { return this.logout(); },
    logoutStaff() { return this.logout(); },
    logoutMember() { return this.logout(); },
    async changePassword() {
      showAccountDialog('修改密码', '<label for="oldPassword">原密码</label><input id="oldPassword" class="input" type="password" autocomplete="current-password" required><label for="newPassword">新密码</label><input id="newPassword" class="input" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>', async form => {
        await this.req('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: form.querySelector('#oldPassword').value, newPassword: form.querySelector('#newPassword').value }) });
        this.clearSession(); location.reload();
      });
    },
    setMemberCredentials(id) {
      showAccountDialog('设置会员登录账号', '<label for="credentialUsername">用户名</label><input id="credentialUsername" class="input" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" required><label for="credentialPassword">初始密码 / 重置密码</label><input id="credentialPassword" class="input" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>', async form => {
        await this.req(`/api/accounts/MEMBER/${id}/credentials`, { method: 'PUT', body: JSON.stringify({ username: form.querySelector('#credentialUsername').value, password: form.querySelector('#credentialPassword').value }) });
        window.GQ?.toast('账号已保存，请将用户名和密码告知会员');
      });
    },

    /* ---------------------------------------------------------------------
       管理端 PC 业务数据同步
       --------------------------------------------------------------------- */
    async syncAdminAll() {
      const generation = this.syncGeneration = (this.syncGeneration || 0) + 1;
      const [members, plans, orders, containers, finance, recharges, deposits, containerLedgers, overview, products] =
        await Promise.all([
          this.req('/api/members'+(this.memberQuery?'?q='+encodeURIComponent(this.memberQuery):'')),
          this.req('/api/plans'),
          this.req('/api/orders'),
          this.req('/api/containers/summary'),
          this.session.permissions.includes('kunlun.waterstation:report:export') ? this.req('/api/reports/finance-summary') : Promise.resolve(null),
          this.session.permissions.includes('kunlun.waterstation:report:export') ? this.req('/api/ledgers/recharges') : Promise.resolve([]),
          this.session.permissions.includes('kunlun.waterstation:report:export') ? this.req('/api/ledgers/deposits') : Promise.resolve([]),
          this.session.permissions.includes('kunlun.waterstation:report:export') ? this.req('/api/ledgers/containers') : Promise.resolve([]),
          this.session.permissions.includes('kunlun.waterstation:report:export') ? this.req('/api/reports/overview') : Promise.resolve(null),
          this.req('/api/products'),
        ]);
      if(generation !== this.syncGeneration)return;
      this.members = members;
      this.plans = plans;
      this.products = products;
      this.orders = orders;
      this.containers = containers;
      this.finance = finance;
      this.overview = overview;
      this.recharges = recharges;
      this.deposits = deposits;
      this.containerLedgers = containerLedgers;
      if (!this.selectedMember && members.length > 0) {
        this.selectedMember = members[0];
      } else if (this.selectedMember) {
        this.selectedMember = members.find((m) => m.id === this.selectedMember.id) || members[0];
      }
      this.renderAdminDOM();
      window.KunlunMembership?.applyListFilters();
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

      // 同步 window.memberData 供 360° 档案抽屉读取数据
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
        totalQty: 200, inStationQty: 164, inTransitQty: 0, memberHeldQty: 2, inspectingQty: 34, abnormalQty: 0, warnThreshold: 80, unitDeposit: 5, damagedQty: 0, scrappedQty: 0,
      };

      const pendingDeliv = this.overview?.pendingDelivery ?? this.orders.filter((o) => o.status === 'PENDING' && o.fulfillMode === 'DELIVERY').length;
      const pendingPickup = this.overview?.pendingPickup ?? this.orders.filter((o) => o.status === 'PENDING' && o.fulfillMode === 'PICKUP').length;
      const dispatchedCnt = this.overview?.dispatched ?? this.orders.filter((o) => o.status === 'DISPATCHED').length;
      const completedOrders = this.orders.filter((o) => o.status === 'COMPLETED');
      const pendingTotal = pendingDeliv + pendingPickup + dispatchedCnt;

      const doneBuckets = this.overview?.completedBuckets ?? completedOrders
        .filter((o) => o.waterType === 'BUCKET_18_9L')
        .reduce((s, o) => s + (o.actualQty ?? o.orderQty), 0);
      const doneBags = this.overview?.completedBags ?? completedOrders
        .filter((o) => o.waterType === 'BAG_7_5L')
        .reduce((s, o) => s + (o.actualQty ?? o.orderQty), 0);

      const rcgRev = Number(this.finance?.rechargeRevenueTotal || 0);
      const depCol = Number(this.finance?.depositCollectedTotal || 0);
      const depRef = Number(this.finance?.depositRefundedTotal || 0);
      const depPool = Number(this.finance?.unrefundedDepositPoolTotal || 0);
      const rechargeRefunded = Number(this.finance?.rechargeRefundedTotal || 0);
      const netCash = rcgRev - rechargeRefunded + (depCol - depRef);

      const refundableTotal = Number(this.overview?.refundableDeposit || 0);

      const hero = document.querySelector('#page-dashboard .hero-banner');
      if(hero){hero.querySelector('h2').textContent=`你好，${this.session.displayName}`;hero.querySelector('p').textContent=new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'full'});}
      const chart=document.querySelector('svg.chart');
      if(chart && this.overview){
        const points=this.overview.trend, cashMax=Math.max(1,...points.map(p=>Number(p.rechargeAmount))), qtyMax=Math.max(1,...points.map(p=>Number(p.waterQty)));
        chart.innerHTML=Array.from({length:4},(_,i)=>`<line class="gridline" x1="45" x2="650" y1="${20+i*45}" y2="${20+i*45}"/><text x="2" y="${24+i*45}">${Math.round(cashMax*(3-i)/3)}</text><text x="658" y="${24+i*45}">${Math.round(qtyMax*(3-i)/3)}</text>`).join('')+
          points.map((p,i)=>`<rect x="${45+i*95}" y="${155-Number(p.waterQty)/qtyMax*135}" width="22" height="${Number(p.waterQty)/qtyMax*135}" fill="#7fd3a8" opacity=".4"/><text x="${55+i*95}" y="185" text-anchor="middle">${p.date.slice(5).replace('-','/')}</text>`).join('')+
          `<polyline points="${points.map((p,i)=>`${55+i*95},${155-Number(p.rechargeAmount)/cashMax*135}`).join(' ')}" fill="none" stroke="#12925f" stroke-width="3"/>`;
        chart.setAttribute('aria-label','近七日实际水费收款与核销水量');
        document.querySelector('.chart-legend').innerHTML='<span><i class="legend-dot"></i>水费收款（左轴：元）</span><span><i class="legend-dot light"></i>核销水量（右轴：桶/袋）</span>';
      }

      // 1. 侧栏水单徽章 & 首页 4 张核心 KPI 卡（ 数据）
      const orderBadge = document.getElementById('orderBadge');
      if (orderBadge) orderBadge.textContent = String(pendingTotal);

      const dashStats = document.querySelectorAll('#page-dashboard .stats-grid .stat-card');
      if (dashStats.length >= 4) {
        dashStats[0].querySelector('.stat-top span').textContent = '累计净收款（元）';
        dashStats[0].querySelector('.stat-value').textContent = `¥ ${netCash.toFixed(2)}`;
        dashStats[0].querySelector('.stat-foot').innerHTML = `<span class="trend-up"></span>水费净收 ¥${(rcgRev - rechargeRefunded).toFixed(2)} · 押金净收 ¥${(depCol - depRef).toFixed(2)}`;

        dashStats[1].querySelector('.stat-top span').textContent = '已核销用水';
        dashStats[1].querySelector('.stat-value').innerHTML = `${doneBuckets}<small>桶</small> · ${doneBags}<small>袋</small>`;
        dashStats[1].querySelector('.stat-foot').innerHTML = `累计完结水单 <b>${this.overview?.completedOrders ?? completedOrders.length}</b> 笔`;

        dashStats[2].querySelector('.stat-value').innerHTML = `${pendingTotal}<small>单</small>`;
        dashStats[2].querySelector('.stat-foot').innerHTML = `<span style="color:var(--orange-500)">待接单配送 ${pendingDeliv}</span> · 配送中 ${dispatchedCnt} · 待自提 ${pendingPickup}`;

        dashStats[3].querySelector('.stat-value').innerHTML = `${bucketCfg.memberHeldQty}<small>桶</small> / ${bagCfg.memberHeldQty}<small>袋</small>`;
        dashStats[3].querySelector('.stat-foot').textContent = `站内可用：桶 ${bucketCfg.inStationQty} · 袋 ${bagCfg.inStationQty}`;
      }

      // 2. 首页今日待办（ 统计）
      const todoNums = document.querySelectorAll('#page-dashboard .todo-list .todo-item');
      if (todoNums.length >= 4) {
        todoNums[0].querySelector('.todo-num').textContent = String(pendingDeliv);
        todoNums[1].querySelector('.todo-num').textContent = String(pendingPickup);
        todoNums[2].querySelector('b').textContent = '可退押金';
        todoNums[2].querySelector('.todo-num').textContent = '¥' + refundableTotal.toFixed(2);
        todoNums[3].querySelector('small').textContent = `当前站内可用 ${bucketCfg.inStationQty} 个，预警值 ${bucketCfg.warnThreshold}`;
      }

      // 3. 首页最新水单（ 订单）
      const orderMini = document.querySelector('#page-dashboard .order-mini');
      if (orderMini) {
        const rowsHtml =
          this.orders.length === 0
            ? `<div style="padding:18px 0;color:var(--muted);text-align:center;font-size:12.5px">暂无水单，可通过「代开水单」创建</div>`
            : this.orders
                .slice(0, 4)
                .map((o) => {
                  const isPickup = o.fulfillMode === 'PICKUP';
                  const wLabel = escapeHtml(o.productSnapshot?.waterLabel || (o.waterType === 'BUCKET_18_9L' ? '桶装水' : '袋装水'));
                  const stText =
                    o.status === 'COMPLETED'
                      ? '<span class="tag gray">已完成</span>'
                      : o.status === 'CANCELLED'
                      ? '<span class="tag red">已取消</span>'
                      : isPickup
                      ? `<span class="tag aqua dot">待自提(${o.pickupCode})</span>`
                      : '<span class="tag orange dot">待接单</span>';
                  return `<div class="order-row"><span><b>${escapeHtml(o.addressSnapshot?.contactName || '会员')}</b><br><small style="color:var(--muted)">${o.orderNo}</small></span><span>${isPickup ? '自提' : '配送'}</span><span>${wLabel} × ${o.orderQty}</span>${stText}</div>`;
                })
                .join('');
        orderMini.innerHTML = `<div class="order-row head"><span>会员 / 单号</span><span>方式</span><span>水品与数量</span><span>状态</span></div>${rowsHtml}`;
      }

      // 4. 首页容器五维恒等概览（  container_configs）
      const assetContent = document.querySelector('#page-dashboard .asset-content');
      if (assetContent) {
        const bPct = Math.min(100, Math.round((bucketCfg.memberHeldQty / Math.max(1, bucketCfg.totalQty)) * 100));
        const gPct = Math.min(100, Math.round((bagCfg.memberHeldQty / Math.max(1, bagCfg.totalQty)) * 100));
        assetContent.innerHTML = `
          <div class="asset-line"><span>15L 周转桶</span><span>会员持有 <b>${bucketCfg.memberHeldQty}</b> / 总量 <b>${bucketCfg.totalQty}</b></span></div>
          <div class="progress"><i style="width:${Math.max(4, bPct)}%"></i></div>
          <div class="asset-meta"><span>站内可用 ${bucketCfg.inStationQty}</span><span>配送在途 ${bucketCfg.inTransitQty}</span><span>待检 ${bucketCfg.inspectingQty} · 破损 ${bucketCfg.damagedQty||0} · 异常 ${bucketCfg.abnormalQty}</span></div>
          <div class="asset-line" style="margin-top:18px"><span>5L 周转水袋</span><span>会员持有 <b>${bagCfg.memberHeldQty}</b> / 总量 <b>${bagCfg.totalQty}</b></span></div>
          <div class="progress"><i style="width:${Math.max(4, gPct)}%;background:var(--grad-aqua)"></i></div>
          <div class="asset-meta"><span>站内可用 ${bagCfg.inStationQty}</span><span>配送在途 ${bagCfg.inTransitQty}</span><span>待检 ${bagCfg.inspectingQty} · 破损 ${bagCfg.damagedQty||0} · 异常 ${bagCfg.abnormalQty}</span></div>
          <div class="identity-formula"><span>库存平衡校验 (${bucketCfg.identityValid && bagCfg.identityValid ? 'PASS' : 'WARN'})</span><b>现存总量 = 可用 + 在途 + 会员持有 + 待检 + 异常 + 破损</b></div>`;
      }

      // 5. 会员管理页：汇总条 + 表格 + 页脚计数（  members）
      const memSummary = document.querySelectorAll('#page-members .summary-strip .summary-item b');
      if (memSummary.length >= 4) {
        const withTickets = this.members.filter(
          (m) => m.bucketDeliveryTickets + m.bucketPickupTickets + m.bagPickupTickets + m.bagDeliveryTickets > 0
        ).length;
        const withContainers = this.members.filter((m) => m.heldBuckets + m.heldBags > 0).length;
        memSummary[0].textContent = String(this.overview?.memberCount ?? this.members.length);
        memSummary[1].textContent = String(this.overview?.newMembersMonth ?? 0);
        memSummary[2].textContent = String(this.overview?.membersWithTickets ?? withTickets);
        memSummary[3].textContent = String(this.overview?.membersWithContainers ?? withContainers);
      }
      const memToolbarSmall = document.querySelector('#page-members .table-toolbar small');
      if (memToolbarSmall) memToolbarSmall.textContent = `当前显示 ${this.members.length} 位会员 · 可按姓名或手机号搜索`;
      const memFooterSpan = document.querySelector('#page-members .table-footer span');
      if (memFooterSpan) memFooterSpan.textContent = `当前显示 ${this.members.length} 条记录（最多 50 条）`;

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
          <tr data-member="${escapeHtml(m.name)}">
            <td><div class="member-cell"><div class="member-avatar" style="${palette[i % palette.length]}">${escapeHtml(m.name[0])}</div><div><b>${escapeHtml(m.name)}</b><small>${m.memberNo}</small></div></div></td>
            <td>${m.phone}</td>
            <td><b>${m.bucketPickupTickets}</b> / <b>${m.bucketDeliveryTickets}</b> 桶${m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets > 0 ? ` <span class="tag orange">预占 ${m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets}</span>` : ''}</td>
            <td><b>${m.bagPickupTickets}</b> / <b>${m.bagDeliveryTickets}</b> 袋</td>
            <td>¥ ${Number(m.depositAmount).toFixed(2)}</td>
            <td>${m.heldBuckets} 桶 / ${m.heldBags} 袋</td>
            <td>${(m.createdAt || '').slice(0, 10) || '2026-10-26'}</td>
            <td><button class="link" onclick="openMember('${m.id}')">360° 详情</button></td>
          </tr>`
          )
          .join('');
      }

      // 6. 水单管理页：汇总条 + 表格（  water_orders）
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
          orderTable.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">暂无水单，可代客开单或由会员预约</td></tr>`;
        } else {
          orderTable.innerHTML = this.orders
            .map((o) => {
              const isPickup = o.fulfillMode === 'PICKUP';
              const waterLabel = o.productSnapshot?.waterLabel || (o.waterType === 'BUCKET_18_9L' ? '桶装水' : '袋装水');
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
                : escapeHtml(o.addressSnapshot?.address || '未设置配送地址');
              return `
              <tr data-status="${st.text}">
                <td><span class="order-no">${o.orderNo}</span><br><small style="color:var(--muted)">${new Date(o.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></td>
                <td><b>${escapeHtml(contactName)}</b><br><small style="color:var(--muted)">${escapeHtml(contactPhone)}</small></td>
                <td><span class="tag ${isPickup ? 'aqua' : 'green'}">${isPickup ? '自提' : '配送'}</span> ${addr}</td>
                <td>小分子团弱碱活性水 ${escapeHtml(waterLabel)} × <b>${o.orderQty}</b></td>
                <td>${o.status === 'COMPLETED' ? `已核销 ${o.actualQty ?? o.orderQty}` : o.status === 'CANCELLED' ? '已释放预占' : `预占 ${o.reservedQty} ${unit}`}</td>
                <td>${o.status === 'COMPLETED' ? '已交付' : '待交付'}</td>
                <td><span class="tag ${st.cls}">${st.text}</span></td>
                <td>${
                  o.status === 'PENDING' || o.status === 'DISPATCHED'
                    ? `<button class="link" onclick="openFulfill('${o.orderNo}',${escapeHtml(JSON.stringify(contactName))},${escapeHtml(JSON.stringify(waterLabel))},${o.orderQty},'${o.id}')">${isPickup ? '核验自提' : '接单并交付'}</button>
                       <button class="link" style="color:var(--red-500);margin-left:8px" onclick="KunlunLive.cancelOrderById('${o.id}','${o.orderNo}')">取消</button>`
                    : `<button class="link" onclick="KunlunMembership.showOrder('${o.id}')">查看详情</button>`
                }</td>
              </tr>`;
            })
            .join('');
        }
      }

      // 7. 充值与押金页：4 张 KPI 卡 + 流水表（ ）
      const finStats = document.querySelectorAll('#page-finance .stats-grid .stat-card');
      if (finStats.length >= 4) {
        finStats[0].querySelector('.stat-top').textContent = '水费充值累计';
        finStats[0].querySelector('.stat-value').textContent = `¥ ${rcgRev.toFixed(2)}`;
        finStats[0].querySelector('.stat-foot').textContent = `退款 ¥${Number(this.finance?.rechargeRefundedTotal || 0).toFixed(2)} · 水费净收 ¥${Number(this.finance?.rechargeNetReceived || 0).toFixed(2)}`;

        finStats[1].querySelector('.stat-top').textContent = '押金收支净额';
        finStats[1].querySelector('.stat-value').textContent = `¥ ${(depCol - depRef).toFixed(2)}`;
        finStats[1].querySelector('.stat-foot').textContent = `收押 ${this.finance?.depositCollectCount || 0} 笔 (¥${depCol.toFixed(0)}) · 退押 ${this.finance?.depositRefundCount || 0} 笔 (¥${depRef.toFixed(0)})`;

        finStats[2].querySelector('.stat-top').textContent = '在池未退押金总额';
        finStats[2].querySelector('.stat-value').textContent = `¥ ${depPool.toFixed(2)}`;
        finStats[2].querySelector('.stat-foot').textContent = this.finance?.reconciledZeroDiff ? '与收退流水  零误差对齐' : '对账校验中';

        finStats[3].querySelector('.stat-top').textContent = '当前可退押金';
        finStats[3].querySelector('.stat-value').textContent = `¥ ${refundableTotal.toFixed(2)}`;
        finStats[3].querySelector('.stat-foot').textContent = '已扣除会员实际持有容器占用押金';
      }
      this.renderFinanceTabContent(window._currentFinanceTab || '充值记录');

      // 8. 桶袋台账页：4 张 KPI 卡 + 容器流转表（ ）
      const assetStats = document.querySelectorAll('#page-assets .stats-grid .stat-card');
      if (assetStats.length >= 4) {
        assetStats[0].querySelector('.stat-value').innerHTML = `${bucketCfg.inStationQty}<small>/ ${bucketCfg.totalQty}</small>`;
        assetStats[0].querySelector('.stat-foot').innerHTML = `${bucketCfg.lowStockWarning ? `<span style="color:var(--orange-500)">低于预警值 ${bucketCfg.warnThreshold}</span>` : '库存充足'} · 待检 ${bucketCfg.inspectingQty}`;

        assetStats[1].querySelector('.stat-value').innerHTML = `${bucketCfg.memberHeldQty}<small>个</small>`;
        assetStats[1].querySelector('.stat-foot').textContent = `会员持有周转桶汇总`;

        assetStats[2].querySelector('.stat-value').innerHTML = `${bagCfg.inStationQty}<small>/ ${bagCfg.totalQty}</small>`;
        assetStats[2].querySelector('.stat-foot').textContent = `待检 ${bagCfg.inspectingQty} · 配送在途 ${bagCfg.inTransitQty}`;

        assetStats[3].querySelector('.stat-value').innerHTML = `${bagCfg.memberHeldQty}<small>个</small>`;
        assetStats[3].querySelector('.stat-foot').textContent = `会员持有周转水袋汇总`;
      }
      const assetTbody = document.getElementById('containerMovementBody');
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
                <td><b>${escapeHtml(c.memberName)}</b></td>
                <td>${c.orderNo}</td>
                <td>${c.containerType === 'BUCKET' ? '15L 周转桶' : '5L 周转水袋'}</td>
                <td><b>${c.fullOutQty}</b></td>
                <td><b>${c.emptyInQty}</b></td>
                <td>${deltaTag} (持有 ${c.heldAfter})</td>
                <td>${escapeHtml(c.operatorName)}</td>
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
              <td><b>${escapeHtml(r.memberName)}</b> <small style="color:var(--muted)">(${r.memberNo})</small></td>
              <td>${escapeHtml(r.planName)}</td>
              <td><b>¥ ${Number(r.paidAmount).toFixed(2)}</b></td>
              <td>购 ${r.buyQty} + 赠 ${r.giftQty}</td>
              <td>${r.payMethod}</td>
              <td>${escapeHtml(r.operatorName)}</td>
              <td><button class="link" onclick="KunlunMembership.showRecharge('${r.rechargeNo}')">查看快照</button></td>
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
              <td><b>${escapeHtml(d.memberName)}</b></td>
              <td><span class="tag ${d.flowType === 'COLLECT' ? 'green' : 'orange'}">${d.flowType === 'COLLECT' ? '交押金' : '退押金'}</span></td>
              <td>${d.containerType === 'BUCKET' ? '15L 周转桶' : '5L 周转水袋'} × ${d.qty}</td>
              <td>¥ ${Number(d.unitPrice).toFixed(2)}</td>
              <td><b>${d.flowType === 'COLLECT' ? '+' : '-'}¥ ${Number(d.amount).toFixed(2)}</b></td>
              <td>${d.remainingQty} 个</td>
              <td>${escapeHtml(d.operatorName)}</td>
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
        window.GQ?.toast(`水单 ${orderNo} 已取消，预占水票已释放回可用余额`);
        await this.syncAdminAll();
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    },
  });

  /* -----------------------------------------------------------------------
     1. 管理端 PC 登录门禁界面（仅限 ADMIN 管理员登录）
     ----------------------------------------------------------------------- */
  function showAccountDialog(title, fields, save) {
    const dialog = document.createElement('dialog');
    dialog.className = 'account-dialog';
    dialog.innerHTML = `<form><h3>${title}</h3><div class="account-fields">${fields}</div><p role="alert" class="account-error"></p><div class="account-buttons"><button type="button" class="btn">取消</button><button class="btn primary" type="submit">保存</button></div></form>`;
    dialog.querySelector('button[type=button]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const btn = dialog.querySelector('button[type=submit]'); btn.disabled = true;
      try { await save(e.target); dialog.close(); }
      catch (err) { dialog.querySelector('[role=alert]').textContent = err.message; }
      finally { btn.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal();
  }

  function pageKind() {
    return document.getElementById('adminApp') ? 'admin' : document.getElementById('staffScroll') ? 'staff' : 'member';
  }
  async function enterPage(kind) {
    const me = await Live.req('/api/auth/me');
    if ((kind === 'admin' && (me.subjectType !== 'STAFF' || me.role !== 'ADMIN')) ||
        (kind === 'staff' && me.subjectType !== 'STAFF') || (kind === 'member' && me.subjectType !== 'MEMBER'))
      throw new Error('当前账号不能登录此入口，请使用对应账号');
    Live.session = { ...Live.session, ...me };
    if (kind === 'admin') { await Live.syncAdminAll(); hookAdminActions(); }
    else if (kind === 'staff') { await syncStaffMiniApp(); hookStaffActions(); }
    else { await syncMemberMiniApp(); hookMemberActions(); }
    Live.refreshPage = async () => {
      if (kind === 'admin') await Live.syncAdminAll();
      else if (kind === 'staff') await syncStaffMiniApp();
      else await syncMemberMiniApp();
    };
    window.KunlunMembership?.mount(kind);
    document.getElementById('kunlunLoginGate')?.remove();
    document.documentElement.classList.remove('auth-pending');
    if (!document.getElementById('changePasswordButton')) {
      const button = document.createElement('button'); button.id = 'changePasswordButton';
      button.className = 'btn sm'; button.textContent = '修改密码'; button.onclick = () => Live.changePassword();
      (document.querySelector('.topbar .user')?.parentElement || document.querySelector('.wx-navbar') || document.body).append(button);
    }
    // Old prototype login affordances now use the real account flow.
    window.openWxAuth = () => Live.logout();
  }
  function showLoginGate(kind) {
    document.documentElement.classList.add('auth-pending');
    Live.clearSession();
    document.getElementById('kunlunLoginGate')?.remove();
    const gate = document.createElement('div'); gate.id = 'kunlunLoginGate'; gate.className = `login-gate login-${kind}`;
    const label = kind === 'admin' ? '管理后台' : kind === 'staff' ? '员工工作台' : '会员中心';
    gate.innerHTML = `<div class="login-brand"><div class="gq-logo">${window.GQ?.logoSvg || '麒'}</div><h1>绿麒麟水站</h1><p>鲜活每一滴，好水到你家</p></div>
      <form class="login-card"><h2>${label}</h2><p class="login-subtitle">使用用户名和密码登录</p>
      <label for="loginUsername">用户名</label><input id="loginUsername" name="username" class="input" autocomplete="username" required maxlength="32" placeholder="请输入用户名">
      <label for="loginPassword">密码</label><div class="password-field"><input id="loginPassword" name="password" class="input" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入密码"><button type="button" id="togglePassword" aria-label="显示密码">显示</button></div>
      <p role="alert" class="account-error"></p><button class="btn primary login-submit" type="submit">登录</button><p class="login-help">${kind === 'admin' ? '仅限水站管理员' : '首次使用或忘记密码，请联系水站设置账号'}</p></form>`;
    (kind === 'admin' ? document.body : document.querySelector('.phone-screen') || document.body).append(gate);
    gate.querySelector('#togglePassword').onclick = e => {
      const input = gate.querySelector('#loginPassword'); const show = input.type === 'password';
      input.type = show ? 'text' : 'password'; e.target.textContent = show ? '隐藏' : '显示'; e.target.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    };
    gate.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const btn = gate.querySelector('[type=submit]'); if (btn.disabled) return;
      const error = gate.querySelector('[role=alert]'); error.textContent = ''; btn.disabled = true; btn.textContent = '正在登录…';
      try {
        const account = gate.querySelector('#loginUsername').value.trim(), password = gate.querySelector('#loginPassword').value;
        const session = kind === 'member' ? await Live.memberLogin(account, password) : await Live.staffLogin(account, password, kind === 'admin');
        await enterPage(kind);
        sessionStorage.setItem(`kunlun_${kind}_session`, JSON.stringify(session));
      } catch (err) { Live.clearSession(); error.textContent = err.message || '登录失败，请重试'; }
      finally { btn.disabled = false; btn.textContent = '登录'; }
    };
  }
  document.addEventListener('DOMContentLoaded', async () => {
    const kind = pageKind(), saved = sessionStorage.getItem(`kunlun_${kind}_session`);
    if (saved) {
      try {
        Live.session = JSON.parse(saved); Live.token = Live.session.accessToken;
        await enterPage(kind); return;
      } catch { Live.clearSession(); }
    }
    showLoginGate(kind);
  });

  function hookAdminActions() {
    let searchTimer;
    window.filterMembers = value => {
      Live.memberQuery=value.trim();clearTimeout(searchTimer);
      searchTimer=setTimeout(()=>Live.syncAdminAll().catch(e=>window.GQ.toast(e.message)),200);
    };
    // 覆盖 openMember(name)，使 360° 会员抽屉完全渲染字段
    window.openMember = function (name) {
      const m = Live.members.find((x) => x.id === name || x.name === name) || Live.members[0];
      if (!m) return;
      Live.selectedMember = m;
      document.getElementById('drawerName').textContent = m.name;
      const statusTag=document.querySelector('#drawerMask .member-profile .tag');if(statusTag)statusTag.textContent=m.status==='ACTIVE'?'正常':'停用';
      document.getElementById('drawerAvatar').textContent = m.name[0];
      document.getElementById('drawerBucket').textContent = String(m.bucketDeliveryTickets + m.bucketPickupTickets);
      document.getElementById('drawerBag').textContent = String(m.bagPickupTickets + m.bagDeliveryTickets);
      document.getElementById('drawerDeposit').textContent = `¥${Number(m.depositAmount).toFixed(0)}`;
      document.getElementById('drawerHeld').textContent = `${m.heldBuckets} / ${m.heldBags}`;

      const pInfo = document.querySelector('#drawerMask .member-profile p');
      if (pInfo) pInfo.textContent = `${m.memberNo} · 麒麟会员 · ${(m.createdAt || '').slice(0, 10) || '档案'}`;

      const detailCards = document.querySelectorAll('#drawerMask .detail-card');
      if (detailCards.length >= 2) {
        const refundable = null;
        detailCards[0].innerHTML = `
          <h4>基础资料 ()</h4>
          <div class="detail-row"><span>联系电话</span><b>${m.phone}</b></div>
          <div class="detail-row"><span>默认配送地址</span><b>${escapeHtml(m.defaultAddress || '门店自提')}</b></div>
          <div class="detail-row"><span>会员卡号</span><b>${m.memberNo}</b></div><button class="btn sm" onclick="KunlunLive.setMemberCredentials('${m.id}')">设置登录账号</button>`;
        detailCards[1].innerHTML = `
          <h4>四类水票与押金明细</h4>
          <div class="detail-row"><span>自提桶票 / 配送桶票</span><b>${m.bucketPickupTickets} 桶 / ${m.bucketDeliveryTickets} 桶（预占 ${m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets}）</b></div>
          <div class="detail-row"><span>自提袋票 / 配送袋票</span><b>${m.bagPickupTickets} 袋 / ${m.bagDeliveryTickets} 袋</b></div>
          <div class="detail-row"><span>实际持有桶 / 袋</span><b>${m.heldBuckets} 桶 / ${m.heldBags} 袋</b></div>
          <div class="detail-row"><span>在池押金 / 当前可退</span><b data-refundable style="color:var(--brand-600)">¥${Number(m.depositAmount).toFixed(2)} / 可退金额查询中</b></div>`;
      }
      Live.req(`/api/members/${m.id}/deposit-summary`).then(rows => {
        if(Live.selectedMember?.id!==m.id)return;
        const value=document.querySelector('#drawerMask .detail-card .detail-row:last-child b[data-refundable]');
        if(value)value.textContent=`¥${Number(m.depositAmount).toFixed(2)} / 可退 ¥${rows.reduce((sum,r)=>sum+Number(r.refundableAmount),0).toFixed(2)}`;
      }).catch(e=>window.GQ.toast(e.message));
      document.getElementById('drawerMask').classList.add('open');
    };

    // 覆盖 selectedMember() 辅助条，显示当前选中的会员
    window.selectedMember = function (name) {
      const m = (name && Live.members.find((x) => x.id === name || x.name === name)) || Live.selectedMember || Live.members[0];
      if (!m) return '';
      Live.selectedMember = m;
      return `<div class="selected-member"><div class="member-avatar">${escapeHtml(m.name[0])}</div><div><b>${escapeHtml(m.name)}</b><small>${m.phone} · ${m.memberNo}</small></div><button class="text-btn" onclick="openModal('memberSearch')">更换会员</button></div>`;
    };

    // 覆盖 openMemberSearch()，列出全部会员供选择
    window.openMemberSearch = function () {
      const listHtml = Live.members
        .map(
          (m) =>
            `<div class="detail-card" style="cursor:pointer" onclick="KunlunLive.pickMemberAndOpen('${m.id}')"><div class="member-cell"><div class="member-avatar">${escapeHtml(m.name[0])}</div><div><b>${escapeHtml(m.name)}</b><small>${m.phone} · ${m.memberNo}（桶票 ${m.bucketDeliveryTickets + m.bucketPickupTickets} / 袋票 ${m.bagPickupTickets}）</small></div><span class="tag green" style="margin-left:auto">选择</span></div></div>`
        )
        .join('');
      window.setModal(
        '选择会员',
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

    // 新建会员真实落库
    window.saveMember = async function () {
      const inputs = document.querySelectorAll('#modalBody input, #modalBody textarea');
      const name = document.getElementById('newMemberName')?.value?.trim();
      const phone = document.getElementById('newMemberPhone')?.value?.trim();
      const addr = inputs[2]?.value?.trim() || '';
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
        window.GQ?.toast(`建档成功：${res.name}（${res.memberNo}）`);
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };

    // 导出 CSV
    window.exportCSV = async function () {
      try {
        const headers = {};
        if (Live.token) headers['Authorization'] = `Bearer ${Live.token}`;
        const section = document.querySelector('.section.active')?.id;
        const dataset = section==='page-finance' ? (window._currentFinanceTab==='押金记录'?'deposit-ledgers':'recharges') : ({'page-members':'members','page-orders':'orders','page-assets':'container-ledgers'})[section] || 'ticket-ledgers';
        const res = await fetch(`${Live.baseUrl}/api/exports/${dataset}`, { headers });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: '导出失败' }));
          if (res.status === 401) { Live.clearSession(); location.reload(); }
        throw new Error(err.message || err.error);
        }
        const csv = await res.text();
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `绿麒麟水站_导出_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        window.GQ?.toast('报表已导出');
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };
  }

  /* -----------------------------------------------------------------------
     会员端微信小程序  同步
     ----------------------------------------------------------------------- */
  async function syncMemberMiniApp() {
    if (!Live.session) return;
    const [p, orders, products] = await Promise.all([
      Live.req(`/api/members/${Live.session.subjectId}/profile`),
      Live.req(`/api/orders?memberId=${Live.session.subjectId}`),
      Live.req('/api/products'),
    ]);
    Live.selectedMember = p;
    Live.products = products;
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

    window.KunlunMembership?.renderOrders('member');
    const address = document.getElementById('profAddr');
    if (address) address.textContent = (p.defaultAddress || '未设置配送地址') + ' ›';
    // 个人中心信息 + 退出登录按钮
    const profCard = document.querySelector('#member-profile .h5-card > div:last-child');
    if (profCard) {
      profCard.innerHTML = `<b style="font-size:16px;color:var(--ink)">${escapeHtml(p.name)}</b><div style="color:var(--muted);font-size:12px;margin-top:2px">${p.phone} · ${p.memberNo}</div>`;
    }
    const profList = document.querySelector('#member-profile .profile-list');
    if (profList && !document.getElementById('mLogoutRow')) {
      const row = document.createElement('div');
      row.id = 'mLogoutRow';
      row.className = 'profile-row';
      row.style.color = 'var(--red-500)';
      row.innerHTML = `<svg class="icon"><use href="#i-logout"/></svg><span>退出登录 / 切换账号</span><small>当前 ${p.phone} ›</small>`;
      row.onclick = () => Live.logoutMember();
      profList.appendChild(row);
    }
  }

  function hookMemberActions() {
    const originalMemberOrder = window.openMemberOrder;
    window.openMemberOrder = mode => {
      Live.orderMode = mode; Live.orderRequestKey = crypto.randomUUID();
      originalMemberOrder(mode);
      const p = Live.selectedMember, pickup = mode === '自提';
      const choices = document.getElementById('mWaterSel');
      choices.options[0].textContent = `${Live.products.find(x=>x.waterType==='BUCKET_18_9L').name}（可用 ${pickup ? p.bucketPickupTickets : p.bucketDeliveryTickets} 桶）`;
      choices.options[1].textContent = `${Live.products.find(x=>x.waterType==='BAG_7_5L').name}（可用 ${pickup ? p.bagPickupTickets : p.bagDeliveryTickets} 袋）`;
      if (!pickup) document.querySelector('#mSheetBody .field input').value = p.defaultAddress || '';
      window.updateMOrderSummary();
    };
    window.openWxAuth = () => Live.logoutMember();
    window.submitMemberOrder = async function () {
      const m = Live.selectedMember;
      if (!m) return;
      const isPickup = Live.orderMode === '自提';
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
            idempotencyKey: Live.orderRequestKey,
            addressOverride: isPickup ? null : document.querySelector('#mSheetBody .field input')?.value,
          }),
        });
        window.closeMSheet?.();
        await syncMemberMiniApp();
        if (isPickup && res.pickupCode) {
          window.showPickupQr?.(res.orderNo, res.pickupCode);
        } else {
          window.GQ?.toast(`预约成功！单号 ${res.orderNo}，剩余可用票 ${res.availableTicketsAfter}`);
          window.memberNav?.('orders');
        }
      } catch (e) {
        window.GQ?.toast(e.message);
      }
    };
  }

  /* -----------------------------------------------------------------------
     员工端微信小程序  同步
     ----------------------------------------------------------------------- */
  async function syncStaffMiniApp() {
    if (!Live.session) return;
    await Live.syncAdminAll();
    const greetH2 = document.querySelector('#staff-home .h5-greeting h2');
    if (greetH2) greetH2.textContent = `${Live.session.displayName}，你好`;
    const shift=document.querySelector('.shift-card span');if(shift)shift.textContent='当前账号：'+Live.session.codeOrNo;
    const profile=document.querySelector('#staff-profile .h5-card');if(profile){profile.querySelector('.member-avatar').textContent=Live.session.displayName[0];profile.querySelector('b').textContent=Live.session.displayName;profile.querySelector('b').nextElementSibling.textContent=Live.session.codeOrNo+' · '+({ADMIN:'管理员',CLERK:'店员',COURIER:'送水员'}[Live.session.role]||Live.session.role);}

    const pendingCnt = Live.orders.filter((o) => o.status === 'PENDING' || o.status === 'DISPATCHED').length;
    const doneCnt = Live.orders.filter((o) => o.status === 'COMPLETED').length;
    const workNums = document.querySelectorAll('#staff-home .work-numbers .work-number b');
    if (workNums.length >= 3) {
      workNums[0].textContent = String(pendingCnt);
      workNums[1].textContent = String(doneCnt);
      workNums[2].textContent = String(Live.members.length);
      workNums[1].parentElement.querySelector('small').textContent='当前列表已完成';
      workNums[2].parentElement.querySelector('small').textContent='当前查询会员';
    }

    window.KunlunMembership?.renderOrders('staff');
    // 渲染员工端查会员列表 (#staffMemberList)
    const staffMemberList = document.getElementById('staffMemberList');
    if (staffMemberList) {
      staffMemberList.innerHTML = Live.members
        .map(
          (m) => `
        <div class="h5-card" onclick="openSheet('memberDetail','${m.id}')" style="cursor:pointer">
          <div class="member-cell"><div class="member-avatar">${escapeHtml(m.name[0])}</div><div><b>${escapeHtml(m.name)}</b><small>${m.phone} · ${m.memberNo}</small></div><span class="tag green" style="margin-left:auto">办理 ›</span></div>
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
