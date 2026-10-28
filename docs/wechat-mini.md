# 微信小程序测试版

## 本轮范围与状态

员工与会员使用**同一个原生微信小程序**。登录后根据后端返回的 `subjectType`、`permissions` 呈现页面；退出后才能切换账号。前端隐藏入口不替代后端权限校验。

`apps/wechat-mini` 使用 WXML / WXSS / JavaScript，直接生成微信开发者工具项目，不是 H5 的 web-view 包装。现有 `apps/mini-app` H5 与管理端继续保留。字体采用 PingFang SC / Noto Sans CJK SC / Microsoft YaHei；品牌色深绿 `#174E3C`、浅绿 `#EAF3EA`、暖白 `#F7F8F2`。参考妙铺送水案例的业务路径，未复制其素材或页面。

这是**测试版交付**：当前可用的支付提供者只有 `MOCK`，没有请求微信支付现网，没有真实资金交易，不是微信官方支付沙箱。真实微信支付的方向已确认：自有商户号直连、APIv3、微信支付公钥验签。`lib/payment.js` 包含官方 `wx.requestPayment` 前端参数适配及支付后查询，但服务端真实下单、签名验签、回调、对账与原路退款尚未实现，因此不能宣称微信支付真实接入或上线验收完成。

## 可测试功能

| 身份 | 本轮可用 | 仍使用现有 H5 / 管理端 |
| --- | --- | --- |
| 会员 | 账号登录；桶装/袋装订水；配送/自提；查看及取消待处理水单；自提码；水票余额、套餐购买与模拟支付重试；新增/编辑地址；押金与桶袋持有查询 | 微信身份绑定、自助注册、优惠券购买抵扣、更多历史账单 |
| 员工 | 账号登录；待处理/配送中等水单筛选与分页；接单；按预约数量交付；自提码核验；空桶袋回收登记；会员查询与代客订水 | 新建会员、收取/补交押金、差额履约、充值代办、退款申请与审核、库存管理 |

员工退款、押金等菜单不会伪装成已迁移能力；押金不足时后端拒绝交付，提示回门店处理。员工与会员在首页及底部导航中看见不同功能。本地演示中的姓名、手机号和地址均为固定测试数据。

## 运行本地演示

```sh
pnpm --filter @kunlun/wechat-mini build
pnpm --filter @kunlun/wechat-mini test
```

开发者工具打开 `apps/wechat-mini/dist`，选择游客模式即可进行本地操作。`touristappid` 是游客占位值，不是正式或可真机预览的小程序 AppID。此模式无网络请求，状态仅在微信模拟器的本地存储里保存；退出登录后选员工账号，可处理刚才会员创建的水单。

本机稳定版 `2.01.2510290` 的游客模式使用基础库 `3.16.2` 时出现 `webapi_getwxaasyncsecinfo:fail` 并白屏；使用开发工具提供的 `2.30.4` 后登录页正常渲染，测试项目暂固定此版本。每次编译可能显示 `更改 AppID 失败 touristappid`，关闭提示后继续游客测试。这不代表已具备真机预览资格；取得自己的测试 AppID 后应重新在当前基础库验收。

推荐验收顺序：

1. 体验会员 → 购买水票 → 依次模拟取消、失败、成功；核对只有成功增加水票，重试不重复入账。
2. 会员订水 → 送水上门；另下一笔自提单查看自提码；再下一笔并取消，核对水票退回。
3. 退出 → 体验员工 → 接单 → 按真实回收数量确认交付；自提单输入会员自提码核销。
4. 会员重新登录，检查水单完成状态、水票与桶袋持有。

## 接独立测试后端

小程序使用现有账号密码登录，账号由门店开通。当前没有 `wx.login` 换取 OpenID 的后端绑定流程，不能把测试账号登录描述成微信授权登录。

服务端只在同时满足以下条件时允许模拟支付：

- `Kunlun__MiniPayments__Mode=Mock`；默认 `Disabled`。
- `ASPNETCORE_ENVIRONMENT=Development` 或 `Testing`。
- `ConnectionStrings__Kunlun` 指向独立测试库，数据库名包含 `test`。

不符合条件时启动失败；Disabled 不创建测试支付表，支付接口返回 503。`Wechat` 等未实现模式也拒绝启动，不能因缺少商户配置悄悄降级为模拟支付。不要对正式库设置 Mock。

构建时通过环境变量设置自己的 AppID 和测试 HTTPS API 源站：

