namespace Kunlun.WaterStation;

public enum WaterType { Bucket18_9L, Bag7_5L }
public enum FulfillMode { Delivery, Pickup }
public enum ContainerType { Bucket, Bag }

/// <summary>
/// 容器总账与恒等式校验：现存总量 = 门店可用 + 会员持有 + 待报废；库存只经入库增加、报废减少
/// </summary>
public sealed record ContainerSummary(
    ContainerType Type,
    decimal UnitDeposit,
    int TotalQty,
    int InStationQty,
    int MemberHeldQty,
    int DamagedQty = 0,
    int ScrappedQty = 0)
{
    public bool IsBalanced =>
        TotalQty == (long)InStationQty + MemberHeldQty + DamagedQty;
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
