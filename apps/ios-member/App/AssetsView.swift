import SwiftUI
import KunlunCore

struct AssetsView: View {
    @Environment(MemberStore.self) private var store
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                StateView(state: store.deposits, retry: { await store.loadDeposits() }) { rows in
                    VStack(alignment: .leading, spacing: 12) {
                        Text("我的押金余额").font(.subheadline)
                        Text(rows.reduce(Decimal.zero) { $0 + $1.paidAmount }.yuan).font(.system(.largeTitle, design: .rounded, weight: .bold))
                        Text("按原收款批次记录").font(.caption).opacity(0.8)
                    }.padding(24).foregroundStyle(.white).frame(maxWidth: .infinity, alignment: .leading).background(Brand.gradient, in: RoundedRectangle(cornerRadius: 24))
                    ForEach(rows) { row in
                        Card {
                            HStack { Text(row.title).font(.title3.bold()); Spacer(); Text(row.heldQty <= row.paidQty - row.pendingDamageQty ? "押金已覆盖" : "需补交押金").font(.caption).foregroundStyle(Brand.green) }
                            DetailLine(title: "当前手里有", value: "\(row.heldQty) 个")
                            DetailLine(title: "剩余押金", value: "\(row.paidQty) 个 · \(row.paidAmount.yuan)")
                            DetailLine(title: "当前可退", value: "\(row.refundableQty) 个 · \(row.refundableAmount.yuan)")
                            if row.pendingRefundQty > 0 { Text("退押申请审核中：\(row.pendingRefundQty) 个").font(.footnote).foregroundStyle(.orange) }
                            if row.pendingDamageQty > 0 { Text("待报废 \(row.pendingDamageQty) 个，暂占押金 \(row.pendingDamageAmount.yuan)").font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                    if rows.isEmpty { Text("暂无押金记录").foregroundStyle(.secondary) }
                }
                Text("归还空桶或水袋后，请由门店登记并核对，按原收款价办理退款。").font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 4)
            }.padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("押金与桶")
            .task { await store.loadDeposits() }.refreshable { await store.loadDeposits() }
    }
}