```sh
KUNLUN_MINI_MODE=api \
KUNLUN_MINI_APPID="$YOUR_TEST_APPID" \
KUNLUN_MINI_API_BASE="$YOUR_TEST_HTTPS_ORIGIN" \
pnpm --filter @kunlun/wechat-mini build
```

设置微信公众平台 request 合法域名，保留 HTTPS/TLS/证书校验。API 构建移除本地演示数据与引用，不会在接口报错时回退演示。登录令牌按运行模式及后端源站分别存储，401 清除会话。正式版 `envVersion=release` 被拒绝使用，避免误上传成为业务入口。

## 测试支付接口与原子性

| 接口 | 权限与用途 |
| --- | --- |
| `POST /api/mini-payments` | 会员创建本人待支付单；仅接收套餐 ID 和幂等键 |
| `GET /api/mini-payments` | 本人最近 100 笔测试支付单 |
| `GET /api/mini-payments/{id}` | 查询本人支付单；不可查询他人 |
| `POST /api/mini-payments/{id}/simulate` | 模拟 SUCCESS / CANCEL / FAIL；仅独立测试后端可用 |

金额取后端套餐配置，以精确 decimal 转为整数分；创建时保存套餐名称、价格、水品、履约方式、数量快照。相同会员与幂等键复用同一支付单，换套餐返回 409。取消与失败保留 NOTPAY，可以重试；SUCCESS 不得被晚到的取消降级。

结算先锁会员、再锁支付单，判断状态与更新余额在同一 PostgreSQL 事务中完成。支付状态、`recharge_orders`、`ticket_batches`、`ticket_ledgers`、会员可用水票一起提交或回滚。账务方式记录为 `MOCK`，操作人“ 小程序模拟支付 ”，不能算真实微信收入。模拟接口不接受“支付回调”身份，也不将前端 `wx.requestPayment` 成功回调作为入账依据。

## 真实支付下一阶段

已确认方案：普通商户直连 + 小程序支付 + APIv3 + 微信支付公钥验签。尚需小程序 AppID、认证与支付权限、绑定的商户号，以及在服务端安全配置的 AppSecret、商户私钥/证书序列号、APIv3 密钥、微信支付公钥/公钥 ID。**不要把密钥发到聊天、写进小程序、提交 Git 或打印日志。**

真实服务端需要完成：微信登录 code 换取并绑定 OpenID；预支付下单及调起参数签名；HTTP 应答/回调验签与 AES-GCM 解密；订单金额、商户号、AppID、OpenID、外部交易号核对；回调幂等、主动查单补偿、关单；交易账单对账；与现有退款审核衔接的原路退款；适用的订单发货管理。具备这些能力后才能更换提供者并做真实小额联调，不能只替换配置就收款。

## 验证与依据

- `tests/flows.test.cjs`：本地业务、角色隔离、取消/失败/重复支付及前端成功不可伪造到账。
- `MiniPaymentTests.cs`：真实隔离 PostgreSQL 的并发、身份隔离、金额篡改、历史套餐快照、原子入账、生产防护。
- 官方支付 Skill 检查结论：本轮模拟路径的金额、幂等、权限、按钮防抖、前端结果确认可测试；签名/验签/加密/echo、真实下单/回调/补偿/退款/对账、主备域名容灾和 Request-ID 日志未实现或未验证。**不具备生产支付接入完成结论。**
- 官方通用流程规则的付款按钮防抖用 `ui.run` 同步 busy 状态；真实预支付接口 mock 用例尚不适用，因为没有实现向微信下单。后台微信查单规则尚未满足，属于真实接入阶段的缺口。付款码撤销与退款重试规则不属于本轮模拟支付范围。

本次使用的开发技能：

- [TencentCloudBase miniprogram-development](https://github.com/TencentCloudBase/skills/tree/main/skills/miniprogram-development)
- [微信支付官方 wechatpay-payment-integration](https://github.com/wechatpay-apiv3/wechatpay-skills/tree/main/wechatpay-payment-integration)
- 配套的 UI 设计规范用于原生页面布局与品牌样式。

官方依据：

- [小程序支付开发接入准备](https://pay.weixin.qq.com/doc/v3/merchant/4015459512)
- [小程序支付开发指引](https://pay.weixin.qq.com/doc/v3/merchant/4012791911)
- [小程序调起支付](https://pay.weixin.qq.com/doc/v3/merchant/4012791898)
- 视觉参考：[哆哆送水案例](https://www.vmiaopu.com/cases/181.html)。
