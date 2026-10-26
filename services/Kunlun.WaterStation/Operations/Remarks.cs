namespace Kunlun.WaterStation.Operations;

/// <summary>
/// 会员与水单的选填备注（如“空桶放门口”），供配送员和店员办理时查看。
/// 去除首尾空白，空白备注存为 NULL，超出列长度直接拒绝而不是截断。
/// </summary>
public static class Remarks
{
    public const int OrderMaxLength = 200;
    public const int MemberMaxLength = 500;

    public static string? Normalize(string? value, int maxLength)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        if (text.Length > maxLength) throw new BusinessRuleException($"备注不能超过 {maxLength} 字");
        return text;
    }
}
