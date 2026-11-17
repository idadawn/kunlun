using System.Globalization;

namespace Kunlun.WaterStation.Operations;

/// <summary>Amounts staff type in: yuan to the cent.</summary>
public static class Money
{
    public const decimal Max = 99_999_999m;

    /// <summary>Not negative (or above zero when <paramref name="allowZero"/> is false), at most two decimals, within range.</summary>
    public static bool Valid(decimal amount, bool allowZero = true) =>
        (allowZero ? amount >= 0 : amount > 0) && amount <= Max && decimal.Round(amount, 2) == amount;

    /// <summary>Two decimals, for messages and request hashes, so 75 and 75.00 read the same.</summary>
    public static string Text(decimal amount) => amount.ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>
    /// The price of each container when a deposit total is typed in for several of them. A deposit lot keeps one price per
    /// container and refunds take whole containers, so the total has to split evenly to the cent.
    /// </summary>
    public static decimal UnitPrice(decimal total, int qty, string unit)
    {
        if (qty <= 0 || !Valid(total, allowZero: false)) throw new BusinessRuleException("押金金额要大于 0、精确到分");
        var each = decimal.Round(total / qty, 2);
        if (each * qty != total)
            throw new BusinessRuleException($"¥{Text(total)} 分到 {qty} 个{unit}不是整分（每个约 ¥{Text(each)}），请核对金额或个数");
        return each;
    }
}
