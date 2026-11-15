import SwiftUI
import KunlunCore

struct HomeView: View {
    @Environment(MemberStore.self) private var store
    @Environment(MemberRouter.self) private var router
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 18) {
                    HStack { Image(systemName: "drop.fill"); Text("绿麒麟水站").fontWeight(.semibold); Spacer(); Text("麒麟会员").font(.caption).padding(8).background(.white.opacity(0.15), in: Capsule()) }
                    Text("你好，\(store.identity?.displayName ?? "会员")").font(.title.bold())
                    Text("鲜活每一滴，好水到你家").font(.subheadline).opacity(0.9)
                    Text(store.identity?.codeOrNo ?? "").font(.caption.monospaced()).opacity(0.8)
                }.padding(24).foregroundStyle(.white).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Brand.gradient, in: RoundedRectangle(cornerRadius: 26))
                HStack { Text("我的水票").font(.title2.bold()); Spacer(); NavigationLink("充值记录") { RechargeView() }.font(.subheadline) }
                StateView(state: store.profile, retry: { await store.loadProfile() }) { profile in
                    if profile.tickets.isEmpty {
                        Card { Text("还没有水票").font(.headline); Text("到店充值后，剩余水票会显示在这里。").font(.subheadline).foregroundStyle(.secondary) }
                    }
                    ForEach(profile.tickets) { ticket in
                        Card {
                            HStack(alignment: .center) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Label(ticket.name, systemImage: ticket.containerType == "BAG" ? "drop" : "waterbottle").font(.headline)
                                    Text(modeTitle(ticket.fulfillMode)).font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 4) {
                                    (Text("\(ticket.available)").font(.system(.largeTitle, design: .rounded, weight: .bold)) + Text(" \(ticket.unit)").font(.subheadline)).foregroundStyle(Brand.green)
                                    Text("可用水票").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            if ticket.reserved > 0 { Text("另有 \(ticket.reserved) \(ticket.unit)已为待办理水单预留").font(.caption).foregroundStyle(.secondary) }
                        }.accessibilityElement(children: .combine)
                    }
                    Card {
                        Text("我的袋桶与押金").font(.headline)
                        DetailLine(title: "手里的周转桶", value: "\(profile.heldBuckets) 个")
                        DetailLine(title: "手里的周转水袋", value: "\(profile.heldBags) 个")
                        DetailLine(title: "已交押金", value: profile.depositAmount.yuan)
                        Button("查看押金明细") { router.tab = .assets }.font(.subheadline)
                    }
                }
                StoreHint()
            }.padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("我的水票").navigationBarTitleDisplayMode(.inline)
            .task { await store.loadProfile() }.refreshable { await store.loadProfile() }
    }
}
