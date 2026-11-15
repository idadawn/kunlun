import SwiftUI
import KunlunCore

struct RecordsView: View {
    @Environment(MemberStore.self) private var store
    @State private var status = ""
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("用水记录").font(.title2.bold())
                    Spacer()
                    Picker("水单状态", selection: $status) {
                        Text("全部状态").tag("")
                        Text("待办理").tag("PENDING")
                        Text("配送中").tag("DISPATCHED")
                        Text("已完成").tag("COMPLETED")
                        Text("已取消").tag("CANCELLED")
                    }.accessibilityIdentifier("orders.filter")
                }
                StateView(state: store.orders, retry: { await store.loadOrders(status: status) }) { orders in
                    if orders.isEmpty { ContentUnavailableView("暂无用水记录", systemImage: "drop", description: Text("店员登记后，可在这里查看用水情况。")) }
                    ForEach(orders) { OrderCard(order: $0) }
                    if let message = store.moreError { Text(message).font(.footnote).foregroundStyle(.red) }
                    if store.hasMoreOrders {
                        Button { Task { await store.loadOrders(more: true) } } label: {
                            HStack { Spacer(); if store.loadingMore { ProgressView() }; Text("加载更多"); Spacer() }
                        }.buttonStyle(.bordered).disabled(store.loadingMore).accessibilityIdentifier("orders.more")
                    }
                }
                StoreHint()
            }.padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("记录").navigationBarTitleDisplayMode(.inline)
            .toolbar { NavigationLink("充值记录") { RechargeView() } }
            .task(id: status) { await store.loadOrders(status: status) }
            .refreshable { await store.loadOrders(status: status) }
    }
}

struct RechargeView: View {
    @Environment(MemberStore.self) private var store
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                StateView(state: store.batches, retry: { await store.loadBatches() }) { batches in
                    if batches.isEmpty { ContentUnavailableView("暂无充值记录", systemImage: "ticket", description: Text("充值请到门店办理。")) }
                    ForEach(batches) { batch in
                        Card {
                            HStack(alignment: .top) { Text(batch.name).font(.headline); Spacer(); Text(batch.paidAmount.yuan).font(.headline).foregroundStyle(Brand.green) }
                            Text("\(batch.waterLabel) · \(modeTitle(batch.fulfillMode))").font(.subheadline).foregroundStyle(.secondary)
                            DetailLine(title: "购票 / 赠票", value: "\(batch.fixedQty) / \(batch.giftQty) 份")
                            DetailLine(title: "剩余购票 / 赠票", value: "\(batch.remainingBuy) / \(batch.remainingGift) 份")
                            if batch.reservedBuy + batch.reservedGift > 0 { DetailLine(title: "其中已预留", value: "\(batch.reservedBuy + batch.reservedGift) 份") }
                            if let quantity = batch.pendingGiftQty, quantity > 0 { Text("赠票 \(quantity) 份待审核").font(.footnote).foregroundStyle(.orange) }
                            if batch.pendingRequestNo != nil { Text("水费退款申请审核中").font(.footnote).foregroundStyle(.orange) }
                            if batch.status == "REFUNDED" { DetailLine(title: "已退款", value: batch.refundedAmount.yuan) }
                            if batch.source == "LEGACY" { Text("历史余额，详情请向门店核对").font(.footnote).foregroundStyle(.secondary) }
                            Text(displayDate(batch.createdAt)).font(.caption).foregroundStyle(.secondary)
                            if !batch.rechargeNo.isEmpty { Text(batch.rechargeNo).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled) }
                        }
                    }
                }
            }.padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("充值记录")
            .task { await store.loadBatches() }.refreshable { await store.loadBatches() }
    }
}
