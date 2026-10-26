namespace Kunlun.WaterStation;

public enum WaterType { Bucket18_9L, Bag7_5L }
public enum FulfillMode { Delivery, Pickup }
public enum ContainerType { Bucket, Bag }

/// <summary>
/// 容器总账与恒等式校验：总量 = 站内可用 + 配送在途 + 会员持有 + 待检 + 异常
/// </summary>
public sealed record ContainerSummary(
    ContainerType Type,
    decimal UnitDeposit,
    int TotalQty,
    int InStationQty,
    int InTransitQty,
    int MemberHeldQty,
    int InspectingQty,
    int AbnormalQty)
{
    public bool IsBalanced =>
        TotalQty == InStationQty + InTransitQty + MemberHeldQty + InspectingQty + AbnormalQty;
}

/// <summary>
/// 交付与容器流转核算：会员持有变化 = 满桶领出(N) - 空桶收回(M)
/// </summary>
public static class ContainerAccounting
{
    public static int CalculateHoldingDelta(int fullOutN, int emptyInM) => fullOutN - emptyInM;

    public static int CalculateRefundableDepositQty(int paidRemainingDepositQty, int currentHeldQty) =>
        Math.Max(0, paidRemainingDepositQty - currentHeldQty);
}
